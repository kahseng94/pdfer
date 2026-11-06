import { expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from './pdf'
import { COMPARE_LIMITS, comparePdfs, DEFAULT_COMPARE, pairSize, renderComparisonPage, textChanges, visualChanges } from './pdfCompare'

function raster(width = 48, height = 48) { return new Uint8ClampedArray(width * height * 4).fill(255) }
const signal = () => new AbortController().signal

it('does not flag identical blank rasters and respects the color/noise threshold', async () => {
  const a = raster(), b = raster()
  expect((await visualChanges(a, b, 48, 48, 'balanced', signal())).regions).toEqual([])
  for (let i = 0; i < 12; i++) b[i * 4] = 240
  expect((await visualChanges(a, b, 48, 48, 'balanced', signal())).regions).toEqual([])
  expect((await visualChanges(a, b, 48, 48, 'precise', signal())).changedPixels).toBe(12)
  b.fill(255); b[0] = 0
  expect((await visualChanges(a, b, 48, 48, 'balanced', signal())).regions).toEqual([])
  expect((await visualChanges(a, b, 48, 48, 'precise', signal())).regions).toHaveLength(1)
})

it('groups neighboring differences and keeps distant regions independently navigable', async () => {
  const a = raster(), b = raster()
  for (const pixel of [0, 1, 2, 3, 47 * 48 + 44, 47 * 48 + 45, 47 * 48 + 46, 47 * 48 + 47]) b[pixel * 4] = 0
  const result = await visualChanges(a, b, 48, 48, 'balanced', signal())
  expect(result.regions).toHaveLength(2)
  expect(result.changedPixels).toBe(8)
  expect(result.regions[0]).toEqual({ x: 0, y: 0, width: 12, height: 12 })
})

it('cancels pixel analysis after yielding to the event loop', async () => {
  const controller = new AbortController()
  const result = visualChanges(raster(), raster(), 48, 48, 'balanced', controller.signal)
  controller.abort()
  await expect(result).rejects.toMatchObject({ name: 'AbortError' })
})

it('bounds extreme page sizes, retaining shared physical scale and aspect ratios', () => {
  for (const geometry of [{ width: 100_000, height: 100_000 }, { width: 1, height: 1_000_000 }, { width: 300, height: 400 }]) {
    const size = pairSize(geometry, { width: 20, height: 20 }, 144)
    expect(size.width * size.height).toBeLessThanOrEqual(COMPARE_LIMITS.pixels)
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(COMPARE_LIMITS.side)
  }
  expect(pairSize({ width: 200, height: 100 }, { width: 100, height: 300 }, 72)).toEqual({ width: 200, height: 300, scale: 1 })
  expect(() => pairSize({ width: Infinity, height: 20 }, null, 96)).toThrow('Invalid')
})

it('reports literal additions and removals without treating whitespace as an edit', () => {
  expect(textChanges('hello\nworld', 'hello  world').changes).toEqual([])
  expect(textChanges('A red car and blue sky.', 'A green car and clear sky.')).toEqual({ coarse: false, changes: [
    { removed: 'red', added: 'green' }, { removed: 'blue', added: 'clear' },
  ] })
  expect(textChanges('', 'New text').changes).toEqual([{ removed: '', added: 'New text' }])
  expect(textChanges('Old text', '').changes).toEqual([{ removed: 'Old text', added: '' }])
  expect(textChanges('same', 'same')).toEqual({ coarse: false, changes: [] })
})

it('bounds text diff work without truncating long replacement text', () => {
  const a = Array.from({ length: 3000 }, (_, i) => `old${i}`).join(' ')
  const b = Array.from({ length: 3000 }, (_, i) => `new${i}`).join(' ')
  expect(textChanges(`prefix ${a} end`, `prefix ${b} end`)).toEqual({ coarse: true, changes: [{ removed: a, added: b }] })
})

it('cancels an active PDF render through its RenderTask', async () => {
  let reject!: (reason: Error) => void
  const cancel = vi.fn(() => reject(new DOMException('cancelled', 'AbortError')))
  const page = { getViewport: vi.fn(), render: () => ({ promise: new Promise<void>((_, fail) => { reject = fail }), cancel }) } as unknown as Awaited<ReturnType<PDFDocumentProxy['getPage']>>
  const controller = new AbortController()
  const rendering = renderComparisonPage(page, {} as HTMLCanvasElement, { width: 20, height: 20, scale: 1 }, controller.signal)
  controller.abort()
  await expect(rendering).rejects.toMatchObject({ name: 'AbortError' })
  expect(cancel).toHaveBeenCalledOnce()
})

it('rejects too many pages and invalid settings before reading or allocating pages', async () => {
  const getPage = vi.fn(), createCanvas = vi.fn()
  const doc = { numPages: 1001, getPage } as unknown as PDFDocumentProxy
  await expect(comparePdfs(doc, doc, DEFAULT_COMPARE, { signal: signal(), createCanvas })).rejects.toThrow('1000')
  await expect(comparePdfs(doc, doc, { ...DEFAULT_COMPARE, dpi: 300 } as never, { signal: signal(), createCanvas })).rejects.toThrow('settings')
  expect(getPage).not.toHaveBeenCalled(); expect(createCanvas).not.toHaveBeenCalled()
})

it('releases each pair before reading the next and reports missing text explicitly', async () => {
  const canvases: HTMLCanvasElement[] = [], cleaned: number[] = []
  const getPage = vi.fn(async (number: number) => {
    if (number > 1) expect(canvases.every((c) => !c.width && !c.height)).toBe(true)
    return { getViewport: () => ({ width: 24, height: 24 }), render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
      getTextContent: async () => { if (number === 2) throw new Error('broken font'); return { items: [], styles: {}, lang: null } },
      cleanup: () => cleaned.push(number),
    }
  })
  const doc = { numPages: 3, getPage } as unknown as PDFDocumentProxy
  const createCanvas = () => {
    const canvas = { width: 0, height: 0, getContext: () => ({ getImageData: () => ({ data: raster(canvas.width, canvas.height) }) }) } as unknown as HTMLCanvasElement
    canvases.push(canvas); return canvas
  }
  const pages = await comparePdfs(doc, doc, DEFAULT_COMPARE, { signal: signal(), createCanvas })
  expect(cleaned).toEqual([1, 1, 2, 2, 3, 3])
  expect(pages[1].warnings).toEqual(['Original: Text extraction failed; visual comparison only.', 'Revised: Text extraction failed; visual comparison only.'])
  expect(pages[1].textChanges).toEqual([])
  expect(canvases.every((c) => !c.width && !c.height)).toBe(true)
})

it('bounds cumulative pixel work even when all pages are added', async () => {
  const page = { getViewport: () => ({ width: 2000, height: 2000 }), getTextContent: async () => ({ items: [] }), cleanup: vi.fn() }
  const empty = { numPages: 0 } as PDFDocumentProxy
  const doc = { numPages: 600, getPage: vi.fn(async () => page) } as unknown as PDFDocumentProxy
  await expect(comparePdfs(empty, doc, DEFAULT_COMPARE, { signal: signal() })).rejects.toThrow('pixel budget')
  expect(page.cleanup.mock.calls.length).toBeGreaterThan(400)
  expect(page.cleanup.mock.calls.length).toBeLessThan(600)
})
