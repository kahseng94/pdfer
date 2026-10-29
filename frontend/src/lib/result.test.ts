import { describe, expect, it } from 'vitest'
import { sameInputs } from './result'

describe('sameInputs', () => {
  const file = new File([''], 'a.pdf')
  const items = [{ page: 1 }]

  it('matches the same values in the same order', () => {
    expect(sameInputs([file, 'ranges', '1-3'], [file, 'ranges', '1-3'])).toBe(true)
    expect(sameInputs([items, undefined, NaN], [items, undefined, NaN])).toBe(true)
    expect(sameInputs([], [])).toBe(true)
  })

  it('tells changed, reordered or extra values apart', () => {
    expect(sameInputs([file, 'ranges', '1-3'], [file, 'ranges', '1-4'])).toBe(false)
    expect(sameInputs(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameInputs([file], [file, file])).toBe(false)
  })

  it('compares objects by identity, so an edited list counts as changed', () => {
    expect(sameInputs([items], [[...items]])).toBe(false)
    expect(sameInputs([new File([''], 'a.pdf')], [file])).toBe(false)
  })
})
