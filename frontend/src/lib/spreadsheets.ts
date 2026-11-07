// Excel to CSV and CSV to Excel: limits, options and what the backend reports about a conversion.

export const MAX_WORKBOOK_BYTES = 64 * 1024 * 1024
/** For all the CSV files in one workbook together. */
export const MAX_CSV_BYTES = 64 * 1024 * 1024
export const MAX_CSV_FILES = 50

export type CsvDelimiter = 'comma' | 'semicolon' | 'tab'

export const CSV_DELIMITERS: { value: CsvDelimiter; label: string; char: string }[] = [
  { value: 'comma', label: 'Comma (,)', char: ',' },
  { value: 'semicolon', label: 'Semicolon (;)', char: ';' },
  { value: 'tab', label: 'Tab', char: '\t' },
]

export type WorkbookSheets = { sheets: { name: string; hidden: boolean }[]; active: number }

export type SheetSize = { name: string; rows: number; columns: number }

/** Each CSV made, and how many formulas were saved without a result (they come out empty). */
export type CsvSummary = { sheets: SheetSize[]; uncalculated: number }

/** Each worksheet made, the file and separator it came from, and how many control characters were dropped. */
export type WorkbookSummary = {
  sheets: (SheetSize & { source: string; delimiter: CsvDelimiter | 'pipe' | 'other'; encoding: string })[]
  removed: number
}

const SEPARATOR_NAMES: Record<string, string> = {
  comma: 'comma-separated', semicolon: 'semicolon-separated', tab: 'tab-separated', pipe: 'pipe-separated',
}

export function separatorName(delimiter: string): string {
  return SEPARATOR_NAMES[delimiter] ?? 'custom separator'
}

/** "1,204 rows × 8 columns" */
export function sheetSize({ rows, columns }: SheetSize): string {
  const count = (n: number, one: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : `${one}s`}`
  return `${count(rows, 'row')} × ${count(columns, 'column')}`
}

/** The `X-Spreadsheet-Summary` header; a missing or malformed one reads as no summary. */
export function parseSummary<T extends { sheets: unknown[] }>(header: string | null): T | null {
  try {
    const value: unknown = header ? JSON.parse(header) : null
    return value && typeof value === 'object' && Array.isArray((value as { sheets?: unknown }).sheets) ? value as T : null
  } catch {
    return null
  }
}

/**
 * Up to `limit` rows of CSV text, split into fields the way spreadsheet apps
 * read them: quoted fields may hold separators, line breaks and doubled quotes.
 */
export function csvRows(text: string, delimiter: string, limit: number): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  for (; i < text.length && rows.length < limit; i++) {
    const c = text[i]
    if (quoted) {
      if (c !== '"') field += c
      else if (text[i + 1] === '"') { field += '"'; i++ }
      else quoted = false
    } else if (c === '"' && field === '') quoted = true
    else if (c === delimiter) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); rows.push(row)
      row = []; field = ''
    } else field += c
  }
  if ((field || row.length) && rows.length < limit) { row.push(field); rows.push(row) }
  return rows
}
