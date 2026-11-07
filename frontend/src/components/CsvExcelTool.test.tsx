// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HandoffContext } from '../lib/handoff'
import { CsvExcelTool } from './CsvExcelTool'

const mocks = vi.hoisted(() => ({ convert: vi.fn(), save: vi.fn(), send: vi.fn() }))
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), csvToExcel: mocks.convert, saveFile: mocks.save }))

let root: Root, container: HTMLDivElement
const workbook = new File(['xlsx'], 'combined.xlsx')
function button(label: string) {
  const node = [...container.querySelectorAll('button')].find((element) => element.textContent === label || element.getAttribute('aria-label') === label)
  if (!node) throw new Error(`Missing button ${label}`)
  return node
}
async function choose(...files: File[]) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', { configurable: true, value: files })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
beforeEach(async () => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocks.convert.mockResolvedValue({ file: workbook, summary: { sheets: [
    { name: 'sales', source: 'sales.csv', rows: 1204, columns: 8, delimiter: 'semicolon', encoding: 'Windows-1252' },
    { name: 'History_', source: 'History.csv', rows: 2, columns: 1, delimiter: 'comma', encoding: 'UTF-8' },
  ], removed: 2 } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<HandoffContext value={{ delivery: null, send: mocks.send }}><CsvExcelTool /></HandoffContext>))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('points workbooks to Excel to CSV', async () => {
  await choose(new File(['x'], 'book.xlsx'))
  expect(container.textContent).toContain('Excel workbooks were not added. Use Excel to CSV')
  expect(container.querySelector('li')).toBeNull()
})

it('converts the files in the chosen order and describes each sheet made', async () => {
  const history = new File(['1'], 'History.csv'), sales = new File(['2'], 'sales.csv')
  await choose(history, sales)
  expect(container.textContent).toContain('2 files become 2 sheets, in this order')
  await act(async () => button('Move sales.csv up').click())
  await act(async () => container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[0].click())
  await act(async () => button('Convert 2 files to Excel').click())
  expect(mocks.convert.mock.calls[0][0]).toEqual([sales, history])
  expect(mocks.convert.mock.calls[0][1]).toEqual({ delimiter: 'auto', detectTypes: false, header: true })

  const sheets = [...container.querySelectorAll('[aria-label="Sheets made"] li')].map((item) => item.textContent)
  expect(sheets).toEqual([
    'sales · 1,204 rows × 8 columns · read as semicolon-separated Windows-1252 text',
    'History_ · 2 rows × 1 column · read as comma-separated UTF-8 text from History.csv',
  ])
  expect(container.textContent).toContain('Removed 2 control characters')
  await act(async () => button('Open in Excel to PDF').click())
  expect(mocks.send).toHaveBeenCalledWith('excel', workbook)

  await act(async () => button('Remove History.csv').click())
  expect(container.querySelector('[aria-label="Sheets made"]')).toBeNull()
  expect(button('Convert 1 file to Excel')).toBeTruthy()
})

it('blocks empty files before converting', async () => {
  await choose(new File([], 'empty.csv'))
  expect(container.querySelector('[role=alert]')!.textContent).toContain('empty.csv is empty')
  expect(button('Convert 1 file to Excel').disabled).toBe(true)
})
