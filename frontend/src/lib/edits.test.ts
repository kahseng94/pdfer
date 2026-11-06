import { describe, expect, it } from 'vitest'
import {
  boxBetween,
  boxesOverlap,
  bounds,
  clampPoint,
  constrainBox,
  copyRegionToPage,
  imagePlacement,
  moved,
  normalizeText,
  resized,
  regionOnPage,
  rotateRegion,
  toPayload,
  type DrawElement,
  type ImageElement,
  type LineElement,
  type RegionElement,
  type ShapeElement,
  type TextElement,
} from './edits'

const line: LineElement = { id: 'l', page: 1, type: 'line', x1: 10, y1: 30, x2: 50, y2: 20, stroke: '#000000', strokeWidth: 4 }
const draw: DrawElement = { id: 'd', page: 1, type: 'draw', points: [[5, 5], [8, 1], [2, 9]], stroke: '#000000', strokeWidth: 2 }
const rect: ShapeElement = { id: 'r', page: 2, type: 'rect', x: 1, y: 2, width: 30, height: 20, stroke: '#ff0000', strokeWidth: 2, fill: null }
const region: RegionElement = { id: 'region', type: 'region', page: 1, sourcePage: 1, x: 100.123, y: 200.456, width: 40, height: 20, source: { x: 10.123, y: 30.456, width: 80, height: 40 } }

describe('regions', () => {
  it('rotates about the center, swaps visible dimensions, and preserves the source', () => {
    const original: RegionElement = { ...region, x: 50, y: 60, width: 120, height: 40 }
    const page = { width: 300, height: 400 }
    const right = rotateRegion(original, 90, page)
    expect(right).toMatchObject({ rotation: 90, x: 90, y: 20, width: 40, height: 120, source: original.source, sourcePage: 1 })
    const upsideDown = rotateRegion(right, 180, page)
    expect(upsideDown).toMatchObject({ rotation: 180, x: 50, y: 60, width: 120, height: 40 })
    expect(rotateRegion(rotateRegion(upsideDown, 270, page), 0, page)).toMatchObject({ rotation: 0, x: 50, y: 60, width: 120, height: 40 })
    expect(original.rotation).toBeUndefined()
    expect(toPayload([right]).edits[0]).toMatchObject({ rotation: 90, width: 40, height: 120 })
  })

  it('fits rotated regions inside the page and carries rotation to independent copies', () => {
    const rotated = rotateRegion({ ...region, x: 0, y: 0, width: 300, height: 400 }, 90, { width: 300, height: 400 })
    expect(rotated).toMatchObject({ rotation: 90, x: 0, y: 87.5, width: 300, height: 225 })
    const copy = copyRegionToPage(rotated, 'turned-copy', 2, { width: 200, height: 300 })
    expect(copy).toMatchObject({ copy: true, rotation: 90, source: region.source, sourcePage: 1, width: 200, height: 150 })
  })

  it('offsets a same-page copy without changing the original or its source', () => {
    const copy = copyRegionToPage(region, 'same-page-copy', 1, { width: 300, height: 400 })
    expect(copy).toMatchObject({ id: 'same-page-copy', page: 1, sourcePage: 1, copy: true, width: 40, height: 20, source: region.source })
    expect(copy.x).toBeCloseTo(region.x + 12)
    expect(copy.y).toBeCloseTo(region.y + 12)
    expect(region).toMatchObject({ x: 100.123, y: 200.456 })
  })

  it('offsets inward at the page edges and keeps nearly full-page copies inside', () => {
    const page = { width: 300, height: 400 }
    expect(copyRegionToPage({ ...region, x: 260, y: 380 }, 'edge-copy', 1, page)).toMatchObject({ x: 248, y: 368, width: 40, height: 20 })
    expect(copyRegionToPage({ ...region, x: 1, y: 2, width: 298, height: 397 }, 'wide-copy', 1, page)).toMatchObject({ x: 2, y: 0, width: 298, height: 397 })
    expect(copyRegionToPage({ ...region, x: 0, y: 0, ...page }, 'full-copy', 1, page)).toMatchObject({ x: 0, y: 0, ...page, copy: true })
  })

  it('makes an independent copy, preserves the selected region, and fits the target page', () => {
    const original = structuredClone(region)
    const copy = copyRegionToPage(region, 'copy', 2, { width: 30, height: 50 })
    expect(copy).toMatchObject({ id: 'copy', copy: true, page: 2, sourcePage: 1, source: region.source, x: 0, y: 35, width: 30, height: 15 })
    expect(region).toEqual(original)
    const another = copyRegionToPage(copy, 'copy-again', 1, { width: 300, height: 400 })
    expect(another).toMatchObject({ id: 'copy-again', copy: true, page: 1, sourcePage: 1, source: region.source, width: 30, height: 15 })
    expect(toPayload([copy]).edits[0]).toMatchObject({ copy: true, page: 2, sourcePage: 1, source: { x: 10.12, y: 30.46, width: 80, height: 40 } })
  })
  it('serializes deleted regions as masks while keeping their original source and former destination', () => {
    expect(toPayload([{ ...region, page: 2, deleted: true }])).toEqual({ images: [], edits: [{
      type: 'region', page: 2, sourcePage: 1, deleted: true, x: 100.12, y: 200.46, width: 40, height: 20,
      source: { x: 10.12, y: 30.46, width: 80, height: 40 },
    }] })
  })
  it('moves and resizes the destination without changing the original selection', () => {
    const next = moved(region, 10, 20)
    expect(next.source).toEqual(region.source)
    expect(bounds(next)).toEqual({ x: 110.123, y: 220.456, width: 40, height: 20 })
    expect(toPayload([next])).toEqual({ images: [], edits: [{ type: 'region', page: 1, sourcePage: 1, x: 110.12, y: 220.46, width: 40, height: 20, source: { x: 10.12, y: 30.46, width: 80, height: 40 } }] })
  })

  it('changes destination pages while preserving the source and fitting proportionally', () => {
    const next = regionOnPage(region, 2, { width: 30, height: 50 })
    expect(next).toMatchObject({ page: 2, sourcePage: 1, source: region.source, x: 0, y: 35, width: 30, height: 15 })
    const back = regionOnPage(next, 1, { width: 300, height: 400 })
    expect(back).toMatchObject({ page: 1, sourcePage: 1, source: region.source, width: 30, height: 15 })
    expect(toPayload([next]).edits[0]).toMatchObject({ page: 2, sourcePage: 1 })
  })

  it('keeps a region within the page and preserves aspect ratio at its limits', () => {
    const page = { width: 300, height: 400 }
    expect(clampPoint([-20, 500], page)).toEqual([0, 400])
    expect(constrainBox({ x: -10, y: 390, width: 40, height: 20 }, page)).toEqual({ x: 0, y: 380, width: 40, height: 20 })
    expect(constrainBox({ x: -50, y: -20, width: 600, height: 200 }, page, true)).toEqual({ x: 0, y: 0, width: 300, height: 100 })
  })

  it('allows adjacent selections but detects intersecting sources', () => {
    const a = { x: 0, y: 0, width: 10, height: 20 }
    expect(boxesOverlap(a, { ...a, x: 10 })).toBe(false)
    expect(boxesOverlap(a, { ...a, x: 9 })).toBe(true)
    expect(boxesOverlap(a, { x: 2, y: 2, width: 2, height: 2 })).toBe(true)
  })
})

describe('bounds', () => {
  it('pads lines and strokes by half their width', () => {
    expect(bounds(line)).toEqual({ x: 8, y: 18, width: 44, height: 14 })
    expect(bounds(draw)).toEqual({ x: 1, y: 0, width: 8, height: 10 })
  })

  it('is the box itself for boxed elements', () => {
    expect(bounds(rect)).toEqual({ x: 1, y: 2, width: 30, height: 20 })
  })
})

describe('moved', () => {
  it('shifts every coordinate', () => {
    expect(moved(line, 1, -1)).toMatchObject({ x1: 11, y1: 29, x2: 51, y2: 19 })
    expect(moved(draw, 1, 1).points).toEqual([[6, 6], [9, 2], [3, 10]])
    expect(moved(rect, -1, -2)).toMatchObject({ x: 0, y: 0, width: 30, height: 20 })
  })
})

describe('resized', () => {
  const box = { x: 10, y: 10, width: 40, height: 20 }

  it('moves the dragged edges only', () => {
    expect(resized(box, 'se', 5, 5)).toEqual({ x: 10, y: 10, width: 45, height: 25 })
    expect(resized(box, 'nw', 5, 5)).toEqual({ x: 15, y: 15, width: 35, height: 15 })
    expect(resized(box, 'e', 5, 5)).toEqual({ x: 10, y: 10, width: 45, height: 20 })
    expect(resized(box, 'n', 5, -5)).toEqual({ x: 10, y: 5, width: 40, height: 25 })
  })

  it('never shrinks past the minimum', () => {
    expect(resized(box, 'se', -100, -100)).toEqual({ x: 10, y: 10, width: 2, height: 2 })
    expect(resized(box, 'nw', 100, 100)).toEqual({ x: 48, y: 28, width: 2, height: 2 })
  })

  it('keeps the aspect ratio from a corner when asked', () => {
    expect(resized(box, 'se', 40, 0, true)).toEqual({ x: 10, y: 10, width: 80, height: 40 })
    expect(resized(box, 'nw', 0, -20, true)).toEqual({ x: -30, y: -10, width: 80, height: 40 })
    expect(resized(box, 'e', 40, 0, true)).toEqual({ x: 10, y: 10, width: 80, height: 20 })
  })
})

describe('boxBetween', () => {
  it('takes any two opposite corners', () => {
    expect(boxBetween([10, 20], [5, 30])).toEqual({ x: 5, y: 20, width: 5, height: 10 })
  })
})

describe('imagePlacement', () => {
  it('centres the picture at 96 dpi', () => {
    expect(imagePlacement({ width: 96, height: 48 }, { width: 612, height: 792 })).toEqual({ x: 270, y: 378, width: 72, height: 36 })
  })

  it('shrinks big pictures to 60% of the page', () => {
    const box = imagePlacement({ width: 4000, height: 2000 }, { width: 600, height: 800 })
    expect(box).toEqual({ x: 120, y: 310, width: 360, height: 180 })
  })
})

describe('normalizeText', () => {
  it('unifies line endings and drops control characters', () => {
    expect(normalizeText('a\r\nb\rc\td\x07e')).toBe('a\nb\nc    de')
  })
})

describe('toPayload', () => {
  const file = new File([''], 'a.png', { type: 'image/png' })
  const other = new File([''], 'b.png', { type: 'image/png' })
  const text: TextElement = { id: 't', page: 1, type: 'text', x: 1.234, y: 5.678, text: 'hi\r\nthere', size: 12, color: '#000000', family: 'serif', bold: true, italic: false }
  const image = (id: string, f: File): ImageElement => ({ id, page: 1, type: 'image', x: 0, y: 0, width: 10, height: 5, file: f, url: 'blob:x' })

  it('drops ids, rounds positions and numbers the images once each', () => {
    const { edits, images } = toPayload([text, image('a', file), image('b', other), image('c', file), rect])
    expect(images).toEqual([file, other])
    expect(edits).toEqual([
      { type: 'text', page: 1, x: 1.23, y: 5.68, text: 'hi\nthere', size: 12, color: '#000000', family: 'serif', bold: true, italic: false },
      { type: 'image', page: 1, x: 0, y: 0, width: 10, height: 5, image: 0 },
      { type: 'image', page: 1, x: 0, y: 0, width: 10, height: 5, image: 1 },
      { type: 'image', page: 1, x: 0, y: 0, width: 10, height: 5, image: 0 },
      { type: 'rect', page: 2, x: 1, y: 2, width: 30, height: 20, stroke: '#ff0000', strokeWidth: 2, fill: null },
    ])
  })

  it('serializes strokes', () => {
    expect(toPayload([line, draw]).edits).toEqual([
      { type: 'line', page: 1, x1: 10, y1: 30, x2: 50, y2: 20, stroke: '#000000', strokeWidth: 4 },
      { type: 'draw', page: 1, points: [[5, 5], [8, 1], [2, 9]], stroke: '#000000', strokeWidth: 2 },
    ])
  })
})
