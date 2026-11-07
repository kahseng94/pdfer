// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HandoffContext } from '../lib/handoff'
import { ExcelCsvTool } from './ExcelCsvTool'

const mocks = vi.hoisted(() => ({ sheets: vi.fn(), convert: vi.fn(), save: vi.fn(), send: vi.fn() }))
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), readWorkbookSheets: mocks.sheets, excelToCsv: mocks.convert, saveFile: mocks.save }))

let root: Root, container: HTMLDivElement
const csv = new File(['﻿name;amount\r\nAda;1.5\r\n'], 'book_Sales.csv', { type: 'text/csv' })
function button(label: string) {
  const node = [...container.querySelectorAll('button')].find((element) => element.textContent === label)
  if (!node) throw new Error(`Missing button ${label}`)
  return node
}
async function choose(...names: string[]) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', { configurable: true, value: names.map((name) => new File(['x'], name)) })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function select(label: string, value: string) {
  const node = [...container.querySelectorAll('label')].find((element) => element.textContent?.startsWith(label))!.querySelector('select')!
  await act(async () => { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })) })
}
beforeEach(async () => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocks.sheets.mockResolvedValue({ sheets: [{ name: 'Notes', hidden: false }, { name: 'Sales', hidden: false }, { name: 'Raw', hidden: true }], active: 1 })
  mocks.convert.mockResolvedValue({ file: csv, summary: { sheets: [{ name: 'Sales', rows: 40, columns: 2 }], uncalculated: 3 } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<HandoffContext value={{ delivery: null, send: mocks.send }}><ExcelCsvTool /></HandoffContext>))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('explains that old .xls workbooks must be saved as .xlsx', async () => {
  await choose('old.xls')
  expect(mocks.sheets).not.toHaveBeenCalled()
  expect(container.textContent).toContain('save it as .xlsx first')
})

it('starts on the sheet the workbook opens on and converts with the chosen options', async () => {
  await choose('book.xlsx')
  expect(container.textContent).toContain('3 sheets')
  const sheet = [...container.querySelectorAll('option')].map((option) => option.textContent)
  expect(sheet).toEqual(['Notes', 'Sales', 'Raw (hidden)', 'All sheets (a ZIP with one CSV each)', 'Comma (,)', 'Semicolon (;)', 'Tab'])
  await select('Separator', 'semicolon')
  await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
  await act(async () => button('Convert to CSV').click())
  expect(mocks.convert.mock.calls[0][1]).toEqual({ sheet: 1, delimiter: 'semicolon', bom: false })

  expect(container.textContent).toContain('40 rows × 2 columns')
  expect(container.textContent).toContain('3 formulas were saved without a result')
  const cells = [...container.querySelectorAll('table[aria-label="CSV preview"] tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent))
  expect(cells).toEqual([['name', 'amount'], ['Ada', '1.5']])
  expect(container.textContent).toContain('First 2 of 40 rows')
  await act(async () => button('Download').click())
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith(csv)
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open in CSV to Excel"]')!.click())
  expect(mocks.send).toHaveBeenCalledWith('csv-excel', csv)

  await select('Sheet', 'all')
  expect(container.querySelector('table')).toBeNull()
  expect(button('Convert every sheet to CSV')).toBeTruthy()
})

it('shows why a workbook could not be read', async () => {
  mocks.sheets.mockRejectedValue(new Error('This workbook is password protected.'))
  await choose('locked.xlsx')
  expect(container.querySelector('[role=alert]')!.textContent).toBe('This workbook is password protected.')
  expect(button('Convert to CSV').disabled).toBe(true)
})
