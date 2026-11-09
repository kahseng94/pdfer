// Which files each tool takes. Shared by the Dropzone, window drops and paste.

import { MAX_OFFICE_BYTES, OFFICE_FORMATS, type OfficeKind } from './office'
import { MAX_CSV_BYTES, MAX_WORKBOOK_BYTES } from './spreadsheets'
import { MAX_MARKDOWN_BYTES } from './markdown'

export type FileKind = 'pdf' | 'image' | 'photo' | 'png' | 'jpg' | 'word' | 'excel' | 'powerpoint' | 'xlsx' | 'csv' | 'sheet' | 'markdown' | 'compressible'

type KindSpec = {
  /** The `accept` attribute for a file input. */
  accept: string
  formatHint: string
  /** Wording for one file ("a PDF") and several ("PDFs"). */
  one: string
  many: string
  is: (f: File) => boolean
}

const PDF: KindSpec = {
  accept: 'application/pdf,.pdf',
  formatHint: 'PDF documents',
  one: 'a PDF',
  many: 'PDFs',
  is: (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'),
}

const IMAGE: KindSpec = {
  accept: 'image/jpeg,image/png,.jpg,.jpeg,.png',
  formatHint: 'JPG and PNG images',
  one: 'an image',
  many: 'images',
  is: (f) => f.type === 'image/jpeg' || f.type === 'image/png' || /\.(jpe?g|png)$/i.test(f.name),
}

/** Everything the photo tools open; the backend reads them all, the browser previews all but TIFF and HEIC. */
const PHOTO: KindSpec = {
  accept: 'image/jpeg,image/png,image/webp,image/gif,image/bmp,image/tiff,image/avif,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.gif,.bmp,.tif,.tiff,.avif,.heic,.heif',
  formatHint: 'JPG, PNG, WebP, GIF, BMP, TIFF, AVIF and HEIC images',
  one: 'a photo',
  many: 'photos',
  is: (f) => /^image\/(jpeg|png|webp|gif|bmp|tiff|avif|heic|heif)$/.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|tiff?|avif|heic|heif)$/i.test(f.name),
}

/** Workbooks the spreadsheet tools read themselves, without LibreOffice. */
const XLSX: KindSpec = {
  accept: '.xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12',
  formatHint: `Excel workbooks (.xlsx, .xlsm) · Up to ${MAX_WORKBOOK_BYTES / (1024 * 1024)} MB`,
  one: 'an Excel workbook', many: 'Excel workbooks', is: (f) => /\.xls[xm]$/i.test(f.name),
}

const CSV: KindSpec = {
  accept: '.csv,.tsv,text/csv,text/tab-separated-values',
  formatHint: `CSV and TSV files · Up to ${MAX_CSV_BYTES / (1024 * 1024)} MB in total`,
  one: 'a CSV file', many: 'CSV files', is: (f) => /\.(csv|tsv)$/i.test(f.name),
}

function officeFormatHint(kind: OfficeKind) {
  return `${OFFICE_FORMATS[kind].extensions} · Up to ${MAX_OFFICE_BYTES / (1024 * 1024)} MB`
}

export const FILE_KINDS: Record<FileKind, KindSpec> = {
  pdf: PDF,
  image: IMAGE,
  photo: PHOTO,
  png: {
    accept: 'image/png,.png', one: 'a PNG image', many: 'PNG images',
    formatHint: 'PNG images (.png)',
    is: (f) => f.type === 'image/png' || /\.png$/i.test(f.name),
  },
  jpg: {
    accept: 'image/jpeg,.jpg,.jpeg', one: 'a JPG image', many: 'JPG images',
    formatHint: 'JPEG images (.jpg, .jpeg)',
    is: (f) => f.type === 'image/jpeg' || /\.jpe?g$/i.test(f.name),
  },
  // Office conversion requires a supported extension, even if the OS omits MIME.
  word: {
    accept: '.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    formatHint: officeFormatHint('word'),
    one: 'a Word document', many: 'Word documents', is: (f) => /\.docx?$/i.test(f.name),
  },
  excel: {
    accept: '.xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    formatHint: officeFormatHint('excel'),
    one: 'an Excel workbook', many: 'Excel workbooks', is: (f) => /\.xlsx?$/i.test(f.name),
  },
  powerpoint: {
    accept: '.ppt,.pptx,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation',
    formatHint: officeFormatHint('powerpoint'),
    one: 'a PowerPoint presentation', many: 'PowerPoint presentations', is: (f) => /\.pptx?$/i.test(f.name),
  },
  xlsx: XLSX,
  csv: CSV,
  sheet: {
    accept: `${XLSX.accept},${CSV.accept}`,
    formatHint: `Excel workbooks (.xlsx, .xlsm) and CSV files (.csv, .tsv) · Up to ${MAX_WORKBOOK_BYTES / (1024 * 1024)} MB`,
    one: 'a spreadsheet', many: 'spreadsheets', is: (f) => XLSX.is(f) || CSV.is(f),
  },
  markdown: {
    accept: '.md,.markdown,.mdown,.mkd,.mkdn,text/markdown',
    formatHint: `Markdown files (.md, .markdown) · Up to ${MAX_MARKDOWN_BYTES / (1024 * 1024)} MB`,
    one: 'a Markdown file', many: 'Markdown files', is: (f) => /\.(md|markdown|mdown|mkdn?)$/i.test(f.name),
  },
  /** What the Compress tool takes: a PDF, or pictures including WebP. */
  compressible: {
    accept: `${PDF.accept},${IMAGE.accept},image/webp,.webp`,
    formatHint: 'PDF, JPG, PNG, and WebP files',
    one: 'a PDF or image',
    many: 'PDFs or images',
    is: (f) => PDF.is(f) || IMAGE.is(f) || f.type === 'image/webp' || f.name.toLowerCase().endsWith('.webp'),
  },
}

/** Keep the files of the wanted kind, in order; `skipped` counts the rest. */
export function pickFiles(files: Iterable<File>, kind: FileKind): { wanted: File[]; skipped: number } {
  const all = [...files]
  const wanted = all.filter(FILE_KINDS[kind].is)
  return { wanted, skipped: all.length - wanted.length }
}
