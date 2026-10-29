import { rebuildRedactedPdf } from './api'
import type { PdfSize, Redaction } from './documentTools'
import type { PDFDocumentProxy } from './pdf'

export const REDACTION_DPI = [72, 150, 300] as const
export type RedactionProgress = { completed: number; total: number; phase: 'render' | 'build' }

export function redactionProblem(areas: readonly Redaction[], sizes: readonly PdfSize[]): string | null {
  if (!areas.length) return 'Mark at least one area to redact.'
  if (areas.length > 2000) return 'Use at most 2000 redaction areas.'
  for (const [index, area] of areas.entries()) {
    const size = sizes[area.page - 1]
    if (!Number.isInteger(area.page) || !size || ![area.x, area.y, area.width, area.height].every(Number.isFinite) || area.x < 0 || area.y < 0 || area.width < 1 || area.height < 1 || area.x + area.width > size.width + 0.001 || area.y + area.height > size.height + 0.001) return `Area ${index + 1} must stay inside its page and be at least 1 point wide and high.`
  }
  return null
}

/** Rendering all pages and rebuilding from pixels removes all original PDF object data. */
export async function renderRedactedPdf(doc: PDFDocumentProxy, source: File, areas: readonly Redaction[], sizes: readonly PdfSize[], dpi: number, signal: AbortSignal, onProgress?: (progress: RedactionProgress) => void): Promise<File> {
  const problem = redactionProblem(areas, sizes)
  if (problem) throw new Error(problem)
  if (!(REDACTION_DPI as readonly number[]).includes(dpi)) throw new Error('Choose 72, 150 or 300 DPI.')
  if (sizes.length !== doc.numPages || doc.numPages > 1000) throw new Error('Split documents longer than 1000 pages before redacting.')
  signal.throwIfAborted()
  const images: File[] = []
  let bytes = 0, totalPixels = 0
  for (let number = 1; number <= doc.numPages; number++) {
    signal.throwIfAborted()
    onProgress?.({ completed: number - 1, total: doc.numPages, phase: 'render' })
    signal.throwIfAborted()
    const page = await doc.getPage(number)
    signal.throwIfAborted()
    const viewport = page.getViewport({ scale: dpi / 72 })
    const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height)
    totalPixels += width * height
    if (!Number.isFinite(totalPixels) || width <= 0 || height <= 0 || width > 16_384 || height > 16_384 || width * height > 32_000_000 || totalPixels > 250_000_000) throw new Error(`Page ${number} is too large at this resolution. Choose a lower DPI or split the PDF first.`)
    const canvas = document.createElement('canvas')
    canvas.width = width; canvas.height = height
    let cancel: (() => void) | undefined
    try {
      const task = page.render({ canvas, viewport, background: '#ffffff' })
      cancel = () => task.cancel()
      signal.addEventListener('abort', cancel, { once: true })
      await task.promise
      signal.throwIfAborted()
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Could not draw the redaction masks.')
      context.save(); context.setTransform(1, 0, 0, 1, 0, 0)
      context.globalAlpha = 1; context.globalCompositeOperation = 'source-over'; context.fillStyle = '#000000'
      for (const area of areas.filter((entry) => entry.page === number)) {
        const left = Math.floor(area.x * dpi / 72), top = Math.floor(area.y * dpi / 72)
        const right = Math.ceil((area.x + area.width) * dpi / 72), bottom = Math.ceil((area.y + area.height) * dpi / 72)
        context.fillRect(left, top, right - left, bottom - top)
      }
      context.restore()
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((image) => image ? resolve(image) : reject(new Error('Could not encode a redacted page.')), 'image/png'))
      signal.throwIfAborted()
      bytes += blob.size
      if (blob.size > 64 * 1024 * 1024 || bytes > 256 * 1024 * 1024) throw new Error('The rendered document is too large. Use a lower DPI or split the PDF first.')
      images.push(new File([blob], `page-${number}.png`, { type: 'image/png' }))
    } finally {
      if (cancel) signal.removeEventListener('abort', cancel)
      canvas.width = 0; canvas.height = 0
    }
  }
  signal.throwIfAborted()
  onProgress?.({ completed: doc.numPages, total: doc.numPages, phase: 'build' })
  signal.throwIfAborted()
  return rebuildRedactedPdf(source, images, [...sizes], signal)
}
