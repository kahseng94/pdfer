import { describe, expect, it } from 'vitest'
import {
  boxBetween,
  bounds,
  imagePlacement,
  moved,
  normalizeText,
  resized,
  toPayload,
  type DrawElement,
  type ImageElement,
  type LineElement,
  type ShapeElement,
  type TextElement,
} from './edits'

const line: LineElement = { id: 'l', page: 1, type: 'line', x1: 10, y1: 30, x2: 50, y2: 20, stroke: '#000000', strokeWidth: 4 }
const draw: DrawElement = { id: 'd', page: 1, type: 'draw', points: [[5, 5], [8, 1], [2, 9]], stroke: '#000000', strokeWidth: 2 }
const rect: ShapeElement = { id: 'r', page: 2, type: 'rect', x: 1, y: 2, width: 30, height: 20, stroke: '#ff0000', strokeWidth: 2, fill: null }

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
