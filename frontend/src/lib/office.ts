export const OFFICE_FORMATS = {
  word: { label: 'Word', extensions: '.doc, .docx', hint: 'Page layout follows the document. Fonts available on this computer affect the result.' },
  excel: { label: 'Excel', extensions: '.xls, .xlsx', hint: 'Pages follow the workbook’s print areas, page breaks and scaling. Set these in Excel for the layout you want.' },
  powerpoint: { label: 'PowerPoint', extensions: '.ppt, .pptx', hint: 'Slides become PDF pages. Animations and transitions are not included; hidden slides and speaker notes are not exported.' },
} as const

export type OfficeKind = keyof typeof OFFICE_FORMATS
export type OfficeStatus = { available: boolean; message: string | null }
export const MAX_OFFICE_BYTES = 128 * 1024 * 1024
