import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api'
import type { PDFDocumentProxy } from './pdf'
import { pagesIn, parseSpec } from './ranges'

export type TextRun = { start: number; end: number; item: number }
export type PageText = { page: number; text: string; content: TextContent; runs: TextRun[] }
export type TextMatch = { page: number; start: number; end: number }
export type SearchOptions = { matchCase: boolean; wholeWord: boolean }
export type TextProgress = { completed: number; total: number }
export type TextScope = 'all' | 'page' | 'ranges'
export const MAX_MATCHES = 10_000
const MAX_CHARACTERS = 10_000_000
const MAX_ITEMS = 500_000
const MAX_PAGE_ITEMS = 50_000

/** Add only spaces missing between positioned runs, never between adjacent glyphs. */
function separator(previous: TextItem, next: TextItem): string {
  const [a, b, c, d, x, y] = previous.transform as number[]
  const vertical = previous.dir === 'ttb'
  const length = vertical ? Math.hypot(c, d) : Math.hypot(a, b)
  if (!length) return ''
  const ux = (vertical ? -c : a) / length, uy = (vertical ? -d : b) / length
  const dx = Number(next.transform[4]) - x, dy = Number(next.transform[5]) - y
  const height = Math.max(Math.hypot(c, d), Math.hypot(Number(next.transform[2]), Number(next.transform[3])), 1)
  if (Math.abs(-uy * dx + ux * dy) > height * 0.5) return '\n'
  const advance = dx * ux + dy * uy
  const gap = Math.max(advance - (vertical ? previous.height : previous.width), -advance - (vertical ? next.height : next.width))
  return gap > height * 0.15 ? ' ' : ''
}

/** Retain offsets into the exact item strings so search highlights match the PDF text layer. */
export function pageText(content: TextContent, page: number): PageText {
  const parts: string[] = []
  const runs: TextRun[] = []
  let length = 0
  let tail = ''
  let previous: TextItem | null = null
  let itemIndex = 0
  const append = (text: string) => {
    parts.push(text)
    length += text.length
    if (text) tail = text.at(-1) ?? ''
  }
  for (const item of content.items) {
    if (!('str' in item)) continue
    if (item.str && previous && tail && !/\s/u.test(tail) && !/^\s/u.test(item.str)) append(separator(previous, item))
    const start = length
    append(item.str)
    runs.push({ start, end: length, item: itemIndex++ })
    if (item.hasEOL && tail !== '\n') append('\n')
    if (item.str) previous = item
  }
  return { page, content, runs, text: parts.join('').trimEnd() }
}

/** One page at a time; cancelled or failed extraction never returns partial exports. */
export async function extractPdfText(doc: PDFDocumentProxy, options: {
  signal: AbortSignal
  onProgress?: (progress: TextProgress) => void
}): Promise<PageText[]> {
  const { signal, onProgress } = options
  const pages: PageText[] = []
  let characters = 0, items = 0
  signal.throwIfAborted()
  onProgress?.({ completed: 0, total: doc.numPages })
  for (let number = 1; number <= doc.numPages; number++) {
    signal.throwIfAborted()
    try {
      const source = await doc.getPage(number)
      signal.throwIfAborted()
      const content = await source.getTextContent({ includeMarkedContent: false })
      signal.throwIfAborted()
      items += content.items.length
      if (items > MAX_ITEMS || content.items.length > MAX_PAGE_ITEMS) {
        throw new Error('This PDF has too much text for one session. Split it into smaller PDFs and try again.')
      }
      const page = pageText(content, number)
      characters += page.text.length
      if (characters > MAX_CHARACTERS) {
        throw new Error('This PDF has too much text for one session. Split it into smaller PDFs and try again.')
      }
      pages.push(page)
      onProgress?.({ completed: number, total: doc.numPages })
    } catch (err) {
      signal.throwIfAborted()
      throw new Error(`Could not extract page ${number}: ${(err as Error).message}`)
    }
  }
  signal.throwIfAborted()
  return pages
}

export function searchText(pages: readonly PageText[], query: string, options: SearchOptions): { matches: TextMatch[]; limited: boolean } {
  const words = query.trim().split(/\s+/u).filter(Boolean)
  if (!words.length) return { matches: [], limited: false }
  const literal = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
  const pattern = options.wholeWord ? `(?<![\\p{L}\\p{N}\\p{M}_])${literal}(?![\\p{L}\\p{N}\\p{M}_])` : literal
  const regex = new RegExp(pattern, options.matchCase ? 'gu' : 'giu')
  const matches: TextMatch[] = []
  for (const page of pages) {
    regex.lastIndex = 0
    for (const match of page.text.matchAll(regex)) {
      if (matches.length === MAX_MATCHES) return { matches, limited: true }
      matches.push({ page: page.page, start: match.index, end: match.index + match[0].length })
    }
  }
  return { matches, limited: false }
}

/** Match slices within one text span. Phrases may span several PDF items/lines. */
export function runHighlights(run: TextRun, matches: readonly TextMatch[]): { start: number; end: number; match: TextMatch }[] {
  if (run.end <= run.start) return []
  let low = 0, high = matches.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (matches[middle].end <= run.start) low = middle + 1
    else high = middle
  }
  const result = []
  for (let index = low; index < matches.length && matches[index].start < run.end; index++) {
    const match = matches[index]
    result.push({ start: Math.max(match.start, run.start) - run.start, end: Math.min(match.end, run.end) - run.start, match })
  }
  return result
}

export function matchKey(match: TextMatch): string { return `${match.page}:${match.start}:${match.end}` }

export function textPages(scope: TextScope, current: number, spec: string, total: number): number[] {
  if (scope === 'all') return Array.from({ length: total }, (_, index) => index + 1)
  if (scope === 'page') return current >= 1 && current <= total ? [current] : []
  const { ranges, invalid } = parseSpec(spec, total)
  if (invalid.length) throw new Error(`Not valid for this ${total}-page PDF: ${invalid.join(', ')}`)
  const selected = [...pagesIn(ranges)].sort((a, b) => a - b)
  if (!selected.length) throw new Error('Choose at least one page to export.')
  return selected
}

export function exportText(pages: readonly PageText[], selected: readonly number[], headings: boolean): string {
  return selected.map((number) => {
    const page = pages[number - 1]
    if (!page || page.page !== number) throw new Error('Wait for text extraction to finish before exporting.')
    return `${headings ? `--- Page ${number} ---\n\n` : ''}${page.text}`
  }).join('\n\n') + '\n'
}

export function textFile(name: string, text: string): File {
  // oxlint-disable-next-line no-control-regex -- A source filename must not turn into a path.
  const stem = name.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').trim().replace(/^\.+|\.+$/g, '') || 'document'
  return new File([text], `${stem}.txt`, { type: 'text/plain;charset=utf-8' })
}
