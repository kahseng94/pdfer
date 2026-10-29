import { assembleOcr, recognizePage, type OcrEngine } from './api'
import type { PDFDocumentProxy } from './pdf'
import { pagesIn, parseSpec } from './ranges'

export const OCR_DPI = [150, 300] as const
export type OcrProgress = {
  completed: number; total: number; page: number; skipped: number; recognized: number
  phase: 'inspect' | 'render' | 'recognize' | 'assemble'
}

export function ocrPages(spec: string, total: number): number[] {
  if (!Number.isInteger(total) || total < 1 || total > 1000) throw new Error('Choose a PDF with 1–1000 pages, or split it first.')
  const parsed = parseSpec(spec.trim() || `1-${total}`, total)
  if (parsed.invalid.length || !parsed.ranges.length) throw new Error('Enter pages such as 1-3, 5, 8- within this PDF.')
  return [...pagesIn(parsed.ranges)].sort((a, b) => a - b)
}

/** Render only text-free selected pages; add invisible text to the original PDF. */
export async function recognizePdf(doc: PDFDocumentProxy, source: File, spec: string, languages: readonly string[], dpi: number,
  signal: AbortSignal, onProgress: (value: OcrProgress) => void, engine: OcrEngine = 'tesseract'): Promise<File> {
  const selected = ocrPages(spec, doc.numPages)
  if (source.size > 128 * 1024 * 1024) throw new Error('Choose a PDF under 128 MB, or split it first.')
  if (!languages.length || languages.length > 8) throw new Error('Choose between one and eight OCR languages.')
  if (engine === 'paddleocr' && (languages.length !== 1 || languages[0] !== 'auto')) throw new Error('PaddleOCR uses automatic multilingual recognition.')
  if (!(OCR_DPI as readonly number[]).includes(dpi)) throw new Error('Choose 150 or 300 DPI.')
  const layers: File[] = []
  const pages: number[] = []
  let skipped = 0, bytes = 0
  for (const [index, number] of selected.entries()) {
    signal.throwIfAborted()
    const progress = (phase: OcrProgress['phase']) => onProgress({ completed: index, total: selected.length, page: number, skipped, recognized: layers.length, phase })
    progress('inspect')
    const page = await doc.getPage(number)
    signal.throwIfAborted()
    const text = await page.getTextContent()
    signal.throwIfAborted()
    if (text.items.some((item) => 'str' in item && item.str.trim())) { skipped++; continue }
    const viewport = page.getViewport({ scale: dpi / 72 })
    const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height)
    if (!Number.isFinite(width * height) || width <= 0 || height <= 0 || width > 16_384 || height > 16_384 || width * height > 32_000_000) {
      throw new Error(`Page ${number} is too large at ${dpi} DPI. Try 150 DPI or resize the page first.`)
    }
    const canvas = document.createElement('canvas')
    canvas.width = width; canvas.height = height
    let cancel: (() => void) | undefined
    try {
      progress('render')
      const rendering = page.render({ canvas, viewport, background: '#ffffff' })
      cancel = () => rendering.cancel()
      signal.addEventListener('abort', cancel, { once: true })
      await rendering.promise
      signal.throwIfAborted()
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((image) => image ? resolve(image) : reject(new Error('Could not render this page for OCR.')), 'image/png'))
      signal.throwIfAborted()
      if (blob.size > 32 * 1024 * 1024) throw new Error('The rendered page is too large. Try 150 DPI.')
      // Free the full-resolution raster before waiting on the native OCR engine.
      canvas.width = 0; canvas.height = 0
      progress('recognize')
      const layer = await recognizePage(blob, languages, dpi, signal, engine)
      signal.throwIfAborted()
      bytes += layer.size
      if (layer.size > 8 * 1024 * 1024 || bytes > 64 * 1024 * 1024) throw new Error('The OCR text is too large. Split the document first.')
      layers.push(layer); pages.push(number)
    } catch (reason) {
      signal.throwIfAborted()
      throw new Error(`Page ${number}: ${(reason as Error).message}`)
    } finally {
      if (cancel) signal.removeEventListener('abort', cancel)
      canvas.width = 0; canvas.height = 0
    }
  }
  signal.throwIfAborted()
  if (!layers.length) throw new Error('All selected pages already contain text. Open this PDF in Search & text, or choose other pages.')
  onProgress({ completed: selected.length, total: selected.length, page: selected.at(-1)!, skipped, recognized: layers.length, phase: 'assemble' })
  const output = await assembleOcr(source, layers, pages, signal)
  signal.throwIfAborted()
  return output
}
