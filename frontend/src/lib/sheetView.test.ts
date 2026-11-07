import { describe, expect, it } from 'vitest'
import { cellAlign, cellDetails, cellName, cellText, columnName, columnWidths, findCells, sampleRows, type SheetView } from './sheetView'

const view: SheetView = {
  sheets: [{ name: 'S', hidden: false }], sheet: 0, columns: 3, truncated: false, csv: null,
  rows: [['Name', 'Total'], ['Tea', ['$3.50', 'n'], ['TRUE', 'b']], [], [null, ['#DIV/0!', 'e'], 'tea time']],
  formulas: [[1, 1, '=B1*2']], values: [[1, 1, '3.5']],
}

describe('sheet view helpers', () => {
  it('names columns and cells the way Excel does', () => {
    expect([0, 25, 26, 27, 701, 702, 16383].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA', 'XFD'])
    expect(cellName({ row: 11, column: 1 })).toBe('B12')
  })

  it('reads text and alignment from each kind of cell', () => {
    expect([null, 'x', ['1', 'n'], ['TRUE', 'b']].map((cell) => cellText(cell as never))).toEqual(['', 'x', '1', 'TRUE'])
    expect(cellAlign('x')).toBe('left')
    expect(cellAlign(['1', 'n'])).toBe('right')
    expect(cellAlign(['#N/A', 'e'])).toBe('center')
  })

  it('finds shown text in reading order, ignoring case, up to a limit', () => {
    expect(findCells(view, 'TEA')).toEqual([{ row: 1, column: 0 }, { row: 3, column: 2 }])
    expect(findCells(view, '$3')).toEqual([{ row: 1, column: 1 }])
    expect(findCells(view, 'tea', 1)).toHaveLength(1)
    expect(findCells(view, '')).toEqual([])
  })

  it('sizes columns to their text within limits and looks up formulas and stored values', () => {
    const widths = columnWidths({ rows: [['a', 'x'.repeat(200)]], columns: 3 })
    expect(widths[0]).toBe(64)
    expect(widths[1]).toBe(320)
    expect(widths).toHaveLength(3)
    // Longer values far down the sheet widen the column too.
    const rows = Array.from({ length: 50_000 }, (_, row) => [`Customer ${row}`])
    expect(columnWidths({ rows, columns: 1 }, (text) => text.length * 10)[0]).toBe(14 * 10 + 24)
    expect(sampleRows(5)).toEqual([0, 1, 2, 3, 4])
    const sampled = sampleRows(100_000)
    expect(sampled.length).toBeLessThan(1300)
    expect(sampled.at(-1)).toBe(99_999)
    const details = cellDetails(view)
    expect(details.formulas.get(1 * 3 + 1)).toBe('=B1*2')
    expect(details.values.get(1 * 3 + 1)).toBe('3.5')
  })
})
