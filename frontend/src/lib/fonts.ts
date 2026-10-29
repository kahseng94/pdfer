// The fonts text edits are previewed and saved in.
//
// Latin text is set in the standard PDF fonts, previewed with CSS stacks that
// share their metrics. Anything else is set in the fonts the backend embeds,
// which are loaded here so the preview is drawn with the very same files.

import type { FontFamily, TextElement } from './edits'

/** CSS stacks that look like the standard PDF fonts (Arial shares Helvetica's metrics). */
export const FONT_FAMILIES: { value: FontFamily; label: string; css: string }[] = [
  { value: 'sans', label: 'Sans', css: 'Helvetica, Arial, sans-serif' },
  { value: 'serif', label: 'Serif', css: "'Times New Roman', Times, serif" },
  { value: 'mono', label: 'Mono', css: "'Courier New', Courier, monospace" },
]

export type CodeRange = [first: number, last: number]

/** What the backend reports: each family's embedded fonts in fallback order, and the code points they cover. */
export type FontInfo = { families: Record<FontFamily, string[]>; coverage: CodeRange[] }

let info: FontInfo | null = null
let loading: Promise<FontInfo | null> | null = null

function cssName(file: string): string {
  return `pdfer ${file.replace(/\.ttf$/i, '')}`
}

/** Fetch the backend's font list and load the files, once. Resolves to null when that fails, and can be tried again. */
export function loadFonts(): Promise<FontInfo | null> {
  loading ??= (async () => {
    const res = await fetch('/api/fonts')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const next = (await res.json()) as FontInfo
    const files = new Set(Object.values(next.families).flat())
    await Promise.all(
      [...files].map(async (file) => {
        const face = new FontFace(cssName(file), `url(/api/fonts/${encodeURIComponent(file)})`)
        document.fonts.add(face)
        await face.load()
      }),
    )
    info = next
    return next
  })().catch(() => {
    loading = null
    return null
  })
  return loading
}

export function fontInfo(): FontInfo | null {
  return info
}

/** For tests. */
export function setFontInfo(next: FontInfo | null): void {
  info = next
}

// Everything the standard PDF fonts can write: printable Latin-1 plus the extra characters Windows-1252 adds.
const WIN_ANSI = /^[\x20-\x7e\xa0-\xff\n€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]$/

/** Whether the text goes beyond the standard fonts, so the embedded ones are used for all of it. */
export function needsEmbeddedFont(text: string): boolean {
  for (const ch of text) if (!WIN_ANSI.test(ch)) return true
  return false
}

function covered(ch: string, coverage: CodeRange[]): boolean {
  const code = ch.codePointAt(0) ?? 0
  let lo = 0
  let hi = coverage.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [first, last] = coverage[mid]
    if (code < first) hi = mid - 1
    else if (code > last) lo = mid + 1
    else return true
  }
  return false
}

/** Characters in the text that no font can write, each once. Text within the standard fonts needs no check. */
export function unsupportedChars(text: string, coverage: CodeRange[] = info?.coverage ?? []): string[] {
  if (!needsEmbeddedFont(text)) return []
  const bad = new Set<string>()
  for (const ch of text) if (ch !== '\n' && ch !== '\r' && !covered(ch, coverage)) bad.add(ch)
  return [...bad]
}

/** The CSS font-family for a family, which is the embedded chain when the text needs it and the fonts are loaded. */
export function familyCss(family: FontFamily, text = ''): string {
  const chain = needsEmbeddedFont(text) ? (info?.families[family] ?? []) : []
  if (chain.length) return chain.map((file) => `"${cssName(file)}"`).join(', ') + ', sans-serif'
  return FONT_FAMILIES.find((f) => f.value === family)?.css ?? FONT_FAMILIES[0].css
}

export function fontCss(el: Pick<TextElement, 'size' | 'family' | 'bold' | 'italic' | 'text'>, scale = 1): string {
  return `${el.italic ? 'italic ' : ''}${el.bold ? 'bold ' : ''}${el.size * scale}px ${familyCss(el.family, el.text)}`
}
