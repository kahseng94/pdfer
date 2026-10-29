import { describe, expect, it } from 'vitest'
import { DEFAULT_NUMBERS, DEFAULT_WATERMARK, numberText, stampProblem, type StampSettings } from './stamps'

const settings = (): StampSettings => ({ pages: '1-4', numbers: { ...DEFAULT_NUMBERS }, watermark: null })

describe('numbering examples', () => {
  it('counts skipped pages when numbering the document', () => {
    expect(numberText(DEFAULT_NUMBERS, 3, 0, 2, 4)).toBe('Page 3 of 4')
    expect(numberText({ ...DEFAULT_NUMBERS, start: 5 }, 3, 0, 2, 4)).toBe('Page 7 of 8')
  })

  it('counts only selected pages when requested, starting at the chosen number', () => {
    const numbers = { ...DEFAULT_NUMBERS, mode: 'selected' as const, start: 5 }
    expect(numberText(numbers, 3, 0, 2, 4)).toBe('Page 5 of 6')
    expect(numberText(numbers, 4, 1, 2, 4)).toBe('Page 6 of 6')
  })

  it.each([['number', '3'], ['page', 'Page 3'], ['of-total', '3 of 4'], ['page-of-total', 'Page 3 of 4']] as const)('supports %s format', (format, expected) => {
    expect(numberText({ ...DEFAULT_NUMBERS, format }, 3, 0, 2, 4)).toBe(expected)
  })
})

describe('stamp validation', () => {
  it('allows either feature or both with ranges and overlapping selections', () => {
    expect(stampProblem(settings(), 4)).toBeNull()
    expect(stampProblem({ ...settings(), pages: '3,1-3', watermark: DEFAULT_WATERMARK }, 4)).toBeNull()
    expect(stampProblem({ ...settings(), numbers: null, watermark: DEFAULT_WATERMARK }, 4)).toBeNull()
  })

  it('requires pages and an enabled feature', () => {
    expect(stampProblem({ ...settings(), pages: '' }, 4)).toContain('Choose at least one')
    expect(stampProblem({ ...settings(), pages: '1,5' }, 4)).toContain('Not valid')
    expect(stampProblem({ ...settings(), numbers: null }, 4)).toContain('Enable')
  })

  it('blocks incomplete or out-of-range numeric fields before generating a preview', () => {
    expect(stampProblem({ ...settings(), numbers: { ...DEFAULT_NUMBERS, start: NaN } }, 4)).toContain('whole number')
    expect(stampProblem({ ...settings(), numbers: { ...DEFAULT_NUMBERS, start: 1.5 } }, 4)).toContain('whole number')
    expect(stampProblem({ ...settings(), numbers: { ...DEFAULT_NUMBERS, size: 0 } }, 4)).toContain('size')
    expect(stampProblem({ ...settings(), numbers: { ...DEFAULT_NUMBERS, margin: 145 } }, 4)).toContain('margin')
    expect(stampProblem({ ...settings(), watermark: { ...DEFAULT_WATERMARK, rotation: 181 } }, 4)).toContain('rotation')
    expect(stampProblem({ ...settings(), watermark: { ...DEFAULT_WATERMARK, opacity: 0 } }, 4)).toContain('opacity')
  })

  it('rejects empty, multiline or oversized watermark text', () => {
    for (const text of ['', '   ', 'two\nlines', 'bad\ttext', 'x'.repeat(201)]) {
      expect(stampProblem({ ...settings(), watermark: { ...DEFAULT_WATERMARK, text } }, 4)).toBeTruthy()
    }
  })
})
