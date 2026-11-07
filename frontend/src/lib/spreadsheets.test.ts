import { afterEach, describe, expect, it, vi } from 'vitest'
import { csvToExcel, excelToCsv, readWorkbookSheets } from './api'
import { pickFiles } from './files'
import { csvRows, parseSummary, separatorName, sheetSize } from './spreadsheets'
import { targetsFor } from './tools'

afterEach(() => vi.unstubAllGlobals())

describe('csvRows', () => {
  it('reads quoted separators, line breaks and doubled quotes, skipping a byte order mark', () => {
    expect(csvRows('﻿a,"b,c"\r\n"say ""hi""","two\nlines"\n', ',', 10)).toEqual([['a', 'b,c'], ['say "hi"', 'two\nlines']])
  })

  it('keeps empty fields, uses the given separator and stops at the limit', () => {
    expect(csvRows(';x;\n1;2;3\n4;5;6', ';', 2)).toEqual([['', 'x', ''], ['1', '2', '3']])
    expect(csvRows('a\tb', '\t', 5)).toEqual([['a', 'b']])
    expect(csvRows('', ',', 5)).toEqual([])
  })
})

it('summarises sheet sizes and separators in words', () => {
  expect(sheetSize({ name: 's', rows: 1204, columns: 1 })).toBe('1,204 rows × 1 column')
  expect(separatorName('tab')).toBe('tab-separated')
  expect(separatorName('other')).toBe('custom separator')
  expect(parseSummary('{"sheets":[],"removed":0}')).toEqual({ sheets: [], removed: 0 })
  expect(parseSummary('not json')).toBeNull()
  expect(parseSummary('{"rows":1}')).toBeNull()
  expect(parseSummary(null)).toBeNull()
})

it('tells workbooks from CSV files and hands results to the other spreadsheet tools', () => {
  const files = ['a.xlsx', 'b.XLSM', 'c.xls', 'd.csv', 'e.TSV', 'f.txt'].map((name) => new File([''], name))
  expect(pickFiles(files, 'xlsx').wanted.map((f) => f.name)).toEqual(['a.xlsx', 'b.XLSM'])
  expect(pickFiles(files, 'csv').wanted.map((f) => f.name)).toEqual(['d.csv', 'e.TSV'])
  expect(targetsFor(new File([''], 'book.csv', { type: 'text/csv' }), 'excel-csv').map((t) => t.id)).toEqual(['sheet-view', 'csv-excel'])
  expect(targetsFor(new File([''], 'book.xlsx'), 'csv-excel').map((t) => t.id)).toEqual(['excel', 'sheet-view', 'excel-csv'])
  expect(targetsFor(new File([''], 'book.xlsx'), 'sheet-view').map((t) => t.id)).toEqual(['excel', 'excel-csv'])
  expect(pickFiles(files, 'sheet').wanted.map((f) => f.name)).toEqual(['a.xlsx', 'b.XLSM', 'd.csv', 'e.TSV'])
  expect(targetsFor(new File([''], 'book_sheets.zip', { type: 'application/zip' }), 'excel-csv')).toEqual([])
})

describe('spreadsheet API', () => {
  it('lists sheets and reports backend problems', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sheets: [{ name: 'A', hidden: false }], active: 0 })))
    vi.stubGlobal('fetch', fetch)
    const source = new File(['x'], 'book.xlsx')
    expect(await readWorkbookSheets(source)).toEqual({ sheets: [{ name: 'A', hidden: false }], active: 0 })
    expect(fetch.mock.calls[0][0]).toBe('/api/spreadsheets/sheets')
    expect((fetch.mock.calls[0][1].body as FormData).get('file')).toBe(source)
    fetch.mockResolvedValue(new Response(JSON.stringify({ detail: 'save it as .xlsx' }), { status: 400 }))
    await expect(readWorkbookSheets(source)).rejects.toThrow('save it as .xlsx')
  })

  it('sends Excel to CSV options and returns the summary', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('a;b\r\n', { headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': "attachment; filename*=UTF-8''book_Sales.csv",
      'X-Spreadsheet-Summary': JSON.stringify({ sheets: [{ name: 'Sales', rows: 1, columns: 2 }], uncalculated: 0 }),
    } }))
    vi.stubGlobal('fetch', fetch)
    const signal = new AbortController().signal
    const made = await excelToCsv(new File(['x'], 'book.xlsx'), { sheet: 2, delimiter: 'semicolon', bom: false }, signal)
    const options = fetch.mock.calls[0][1] as RequestInit
    const body = options.body as FormData
    expect(fetch.mock.calls[0][0]).toBe('/api/spreadsheets/csv')
    expect(options.signal).toBe(signal)
    expect([body.get('sheet'), body.get('delimiter'), body.get('bom')]).toEqual(['2', 'semicolon', 'false'])
    expect(made.file.name).toBe('book_Sales.csv')
    expect(made.summary).toEqual({ sheets: [{ name: 'Sales', rows: 1, columns: 2 }], uncalculated: 0 })
  })

  it('sends every CSV file in order with the workbook options', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('xlsx', { headers: { 'Content-Disposition': 'attachment; filename="combined.xlsx"' } }))
    vi.stubGlobal('fetch', fetch)
    const files = [new File(['1'], 'b.csv'), new File(['2'], 'a.csv')]
    const made = await csvToExcel(files, { delimiter: 'auto', detectTypes: false, header: true })
    const body = fetch.mock.calls[0][1].body as FormData
    expect(fetch.mock.calls[0][0]).toBe('/api/spreadsheets/xlsx')
    expect(body.getAll('files')).toEqual(files)
    expect([body.get('delimiter'), body.get('detect_types'), body.get('header')]).toEqual(['auto', 'false', 'true'])
    expect(made.file.name).toBe('combined.xlsx')
    expect(made.summary).toBeNull()
  })
})
