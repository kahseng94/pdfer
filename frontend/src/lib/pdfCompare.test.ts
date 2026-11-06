import { expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from './pdf'
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api'
import { COMPARE_LIMITS, cleanupComparisonDocuments, comparePdfs, comparisonPage, createComparisonScheduler, DEFAULT_COMPARE, pairSize, readComparisonText, renderComparisonPage, textChanges, visualChanges } from './pdfCompare'

function raster(width = 48, height = 48) { return new Uint8ClampedArray(width * height * 4).fill(255) }
const signal = () => new AbortController().signal
type PdfPage = Awaited<ReturnType<PDFDocumentProxy['getPage']>>
const chunk = (items: TextContent['items'] = []): TextContent => ({ items, styles: {}, lang: null })
const item = (str: string): TextItem => ({ str, transform: [1, 0, 0, 12, 0, 0], width: 10, height: 12, dir: 'ltr', fontName: 'test', hasEOL: false })
const textStream = (content = chunk()) => new ReadableStream<TextContent>({ start(controller) { controller.enqueue(content); controller.close() } })
function context() { return { fillStyle: '', fillRect: vi.fn(), save: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), restore: vi.fn() } }

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
  const page = { getViewport: () => ({ width: 20, height: 20 }), render: () => ({ promise: new Promise<void>((_, fail) => { reject = fail }), cancel }) } as unknown as PdfPage
  const controller = new AbortController()
  const ctx = context()
  const rendering = renderComparisonPage(page, { getContext: () => ctx } as unknown as HTMLCanvasElement, { width: 20, height: 20, scale: 1 }, controller.signal)
  controller.abort()
  await expect(rendering).rejects.toMatchObject({ name: 'AbortError' })
  expect(cancel).toHaveBeenCalledOnce()
  expect(ctx.restore).toHaveBeenCalledOnce()
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
      streamTextContent: () => { if (number === 2) throw new Error('broken font'); return textStream() },
      cleanup: () => cleaned.push(number),
    }
  })
  const cleanup = vi.fn(async () => {})
  const doc = { numPages: 3, getPage, cleanup } as unknown as PDFDocumentProxy
  const createCanvas = () => {
    const canvas = { width: 0, height: 0, getContext: () => ({ ...context(), getImageData: () => ({ data: raster(canvas.width, canvas.height) }) }) } as unknown as HTMLCanvasElement
    canvases.push(canvas); return canvas
  }
  const pages = await comparePdfs(doc, doc, DEFAULT_COMPARE, { signal: signal(), createCanvas })
  expect(cleaned).toEqual([1, 1, 2, 2, 3, 3])
  expect(pages[1].warnings).toEqual(['Original: Text extraction failed; visual comparison only.', 'Revised: Text extraction failed; visual comparison only.'])
  expect(pages[1].textChanges).toEqual([])
  expect(canvases.every((c) => !c.width && !c.height)).toBe(true)
  expect(cleanup).toHaveBeenCalledTimes(3)
})

it('bounds cumulative pixel work even when all pages are added', async () => {
  const page = { getViewport: () => ({ width: 2000, height: 2000 }), streamTextContent: () => textStream(), cleanup: vi.fn() }
  const empty = { numPages: 0, cleanup: async () => {} } as unknown as PDFDocumentProxy
  const doc = { numPages: 600, getPage: vi.fn(async () => page), cleanup: async () => {} } as unknown as PDFDocumentProxy
  await expect(comparePdfs(empty, doc, DEFAULT_COMPARE, { signal: signal() })).rejects.toThrow('pixel budget')
  expect(page.cleanup.mock.calls.length).toBeGreaterThan(400)
  expect(page.cleanup.mock.calls.length).toBeLessThan(600)
})

it('cancels pending text reads without waiting for the worker to acknowledge cancellation', async () => {
  const cancel = vi.fn(() => new Promise<void>(() => {}))
  const stream = new ReadableStream<TextContent>({ cancel })
  const page = { streamTextContent: () => stream } as unknown as PdfPage
  const controller = new AbortController(), reading = readComparisonText(page, 1, controller.signal)
  controller.abort()
  await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
  expect(cancel).toHaveBeenCalledOnce()
  expect(stream.locked).toBe(false)
})

it.each(['characters', 'items'])('stops text extraction at its %s limit before requesting another chunk', async (limit) => {
  const content = limit === 'characters' ? chunk([item('x'.repeat(COMPARE_LIMITS.pageCharacters + 1))]) : chunk(Array.from({ length: COMPARE_LIMITS.pageItems + 1 }, () => item('')))
  const cancel = vi.fn(), pull = vi.fn((controller: ReadableStreamDefaultController<TextContent>) => controller.enqueue(content))
  const stream = new ReadableStream<TextContent>({ pull, cancel }, { highWaterMark: 0 })
  const result = await readComparisonText({ streamTextContent: () => stream } as unknown as PdfPage, 1, signal())
  expect(result.text).toBe('')
  expect(result.warning).toContain('visual comparison only')
  expect(pull).toHaveBeenCalledOnce()
  expect(cancel).toHaveBeenCalledOnce()
  expect(stream.locked).toBe(false)
})

it('preserves spacing across text stream chunks without retaining font dictionaries', async () => {
  const a = item('Hello'), b = { ...item('world'), transform: [1, 0, 0, 12, 30, 0] }
  const stream = new ReadableStream<TextContent>({ start(controller) { controller.enqueue(chunk([a])); controller.enqueue(chunk([b])); controller.close() } })
  await expect(readComparisonText({ streamTextContent: () => stream } as unknown as PdfPage, 1, signal())).resolves.toEqual({ text: 'Hello world' })
})

it('cancels a pending page load promptly and releases its late result', async () => {
  let resolve!: (page: PdfPage) => void
  const doc = { numPages: 1, getPage: () => new Promise<PdfPage>((done) => { resolve = done }) } as unknown as PDFDocumentProxy
  const controller = new AbortController(), pending = comparisonPage(doc, 1, controller.signal)
  await Promise.resolve()
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  const cleanup = vi.fn()
  resolve({ cleanup } as unknown as PdfPage)
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce())
})

it('waits for cancelled preview/raster work to settle and skips superseded queued work', async () => {
  const schedule = createComparisonScheduler(), old = new AbortController(), skipped = new AbortController()
  let release!: () => void
  const first = schedule(old.signal, () => new Promise<void>((done) => { release = done }))
  await Promise.resolve()
  old.abort()
  const staleWork = vi.fn(async () => {}), nextWork = vi.fn(async () => 'new result')
  const stale = schedule(skipped.signal, staleWork)
  const rejected = expect(stale).rejects.toMatchObject({ name: 'AbortError' })
  skipped.abort()
  const next = schedule(signal(), nextWork)
  expect(nextWork).not.toHaveBeenCalled()
  release(); await first; await rejected
  await expect(next).resolves.toBe('new result')
  expect(staleWork).not.toHaveBeenCalled()
})

it('waits for PDF.js deferred operator-stream cleanup without retrying other failures', async () => {
  const cleanup = vi.fn().mockRejectedValueOnce(new Error('startCleanup: Page 2 is currently rendering.')).mockResolvedValue(undefined)
  const doc = { cleanup } as unknown as PDFDocumentProxy
  await cleanupComparisonDocuments(doc, doc, signal())
  expect(cleanup).toHaveBeenCalledTimes(2)
  cleanup.mockReset().mockRejectedValue(new Error('worker failed'))
  await expect(cleanupComparisonDocuments(doc, null, signal())).rejects.toThrow('worker failed')
  expect(cleanup).toHaveBeenCalledOnce()
})

it('stops deferred document cleanup retries on cancellation', async () => {
  const cleanup = vi.fn().mockRejectedValue(new Error('startCleanup: Page 1 is currently rendering.'))
  const controller = new AbortController(), pending = cleanupComparisonDocuments({ cleanup } as unknown as PDFDocumentProxy, null, controller.signal)
  await Promise.resolve()
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(cleanup).toHaveBeenCalledOnce()
})
