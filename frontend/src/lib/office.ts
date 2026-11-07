export const OFFICE_FORMATS = {
  word: { label: 'Word', extensions: '.doc, .docx' },
  excel: { label: 'Excel', extensions: '.xls, .xlsx' },
  powerpoint: { label: 'PowerPoint', extensions: '.ppt, .pptx' },
} as const

export type OfficeKind = keyof typeof OFFICE_FORMATS
export type OfficeStatus = { available: boolean; message: string | null }
export const MAX_OFFICE_BYTES = 128 * 1024 * 1024
