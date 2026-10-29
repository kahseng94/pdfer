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
  recognize.mockResolvedValue(new File(['text layer'], 'text.pdf', { type: 'application/pdf' }))
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
  expect(recognize.mock.calls[0].slice(1)).toEqual([['eng', 'fra'], 300, signal, 'tesseract'])
  expect(pages[1].render).not.toHaveBeenCalled()
  expect(assemble).toHaveBeenCalledWith(source, [expect.any(File), expect.any(File)], [1, 3], signal)
  expect(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
  expect(progress).toHaveBeenLastCalledWith({ completed: 3, total: 3, page: 3, skipped: 1, recognized: 2, phase: 'assemble' })
  expect(output.name).toBe('scan_searchable.pdf')
})

it('processes only the requested page ranges', async () => {
  const { doc, getPage } = fixture(['', '', ''])
  await recognizePdf(doc, source, '3, 1, 3', ['eng'], 150, new AbortController().signal, vi.fn())
  expect(getPage.mock.calls).toEqual([[1], [3]])
  expect(assemble.mock.calls[0][2]).toEqual([1, 3])
})

it('uses the selected PaddleOCR engine for every scanned page without falling back', async () => {
  const { doc } = fixture(['', ''])
  const signal = new AbortController().signal
  await recognizePdf(doc, source, '', ['auto'], 300, signal, vi.fn(), 'paddleocr')
  expect(recognize).toHaveBeenCalledTimes(2)
  for (const args of recognize.mock.calls) expect(args.slice(1)).toEqual([['auto'], 300, signal, 'paddleocr'])
  recognize.mockRejectedValue(new Error('PaddleOCR is unavailable'))
  assemble.mockClear()
  await expect(recognizePdf(doc, source, '', ['auto'], 300, signal, vi.fn(), 'paddleocr')).rejects.toThrow('PaddleOCR is unavailable')
  expect(assemble).not.toHaveBeenCalled()
})

it('rejects Tesseract language codes for the unified Paddle model', async () => {
  const { doc } = fixture([''])
  await expect(recognizePdf(doc, source, '', ['eng'], 300, new AbortController().signal, vi.fn(), 'paddleocr')).rejects.toThrow('automatic multilingual')
  expect(recognize).not.toHaveBeenCalled()
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
  recognize.mockResolvedValueOnce(new File(['text'], 'text.pdf')).mockRejectedValueOnce(new Error('engine failed'))
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
