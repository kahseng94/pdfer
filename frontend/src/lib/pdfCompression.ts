import { Zip, ZipPassThrough } from 'fflate'
import { compressPdf, type CompressLevel } from './api'
import { validatePdfTarget } from './pdfTarget'

export type PdfCompressionResult = { name: string; before: number; after: number; target?: number; targetMet?: boolean }
export type PdfCompressionProgress = {
  completed: number
  total: number
  current: string
  results: readonly PdfCompressionResult[]
}
export type PdfCompressionBatch = { file: File; results: PdfCompressionResult[]; outputs: File[] }

export class PdfCompressionError extends Error {
  readonly index: number
  constructor(index: number, filename: string, error: unknown) {
    super(`Could not compress ${filename}: ${error instanceof Error ? error.message : 'Something went wrong.'}`)
    this.index = index
  }
}

/** A flat, portable ZIP filename, unique even on case-insensitive filesystems. */
export function uniquePdfName(filename: string, used: Set<string>): string {
  // oxlint-disable-next-line no-control-regex -- ZIP filenames must not contain paths or control characters.
  const cleaned = filename.normalize('NFC').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').trim().replace(/^\.+|[. ]+$/g, '')
  // Leave room for the extension and collision suffix within filesystem limits.
  const encoder = new TextEncoder()
  let stem = ''
  let size = 0
  for (const character of cleaned) {
    size += encoder.encode(character).length
    if (size > 180) break
    stem += character
  }
  stem ||= 'document_compressed'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `_${stem}`
  let candidate = `${stem}.pdf`
  let suffix = 2
  while (used.has(candidate.normalize('NFC').toLowerCase())) candidate = `${stem} (${suffix++}).pdf`
  used.add(candidate.normalize('NFC').toLowerCase())
  return candidate
}

/**
 * Compress sequentially for bounded server load and real per-file progress.
 * One input returns its PDF; several return a ZIP. No partial archive escapes
 * if a file fails, the inputs change, or the caller cancels.
 */
export async function compressPdfBatch(
  files: readonly File[],
  level: CompressLevel,
  signal: AbortSignal,
  onProgress?: (progress: PdfCompressionProgress) => void,
  maxBytes?: number,
): Promise<PdfCompressionBatch> {
  if (!files.length) throw new Error('Choose at least one PDF to compress.')
  if (files.length > 65_535) throw new Error('Choose fewer PDFs for one ZIP.')
  signal.throwIfAborted()
  if (maxBytes !== undefined) validatePdfTarget(maxBytes)
  const chunks: BlobPart[] = []
  const results: PdfCompressionResult[] = []
  const outputs: File[] = []
  const used = new Set<string>()
  let single: File | null = null
  let size = 0
  let zipError: Error | null = null
  const zip = files.length > 1 ? new Zip((error, data) => {
    if (error) zipError = error
    else if (!zipError) {
      size += data.byteLength
      if (size > 512 * 1024 * 1024) zipError = new Error('This ZIP is too large. Compress fewer PDFs in this batch.')
      else chunks.push(new Uint8Array(data))
    }
  }) : null

  try {
    for (const [index, source] of files.entries()) {
      signal.throwIfAborted()
      onProgress?.({ completed: index, total: files.length, current: source.name, results: [...results] })
      signal.throwIfAborted()
      let output: File
      try {
        output = (await (maxBytes === undefined ? compressPdf(source, level, signal) : compressPdf(source, level, signal, maxBytes))).file
      } catch (error) {
        signal.throwIfAborted()
        throw new PdfCompressionError(index, source.name, error)
      }
      signal.throwIfAborted()
      const name = zip ? uniquePdfName(output.name, used) : output.name
      if (zip) {
        if (size + output.size > 512 * 1024 * 1024) throw new Error('This ZIP is too large. Compress fewer PDFs in this batch.')
        const bytes = new Uint8Array(await output.arrayBuffer())
        signal.throwIfAborted()
        const entry = new ZipPassThrough(name)
        zip.add(entry)
        // PDFs already contain compressed streams; store their exact bytes.
        entry.push(bytes, true)
        if (zipError) throw zipError
      } else single = output
      outputs.push(output)
      results.push({ name, before: source.size, after: output.size,
        ...(maxBytes === undefined ? {} : { target: maxBytes, targetMet: output.size <= maxBytes }),
      })
      onProgress?.({ completed: index + 1, total: files.length, current: source.name, results: [...results] })
    }
    signal.throwIfAborted()
    if (single) return { file: single, results, outputs }
    zip!.end()
    if (zipError) throw zipError
    return { file: new File(chunks, 'pdfs_compressed.zip', { type: 'application/zip' }), results, outputs }
  } finally {
    zip?.terminate()
  }
}
