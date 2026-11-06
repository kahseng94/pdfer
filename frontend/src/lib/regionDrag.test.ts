import { describe, expect, it } from 'vitest'
import { placeDraggedRegion, regionScrollDelta, type RegionPageSurface } from './regionDrag'
import type { RegionElement } from './edits'

const region: RegionElement = { id: 'region', type: 'region', page: 1, sourcePage: 1, source: { x: 20, y: 40, width: 160, height: 100 }, x: 20, y: 40, width: 160, height: 100, copy: true, rotation: 90 }
const surfaces: RegionPageSurface[] = [
  { page: 1, size: { width: 200, height: 300 }, rect: { left: 100, top: -200, width: 400, height: 600 } },
  { page: 2, size: { width: 120, height: 160 }, rect: { left: 180, top: 440, width: 240, height: 320 } },
]

describe('region dragging across pages', () => {
  it('maps screen coordinates to each page and preserves the grabbed fraction after fitting', () => {
    expect(placeDraggedRegion(region, [300, 560], [.25, .3], surfaces, 1)).toEqual({ ...region, page: 2, x: 0, y: 37.5, width: 120, height: 75 })
    expect(region.page).toBe(1)
  })
  it('keeps a region inside its last page in gaps and restores its size when dragged back', () => {
    expect(placeDraggedRegion(region, [0, 420], [.25, .3], surfaces, 2)).toMatchObject({ page: 2, x: 0, y: 0, width: 120, height: 75 })
    expect(placeDraggedRegion(region, [300, 100], [.25, .3], surfaces, 2)).toMatchObject({ page: 1, x: 40, y: 120, width: 160, height: 100 })
    expect(placeDraggedRegion(region, [0, 0], [0, 0], [], 1)).toBe(region)
  })
})

describe('drag edge scrolling', () => {
  it('scrolls in either direction only near the usable viewport edges', () => {
    expect(regionScrollDelta(400, 100, 700, 16)).toBe(0)
    expect(regionScrollDelta(100, 100, 700, 16)).toBeCloseTo(-11.2)
    expect(regionScrollDelta(700, 100, 700, 16)).toBeCloseTo(11.2)
    expect(regionScrollDelta(650, 100, 700, 16)).toBeGreaterThan(0)
    expect(regionScrollDelta(650, 100, 700, 16)).toBeLessThan(11.2)
  })
  it('caps delayed frames and ignores an unusable viewport', () => {
    expect(regionScrollDelta(900, 100, 700, 1000)).toBeCloseTo(22.4)
    expect(regionScrollDelta(0, 100, 100, 16)).toBe(0)
  })
})
