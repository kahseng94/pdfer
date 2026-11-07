// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HandoffContext } from '../lib/handoff'
import type { SheetView } from '../lib/sheetView'
import { SheetViewTool } from './SheetViewTool'

const mocks = vi.hoisted(() => ({ view: vi.fn(), send: vi.fn() }))
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), viewSpreadsheet: mocks.view }))

const sales: SheetView = {
  sheets: [{ name: 'Notes', hidden: false }, { name: 'Sales', hidden: false }, { name: 'Raw', hidden: true }], sheet: 1,
  columns: 3, truncated: false, csv: null,
  rows: [['Item', 'Price', 'Total'], ['Tea', ['$3.50', 'n'], ['$7.00', 'n']], ['Green tea', ['$4.00', 'n']]],
  formulas: [[1, 2, '=B2*2']], values: [[1, 1, '3.5']],
}
const notes: SheetView = { ...sales, sheet: 0, columns: 1, rows: [['Read me']], formulas: [], values: [] }

let root: Root, container: HTMLDivElement
const text = (selector: string) => [...container.querySelectorAll(selector)].map((node) => node.textContent)
async function choose(name: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], name)] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
function cell(name: string) {
  const column = name.charCodeAt(0) - 65, row = Number(name.slice(1)) - 1
  return container.querySelector<HTMLElement>(`[role=row][aria-rowindex="${row + 2}"] [role=gridcell][aria-colindex="${column + 2}"]`)!
}
beforeEach(async () => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocks.view.mockImplementation(async (_file: File, options: { sheet: number | null }) => (options.sheet === 0 ? notes : sales))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<HandoffContext value={{ delivery: null, send: mocks.send }}><SheetViewTool /></HandoffContext>))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('explains that old .xls workbooks must be saved as .xlsx', async () => {
  await choose('old.xls')
  expect(mocks.view).not.toHaveBeenCalled()
  expect(container.textContent).toContain('save it as .xlsx first')
})

it('opens on the workbook sheet, shows formatted cells and the selected cell in full', async () => {
  await choose('book.xlsx')
  expect(mocks.view.mock.calls[0][1]).toEqual({ sheet: null, delimiter: 'auto' })
  expect(text('[role=tab]')).toEqual(['Notes', 'Sales', 'Raw (hidden)'])
  expect(container.querySelector('[role=tab][aria-selected=true]')!.textContent).toBe('Sales')
  expect(text('[role=columnheader]')).toEqual(['', 'A', 'B', 'C'])
  expect(cell('B2').textContent).toBe('$3.50')
  expect(cell('B2').className).toContain('text-right')
  expect(container.textContent).toContain('3 rows × 3 columns')

  await act(async () => cell('C2').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
  expect(container.querySelector('output')!.textContent).toBe('=B2*2 = $7.00')
  const grid = container.querySelector<HTMLElement>('[role=grid]')!
  await act(async () => grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
  expect(container.querySelector('output')!.textContent).toBe('$3.50 (stored as 3.5)')
  expect(grid.getAttribute('aria-activedescendant')).toBe(cell('B2').id)
  await act(async () => grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', ctrlKey: true, bubbles: true })))
  expect(cell('C3').getAttribute('aria-selected')).toBe('true')

  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open in Excel to CSV"]')!.click())
  expect(mocks.send).toHaveBeenCalledWith('excel-csv', expect.objectContaining({ name: 'book.xlsx' }))
})

it('finds text, steps through matches and switches sheets', async () => {
  await choose('book.xlsx')
  const search = container.querySelector<HTMLInputElement>('input[type=search]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'TEA')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(container.textContent).toContain('1 of 2')
  expect(cell('A2').getAttribute('aria-selected')).toBe('true')
  await act(async () => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(container.textContent).toContain('2 of 2')
  expect(cell('A3').getAttribute('aria-selected')).toBe('true')
  expect(cell('A2').className).toContain('bg-amber-100')

  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role=tab]')[0].click())
  expect(mocks.view.mock.calls[1][1]).toEqual({ sheet: 0, delimiter: 'auto' })
  expect(cell('A1').textContent).toBe('Read me')
  expect(container.textContent).toContain('No matches')
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role=tab]')[1].click())
  expect(mocks.view).toHaveBeenCalledTimes(2)
  expect(cell('B2').textContent).toBe('$3.50')
})

it('reads CSV files again with another separator and reports problems', async () => {
  mocks.view.mockResolvedValue({ ...notes, sheets: [{ name: 'list', hidden: false }], sheet: 0, csv: { delimiter: 'comma', encoding: 'Windows-1252' } })
  await choose('list.csv')
  expect(container.querySelector('[role=tablist]')).toBeNull()
  expect(container.textContent).toContain('Read as Windows-1252 text.')
  const separator = container.querySelector<HTMLSelectElement>('select')!
  expect(separator.options[0].textContent).toBe('Detected: comma-separated')
  await act(async () => { separator.value = 'semicolon'; separator.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(mocks.view.mock.calls[1][1]).toEqual({ sheet: null, delimiter: 'semicolon' })

  mocks.view.mockRejectedValue(new Error('This workbook is password protected.'))
  await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Choose another file')!.click())
  await choose('locked.xlsx')
  expect(container.querySelector('[role=alert]')!.textContent).toBe('This workbook is password protected.')
  expect(container.querySelector('[role=grid]')).toBeNull()
})
