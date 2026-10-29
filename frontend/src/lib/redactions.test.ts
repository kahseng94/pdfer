import { afterEach, expect, it, vi } from 'vitest'
import { rebuildRedactedPdf } from './api'
import type { PDFDocumentProxy } from './pdf'
import { redactionProblem, renderRedactedPdf } from './redactions'

vi.mock('./api', () => ({ rebuildRedactedPdf: vi.fn() }))
const rebuild = vi.mocked(rebuildRedactedPdf)
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })
const areas = [{ id: 'area', page: 1, x: 10.2, y: 20.5, width: 10.1, height: 5.2 }]
const sizes = [{ width: 200, height: 100 }, { width: 100, height: 200 }]
const source = new File(['ORIGINAL PRIVATE PDF OBJECTS'], 'private.pdf', { type: 'application/pdf' })

function fixture() {
  const contexts: { fillRect: ReturnType<typeof vi.fn>; setTransform: ReturnType<typeof vi.fn>; fillStyle: string; globalAlpha: number; globalCompositeOperation: string }[] = []
  const canvases: { width: number; height: number }[] = []
  vi.stubGlobal('document', { createElement: () => {
    const context = { save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), fillRect: vi.fn(), fillStyle: '', globalAlpha: .5, globalCompositeOperation: 'multiply' }
    contexts.push(context)
    const canvas = { width: 0, height: 0, getContext: () => context, toBlob: (callback: (blob: Blob) => void) => callback(new Blob([JSON.stringify(context.fillRect.mock.calls)], { type: 'image/png' })) }
    canvases.push(canvas)
    return canvas
  } })
  const page = { getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 200 * scale, height: 100 * scale })), render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })) }
  const getPage = vi.fn(async () => page)
  const doc = { numPages: 2, getPage } as unknown as PDFDocumentProxy
  rebuild.mockResolvedValue(new File(['new PDF'], 'private_redacted.pdf', { type: 'application/pdf' }))
  return { doc, page, getPage, contexts, canvases }
}

it('masks opaque whole pixels before encoding and rebuilds every page from raster files', async () => {
  const { doc, contexts, canvases, getPage } = fixture()
  const signal = new AbortController().signal
  const progress = vi.fn()
  const output = await renderRedactedPdf(doc, source, areas, sizes, 150, signal, progress)
  expect(contexts[0].setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0)
  expect(contexts[0]).toMatchObject({ fillStyle: '#000000', globalAlpha: 1, globalCompositeOperation: 'source-over' })
  expect(contexts[0].fillRect).toHaveBeenCalledWith(21, 42, 22, 12)
  expect(contexts[1].fillRect).not.toHaveBeenCalled()
  expect(getPage).toHaveBeenCalledTimes(2)
  const [, files, dimensions, passedSignal] = rebuild.mock.calls[0]
  expect(files.map((file) => file.type)).toEqual(['image/png', 'image/png'])
  expect(await files[0].text()).toBe('[[21,42,22,12]]')
  expect(await files[1].text()).toBe('[]')
  expect(dimensions).toEqual(sizes)
  expect(passedSignal).toBe(signal)
  expect(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
  expect(output.name).toBe('private_redacted.pdf')
  expect(progress).toHaveBeenLastCalledWith({ completed: 2, total: 2, phase: 'build' })
})

it('cancels a rendering task and never sends partial pages to the backend', async () => {
  const { doc, page, canvases } = fixture()
  const controller = new AbortController()
  let rejectRender: (error: Error) => void = () => {}
  const cancel = vi.fn(() => rejectRender(new Error('Cancelled')))
  page.render.mockReturnValue({ promise: new Promise<void>((_, reject) => { rejectRender = reject }), cancel })
  const pending = renderRedactedPdf(doc, source, areas, sizes, 150, controller.signal)
  const rejected = expect(pending).rejects.toThrow('Cancelled')
  await vi.waitFor(() => expect(page.render).toHaveBeenCalled())
  controller.abort(); await rejected
  expect(cancel).toHaveBeenCalledOnce()
  expect(rebuild).not.toHaveBeenCalled()
  expect(canvases[0].width).toBe(0)
})

it('rejects invalid rectangles, empty redactions and oversized pages before export', async () => {
  const { doc, page } = fixture()
  expect(redactionProblem([], sizes)).toContain('at least one')
  expect(redactionProblem([{ ...areas[0], width: 9999 }], sizes)).toContain('inside')
  expect(redactionProblem([{ ...areas[0], x: NaN }], sizes)).toContain('inside')
  page.getViewport.mockReturnValue({ width: 100_000, height: 100_000 })
  await expect(renderRedactedPdf(doc, source, areas, sizes, 150, new AbortController().signal)).rejects.toThrow('too large')
  expect(page.render).not.toHaveBeenCalled()
  expect(rebuild).not.toHaveBeenCalled()
})
