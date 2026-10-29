import { describe, expect, it, vi } from 'vitest'
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api'
import type { PDFDocumentProxy } from './pdf'
import { exportText, extractPdfText, MAX_MATCHES, pageText, runHighlights, searchText, textFile, textPages } from './pdfText'

function item(str: string, x = 0, y = 100, extra: Partial<TextItem> = {}): TextItem {
  return { str, dir: 'ltr', transform: [10, 0, 0, 10, x, y], width: str.length * 5, height: 10, fontName: 'F1', hasEOL: false, ...extra }
}
const content = (items: TextContent['items']): TextContent => ({ items, styles: {}, lang: null })
const page = (text: string, number = 1) => pageText(content([item(text)]), number)
const options = { matchCase: false, wholeWord: false }

describe('text extraction and offsets', () => {
  it('joins split glyphs and styles without breaking words, preserves spaces and line endings', () => {
    const output = pageText(content([item('Hel'), item('lo', 15), item('world', 35, 100, { hasEOL: true }), item('Next', 0, 80)]), 1)
    expect(output.text).toBe('Hello world\nNext')
    expect(output.runs.map((run) => output.text.slice(run.start, run.end))).toEqual(['Hel', 'lo', 'world', 'Next'])
    const match = searchText([output], 'hello world', options).matches[0]
    expect(output.runs.flatMap((run) => runHighlights(run, [match])).map((hit) => [hit.start, hit.end])).toEqual([[0, 3], [0, 2], [0, 5]])
  })
  it('honors explicit blank EOL items and marked content without shifting span indices', () => {
    const output = pageText(content([{ type: 'beginMarkedContent', id: 'a' }, item('One'), item('', 15, 100, { hasEOL: true }), { type: 'endMarkedContent', id: 'a' }, item('Two', 0, 80)]), 2)
    expect(output.text).toBe('One\nTwo')
    expect(output.runs.map((run) => run.item)).toEqual([0, 1, 2])
  })
  it('infers absent line breaks in the text’s coordinate frame, including rotated text', () => {
    expect(pageText(content([item('One'), item('Two', 0, 80)]), 1).text).toBe('One\nTwo')
    const first = item('One', 0, 0, { transform: [0, 10, -10, 0, 0, 0] })
    const next = item('Two', 0, 0, { transform: [0, 10, -10, 0, 20, 0] })
    expect(pageText(content([first, next]), 1).text).toBe('One\nTwo')
  })
  it('extracts all pages in order, including blank pages, with progress', async () => {
    const getPage = vi.fn(async (number: number) => ({ getTextContent: vi.fn(async () => content(number === 2 ? [] : [item(`Page ${number}`)])) }))
    const progress = vi.fn()
    const output = await extractPdfText({ numPages: 3, getPage } as unknown as PDFDocumentProxy, { signal: new AbortController().signal, onProgress: progress })
    expect(output.map((p) => p.text)).toEqual(['Page 1', '', 'Page 3'])
    expect(getPage.mock.calls.map(([n]) => n)).toEqual([1, 2, 3])
    expect(progress).toHaveBeenLastCalledWith({ completed: 3, total: 3 })
  })
  it('discards a cancelled page read and does not start another page', async () => {
    const controller = new AbortController()
    let finish: (value: TextContent) => void = () => {}
    const getTextContent = vi.fn(() => new Promise<TextContent>((resolve) => { finish = resolve }))
    const getPage = vi.fn(async () => ({ getTextContent }))
    const work = extractPdfText({ numPages: 2, getPage } as unknown as PDFDocumentProxy, { signal: controller.signal })
    const rejected = expect(work).rejects.toThrow()
    await vi.waitFor(() => expect(getTextContent).toHaveBeenCalledOnce())
    controller.abort()
    finish(content([item('old text')]))
    await rejected
    expect(getPage).toHaveBeenCalledOnce()
  })
  it('reports the failing page and never returns partial extraction', async () => {
    const getPage = vi.fn(async (number: number) => ({ getTextContent: async () => { if (number === 2) throw new Error('Unreadable text'); return content([item('first')]) } }))
    await expect(extractPdfText({ numPages: 3, getPage } as unknown as PDFDocumentProxy, { signal: new AbortController().signal })).rejects.toThrow('Could not extract page 2: Unreadable text')
    expect(getPage).toHaveBeenCalledTimes(2)
  })
  it('does no work when already cancelled and rejects a page too large to render safely', async () => {
    const getPage = vi.fn(async () => ({ getTextContent: async () => content(Array.from({ length: 50_001 }, () => item('x'))) }))
    const doc = { numPages: 1, getPage } as unknown as PDFDocumentProxy
    await expect(extractPdfText(doc, { signal: AbortSignal.abort() })).rejects.toThrow()
    expect(getPage).not.toHaveBeenCalled()
    await expect(extractPdfText(doc, { signal: new AbortController().signal })).rejects.toThrow('too much text')
  })
})

describe('literal PDF search', () => {
  it('searches every page, supports case matching, and does not treat input as a regex', () => {
    const pages = [page('Hello hello (a+b) [a].'), page('HELLO', 2)]
    expect(searchText(pages, 'hello', options).matches.map((m) => m.page)).toEqual([1, 1, 2])
    expect(searchText(pages, 'hello', { ...options, matchCase: true }).matches).toHaveLength(1)
    expect(searchText(pages, '(a+b)', options).matches).toHaveLength(1)
    expect(searchText(pages, '[a].', options).matches).toHaveLength(1)
    expect(searchText(pages, '.*', options).matches).toHaveLength(0)
    expect(searchText(pages, '   ', options).matches).toHaveLength(0)
  })
  it('finds phrases across line breaks but never across page boundaries', () => {
    const pages = [page('Alpha\n beta'), page('Alpha', 2), page('beta', 3)]
    expect(searchText(pages, ' Alpha   beta ', options).matches).toEqual([{ page: 1, start: 0, end: 11 }])
  })
  it('uses Unicode word boundaries and keeps UTF-16 offsets accurate', () => {
    const text = '😀 café cafeteria café_2 Ελληνικά Ελληνικά2 中文'
    const result = searchText([page(text)], 'café', { ...options, wholeWord: true })
    expect(result.matches).toEqual([{ page: 1, start: 3, end: 7 }])
    expect(searchText([page(text)], 'Ελληνικά', { ...options, wholeWord: true }).matches).toHaveLength(1)
    expect(searchText([page(text)], '中文', options).matches).toHaveLength(1)
  })
  it('bounds huge result sets and distinguishes an exact limit from truncated matches', () => {
    expect(searchText([page('a '.repeat(MAX_MATCHES))], 'a', options)).toMatchObject({ limited: false })
    const result = searchText([page('a '.repeat(MAX_MATCHES + 1))], 'a', options)
    expect(result.matches).toHaveLength(MAX_MATCHES)
    expect(result.limited).toBe(true)
  })
})

describe('plain text exports', () => {
  it('exports selected ranges once, in order, with optional original page headings', () => {
    const pages = [page('One'), page('', 2), page('Résumé 世界', 3)]
    const selected = textPages('ranges', 1, '3, 1-2, 2', 3)
    expect(selected).toEqual([1, 2, 3])
    expect(exportText(pages, selected, true)).toBe('--- Page 1 ---\n\nOne\n\n--- Page 2 ---\n\n\n\n--- Page 3 ---\n\nRésumé 世界\n')
    expect(exportText(pages, [3], false)).toBe('Résumé 世界\n')
    expect(textPages('page', 2, '', 3)).toEqual([2])
    expect(textPages('all', 2, '', 3)).toEqual([1, 2, 3])
  })
  it.each(['', '1, 4', '3-1', 'nope'])('rejects invalid or empty export ranges: %s', (spec) => {
    expect(() => textPages('ranges', 1, spec, 3)).toThrow()
  })
  it('requires completed pages and creates a UTF-8 text file without an automatic download', async () => {
    expect(() => exportText([page('One')], [2], false)).toThrow('finish')
    const file = textFile('Résumé.PDF', '世界\n')
    expect(file.name).toBe('Résumé.txt')
    expect(file.type).toBe('text/plain;charset=utf-8')
    expect(await file.text()).toBe('世界\n')
    expect(textFile('.pdf', '').name).toBe('document.txt')
  })
})
