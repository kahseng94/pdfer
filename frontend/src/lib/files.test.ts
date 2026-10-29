import { describe, expect, it } from 'vitest'
import { pickFiles } from './files'

const file = (name: string, type = '') => new File([''], name, { type })

describe('pickFiles', () => {
  it('keeps PDFs by type or extension, in order', () => {
    const { wanted, skipped } = pickFiles([file('a.pdf', 'application/pdf'), file('b.txt'), file('C.PDF')], 'pdf')
    expect(wanted.map((f) => f.name)).toEqual(['a.pdf', 'C.PDF'])
    expect(skipped).toBe(1)
  })

  it('keeps JPEG and PNG images only', () => {
    const { wanted, skipped } = pickFiles([file('x', 'image/jpeg'), file('y.png'), file('z.gif', 'image/gif')], 'image')
    expect(wanted.map((f) => f.name)).toEqual(['x', 'y.png'])
    expect(skipped).toBe(1)
  })

  it('takes PDFs and pictures, WebP included, for compression', () => {
    const { wanted, skipped } = pickFiles(
      [file('a.pdf', 'application/pdf'), file('b.webp'), file('c.png', 'image/png'), file('d.txt')],
      'compressible',
    )
    expect(wanted.map((f) => f.name)).toEqual(['a.pdf', 'b.webp', 'c.png'])
    expect(skipped).toBe(1)
  })

  it('handles an empty list', () => {
    expect(pickFiles([], 'pdf')).toEqual({ wanted: [], skipped: 0 })
  })
})
