import type { EditPayload } from './edits'
import type { Crop, Paper, Size } from './photo'
import { toPageSpec, type PageOp } from './ranges'
import { pdfPassword, rememberPdfPassword } from './passwords'
import type { StampSettings } from './stamps'
import { effectiveImageLayout, type ImagePdfLayout } from './imageLayout'
import type { PageLayout } from './organize'
import type { BookmarkEntry, BookmarkSchema, FormSchema, FormValue, PdfSize } from './documentTools'
import type { FieldSpec } from './formBuilder'
import type { MetadataChanges, MetadataSchema } from './metadata'
import { validatePdfTarget } from './pdfTarget'
import type { OfficeKind, OfficeStatus } from './office'
import type { SheetView } from './sheetView'
import { parseSummary, type CsvDelimiter, type CsvSummary, type WorkbookSheets, type WorkbookSummary } from './spreadsheets'
import { parsePhotoResults, type PhotoEdit, type PhotoInfo, type PhotoResult } from './photoEdits'

export type SplitMode = 'ranges' | 'each' | 'extract'

/** Upload a form and resolve to the file the backend sends back and the response headers. */
async function upload(path: string, body: FormData, fallbackName: string, signal?: AbortSignal): Promise<{ file: File; headers: Headers }> {
  let res: Response
  try {
    res = await fetch(path, { method: 'POST', body, signal })
  } catch {
    signal?.throwIfAborted()
    throw new Error("Can't reach the pdfer backend. Is it running?")
  }

  if (!res.ok) {
    const detail = await res
      .json()
      .then((j: { detail?: unknown }) => (typeof j.detail === 'string' ? j.detail : null))
      .catch(() => null)
    throw new Error(detail ?? `Something went wrong (HTTP ${res.status}).`)
  }

  const filename = filenameFrom(res.headers.get('content-disposition')) ?? fallbackName
  const blob = await res.blob()
  return { file: new File([blob], filename, { type: blob.type }), headers: res.headers }
}

async function post(path: string, body: FormData, fallbackName: string, password = '', signal?: AbortSignal): Promise<File> {
  const { file } = await upload(path, body, fallbackName, signal)
  if (file.type === 'application/pdf') rememberPdfPassword(file, password)
  return file
}

function pdfBody(file: File): FormData {
  const body = new FormData()
  body.append('file', file)
  const password = pdfPassword(file)
  if (password) body.append('password', password)
  return body
}

async function inspectPdf<T>(path: string, file: File, signal?: AbortSignal): Promise<T> {
  let response: Response
  try { response = await fetch(path, { method: 'POST', body: pdfBody(file), signal }) }
  catch { signal?.throwIfAborted(); throw new Error("Can't reach the pdfer backend. Is it running?") }
  if (!response.ok) {
    const value = await response.json().catch(() => null) as { detail?: string } | null
    throw new Error(typeof value?.detail === 'string' ? value.detail : `Could not read PDF information (HTTP ${response.status}).`)
  }
  return response.json() as Promise<T>
}
export const readForms = (file: File, signal?: AbortSignal) => inspectPdf<FormSchema>('/api/forms/read', file, signal)
export const readBookmarks = (file: File, signal?: AbortSignal) => inspectPdf<BookmarkSchema>('/api/bookmarks/read', file, signal)
export const readMetadata = (file: File, signal?: AbortSignal) => inspectPdf<MetadataSchema>('/api/metadata/read', file, signal)
export function writeMetadata(file: File, changes: MetadataChanges, clear: boolean, signal?: AbortSignal): Promise<File> {
  const body = pdfBody(file)
  body.append('changes', JSON.stringify(changes)); body.append('clear', String(clear))
  return post('/api/metadata', body, 'metadata.pdf', pdfPassword(file), signal)
}
export function fillForms(file: File, values: Record<string, FormValue>, flatten: boolean, signal?: AbortSignal): Promise<File> {
  const body = pdfBody(file)
  body.append('values', JSON.stringify(values)); body.append('flatten', String(flatten))
  return post('/api/forms/fill', body, 'filled.pdf', pdfPassword(file), signal)
}
/** Add `fields` and remove the existing fields whose IDs (as `readForms` reports them) are in `remove`. */
export function createFormFields(file: File, fields: readonly FieldSpec[], signal?: AbortSignal, remove: readonly string[] = []): Promise<File> {
  const body = pdfBody(file); body.append('fields', JSON.stringify(fields))
  if (remove.length) body.append('remove', JSON.stringify(remove))
  return post('/api/forms/create', body, 'form.pdf', pdfPassword(file), signal)
}
export function writeBookmarks(file: File, entries: readonly BookmarkEntry[], signal?: AbortSignal): Promise<File> {
  const body = pdfBody(file); body.append('entries', JSON.stringify(entries))
  return post('/api/bookmarks', body, 'bookmarks.pdf', pdfPassword(file), signal)
}
export async function rebuildRedactedPdf(source: File, pages: File[], sizes: PdfSize[], signal?: AbortSignal): Promise<File> {
  const body = new FormData()
  for (const page of pages) body.append('pages', page)
  body.append('sizes', JSON.stringify(sizes))
  const password = pdfPassword(source)
  if (password) body.append('password', password)
  const output = await post('/api/redact', body, 'redacted.pdf', password, signal)
  const file = new File([output], `${source.name.replace(/\.pdf$/i, '')}_redacted.pdf`, { type: 'application/pdf' })
  rememberPdfPassword(file, password)
  return file
}

export type OcrEngine = 'tesseract' | 'paddleocr'
export type OcrStatus = { available: boolean; languages: string[]; can_rotate: boolean; message: string | null }
export type OcrPage = { file: File; rotation: number }

export async function readOcrStatus(signal?: AbortSignal, engine: OcrEngine = 'tesseract'): Promise<OcrStatus> {
  let response: Response
  try { response = await fetch(engine === 'tesseract' ? '/api/ocr/status' : '/api/ocr/status?engine=paddleocr', { signal, cache: 'no-store' }) }
  catch { signal?.throwIfAborted(); throw new Error("Can't reach the pdfer backend. Is it running?") }
  if (!response.ok) throw new Error(`Could not check the OCR engine (HTTP ${response.status}).`)
  return response.json() as Promise<OcrStatus>
}

export async function recognizePage(image: Blob, languages: readonly string[], dpi: number, signal: AbortSignal, rotate = false, engine: OcrEngine = 'tesseract'): Promise<OcrPage> {
  const body = new FormData()
  body.append('image', image, 'page.png')
  body.append('languages', languages.join('+'))
  body.append('dpi', String(dpi))
  body.append('rotate', String(rotate))
  body.append('engine', engine)
  const { file, headers } = await upload('/api/ocr/page', body, 'text.pdf', signal)
  const rotation = Number(headers.get('X-OCR-Rotation') ?? '0')
  if (![0, 90, 180, 270].includes(rotation) || (!rotate && rotation !== 0)) throw new Error('OCR returned an invalid page rotation.')
  return { file, rotation }
}

export function assembleOcr(file: File, layers: readonly File[], pages: readonly number[], signal: AbortSignal, rotations?: readonly number[]): Promise<File> {
  const body = pdfBody(file)
  for (const layer of layers) body.append('layers', layer)
  body.append('pages', JSON.stringify(pages))
  if (rotations) body.append('rotations', JSON.stringify(rotations))
  return post('/api/ocr/assemble', body, 'searchable.pdf', pdfPassword(file), signal)
}

export function mergePdfs(files: File[]): Promise<File> {
  const body = new FormData()
  for (const f of files) body.append('files', f)
  const passwords = files.map(pdfPassword)
  const outputPassword = passwords.find(Boolean) ?? ''
  if (outputPassword) body.append('passwords', JSON.stringify(passwords))
  return post('/api/merge', body, 'merged.pdf', outputPassword)
}

export function splitPdf(file: File, mode: SplitMode, ranges: string): Promise<File> {
  const body = pdfBody(file)
  body.append('mode', mode)
  body.append('ranges', ranges)
  return post('/api/split', body, 'split.pdf', pdfPassword(file))
}

export function protectPdf(file: File, newPassword: string, signal?: AbortSignal): Promise<File> {
  const body = pdfBody(file)
  body.append('new_password', newPassword)
  return post('/api/protect', body, 'protected.pdf', newPassword, signal)
}

export function unlockPdf(file: File): Promise<File> {
  return post('/api/unlock', pdfBody(file), 'unlocked.pdf')
}

/** Generate the exact PDF shown in the stamp preview and later downloaded. */
export function stampPdf(file: File, settings: StampSettings, signal?: AbortSignal): Promise<File> {
  const body = pdfBody(file)
  body.append('settings', JSON.stringify(settings))
  return post('/api/stamp', body, 'stamped.pdf', pdfPassword(file), signal)
}

export function filenameFrom(disposition: string | null): string | null {
  if (!disposition) return null
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
  if (encoded) return decodeURIComponent(encoded[1])
  return /filename="([^"]+)"/i.exec(disposition)?.[1] ?? null
}

/** Have the browser download the file under its own name. */
export function saveFile(file: File) {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function organizePdf(file: File, pages: readonly PageOp[], layout?: PageLayout, signal?: AbortSignal): Promise<File> {
  const body = pdfBody(file)
  body.append('pages', toPageSpec(pages))
  if (layout) body.append('layout', JSON.stringify(layout))
  return post('/api/organize', body, 'organized.pdf', pdfPassword(file), signal)
}

/** `images` are the files the image edits refer to by index. */
export function editPdf(file: File, edits: EditPayload[], images: File[], signal?: AbortSignal): Promise<File> {
  const body = pdfBody(file)
  body.append('edits', JSON.stringify(edits))
  for (const img of images) body.append('images', img)
  return post('/api/edit', body, 'edited.pdf', pdfPassword(file), signal)
}

export async function signPdf(file: File, edits: EditPayload[], images: File[], signal?: AbortSignal): Promise<File> {
  const edited = await editPdf(file, edits, images, signal)
  const result = new File([edited], `${file.name.replace(/\.pdf$/i, '')}_signed.pdf`, { type: 'application/pdf' })
  rememberPdfPassword(result, pdfPassword(file))
  return result
}

export async function readOfficeStatus(signal?: AbortSignal): Promise<OfficeStatus> {
  let response: Response
  try { response = await fetch('/api/office/status', { signal, cache: 'no-store' }) }
  catch { signal?.throwIfAborted(); throw new Error("Can't reach the pdfer backend. Is it running?") }
  if (!response.ok) throw new Error(`Could not check LibreOffice (HTTP ${response.status}).`)
  return response.json() as Promise<OfficeStatus>
}

export function officeToPdf(file: File, kind: OfficeKind, signal?: AbortSignal): Promise<File> {
  const body = new FormData()
  body.append('file', file)
  body.append('kind', kind)
  return post('/api/office', body, `${file.name.replace(/\.[^.]+$/, '')}.pdf`, '', signal)
}

export function imagesToPdf(files: File[], layout?: ImagePdfLayout, signal?: AbortSignal): Promise<File> {
  const body = new FormData()
  for (const f of files) body.append('files', f)
  if (layout) {
    const settings = effectiveImageLayout(layout)
    body.append('paper', settings.paper)
    body.append('orientation', settings.orientation)
    body.append('margin_mm', String(settings.marginMm))
    body.append('fit', settings.fit)
  }
  return post('/api/images', body, 'images.pdf', '', signal)
}

/** Post a form and read the JSON answer, turning a backend error into its message. */
async function postForJson<T>(path: string, body: FormData, failure: string, signal?: AbortSignal): Promise<T> {
  let response: Response
  try { response = await fetch(path, { method: 'POST', body, signal }) }
  catch { signal?.throwIfAborted(); throw new Error("Can't reach the pdfer backend. Is it running?") }
  if (!response.ok) {
    const value = await response.json().catch(() => null) as { detail?: unknown } | null
    throw new Error(typeof value?.detail === 'string' ? value.detail : `${failure} (HTTP ${response.status}).`)
  }
  return response.json() as Promise<T>
}

/** The worksheets in an .xlsx or .xlsm workbook and the one it opens on. */
export function readWorkbookSheets(file: File, signal?: AbortSignal): Promise<WorkbookSheets> {
  const body = new FormData()
  body.append('file', file)
  return postForJson('/api/spreadsheets/sheets', body, 'Could not read the workbook', signal)
}

/** One sheet of a workbook (null: the one it opens on), or a CSV file, as cells to show. */
export function viewSpreadsheet(file: File, options: { sheet: number | null; delimiter: CsvDelimiter | 'auto' }, signal?: AbortSignal): Promise<SheetView> {
  const body = new FormData()
  body.append('file', file)
  if (options.sheet !== null) body.append('sheet', String(options.sheet))
  body.append('delimiter', options.delimiter)
  return postForJson('/api/spreadsheets/view', body, 'Could not open the spreadsheet', signal)
}

/** `sheet` is a worksheet's index, or 'all' for a ZIP with one CSV per worksheet that has data. */
export type CsvOptions = { sheet: number | 'all'; delimiter: CsvDelimiter; bom: boolean }

export async function excelToCsv(file: File, options: CsvOptions, signal?: AbortSignal): Promise<{ file: File; summary: CsvSummary | null }> {
  const body = new FormData()
  body.append('file', file)
  body.append('sheet', String(options.sheet))
  body.append('delimiter', options.delimiter)
  body.append('bom', String(options.bom))
  const stem = file.name.replace(/\.[^.]+$/, '')
  const { file: output, headers } = await upload('/api/spreadsheets/csv', body, options.sheet === 'all' ? `${stem}_sheets.zip` : `${stem}.csv`, signal)
  return { file: output, summary: parseSummary<CsvSummary>(headers.get('x-spreadsheet-summary')) }
}

export type WorkbookOptions = { delimiter: CsvDelimiter | 'auto'; detectTypes: boolean; header: boolean }

/** One workbook with a worksheet per CSV file, in the order given. */
export async function csvToExcel(files: File[], options: WorkbookOptions, signal?: AbortSignal): Promise<{ file: File; summary: WorkbookSummary | null }> {
  const body = new FormData()
  for (const f of files) body.append('files', f)
  body.append('delimiter', options.delimiter)
  body.append('detect_types', String(options.detectTypes))
  body.append('header', String(options.header))
  const fallback = files.length === 1 ? `${files[0].name.replace(/\.[^.]+$/, '')}.xlsx` : 'combined.xlsx'
  const { file, headers } = await upload('/api/spreadsheets/xlsx', body, fallback, signal)
  return { file, summary: parseSummary<WorkbookSummary>(headers.get('x-spreadsheet-summary')) }
}

export type CompressLevel = 'light' | 'balanced' | 'strong'

/** The compressed file and the sizes in bytes. `after` is no smaller than `before` when the backend found nothing to shrink. */
export async function compressPdf(file: File, level: CompressLevel, signal?: AbortSignal, maxBytes?: number): Promise<{ file: File; before: number; after: number; target?: number; targetMet?: boolean }> {
  const body = pdfBody(file)
  body.append('level', level)
  if (maxBytes !== undefined) body.append('max_bytes', String(validatePdfTarget(maxBytes)))
  const { file: compressed } = await upload('/api/compress', body, 'compressed.pdf', signal)
  signal?.throwIfAborted()
  rememberPdfPassword(compressed, pdfPassword(file))
  return {
    file: compressed,
    before: file.size,
    after: compressed.size,
    ...(maxBytes === undefined ? {} : { target: maxBytes, targetMet: compressed.size <= maxBytes }),
  }
}

/** Crop a photo to `size` pixels as a JPEG marked `dpi`, kept under `maxKb` when given. */
export function cropPhoto(file: File, crop: Crop, size: Size, dpi: number, maxKb?: number): Promise<File> {
  const body = new FormData()
  body.append('file', file)
  body.append('crop', JSON.stringify(crop))
  body.append('width', String(size.width))
  body.append('height', String(size.height))
  body.append('dpi', String(dpi))
  if (maxKb) body.append('max_kb', String(maxKb))
  return post('/api/photo', body, 'passport.jpg')
}

/**
 * Make a one-page PDF of `paper` holding as many copies of the crop as fit,
 * each `photoMm` millimetres big. Resolves to the sheet and how many copies are on it.
 */
export async function photoSheet(file: File, crop: Crop, photoMm: Size, paper: Paper): Promise<{ file: File; copies: number }> {
  const body = new FormData()
  body.append('file', file)
  body.append('crop', JSON.stringify(crop))
  body.append('photo_width', String(photoMm.width))
  body.append('photo_height', String(photoMm.height))
  body.append('paper', paper)
  const { file: sheet, headers } = await upload('/api/photo-sheet', body, 'passport_sheet.pdf')
  return { file: sheet, copies: Number(headers.get('x-copies')) || 0 }
}

/**
 * Give every photo the same edit. Resolves to the photo itself for one file,
 * a zip for several, and what each came out as, in the order given.
 */
export async function editPhotos(files: File[], edit: PhotoEdit, signal?: AbortSignal): Promise<{ file: File; results: PhotoResult[] }> {
  const body = new FormData()
  for (const f of files) body.append('files', f)
  body.append('edit', JSON.stringify(edit))
  const { file, headers } = await upload('/api/photos/edit', body, files.length === 1 ? 'photo.jpg' : 'photos.zip', signal)
  return { file, results: parsePhotoResults(headers.get('x-results'), files) }
}

/** What a photo is and records: size, camera, exposure, location and the metadata it carries. */
export function readPhotoInfo(file: File, signal?: AbortSignal): Promise<PhotoInfo> {
  const body = new FormData()
  body.append('file', file)
  return postForJson('/api/photos/info', body, 'Could not read the photo', signal)
}

export type ImageFormat = 'keep' | 'jpeg' | 'png' | 'webp'

/** Sizes in bytes of one compressed picture, in the order the files were sent. */
export type ImageResult = { name: string; before: number; after: number }

/**
 * Shrink pictures: resolves to the picture itself for one file, a zip for
 * several, and the sizes, one entry per picture in the order given. `maxKb`
 * keeps each under that size.
 */
export async function compressImages(
  files: File[],
  level: CompressLevel,
  format: ImageFormat,
  maxKb?: number,
): Promise<{ file: File; results: ImageResult[] }> {
  const body = new FormData()
  for (const f of files) body.append('files', f)
  body.append('level', level)
  body.append('format', format)
  if (maxKb) body.append('max_kb', String(maxKb))
  const { file, headers } = await upload('/api/compress-images', body, files.length === 1 ? 'compressed.jpg' : 'images_compressed.zip')
  return { file, results: parseImageResults(headers.get('x-results'), files) }
}

/** The `X-Results` header as sizes per file; a missing or odd header counts every file as unchanged. */
export function parseImageResults(header: string | null, files: readonly { name: string; size: number }[]): ImageResult[] {
  let parsed: unknown = null
  try {
    parsed = header ? JSON.parse(header) : null
  } catch {
    parsed = null
  }
  const list = Array.isArray(parsed) ? parsed : []
  return files.map((file, i) => {
    const entry = list[i] as { name?: unknown; before?: unknown; after?: unknown } | undefined
    const before = typeof entry?.before === 'number' ? entry.before : file.size
    const after = typeof entry?.after === 'number' ? entry.after : before
    const name = typeof entry?.name === 'string' ? safeDecode(entry.name) : file.name
    return { name, before, after }
  })
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
