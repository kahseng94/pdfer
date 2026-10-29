import { describe, expect, it } from 'vitest'
import { cropFromDrag, DEFAULT_ORGANIZE, displayedSize, layoutProblem, pageLayout, POINTS_PER_MM, targetSize, type OrganizeItem } from './organize'

const items: OrganizeItem[] = [{ id: 'original', page: 1, rotation: 0 }, { id: 'copy', page: 1, rotation: 90 }, { id: 'second', page: 2, rotation: 0 }]
const crop = { top: 10, right: 20, bottom: 30, left: 40 }
const settings = { ...DEFAULT_ORGANIZE, cropEnabled: true, resizeEnabled: true, crop }

describe('Organize selection and geometry', () => {
  it('selects copies independently and follows the card through reordering', () => {
    const selected = new Set(['copy'])
    expect(pageLayout(items, selected, settings)).toEqual({ pages: [2], crop, resize: { width: 210, height: 297 } })
    expect(pageLayout([items[1], items[2], items[0]], selected, settings)?.pages).toEqual([1])
    expect(pageLayout([items[0], items[2]], selected, settings)?.pages).toEqual([])
  })
  it('leaves the original API path available when layout features are disabled', () => {
    expect(pageLayout(items, new Set(), DEFAULT_ORGANIZE)).toBeUndefined()
    expect(layoutProblem(items, [], undefined)).toBeNull()
  })
  it('supports paper orientation and exact custom dimensions', () => {
    expect(targetSize({ ...settings, paper: 'letter', orientation: 'landscape' })).toEqual({ width: 279.4, height: 215.9 })
    expect(targetSize({ ...settings, paper: 'custom', width: 123.5, height: 80 })).toEqual({ width: 123.5, height: 80 })
  })
  it('checks only selected pages using dimensions after relative rotation', () => {
    const sizes = [{ width: 100 * POINTS_PER_MM, height: 200 * POINTS_PER_MM }, { width: 10, height: 10 }]
    const options = { pages: [2], crop: { top: 0, bottom: 0, left: 60, right: 60 }, resize: null }
    expect(displayedSize(sizes[0], 90)).toEqual({ width: sizes[0].height, height: sizes[0].width })
    expect(layoutProblem(items, sizes, options)).toBeNull()
    expect(layoutProblem(items, sizes, { ...options, pages: [1] })).toContain('output page 1')
    expect(layoutProblem(items, sizes, { ...options, pages: [] })).toContain('Select at least one')
  })
  it('rejects incomplete, nonfinite, negative and excessive input', () => {
    for (const width of [NaN, Infinity, 0, 5081]) {
      expect(layoutProblem(items, [], { pages: [1], crop: null, resize: { width, height: 297 } })).toContain('width and height')
    }
    for (const top of [NaN, -1, 5081]) {
      expect(layoutProblem(items, [], { pages: [1], crop: { ...crop, top }, resize: null })).toContain('Crop margins')
    }
  })
  it('draws a crop in either direction, clamps outside the page, and ignores clicks', () => {
    const size = { width: 210, height: 297 }
    const start = { width: 200, height: 280 }
    const end = { width: 10, height: 20 }
    expect(cropFromDrag(start, end, size)).toEqual({ top: 20, right: 10, bottom: 17, left: 10 })
    expect(cropFromDrag(end, start, size)).toEqual(cropFromDrag(start, end, size))
    expect(cropFromDrag({ width: -10, height: -5 }, { width: 300, height: 400 }, size)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
    expect(cropFromDrag(start, start, size)).toBeNull()
  })
})
