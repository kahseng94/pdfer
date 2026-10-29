import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from './pdf'
import { exportPages, pageImageName, pdfToImages } from './pdfImages'

// A complete 1 × 1 PNG. Mock canvas encoding, but exercise the real ZIP writer.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII='), (c) => c.charCodeAt(0))
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9])

afterEach(() => vi.unstubAllGlobals())

function fixture() {
  const canvases: { width: number; height: number; toBlob: ReturnType<typeof vi.fn> }[] = []
  vi.stubGlobal('document', {
    createElement: vi.fn(() => {
      const canvas = {
        width: 0, height: 0,
        toBlob: vi.fn((callback: (blob: Blob | null) => void, type: string) => callback(new Blob([type === 'image/png' ? PNG : JPEG], { type }))),
      }
      canvases.push(canvas)
      return canvas
    }),
  })
  const rendered: { width: number; height: number; background: string }[] = []
  const page = {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale })),
    render: vi.fn(({ canvas, background }: { canvas: HTMLCanvasElement; background: string }) => {
      rendered.push({ width: canvas.width, height: canvas.height, background })
      return { promise: Promise.resolve(), cancel: vi.fn() }
    }),
  }
  const getPage = vi.fn(async (_number: number) => page)
  const doc = { numPages: 3, getPage } as unknown as PDFDocumentProxy
  const options = { name: 'Résumé.pdf', spec: '3, 1-2, 2', format: 'png' as const, dpi: 150 as const, signal: new AbortController().signal }
  return { doc, options, canvases, rendered, page, getPage }
}

describe('page selection for image export', () => {
  it('deduplicates overlaps and exports in document order, including open-ended ranges', () => {
    expect(exportPages('5, 2-3, 2, 8-, -2', 10)).toEqual([1, 2, 3, 5, 8, 9, 10])
  })

  it.each(['', ' , ', '0', '4-2', '1, 99', '1, nope'])('rejects an empty or invalid selection: %s', (spec) => {
    expect(() => exportPages(spec, 10)).toThrow()
  })

  it('keeps Unicode filenames and uses padded original page numbers without ZIP paths', () => {
    expect(pageImageName('Résumé.PDF', 3, 120, 'jpeg')).toBe('Résumé_page-003.jpg')
    expect(pageImageName('../folder\\file.pdf', 2, 4, 'png')).toBe('_folder_file_page-2.png')
    expect(pageImageName('.pdf', 1, 1, 'png')).toBe('document_page-1.png')
  })
})

describe('pdfToImages', () => {
  it('produces a readable ZIP with each selected PNG once and the requested pixel dimensions', async () => {
    const { doc, options, getPage, rendered, canvases } = fixture()
    const progress = vi.fn()
    const file = await pdfToImages(doc, { ...options, onProgress: progress })
    expect(file.name).toBe('Résumé_images.zip')
    expect(file.type).toBe('application/zip')
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
    expect(Object.keys(entries)).toEqual(['Résumé_page-1.png', 'Résumé_page-2.png', 'Résumé_page-3.png'])
    expect(getPage.mock.calls.map(([number]) => number)).toEqual([1, 2, 3])
    expect(rendered).toEqual(Array(3).fill({ width: 1275, height: 1650, background: '#ffffff' }))
    expect(canvases.every((c) => c.width === 0 && c.height === 0)).toBe(true)
    const image = entries['Résumé_page-1.png']
    expect([...image.slice(0, 8)]).toEqual([...PNG.slice(0, 8)])
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength)
    expect(view.getUint32(37)).toBe(0x70485973) // PNG pHYs
    expect(view.getUint32(41)).toBe(Math.round(150 / 0.0254))
    expect(progress).toHaveBeenLastCalledWith({ completed: 3, total: 3, page: 3 })
  })

  it('also creates a ZIP for a single JPEG, with JPEG encoding and correct DPI', async () => {
    const { doc, options, canvases, rendered } = fixture()
    const file = await pdfToImages(doc, { ...options, spec: '2', format: 'jpeg', dpi: 300 })
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
    expect(Object.keys(entries)).toEqual(['Résumé_page-2.jpg'])
    expect(canvases[0].toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.92)
    expect(rendered[0]).toMatchObject({ width: 2550, height: 3300 })
    const jpeg = entries['Résumé_page-2.jpg']
    expect(jpeg[13]).toBe(1)
    const view = new DataView(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength)
    expect(view.getUint16(14)).toBe(300)
    expect(view.getUint16(16)).toBe(300)
  })

  it('does no rendering for invalid selections or an already cancelled job', async () => {
    const { doc, options, getPage } = fixture()
    await expect(pdfToImages(doc, { ...options, spec: '1, 4' })).rejects.toThrow('Not valid')
    await expect(pdfToImages(doc, { ...options, signal: AbortSignal.abort() })).rejects.toThrow()
    expect(getPage).not.toHaveBeenCalled()
  })

  it('cancels an active render, releases its canvas, and never starts another page', async () => {
    const { doc, options, page, getPage, canvases } = fixture()
    const controller = new AbortController()
    let rejectRender: (reason: Error) => void = () => {}
    const cancel = vi.fn(() => rejectRender(new Error('Rendering cancelled')))
    page.render.mockReturnValue({ promise: new Promise<void>((_, reject) => { rejectRender = reject }), cancel })
    const pending = pdfToImages(doc, { ...options, signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow('Rendering cancelled')
    await vi.waitFor(() => expect(page.render).toHaveBeenCalledOnce())
    controller.abort()
    await rejected
    expect(cancel).toHaveBeenCalledOnce()
    expect(getPage).toHaveBeenCalledOnce()
    expect(canvases[0].width).toBe(0)
  })

  it('does not return a partial ZIP when cancelled between pages', async () => {
    const { doc, options, getPage } = fixture()
    const controller = new AbortController()
    await expect(pdfToImages(doc, {
      ...options, signal: controller.signal,
      onProgress: ({ completed }) => { if (completed === 1) controller.abort() },
    })).rejects.toThrow()
    expect(getPage).toHaveBeenCalledOnce()
  })

  it('rejects oversized pages before allocating a canvas', async () => {
    const { doc, options, page, canvases } = fixture()
    page.getViewport.mockReturnValue({ width: 20_000, height: 20_000 })
    await expect(pdfToImages(doc, options)).rejects.toThrow('Choose a lower resolution')
    expect(canvases).toHaveLength(0)
  })

  it('reports encoding failure and frees the canvas instead of returning a partial result', async () => {
    const { doc, options, page, canvases, getPage } = fixture()
    page.render.mockImplementation(() => {
      canvases[0].toBlob.mockImplementation((callback: (blob: Blob | null) => void) => callback(null))
      return { promise: Promise.resolve(), cancel: vi.fn() }
    })
    await expect(pdfToImages(doc, options)).rejects.toThrow('Could not encode')
    expect(getPage).toHaveBeenCalledOnce()
    expect(canvases[0].height).toBe(0)
  })
})
