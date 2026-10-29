import { describe, expect, it } from 'vitest'
import { bookmarkProblem, formChanges, indentBookmark, moveBookmark, redactionFromDrag, subtreeEnd, type BookmarkEntry, type FormField } from './documentTools'

const entry = (id: string, level = 0): BookmarkEntry => ({ id, sourceId: id, title: id, page: 1, level })
const entries = [entry('A'), entry('a1', 1), entry('a1-child', 2), entry('a2', 1), entry('B'), entry('b1', 1)]
const shape = (items: BookmarkEntry[]) => items.map((item) => [item.id, item.level])

describe('bookmark hierarchy editing', () => {
  it('moves entire subtrees between siblings without changing destinations', () => {
    expect(subtreeEnd(entries, 1)).toBe(3)
    expect(shape(moveBookmark(entries, 1, 1))).toEqual([['A', 0], ['a2', 1], ['a1', 1], ['a1-child', 2], ['B', 0], ['b1', 1]])
    expect(shape(moveBookmark(entries, 4, -1))).toEqual([['B', 0], ['b1', 1], ['A', 0], ['a1', 1], ['a1-child', 2], ['a2', 1]])
    expect(entries[0].title).toBe('A')
  })
  it('indents a section and outdents it beyond its parent’s remaining children', () => {
    expect(shape(indentBookmark(entries, 4, 1))).toEqual([['A', 0], ['a1', 1], ['a1-child', 2], ['a2', 1], ['B', 1], ['b1', 2]])
    expect(shape(indentBookmark(entries, 1, -1))).toEqual([['A', 0], ['a2', 1], ['a1', 0], ['a1-child', 1], ['B', 0], ['b1', 1]])
    expect(indentBookmark(entries, 0, 1)).toEqual(entries)
  })
  it('allows retained external actions, but requires a page on new bookmarks and valid nesting', () => {
    expect(bookmarkProblem([{ ...entry('external'), page: null }], 3)).toBeNull()
    expect(bookmarkProblem([{ ...entry('new'), sourceId: null, page: null }], 3)).toContain('valid page')
    expect(bookmarkProblem([entry('bad', 1)], 3)).toContain('nesting')
    expect(bookmarkProblem([{ ...entry('bad'), title: '' }], 3)).toContain('title')
  })
})

describe('form edits', () => {
  it('sends only edited writable fields, with duplicate names kept separate by ID', () => {
    const field = (id: string, value: string | boolean, readOnly = false): FormField => ({ id, name: 'duplicate', label: 'Duplicate', pages: [1], required: false, readOnly, type: typeof value === 'boolean' ? 'checkbox' : 'text', value, options: [], reason: null })
    expect(formChanges([field('a', 'before'), field('b', 'unchanged'), field('c', false), field('d', 'fixed', true)], { a: 'after', b: 'unchanged', c: true, d: 'ignored' })).toEqual({ a: 'after', c: true })
  })
})

it('draws and clamps redaction rectangles in either direction and ignores clicks', () => {
  const size = { width: 200, height: 300 }
  expect(redactionFromDrag(2, { x: 150, y: 200 }, { x: -10, y: 20 }, size)).toMatchObject({ page: 2, x: 0, y: 20, width: 150, height: 180 })
  expect(redactionFromDrag(1, { x: 5, y: 5 }, { x: 5, y: 5 }, size)).toBeNull()
})
