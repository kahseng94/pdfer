// The app's tabs, and which of them can open a file another one made.

import { FILE_KINDS, type FileKind } from './files'

export const TOOLS = [
  { id: 'merge', label: 'Merge', takes: 'pdf' },
  { id: 'split', label: 'Split', takes: 'pdf' },
  { id: 'organize', label: 'Organize', takes: 'pdf' },
  { id: 'bookmarks', label: 'Bookmarks', takes: 'pdf' },
  { id: 'metadata', label: 'Metadata', takes: 'pdf' },
  { id: 'text', label: 'Search & text', takes: 'pdf' },
  { id: 'compare', label: 'Compare PDFs', takes: 'pdf' },
  { id: 'ocr', label: 'OCR', takes: 'pdf' },
  { id: 'edit', label: 'Edit', takes: 'pdf' },
  { id: 'forms', label: 'Fill forms', takes: 'pdf' },
  { id: 'redact', label: 'Redact', takes: 'pdf' },
  { id: 'signatures', label: 'Signatures', takes: 'pdf' },
  { id: 'stamps', label: 'Numbers & watermarks', takes: 'pdf' },
  { id: 'compress', label: 'Compress', takes: 'compressible' },
  { id: 'pdf-images', label: 'PDF to images', takes: 'pdf' },
  { id: 'passwords', label: 'Passwords', takes: 'pdf' },
  { id: 'workflows', label: 'Workflows', takes: 'pdf' },
  { id: 'word', label: 'Word to PDF', takes: 'word' },
  { id: 'excel', label: 'Excel to PDF', takes: 'excel' },
  { id: 'powerpoint', label: 'PowerPoint to PDF', takes: 'powerpoint' },
  { id: 'png', label: 'PNG to PDF', takes: 'png' },
  { id: 'jpg', label: 'JPG to PDF', takes: 'jpg' },
  { id: 'images', label: 'Images to PDF', takes: 'image' },
  { id: 'sheet-view', label: 'View spreadsheet', takes: 'sheet' },
  { id: 'excel-csv', label: 'Excel to CSV', takes: 'xlsx' },
  { id: 'csv-excel', label: 'CSV to Excel', takes: 'csv' },
  { id: 'markdown', label: 'Markdown editor', takes: 'markdown' },
  { id: 'photo', label: 'Photo', takes: 'image' },
] as const satisfies readonly { id: string; label: string; takes: FileKind }[]

export type Tool = (typeof TOOLS)[number]
export type ToolId = Tool['id']

export const TOOL_IDS = TOOLS.map((t) => t.id)

/** The tools other than `from` that take `file`, in tab order. */
export function targetsFor(file: File, from: ToolId): Tool[] {
  return TOOLS.filter((t) => t.id !== from && FILE_KINDS[t.takes].is(file))
}
