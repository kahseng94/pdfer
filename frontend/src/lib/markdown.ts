// Markdown for the editor: rendering that never reaches outside this computer, and the edits behind the toolbar.

import { micromark } from 'micromark'
import { gfm, gfmHtml } from 'micromark-extension-gfm'

export const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024

export type Rendered = {
  html: string
  /** Checkboxes in task lists, in document order. */
  tasks: number
  /** Pictures replaced by their description, since nothing is loaded from the web or other files. */
  images: number
  words: number
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces as hyphens. */
export function slug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-')
}

/**
 * GitHub-flavoured Markdown as HTML that is safe to show inside the app.
 *
 * Raw HTML in the source is shown as text and links that could run code are
 * removed (micromark's defaults). On top of that, anchors become data
 * attributes so they can't clash with the app's own ids, pictures become their
 * description so the page never contacts other websites, and task checkboxes
 * can be ticked.
 */
export function renderMarkdown(source: string): Rendered {
  const template = document.createElement('template')
  template.innerHTML = micromark(source, { extensions: [gfm()], htmlExtensions: [gfmHtml()] })
  const root = template.content
  const used = new Map<string, number>()
  for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    if (heading.id) continue
    const base = slug(heading.textContent ?? '')
    const count = used.get(base) ?? 0
    used.set(base, count + 1)
    heading.setAttribute('data-anchor', count ? `${base}-${count}` : base)
  }
  for (const node of root.querySelectorAll('[id]')) {
    node.setAttribute('data-anchor', node.id)
    node.removeAttribute('id')
  }
  for (const node of root.querySelectorAll('[aria-describedby]')) node.removeAttribute('aria-describedby')
  for (const link of root.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? ''
    if (/^(https?:|mailto:)/i.test(href)) {
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.title = href
    } else if (!href.startsWith('#')) {
      link.setAttribute('data-unavailable', '')
      link.title = href ? `Links to other files can’t be opened here: ${href}` : 'This link was removed because it could run code.'
    }
  }
  const images = [...root.querySelectorAll('img')]
  for (const image of images) {
    const description = image.getAttribute('alt') || 'Image'
    const source = image.getAttribute('src')
    const stand = document.createElement('span')
    stand.className = 'markdown-image'
    stand.setAttribute('role', 'img')
    stand.setAttribute('aria-label', `${description} (image not shown)`)
    stand.title = source ? `Image not shown: ${source}` : 'Image not shown'
    stand.textContent = description
    image.replaceWith(stand)
  }
  const boxes = root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  boxes.forEach((box, index) => {
    box.removeAttribute('disabled')
    box.setAttribute('data-task', String(index))
    const item = box.parentElement?.textContent?.trim().split('\n')[0]
    box.setAttribute('aria-label', item ? `Done: ${item}` : 'Done')
  })
  const words = root.textContent?.match(/\S+/g)?.length ?? 0
  return { html: template.innerHTML, tasks: boxes.length, images: images.length, words }
}

const QUOTE = String.raw`(?:[ \t]*>[ \t]?)*`
const FENCE = new RegExp(String.raw`^${QUOTE}[ \t]{0,3}(\`{3,}|~{3,})`)
const TASK = new RegExp(String.raw`^(${QUOTE}[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)[ xX]\](?=[ \t])`)

/** Where each task checkbox's mark (the space or x between its brackets) is in the source, in order; code blocks are skipped. */
export function taskMarkers(source: string): number[] {
  const markers: number[] = []
  let fence: string | null = null
  let offset = 0
  for (const line of source.split('\n')) {
    const opener = FENCE.exec(line)
    if (fence) {
      if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length && !line.slice(opener[0].length).trim()) fence = null
    } else if (opener) {
      fence = opener[1]
    } else {
      const task = TASK.exec(line)
      if (task) markers.push(offset + task[1].length)
    }
    offset += line.length + 1
  }
  return markers
}

/** The source with the task whose mark is at `position` ticked or unticked. */
export function toggleTask(source: string, position: number): string {
  const mark = source[position] === ' ' ? 'x' : ' '
  return source.slice(0, position) + mark + source.slice(position + 1)
}

/** Replace `from`–`to` with `insert`, then select `select` in the new text. */
export type Edit = { from: number; to: number; insert: string; select: [number, number] }

export function applyEdit(value: string, edit: Edit): string {
  return value.slice(0, edit.from) + edit.insert + value.slice(edit.to)
}

/** Wrap the selection in `marker` (bold, italic, strikethrough, code), or unwrap it when it already is. */
export function toggleWrap(value: string, start: number, end: number, marker: string, placeholder: string): Edit {
  const size = marker.length
  const selected = value.slice(start, end)
  if (start >= size && value.slice(start - size, start) === marker && value.slice(end, end + size) === marker) {
    return { from: start - size, to: end + size, insert: selected, select: [start - size, end - size] }
  }
  if (selected.length >= 2 * size && selected.startsWith(marker) && selected.endsWith(marker)) {
    return { from: start, to: end, insert: selected.slice(size, -size), select: [start, end - 2 * size] }
  }
  const text = selected || placeholder
  return { from: start, to: end, insert: marker + text + marker, select: [start + size, start + size + text.length] }
}

function lineBounds(value: string, start: number, end: number): [number, number] {
  const from = value.lastIndexOf('\n', start - 1) + 1
  const last = end > start && value[end - 1] === '\n' ? end - 1 : end
  const to = value.indexOf('\n', last)
  return [from, to < 0 ? value.length : to]
}

export type LineStyle = 'heading' | 'bullet' | 'number' | 'task' | 'quote'

const LIST_MARKER = /^([ \t]*)(?:[-*+] \[[ xX]\] |[-*+] |\d{1,9}[.)] )/
const LINE_PATTERNS: Record<Exclude<LineStyle, 'heading'>, RegExp> = {
  bullet: /^([ \t]*)[-*+] (?!\[[ xX]\] )/,
  number: /^([ \t]*)\d{1,9}[.)] /,
  task: /^([ \t]*)[-*+] \[[ xX]\] /,
  quote: /^()> ?/,
}

/**
 * Turn the selected lines into a list, quote or heading, or back into plain
 * lines when they already are. Headings step through levels 1–3, then off.
 */
export function toggleLines(value: string, start: number, end: number, style: LineStyle): Edit {
  const [from, to] = lineBounds(value, start, end)
  const lines = value.slice(from, to).split('\n')
  let next: string[]
  if (style === 'heading') {
    const level = /^(#{1,6}) /.exec(lines[0])?.[1].length ?? 0
    const target = level >= 3 ? 0 : level + 1
    next = lines.map((line) => (target ? '#'.repeat(target) + ' ' : '') + line.replace(/^#{1,6} /, ''))
  } else {
    const pattern = LINE_PATTERNS[style]
    const filled = lines.filter((line) => line.trim())
    const remove = filled.length > 0 && filled.every((line) => pattern.test(line))
    let number = 0
    next = lines.map((line) => {
      if (!line.trim()) return line
      if (remove) return line.replace(pattern, '$1')
      if (style === 'quote') return `> ${line}`
      const plain = line.replace(LIST_MARKER, '$1')
      const indent = /^[ \t]*/.exec(plain)![0]
      const marker = style === 'number' ? `${++number}. ` : style === 'task' ? '- [ ] ' : '- '
      return indent + marker + plain.slice(indent.length)
    })
  }
  const insert = next.join('\n')
  if (start !== end) return { from, to, insert, select: [from, from + insert.length] }
  const cursor = Math.max(from, start + next[0].length - lines[0].length)
  return { from, to, insert, select: [cursor, cursor] }
}

/** A link around the selection, with the address selected to type over. */
export function insertLink(value: string, start: number, end: number): Edit {
  const text = value.slice(start, end) || 'link text'
  const insert = `[${text}](https://)`
  if (start === end) return { from: start, to: end, insert, select: [start + 1, start + 1 + text.length] }
  const address = start + text.length + 3
  return { from: start, to: end, insert, select: [address, address + 'https://'.length] }
}

/** Inline code for part of a line, a fenced block for several lines. */
export function toggleCode(value: string, start: number, end: number): Edit {
  const selected = value.slice(start, end)
  if (!selected.includes('\n')) return toggleWrap(value, start, end, '`', 'code')
  const fenced = /^```[^\n]*\n([\s\S]*)\n```$/.exec(selected)
  if (fenced) return { from: start, to: end, insert: fenced[1], select: [start, start + fenced[1].length] }
  const insert = '```\n' + selected.replace(/\n$/, '') + '\n```'
  return { from: start, to: end, insert, select: [start, start + insert.length] }
}

/**
 * A small table on the current line if it is empty, else after it, with its
 * first heading selected. Blank lines keep it apart from the text around it,
 * which would otherwise run into the table.
 */
export function insertTable(value: string, start: number): Edit {
  const [lineStart, lineEnd] = lineBounds(value, start, start)
  const table = '| Column | Column |\n| --- | --- |\n|  |  |'
  const empty = !value.slice(lineStart, lineEnd).trim()
  const from = empty ? lineStart : lineEnd
  const before = value.slice(0, from)
  const gap = !before.trim() ? '' : empty ? (before.endsWith('\n\n') ? '' : '\n') : '\n\n'
  const after = value.slice(lineEnd)
  const tail = after.startsWith('\n') && after.slice(1).split('\n')[0].trim() ? '\n' : ''
  const at = from + gap.length + 2
  return { from, to: lineEnd, insert: gap + table + tail, select: [at, at + 'Column'.length] }
}

/**
 * What Enter does in a list or quote: start the next item (with the next
 * number, or an unticked box), or end the list when the item is still empty.
 * Null when the line is neither.
 */
export function continueList(value: string, cursor: number): Edit | null {
  const lineStart = value.lastIndexOf('\n', cursor - 1) + 1
  const line = value.slice(lineStart, cursor)
  const match = /^((?:[ \t]*>[ \t]?)*)([ \t]*)(?:([-*+]) \[[ xX]\] |([-*+]) |(\d{1,9})([.)]) )/.exec(line)
  const quote = match ? null : /^(?:[ \t]*>[ \t]?)+/.exec(line)
  if (!match && !quote) return null
  const lineEnd = value.indexOf('\n', cursor) < 0 ? value.length : value.indexOf('\n', cursor)
  const prefix = match ? match[0] : quote![0]
  if (!line.slice(prefix.length).trim() && !value.slice(cursor, lineEnd).trim()) {
    // Enter on an empty item ends the list, as in most editors.
    return { from: lineStart, to: lineEnd, insert: '', select: [lineStart, lineStart] }
  }
  let next = prefix
  if (match) {
    const [, quotes, indent, taskBullet, bullet, number, delimiter] = match
    next = quotes + indent + (taskBullet ? `${taskBullet} [ ] ` : bullet ? `${bullet} ` : `${Number(number) + 1}${delimiter} `)
  }
  const insert = '\n' + next
  return { from: cursor, to: cursor, insert, select: [cursor + insert.length, cursor + insert.length] }
}

/** Text from a file: UTF-8 (byte order mark dropped), UTF-16 with a byte order mark, or else Windows-1252. */
export function decodeText(bytes: ArrayBuffer): { text: string; encoding: string } {
  const view = new Uint8Array(bytes)
  if ((view[0] === 0xff && view[1] === 0xfe) || (view[0] === 0xfe && view[1] === 0xff)) {
    return { text: new TextDecoder(view[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(view), encoding: 'UTF-16' }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(view), encoding: 'UTF-8' }
  } catch {
    return { text: new TextDecoder('windows-1252').decode(view), encoding: 'Windows-1252' }
  }
}

/** The name to download under: the same name, with .md added when it has no extension. */
export function markdownName(name: string): string {
  const trimmed = name.trim().replace(/[\\/:*?"<>|]/g, '_') || 'Untitled'
  return /\.[^.\s]+$/.test(trimmed) ? trimmed : `${trimmed}.md`
}

export type MarkdownMode = 'write' | 'split' | 'preview'
export type Draft = { name: string; text: string; edited: boolean; crlf: boolean }

const DRAFT_KEY = 'pdfer.markdown.draft'
const MODE_KEY = 'pdfer.markdown.mode'
/** Larger documents are not kept between sessions; browser storage is small. */
const MAX_DRAFT_CHARS = 1_000_000

/** The document open when the app was last closed, if it could be kept. Storage can be blocked, so every call is guarded. */
export function loadDraft(): Draft | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null')
    if (!value || typeof value !== 'object') return null
    const draft = value as Partial<Draft>
    if (typeof draft.name !== 'string' || typeof draft.text !== 'string') return null
    return { name: draft.name, text: draft.text, edited: draft.edited === true, crlf: draft.crlf === true }
  } catch {
    return null
  }
}

/** Keep `draft` for next time, or forget it with null. */
export function saveDraft(draft: Draft | null): void {
  try {
    if (draft && draft.text.length <= MAX_DRAFT_CHARS) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
    else localStorage.removeItem(DRAFT_KEY)
  } catch {
    // Not kept this time; the open document is unaffected.
  }
}

export function loadMode(): MarkdownMode {
  try {
    const value = localStorage.getItem(MODE_KEY)
    return value === 'write' || value === 'preview' ? value : 'split'
  } catch {
    return 'split'
  }
}

export function saveMode(mode: MarkdownMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    // Only a preference.
  }
}
