import { describe, expect, it } from 'vitest'
import { parsePdfTarget, validatePdfTarget, type PdfTargetUnit } from './pdfTarget'

describe('PDF target sizes', () => {
  it('uses explicit decimal KB and MB, including fractional sizes and exact boundaries', () => {
    expect(parsePdfTarget('2', 'MB')).toBe(2_000_000)
    expect(parsePdfTarget('1.25', 'KB')).toBe(1250)
    expect(parsePdfTarget(' 0.001 ', 'MB')).toBe(1000)
    expect(parsePdfTarget('500.0000000', 'MB')).toBe(500_000_000)
    expect(parsePdfTarget('1.001', 'KB')).toBe(1001)
  })
  it.each(['', '0', '-1', 'NaN', 'Infinity', '2 MB', '1e3', '0.5', '1.0001', '500001'])('rejects invalid KB target %s', (value) => {
    expect(() => parsePdfTarget(value, 'KB')).toThrow()
  })
  it('rejects unsupported units and noninteger or out-of-range bytes', () => {
    expect(() => parsePdfTarget('2', 'GB' as PdfTargetUnit)).toThrow()
    for (const value of [NaN, Infinity, -1, 999, 1000.1, 500_000_001]) expect(() => validatePdfTarget(value)).toThrow()
  })
})
