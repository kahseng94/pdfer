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

  it('accepts modern and legacy Office extensions without relying on MIME types', () => {
    const all = ['REPORT.DOC', 'report.docx', 'budget.xls', 'budget.XLSX', 'talk.ppt', 'talk.pptx', 'macro.docm', 'fake.zip'].map((name) => file(name))
    expect(pickFiles(all, 'word').wanted.map((f) => f.name)).toEqual(['REPORT.DOC', 'report.docx'])
    expect(pickFiles(all, 'excel').wanted.map((f) => f.name)).toEqual(['budget.xls', 'budget.XLSX'])
    expect(pickFiles(all, 'powerpoint').wanted.map((f) => f.name)).toEqual(['talk.ppt', 'talk.pptx'])
    expect(pickFiles([file('bad.txt', 'application/msword')], 'word').skipped).toBe(1)
  })

  it('filters the dedicated PNG and JPG inputs while keeping both JPEG extensions', () => {
    const all = [file('a.PNG'), file('b.JPG'), file('c.jpeg'), file('paste', 'image/png'), file('x.webp')]
    expect(pickFiles(all, 'png').wanted.map((f) => f.name)).toEqual(['a.PNG', 'paste'])
    expect(pickFiles(all, 'jpg').wanted.map((f) => f.name)).toEqual(['b.JPG', 'c.jpeg'])
  })
})
