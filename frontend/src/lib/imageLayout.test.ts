import { describe, expect, it } from 'vitest'
import { DEFAULT_IMAGE_LAYOUT, effectiveImageLayout, imageLayoutProblem, imageLayoutSummary, imagePaperSize } from './imageLayout'

describe('image PDF layout', () => {
  it('uses A4 portrait with 10 mm margins and whole-image fitting by default', () => {
    expect(DEFAULT_IMAGE_LAYOUT).toEqual({ paper: 'a4', orientation: 'portrait', marginMm: 10, fit: 'contain' })
    expect(imagePaperSize(DEFAULT_IMAGE_LAYOUT)).toEqual([210, 297])
    expect(imageLayoutSummary(DEFAULT_IMAGE_LAYOUT)).toBe('A4 portrait · 210 × 297 mm · 10 mm margins')
  })

  it('reports the correct A4 and Letter dimensions in each orientation', () => {
    expect(imagePaperSize({ ...DEFAULT_IMAGE_LAYOUT, orientation: 'landscape' })).toEqual([297, 210])
    expect(imagePaperSize({ ...DEFAULT_IMAGE_LAYOUT, paper: 'letter' })).toEqual([215.9, 279.4])
    expect(imagePaperSize({ ...DEFAULT_IMAGE_LAYOUT, paper: 'letter', orientation: 'landscape' })).toEqual([279.4, 215.9])
  })

  it('rejects empty, negative and excessive margins before previewing', () => {
    for (const marginMm of [NaN, Infinity, -1, 101]) expect(imageLayoutProblem({ ...DEFAULT_IMAGE_LAYOUT, marginMm })).toBeTruthy()
    for (const marginMm of [0, 0.5, 10, 100]) expect(imageLayoutProblem({ ...DEFAULT_IMAGE_LAYOUT, marginMm })).toBeNull()
  })

  it('ignores hidden controls in image-size mode, including an unfinished margin field', () => {
    const layout = { ...DEFAULT_IMAGE_LAYOUT, paper: 'image' as const, orientation: 'landscape' as const, fit: 'stretch' as const, marginMm: NaN }
    expect(effectiveImageLayout(layout)).toEqual({ paper: 'image', orientation: 'portrait', marginMm: 0, fit: 'contain' })
    expect(imageLayoutProblem(layout)).toBeNull()
    expect(imagePaperSize(layout)).toBeNull()
    expect(imageLayoutSummary(layout)).toBe('Each page matches its image’s size and resolution')
  })
})
