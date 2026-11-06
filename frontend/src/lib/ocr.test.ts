import { afterEach, expect, it, vi } from 'vitest'
import { assembleOcr, recognizePage } from './api'
import { ocrPages, recognizePdf } from './ocr'
import type { PDFDocumentProxy } from './pdf'

vi.mock('./api', () => ({ assembleOcr: vi.fn(), recognizePage: vi.fn() }))
const assemble = vi.mocked(assembleOcr)
const recognize = vi.mocked(recognizePage)
const source = new File(['original PDF'], 'scan.pdf', { type: 'application/pdf' })
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })

function fixture(texts = ['', 'Existing selectable text', '']) {
  const canvases: { width: number; height: number }[] = []
  vi.stubGlobal('document', { createElement: () => {
    const canvas = { width: 0, height: 0, toBlob: (done: (blob: Blob) => void) => done(new Blob(['raster'], { type: 'image/png' })) }
    canvases.push(canvas)
    return canvas
  } })
  const pages = texts.map((text) => ({
    getTextContent: vi.fn(async () => ({ items: [{ str: text }] })),
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 200 * scale, height: 100 * scale })),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
  }))
  const getPage = vi.fn(async (number: number) => pages[number - 1])
  const doc = { numPages: pages.length, getPage } as unknown as PDFDocumentProxy
  recognize.mockResolvedValue({ file: new File(['text layer'], 'text.pdf', { type: 'application/pdf' }), rotation: 0 })
  assemble.mockResolvedValue(new File(['searchable PDF'], 'scan_searchable.pdf', { type: 'application/pdf' }))
  return { doc, pages, getPage, canvases }
}

it('normalizes page ranges in document order and rejects invalid or empty ranges', () => {
  expect(ocrPages('', 4)).toEqual([1, 2, 3, 4])
  expect(ocrPages('3, 1-2, 2-', 4)).toEqual([1, 2, 3, 4])
  for (const spec of ['0', '5', '3-1', 'hello', ',', '1,5']) expect(() => ocrPages(spec, 4)).toThrow()
})

it('recognizes only text-free pages, preserves the full source, and releases raster memory', async () => {
  const { doc, pages, canvases } = fixture()
  const signal = new AbortController().signal
  const progress = vi.fn()
  const output = await recognizePdf(doc, source, '', ['eng', 'fra'], 300, signal, progress)
  expect(recognize).toHaveBeenCalledTimes(2)
  expect(recognize.mock.calls[0].slice(1)).toEqual([['eng', 'fra'], 300, signal, false, 'tesseract'])
  expect(pages[1].render).not.toHaveBeenCalled()
  expect(assemble).toHaveBeenCalledWith(source, [expect.any(File), expect.any(File)], [1, 3], signal, [0, 0])
  expect(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
  expect(progress).toHaveBeenLastCalledWith({ completed: 3, total: 3, page: 3, skipped: 1, recognized: 2, rotated: 0, phase: 'assemble' })
  expect(output.name).toBe('scan_searchable.pdf')
})

it('processes only the requested page ranges', async () => {
  const { doc, getPage } = fixture(['', '', ''])
  await recognizePdf(doc, source, '3, 1, 3', ['eng'], 150, new AbortController().signal, vi.fn())
  expect(getPage.mock.calls).toEqual([[1], [3]])
  expect(assemble.mock.calls[0][2]).toEqual([1, 3])
})

it('keeps rotation corrections aligned with recognized pages and reports their count', async () => {
  const { doc } = fixture(['', 'Existing text', '', ''])
  recognize.mockResolvedValueOnce({ file: new File(['first'], 'text.pdf'), rotation: 90 })
    .mockResolvedValueOnce({ file: new File(['third'], 'text.pdf'), rotation: 0 })
  const signal = new AbortController().signal
  const progress = vi.fn()
  await recognizePdf(doc, source, '1-3', ['eng'], 150, signal, progress, true)
  expect(recognize).toHaveBeenCalledTimes(2)
  expect(recognize.mock.calls.every((call) => call[4] === true)).toBe(true)
  expect(assemble).toHaveBeenCalledWith(source, [expect.any(File), expect.any(File)], [1, 3], signal, [90, 0])
  expect(progress).toHaveBeenLastCalledWith({ completed: 3, total: 3, page: 3, skipped: 1, recognized: 2, rotated: 1, phase: 'assemble' })
})

it('passes the selected Paddle engine and rotation while preserving page ranges', async () => {
  const { doc } = fixture(['', '', ''])
  recognize.mockResolvedValue({ file: new File(['text'], 'text.pdf'), rotation: 180 })
  const signal = new AbortController().signal
  await recognizePdf(doc, source, '2', ['auto'], 150, signal, vi.fn(), true, 'paddleocr')
  expect(recognize.mock.calls[0].slice(1)).toEqual([['auto'], 150, signal, true, 'paddleocr'])
  expect(assemble).toHaveBeenCalledWith(source, [expect.any(File)], [2], signal, [180])
  await expect(recognizePdf(doc, source, '', ['eng'], 150, signal, vi.fn(), false, 'paddleocr')).rejects.toThrow('automatic multilingual')
})

it('offers no redundant output when all selected pages already contain text', async () => {
  const { doc } = fixture(['Existing text'])
  await expect(recognizePdf(doc, source, '', ['eng'], 300, new AbortController().signal, vi.fn())).rejects.toThrow('already contain text')
  expect(recognize).not.toHaveBeenCalled()
  expect(assemble).not.toHaveBeenCalled()
})

it('aborts the active native request and never assembles a partial result', async () => {
  const { doc } = fixture(['', ''])
  const controller = new AbortController()
  recognize.mockImplementation((_image, _languages, _dpi, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const pending = recognizePdf(doc, source, '', ['eng'], 300, controller.signal, vi.fn())
  const rejection = expect(pending).rejects.toThrow()
  await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce())
  controller.abort()
  await rejection
  expect(recognize).toHaveBeenCalledOnce()
  expect(assemble).not.toHaveBeenCalled()
})

it('cancels rendering, releases the canvas, and rejects late outputs after cancellation', async () => {
  const { doc, pages, canvases } = fixture([''])
  const controller = new AbortController()
  let reject!: (error: Error) => void
  const cancel = vi.fn(() => reject(new Error('render cancelled')))
  pages[0].render.mockReturnValue({ promise: new Promise<void>((_resolve, fail) => { reject = fail }), cancel })
  const pending = recognizePdf(doc, source, '', ['eng'], 300, controller.signal, vi.fn())
  const rejection = expect(pending).rejects.toThrow()
  await vi.waitFor(() => expect(pages[0].render).toHaveBeenCalled())
  controller.abort(); await rejection
  expect(cancel).toHaveBeenCalledOnce()
  expect(canvases[0].width).toBe(0)
  expect(recognize).not.toHaveBeenCalled()
  expect(assemble).not.toHaveBeenCalled()
})

it('identifies a failed page without returning earlier successful pages', async () => {
  const { doc } = fixture(['', ''])
  recognize.mockResolvedValueOnce({ file: new File(['text'], 'text.pdf'), rotation: 0 }).mockRejectedValueOnce(new Error('engine failed'))
  await expect(recognizePdf(doc, source, '', ['eng'], 300, new AbortController().signal, vi.fn())).rejects.toThrow('Page 2: engine failed')
  expect(assemble).not.toHaveBeenCalled()
})

it('bounds page size before allocating a raster and validates options before OCR', async () => {
  const { doc, pages, canvases } = fixture([''])
  pages[0].getViewport.mockReturnValue({ width: 100_000, height: 100_000 })
  await expect(recognizePdf(doc, source, '', ['eng'], 300, new AbortController().signal, vi.fn())).rejects.toThrow('too large')
  expect(canvases).toHaveLength(0)
  await expect(recognizePdf(doc, source, '', [], 300, new AbortController().signal, vi.fn())).rejects.toThrow('languages')
  await expect(recognizePdf(doc, source, '', ['eng'], 72, new AbortController().signal, vi.fn())).rejects.toThrow('DPI')
  expect(recognize).not.toHaveBeenCalled()
})
