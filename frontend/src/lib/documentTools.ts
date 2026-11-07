export type FormValue = string | boolean
export type FormField = {
  id: string; name: string; label: string; pages: number[]; required: boolean; readOnly: boolean
  type: 'text' | 'checkbox' | 'radio' | 'choice' | 'unsupported'; value: FormValue
  options: { value: string; label: string }[]; reason: string | null
  multiline?: boolean; maxLength?: number | null; editable?: boolean; allowEmpty?: boolean
}
export type FormSchema = { fields: FormField[]; pages: number; signed: boolean; xfa: boolean }
export type BookmarkEntry = { id: string; sourceId: string | null; title: string; page: number | null; level: number }
export type BookmarkSchema = { bookmarks: BookmarkEntry[]; pages: number }
export type PdfSize = { width: number; height: number }
export type Redaction = { id: string; page: number; x: number; y: number; width: number; height: number }

export function formChanges(fields: readonly FormField[], values: Record<string, FormValue>): Record<string, FormValue> {
  return Object.fromEntries(fields.filter((field) => !field.readOnly && values[field.id] !== undefined && values[field.id] !== field.value).map((field) => [field.id, values[field.id]]))
}

export function subtreeEnd(entries: readonly BookmarkEntry[], index: number): number {
  let end = index + 1
  while (end < entries.length && entries[end].level > entries[index].level) end++
  return end
}
export function previousSibling(entries: readonly BookmarkEntry[], index: number): number {
  for (let i = index - 1; i >= 0; i--) {
    if (entries[i].level < entries[index].level) break
    if (entries[i].level === entries[index].level) return i
  }
  return -1
}
export function moveBookmark(entries: readonly BookmarkEntry[], index: number, direction: -1 | 1): BookmarkEntry[] {
  const end = subtreeEnd(entries, index)
  if (direction === -1) {
    const previous = previousSibling(entries, index)
    if (previous < 0) return [...entries]
    return [...entries.slice(0, previous), ...entries.slice(index, end), ...entries.slice(previous, index), ...entries.slice(end)]
  }
  if (end >= entries.length || entries[end].level !== entries[index].level) return [...entries]
  const nextEnd = subtreeEnd(entries, end)
  return [...entries.slice(0, index), ...entries.slice(end, nextEnd), ...entries.slice(index, end), ...entries.slice(nextEnd)]
}
export function indentBookmark(entries: readonly BookmarkEntry[], index: number, direction: -1 | 1): BookmarkEntry[] {
  const end = subtreeEnd(entries, index)
  const branch = entries.slice(index, end)
  if (direction === 1) {
    if (previousSibling(entries, index) < 0 || branch.some((entry) => entry.level >= 16)) return [...entries]
    return [...entries.slice(0, index), ...branch.map((entry) => ({ ...entry, level: entry.level + 1 })), ...entries.slice(end)]
  }
  if (entries[index].level === 0) return [...entries]
  let parent = index - 1
  while (parent >= 0 && entries[parent].level >= entries[index].level) parent--
  const parentEnd = subtreeEnd(entries, parent)
  return [...entries.slice(0, index), ...entries.slice(end, parentEnd), ...branch.map((entry) => ({ ...entry, level: entry.level - 1 })), ...entries.slice(parentEnd)]
}

export function bookmarkProblem(entries: readonly BookmarkEntry[], total: number): string | null {
  if (entries.length > 2000) return 'Use at most 2000 bookmarks.'
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry.title.trim() || entry.title.length > 200 || /[\r\n]/.test(entry.title)) return `Bookmark ${i + 1}: enter a single-line title of 1–200 characters.`
    if (entry.page === null ? !entry.sourceId : !Number.isInteger(entry.page) || entry.page < 1 || entry.page > total) return `Bookmark ${i + 1}: choose a valid page.`
    if (!Number.isInteger(entry.level) || entry.level < 0 || entry.level > 16 || entry.level > (i ? entries[i - 1].level + 1 : 0)) return `Bookmark ${i + 1} has an invalid nesting level.`
  }
  return null
}

export function redactionFromDrag(page: number, start: { x: number; y: number }, end: { x: number; y: number }, size: PdfSize): Redaction | null {
  const x = Math.max(0, Math.min(size.width, Math.min(start.x, end.x)))
  const y = Math.max(0, Math.min(size.height, Math.min(start.y, end.y)))
  const right = Math.max(0, Math.min(size.width, Math.max(start.x, end.x)))
  const bottom = Math.max(0, Math.min(size.height, Math.max(start.y, end.y)))
  if (right - x < 1 || bottom - y < 1) return null
  return { id: crypto.randomUUID(), page, x, y, width: right - x, height: bottom - y }
}
