import { describe, expect, it } from 'vitest'
import { parseToolId } from './lastTool'

const ids = ['merge', 'split'] as const

describe('parseToolId', () => {
  it('accepts a known id', () => {
    expect(parseToolId('split', ids, 'merge')).toBe('split')
  })

  it('falls back on anything else', () => {
    expect(parseToolId('nope', ids, 'merge')).toBe('merge')
    expect(parseToolId(null, ids, 'merge')).toBe('merge')
    expect(parseToolId(42, ids, 'merge')).toBe('merge')
  })
})
