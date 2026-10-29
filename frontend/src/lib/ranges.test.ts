import { describe, expect, it } from 'vitest'
import { pagesIn, parseSpec, toPageSpec, toSpec, turn } from './ranges'

describe('parseSpec', () => {
  it('parses pages, ranges and open ends', () => {
    expect(parseSpec('1-3, 5, 8-', 10)).toEqual({ ranges: [[1, 3], [5, 5], [8, 10]], invalid: [] })
    expect(parseSpec('-2', 10).ranges).toEqual([[1, 2]])
  })

  it('reports parts that are malformed or out of bounds', () => {
    expect(parseSpec('abc, 0, 4-2, 3-11, 2', 10)).toEqual({ ranges: [[2, 2]], invalid: ['abc', '0', '4-2', '3-11'] })
  })

  it('ignores empty parts', () => {
    expect(parseSpec(' , ,', 10)).toEqual({ ranges: [], invalid: [] })
  })
})

describe('toSpec', () => {
  it('collapses consecutive pages', () => {
    expect(toSpec([5, 1, 2, 3, 9, 10])).toBe('1-3, 5, 9-10')
    expect(toSpec([])).toBe('')
  })

  it('round-trips through pagesIn', () => {
    const pages = pagesIn(parseSpec('2-4, 7, 9-10', 10).ranges)
    expect(toSpec(pages)).toBe('2-4, 7, 9-10')
  })
})

describe('toPageSpec', () => {
  it('writes a rotation only when there is one', () => {
    expect(
      toPageSpec([
        { page: 3, rotation: 90 },
        { page: 1, rotation: 0 },
        { page: 2, rotation: 180 },
      ]),
    ).toBe('3:90,1,2:180')
    expect(toPageSpec([])).toBe('')
  })
})

describe('turn', () => {
  it('cycles clockwise through quarter turns', () => {
    expect(([0, 90, 180, 270] as const).map(turn)).toEqual([90, 180, 270, 0])
  })
})
