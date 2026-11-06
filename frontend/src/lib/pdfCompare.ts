import type { PDFDocumentProxy } from './pdf'
import { pageText } from './pdfText'

export const COMPARE_LIMITS = {
  fileBytes: 100 * 1024 * 1024, pages: 1000, pixels: 2_000_000, side: 2400,
  totalPixels: 1_000_000_000, pageCharacters: 100_000, characters: 4_000_000,
  pageItems: 50_000, regions: 200,
} as const
export const COMPARE_RESOLUTIONS = [72, 96, 144] as const
export type CompareSettings = { dpi: (typeof COMPARE_RESOLUTIONS)[number]; tolerance: 'precise' | 'balanced' | 'relaxed' }
export const DEFAULT_COMPARE: CompareSettings = { dpi: 96, tolerance: 'balanced' }
const NOISE = { precise: { channel: 8, pixels: 1 }, balanced: { channel: 24, pixels: 4 }, relaxed: { channel: 48, pixels: 12 } }
export type Geometry = { width: number; height: number }
export type Region = { x: number; y: number; width: number; height: number }
export type TextChange = { removed: string; added: string }
export type ComparisonPage = {
  page: number; status: 'unchanged' | 'changed' | 'added' | 'removed'
  original: Geometry | null; revised: Geometry | null; geometryChanged: boolean
  regions: Region[]; groupedRegions: boolean; changedPixels: number; dpi: number
  textChanges: TextChange[]; coarseText: boolean; originalHasText: boolean; revisedHasText: boolean
  warnings: string[]
}
export type CompareProgress = { completed: number; total: number; phase: string }
export type Difference = { page: number; kind: 'region' | 'text' | 'geometry' | 'added' | 'removed'; region?: number }
type PdfPage = Awaited<ReturnType<PDFDocumentProxy['getPage']>>
type CanvasFactory = () => HTMLCanvasElement
const browserCanvas: CanvasFactory = () => document.createElement('canvas')
// Yield between pixel strips and pages so Cancel and replacement inputs stay responsive.
const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

export function pageGeometry(page: PdfPage): Geometry {
  // pdf.js applies CropBox, Rotate and UserUnit in the same way as its previews.
  const { width, height } = page.getViewport({ scale: 1 })
  if (![width, height].every((n) => Number.isFinite(n) && n > 0)) throw new Error('Invalid PDF page dimensions.')
  return { width, height }
}

export function pairSize(original: Geometry | null, revised: Geometry | null, dpi: number) {
  const width = Math.max(original?.width ?? 0, revised?.width ?? 0)
  const height = Math.max(original?.height ?? 0, revised?.height ?? 0)
  if (!(width > 0 && height > 0 && Number.isFinite(width * height))) throw new Error('Invalid PDF page dimensions.')
  // A shared scale and top-left origin preserve physical size differences. Never stretch a page.
  const scale = Math.min(dpi / 72, (COMPARE_LIMITS.side - 1) / width, (COMPARE_LIMITS.side - 1) / height,
    Math.sqrt(COMPARE_LIMITS.pixels / (width * height)) * 0.999)
  return { width: Math.ceil(width * scale), height: Math.ceil(height * scale), scale }
}

/** Used by both comparison and its on-demand preview. Only one page pair is rasterized at a time. */
export async function renderComparisonPage(page: PdfPage, canvas: HTMLCanvasElement, size: ReturnType<typeof pairSize>, signal: AbortSignal) {
  signal.throwIfAborted()
  canvas.width = size.width; canvas.height = size.height
  const task = page.render({ canvas, viewport: page.getViewport({ scale: size.scale }), background: '#ffffff' })
  const cancel = () => task.cancel()
  signal.addEventListener('abort', cancel, { once: true })
  try { await task.promise; signal.throwIfAborted() }
  finally { signal.removeEventListener('abort', cancel) }
}

/** Threshold RGB differences, then group adjacent occupied tiles into visible regions. */
export async function visualChanges(a: Uint8ClampedArray, b: Uint8ClampedArray, width: number, height: number,
  tolerance: CompareSettings['tolerance'], signal: AbortSignal) {
  if (width * height > COMPARE_LIMITS.pixels || a.length !== width * height * 4 || a.length !== b.length) throw new Error('Invalid comparison raster.')
  const tile = 12, columns = Math.ceil(width / tile), rows = Math.ceil(height / tile)
  const counts = new Uint32Array(columns * rows)
  const noise = NOISE[tolerance]
  for (let y = 0; y < height; y++) {
    if (y % 128 === 0) { await yieldToBrowser(); signal.throwIfAborted() }
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > noise.channel) {
        counts[Math.floor(y / tile) * columns + Math.floor(x / tile)]++
      }
    }
  }
  const regions: Region[] = []
  let changedPixels = 0
  for (let start = 0; start < counts.length; start++) {
    if (!counts[start]) continue
    const queue = [start]
    let pixels = counts[start], left = columns, top = rows, right = 0, bottom = 0
    counts[start] = 0
    for (let j = 0; j < queue.length; j++) {
      const cell = queue[j], x = cell % columns, y = Math.floor(cell / columns)
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, n = ny * columns + nx
        if (nx < 0 || ny < 0 || nx >= columns || ny >= rows || !counts[n]) continue
        pixels += counts[n]; counts[n] = 0; queue.push(n)
      }
    }
    if (pixels < noise.pixels) continue
    changedPixels += pixels
    regions.push({ x: left * tile, y: top * tile, width: Math.min(width, (right + 1) * tile) - left * tile, height: Math.min(height, (bottom + 1) * tile) - top * tile })
  }
  const groupedRegions = regions.length > COMPARE_LIMITS.regions
  if (groupedRegions) {
    const x = Math.min(...regions.map((r) => r.x)), y = Math.min(...regions.map((r) => r.y))
    const right = Math.max(...regions.map((r) => r.x + r.width)), bottom = Math.max(...regions.map((r) => r.y + r.height))
    regions.splice(0, regions.length, { x, y, width: right - x, height: bottom - y })
  }
  signal.throwIfAborted()
  return { regions, changedPixels, groupedRegions }
}

/** Literal words in extraction order, ignoring whitespace only; no semantic/page alignment. */
export function textChanges(original: string, revised: string): { changes: TextChange[]; coarse: boolean } {
  const words = (text: string) => text.normalize('NFC').trim().split(/\s+/u).filter(Boolean)
  const a = words(original), b = words(revised)
  let prefix = 0, endA = a.length, endB = b.length
  while (prefix < endA && prefix < endB && a[prefix] === b[prefix]) prefix++
  while (endA > prefix && endB > prefix && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const left = a.slice(prefix, endA), right = b.slice(prefix, endB)
  if (!left.length && !right.length) return { changes: [], coarse: false }
  const fallback = () => ({ changes: [{ removed: left.join(' '), added: right.join(' ') }], coarse: true })
  // Bound quadratic work. Long replacements still display their exact text as one block.
  if (left.length > 1500 || right.length > 1500 || left.length * right.length > 1_000_000) return fallback()
  const stride = right.length + 1, matrix = new Uint16Array((left.length + 1) * stride)
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
    matrix[i * stride + j] = left[i] === right[j] ? 1 + matrix[(i + 1) * stride + j + 1] : Math.max(matrix[(i + 1) * stride + j], matrix[i * stride + j + 1])
  }
  const changes: TextChange[] = []
  let i = 0, j = 0, removed: string[] = [], added: string[] = []
  const flush = () => { if (removed.length || added.length) changes.push({ removed: removed.join(' '), added: added.join(' ') }); removed = []; added = [] }
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) { flush(); i++; j++ }
    else if (i < left.length && (j === right.length || matrix[(i + 1) * stride + j] >= matrix[i * stride + j + 1])) removed.push(left[i++])
    else added.push(right[j++])
  }
  flush()
  return changes.length > 200 ? fallback() : { changes, coarse: false }
}

async function extract(page: PdfPage | null, number: number, signal: AbortSignal): Promise<{ text: string; warning?: string }> {
  if (!page) return { text: '' }
  try {
    const content = await page.getTextContent({ includeMarkedContent: false })
    signal.throwIfAborted()
    if (content.items.length > COMPARE_LIMITS.pageItems) return { text: '', warning: 'Too many text items; visual comparison only.' }
    let characters = 0
    for (const item of content.items) {
      if ('str' in item) characters += item.str.length
      if (characters > COMPARE_LIMITS.pageCharacters) return { text: '', warning: 'Too much page text; visual comparison only.' }
    }
    const text = pageText(content, number).text
    if (text.length > COMPARE_LIMITS.pageCharacters) return { text: '', warning: 'Too much page text; visual comparison only.' }
    return { text }
  } catch {
    signal.throwIfAborted()
    return { text: '', warning: 'Text extraction failed; visual comparison only.' }
  }
}

export async function comparePdfs(original: PDFDocumentProxy, revised: PDFDocumentProxy, settings: CompareSettings, options: {
  signal: AbortSignal; onProgress?: (progress: CompareProgress) => void; createCanvas?: CanvasFactory
}): Promise<ComparisonPage[]> {
  const { signal, onProgress, createCanvas = browserCanvas } = options
  const total = Math.max(original.numPages, revised.numPages)
  if (!COMPARE_RESOLUTIONS.includes(settings.dpi) || !Object.hasOwn(NOISE, settings.tolerance)) throw new Error('Invalid comparison settings.')
  if (total > COMPARE_LIMITS.pages) throw new Error(`Compare up to ${COMPARE_LIMITS.pages} pages at once. Split larger PDFs first.`)
  const pages: ComparisonPage[] = []
  let pixels = 0, characters = 0
  for (let number = 1; number <= total; number++) {
    signal.throwIfAborted()
    onProgress?.({ completed: number - 1, total, phase: `Rendering page pair ${number}` })
    let a: PdfPage | null = null, b: PdfPage | null = null
    let ca: HTMLCanvasElement | null = null, cb: HTMLCanvasElement | null = null
    try {
      a = number <= original.numPages ? await original.getPage(number) : null
      signal.throwIfAborted()
      b = number <= revised.numPages ? await revised.getPage(number) : null
      signal.throwIfAborted()
      const ga = a && pageGeometry(a), gb = b && pageGeometry(b), size = pairSize(ga, gb, settings.dpi)
      pixels += size.width * size.height
      if (pixels > COMPARE_LIMITS.totalPixels) throw new Error('Comparison pixel budget exceeded. Choose 72 DPI or split the PDFs.')
      let visual = { regions: [] as Region[], changedPixels: 0, groupedRegions: false }
      if (a && b) {
        ca = createCanvas(); cb = createCanvas()
        await renderComparisonPage(a, ca, size, signal)
        await renderComparisonPage(b, cb, size, signal)
        onProgress?.({ completed: number - 1, total, phase: `Comparing page pair ${number}` })
        const ac = ca.getContext('2d'), bc = cb.getContext('2d')
        if (!ac || !bc) throw new Error('Could not read the page preview.')
        visual = await visualChanges(ac.getImageData(0, 0, size.width, size.height).data, bc.getImageData(0, 0, size.width, size.height).data, size.width, size.height, settings.tolerance, signal)
      }
      // Drop the rasters before text extraction and before loading the next page pair.
      if (ca) { ca.width = 0; ca.height = 0 }
      if (cb) { cb.width = 0; cb.height = 0 }
      const ta = await extract(a, number, signal), tb = await extract(b, number, signal)
      signal.throwIfAborted()
      characters += ta.text.length + tb.text.length
      if (characters > COMPARE_LIMITS.characters) throw new Error('Comparison text budget exceeded. Split the PDFs into smaller documents.')
      const text = ta.warning || tb.warning ? { changes: [], coarse: false } : textChanges(ta.text, tb.text)
      const geometryChanged = !!ga && !!gb && (Math.abs(ga.width - gb.width) > 0.1 || Math.abs(ga.height - gb.height) > 0.1)
      const status = !a ? 'added' : !b ? 'removed' : geometryChanged || visual.regions.length || text.changes.length ? 'changed' : 'unchanged'
      pages.push({ page: number, status, original: ga, revised: gb, geometryChanged,
        ...visual, regions: visual.regions.map((r) => ({ x: r.x / size.scale, y: r.y / size.scale, width: r.width / size.scale, height: r.height / size.scale })),
        dpi: size.scale * 72, textChanges: text.changes, coarseText: text.coarse,
        originalHasText: !!ta.text.trim(), revisedHasText: !!tb.text.trim(),
        warnings: [ta.warning && `Original: ${ta.warning}`, tb.warning && `Revised: ${tb.warning}`].filter((s): s is string => !!s) })
      onProgress?.({ completed: number, total, phase: `Compared page pair ${number}` })
    } catch (reason) {
      signal.throwIfAborted()
      throw new Error(`Page pair ${number}: ${(reason as Error).message}`)
    } finally {
      if (ca) { ca.width = 0; ca.height = 0 }
      if (cb) { cb.width = 0; cb.height = 0 }
      a?.cleanup(); b?.cleanup()
    }
    await yieldToBrowser()
  }
  signal.throwIfAborted()
  return pages
}

export function differences(pages: ComparisonPage[]): Difference[] {
  return pages.flatMap((page): Difference[] => {
    if (page.status === 'added' || page.status === 'removed') return [{ page: page.page, kind: page.status }]
    const found: Difference[] = page.regions.map((_, region) => ({ page: page.page, kind: 'region', region }))
    if (page.geometryChanged) found.push({ page: page.page, kind: 'geometry' })
    if (page.textChanges.length) found.push({ page: page.page, kind: 'text' })
    return found
  })
}

export function comparisonReport(original: string, revised: string, settings: CompareSettings, pages: ComparisonPage[]): string {
  return [`PDF comparison: ${original} → ${revised}`, `Pages paired by number; ${settings.dpi} DPI requested, ${settings.tolerance} noise tolerance.`,
    'Local visual and literal extracted-text comparison. No page alignment, OCR or semantic interpretation. Whitespace differences ignored.',
    ...pages.flatMap((p) => [`\nPage ${p.page}: ${p.status}${p.warnings.length ? ' (text incomplete)' : ''}`, `Visual regions: ${p.regions.length}; effective DPI: ${p.dpi.toFixed(1)}`,
      ...(p.geometryChanged ? [`Visible page size: ${p.original!.width.toFixed(1)} × ${p.original!.height.toFixed(1)} pt → ${p.revised!.width.toFixed(1)} × ${p.revised!.height.toFixed(1)} pt`] : []),
      ...p.warnings, ...(p.coarseText ? ['Long text replacement grouped into one block.'] : []),
      ...p.textChanges.flatMap((c) => [c.removed && `Removed: ${c.removed}`, c.added && `Added: ${c.added}`].filter(Boolean))])].join('\n') + '\n'
}
