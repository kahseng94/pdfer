import { describe, expect, it } from 'vitest'
import { isFileDrag } from './windowDrop'

describe('isFileDrag', () => {
  it('is true only when files are being dragged', () => {
    expect(isFileDrag(['Files'])).toBe(true)
    expect(isFileDrag(['text/plain', 'text/uri-list'])).toBe(false)
    expect(isFileDrag([])).toBe(false)
    expect(isFileDrag(undefined)).toBe(false)
  })
})
