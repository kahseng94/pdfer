import { describe, expect, it } from 'vitest'
import {
  clampCrop,
  fitCrop,
  frameSize,
  headGuide,
  limitZoom,
  MAX_ZOOM,
  MIN_CROP,
  panCrop,
  PAPERS,
  pixelsAt,
  PRESETS,
  reshapeCrop,
  sheetLayout,
  sizeLabel,
  zoomCrop,
} from './photo'

const image = { width: 4000, height: 3000 }
const aspect = 35 / 45

describe('fitCrop', () => {
  it('fills the picture, centred', () => {
    const crop = fitCrop(image, aspect)
    expect(crop.height).toBeCloseTo(3000)
    expect(crop.width).toBeCloseTo(3000 * aspect)
    expect([crop.cx, crop.cy, crop.angle]).toEqual([2000, 1500, 0])
  })

  it('fits the turned crop when the picture is on its side', () => {
    const crop = fitCrop(image, aspect, 90)
    expect(crop.width).toBeCloseTo(3000)
    expect(crop.height).toBeCloseTo(3000 / aspect)
  })
})

describe('clampCrop', () => {
  it('moves a crop back inside', () => {
    const crop = clampCrop({ cx: 0, cy: 5000, width: 700, height: 900, angle: 0 }, image)
    expect([crop.cx, crop.cy]).toEqual([350, 2550])
  })

  it('shrinks a crop that is too big, keeping its shape', () => {
    const crop = clampCrop({ cx: 2000, cy: 1500, width: 7000, height: 9000, angle: 0 }, image)
    expect(crop.height).toBeCloseTo(3000)
    expect(crop.width / crop.height).toBeCloseTo(7 / 9)
  })

  it('keeps a tilted crop inside', () => {
    const crop = clampCrop({ cx: 0, cy: 0, width: 1000, height: 1000, angle: 45 }, image)
    const half = (1000 * Math.SQRT2) / 2
    expect(crop.cx).toBeCloseTo(half)
    expect(crop.cy).toBeCloseTo(half)
  })
})

describe('panCrop', () => {
  const crop = { cx: 2000, cy: 1500, width: 1000, height: 1000, angle: 0 }

  it('moves the crop against the drag, in picture pixels', () => {
    const moved = panCrop(crop, 10, -4, 0.5, image)
    expect([moved.cx, moved.cy]).toEqual([1980, 1508])
  })

  it('turns the drag with the picture', () => {
    const moved = panCrop({ ...crop, angle: 90 }, 10, 0, 0.5, image)
    expect(moved.cx).toBeCloseTo(2000)
    expect(moved.cy).toBeCloseTo(1520)
  })

  it('stops at the edge', () => {
    expect(panCrop(crop, 100000, 0, 1, image).cx).toBe(500)
  })
})

describe('zoomCrop', () => {
  const crop = { cx: 2000, cy: 1500, width: 1000, height: 1000, angle: 0 }

  it('zooms in about the centre', () => {
    expect(zoomCrop(crop, 2, image)).toEqual({ ...crop, width: 500, height: 500 })
  })

  it('never goes below the minimum', () => {
    expect(zoomCrop(crop, 1e9, image).width).toBe(MIN_CROP)
  })

  it('zooms out only as far as the picture', () => {
    expect(zoomCrop(crop, 0.1, image).height).toBeCloseTo(3000)
  })
})

describe('limitZoom', () => {
  it('stops at the slider maximum', () => {
    const fit = fitCrop(image, 1).width
    const tiny = { cx: 2000, cy: 1500, width: 40, height: 40, angle: 0 }
    expect(limitZoom(tiny, image).width).toBeCloseTo(fit / MAX_ZOOM)
    const fine = { ...tiny, width: 1000, height: 1000 }
    expect(limitZoom(fine, image)).toBe(fine)
  })
})

describe('reshapeCrop', () => {
  it('changes the aspect and angle around the same centre', () => {
    const crop = reshapeCrop({ cx: 2000, cy: 1500, width: 1000, height: 1000, angle: 0 }, 1 / 2, 5, image)
    expect([crop.cx, crop.cy, crop.width, crop.height, crop.angle]).toEqual([2000, 1500, 1000, 2000, 5])
  })
})

describe('frameSize', () => {
  it('fits the aspect inside the stage with a margin', () => {
    expect(frameSize({ width: 500, height: 400 }, aspect, 20)).toEqual({ width: 360 * aspect, height: 360 })
    expect(frameSize({ width: 300, height: 1000 }, 2, 0)).toEqual({ width: 300, height: 150 })
  })
})

describe('pixelsAt', () => {
  it('rounds to whole pixels', () => {
    expect(pixelsAt({ width: 50.8, height: 50.8 }, 300)).toEqual({ width: 600, height: 600 })
    expect(pixelsAt({ width: 35, height: 45 }, 600)).toEqual({ width: 827, height: 1063 })
  })
})

describe('sizeLabel', () => {
  it('uses inches for inch sizes and millimetres otherwise', () => {
    expect(sizeLabel({ width: 50.8, height: 50.8 })).toBe('2 × 2 in')
    expect(sizeLabel({ width: 35, height: 45 })).toBe('35 × 45 mm')
    expect(sizeLabel({ width: 33, height: 48 })).toBe('33 × 48 mm')
  })
})

describe('headGuide', () => {
  it('uses the published head range', () => {
    const guide = headGuide(PRESETS.find((p) => p.id === 'schengen')!)
    expect([guide.min, guide.max]).toEqual([32, 36])
    expect(guide.crown).toBeCloseTo(4.95)
  })

  it('falls back to a typical range', () => {
    const guide = headGuide({ width: 40, height: 60 })
    expect([guide.min, guide.max]).toEqual([36, 45])
  })
})

describe('sheetLayout', () => {
  it('matches the backend', () => {
    expect(sheetLayout(PAPERS['4x6'], { width: 35, height: 45 })).toEqual({ cols: 2, rows: 3, landscape: false, copies: 6 })
    expect(sheetLayout(PAPERS['4x6'], { width: 50.8, height: 50.8 })).toEqual({ cols: 1, rows: 2, landscape: false, copies: 2 })
    expect(sheetLayout(PAPERS.letter, { width: 35, height: 45 })).toEqual({ cols: 7, rows: 4, landscape: true, copies: 28 })
    expect(sheetLayout(PAPERS.a4, { width: 35, height: 45 })).toEqual({ cols: 5, rows: 6, landscape: false, copies: 30 })
    expect(sheetLayout(PAPERS['4x6'], { width: 120, height: 120 })).toEqual({ cols: 0, rows: 0, landscape: false, copies: 0 })
  })
})
