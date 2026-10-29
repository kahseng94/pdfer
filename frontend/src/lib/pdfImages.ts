import { Zip, ZipPassThrough } from 'fflate'
import { withImageDpi } from './imageDpi'
import type { PDFDocumentProxy } from './pdf'
import { pagesIn, parseSpec } from './ranges'

export type PdfImageFormat = 'png' | 'jpeg'
export const IMAGE_RESOLUTIONS = [72, 150, 300] as const
export type ImageResolution = (typeof IMAGE_RESOLUTIONS)[number]
export type ExportProgress = { completed: number; total: number; page: number }

// Render one page at a time and reject allocations likely to exhaust a tab.
const MAX_PIXELS = 32_000_000
const MAX_SIDE = 16_384
const MAX_ZIP_BYTES = 512 * 1024 * 1024

/** Each selected page once, in document order, regardless of overlapping ranges. */
export function exportPages(spec: string, total: number): number[] {
  const { ranges, invalid } = parseSpec(spec, total)
  if (invalid.length) throw new Error(`Not valid for this ${total}-page file: ${invalid.join(', ')}`)
  const pages = [...pagesIn(ranges)].sort((a, b) => a - b)
  if (!pages.length) throw new Error('Choose at least one page to export.')
  if (pages.length > 65_535) throw new Error('Choose fewer pages for one ZIP.')
  return pages
}

function stem(name: string): string {
  // oxlint-disable-next-line no-control-regex -- Keep control characters out of ZIP filenames.
  return name.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').trim().replace(/^\.+|\.+$/g, '') || 'document'
}

export function pageImageName(name: string, page: number, total: number, format: PdfImageFormat): string {
  return `${stem(name)}_page-${String(page).padStart(String(total).length, '0')}.${format === 'jpeg' ? 'jpg' : 'png'}`
}

function encode(canvas: HTMLCanvasElement, format: PdfImageFormat): Promise<Blob> {
  const type = `image/${format}`
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob?.type === type) resolve(blob)
      else reject(new Error('Could not encode the image. Try a lower resolution.'))
    }, type, format === 'jpeg' ? 0.92 : undefined)
  })
}

/** Render selected pages locally and collect their encoded images in a stored ZIP. */
export async function pdfToImages(
  doc: PDFDocumentProxy,
  options: {
    name: string
    spec: string
    format: PdfImageFormat
    dpi: ImageResolution
    signal: AbortSignal
    onProgress?: (progress: ExportProgress) => void
  },
): Promise<File> {
  const { name, spec, format, dpi, signal, onProgress } = options
  if (!IMAGE_RESOLUTIONS.includes(dpi)) throw new Error('Choose 72, 150 or 300 DPI.')
  const pages = exportPages(spec, doc.numPages)
  signal.throwIfAborted()
  const chunks: BlobPart[] = []
  let zipError: Error | null = null
  let size = 0
  const zip = new Zip((error, data) => {
    if (error) zipError = error
    else if (!zipError) {
      size += data.byteLength
      if (size > MAX_ZIP_BYTES) zipError = new Error('This ZIP is too large. Export fewer pages or choose a lower resolution.')
      else chunks.push(new Uint8Array(data))
    }
  })

  try {
    for (const [index, number] of pages.entries()) {
      signal.throwIfAborted()
      onProgress?.({ completed: index, total: pages.length, page: number })
      const page = await doc.getPage(number)
      signal.throwIfAborted()
      const viewport = page.getViewport({ scale: dpi / 72 })
      const width = Math.round(viewport.width)
      const height = Math.round(viewport.height)
      if (!Number.isFinite(width * height) || width <= 0 || height <= 0 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
        throw new Error(`Page ${number} is too large at ${dpi} DPI. Choose a lower resolution.`)
      }

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      let cancel: (() => void) | undefined
      try {
        // Use white for both formats, including PDFs with a transparent background.
        const task = page.render({ canvas, viewport, background: '#ffffff' })
        cancel = () => task.cancel()
        signal.addEventListener('abort', cancel, { once: true })
        await task.promise
        signal.throwIfAborted()
        const blob = await encode(canvas, format)
        signal.throwIfAborted()
        const bytes = withImageDpi(new Uint8Array(await blob.arrayBuffer()), format, dpi)
        signal.throwIfAborted()
        // PNG and JPEG are already compressed. Store each image as it finishes.
        const entry = new ZipPassThrough(pageImageName(name, number, doc.numPages, format))
        zip.add(entry)
        entry.push(bytes, true)
        if (zipError) throw zipError
        onProgress?.({ completed: index + 1, total: pages.length, page: number })
      } finally {
        if (cancel) signal.removeEventListener('abort', cancel)
        canvas.width = 0
        canvas.height = 0
      }
    }
    signal.throwIfAborted()
    zip.end()
    if (zipError) throw zipError
    return new File(chunks, `${stem(name)}_images.zip`, { type: 'application/zip' })
  } finally {
    zip.terminate()
  }
}
