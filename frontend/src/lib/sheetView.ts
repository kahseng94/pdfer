// The spreadsheet viewer: what the backend sends for a sheet, and naming, sizing and finding its cells.

import type { CsvDelimiter } from './spreadsheets'

/** Empty, text, or [shown text, kind]: "n" numbers and dates, "b" TRUE/FALSE, "e" errors such as #DIV/0!. */
export type ViewCell = null | string | [string, 'n' | 'b' | 'e']

export type SheetView = {
  sheets: { name: string; hidden: boolean }[]
  /** The index of the sheet in `rows`. */
  sheet: number
  /** Each row stops at its last cell with content. */
  rows: ViewCell[][]
  columns: number
  /** The sheet has more rows than were sent. */
  truncated: boolean
  /** [row, column, text], 0-based. */
  formulas: [number, number, string][]
  /** Stored values that differ from what is shown, such as 0.15 for 15%. */
  values: [number, number, string][]
  /** How a CSV file was read; null for a workbook. */
  csv: { delimiter: CsvDelimiter | 'pipe' | 'other'; encoding: string } | null
}

export type CellPosition = { row: number; column: number }

export function cellText(cell: ViewCell | undefined): string {
  return cell == null ? '' : typeof cell === 'string' ? cell : cell[0]
}

/** How a cell lines up: numbers to the right, logical values and errors centred, text to the left. */
export function cellAlign(cell: ViewCell | undefined): 'left' | 'right' | 'center' {
  if (cell == null || typeof cell === 'string') return 'left'
  return cell[1] === 'n' ? 'right' : 'center'
}

/** A, B, … Z, AA, AB, … for a 0-based column. */
export function columnName(index: number): string {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name
}

/** "B12" */
export function cellName({ row, column }: CellPosition): string {
  return `${columnName(column)}${row + 1}`
}

/** One key per cell, for maps and sets. */
export function cellKey(view: Pick<SheetView, 'columns'>, { row, column }: CellPosition): number {
  return row * Math.max(view.columns, 1) + column
}

/** Rows to size columns by: the first ones, then about a thousand spread over the rest of the sheet. */
export function sampleRows(count: number, first = 200, spread = 1000): number[] {
  const rows = Array.from({ length: Math.min(count, first) }, (_, row) => row)
  const step = Math.max(1, Math.floor((count - first) / spread))
  for (let row = first; row < count; row += step) rows.push(row)
  if (count > first && rows[rows.length - 1] !== count - 1) rows.push(count - 1)
  return rows
}

/** About how wide `text` is in the grid's 14px font, for when it can't be measured. */
export const estimateWidth = (text: string) => text.length * 8

/**
 * Pixel widths that fit each column's text in a sample of rows from the whole
 * sheet, between a minimum and a maximum. `measure` gives a text's width.
 */
export function columnWidths(view: Pick<SheetView, 'rows' | 'columns'>, measure: (text: string) => number = estimateWidth): number[] {
  const widest = new Array<number>(view.columns).fill(0)
  for (const row of sampleRows(view.rows.length)) {
    view.rows[row].forEach((cell, column) => {
      const text = cellText(cell)
      // Anything past the maximum width is cut off anyway; long text needn't be measured in full.
      if (text) widest[column] = Math.max(widest[column], measure(text.slice(0, 60)))
    })
  }
  return widest.map((width, column) => Math.min(320, Math.max(64, Math.ceil(width) + 24, columnName(column).length * 9 + 24)))
}

/** Formulas and stored values by cell key. */
export function cellDetails(view: SheetView): { formulas: Map<number, string>; values: Map<number, string> } {
  const byKey = (list: [number, number, string][]) => new Map(list.map(([row, column, text]) => [cellKey(view, { row, column }), text]))
  return { formulas: byKey(view.formulas), values: byKey(view.values) }
}

/** Cells whose shown text contains `query`, ignoring case, row by row; at most `limit` of them. */
export function findCells(view: Pick<SheetView, 'rows'>, query: string, limit = 10_000): CellPosition[] {
  const needle = query.toLocaleLowerCase()
  if (!needle) return []
  const found: CellPosition[] = []
  for (let row = 0; row < view.rows.length; row++) {
    const cells = view.rows[row]
    for (let column = 0; column < cells.length; column++) {
      const cell = cells[column]
      if (cell != null && cellText(cell).toLocaleLowerCase().includes(needle)) {
        found.push({ row, column })
        if (found.length >= limit) return found
      }
    }
  }
  return found
}
