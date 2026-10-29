import { describe, expect, it } from 'vitest'
import { targetsFor } from './tools'

const file = (name: string, type = '') => new File([''], name, { type })
const ids = (f: File, from: Parameters<typeof targetsFor>[1]) => targetsFor(f, from).map((t) => t.id)

describe('targetsFor', () => {
  it('offers a PDF to every PDF tool but the one that made it', () => {
    expect(ids(file('merged.pdf', 'application/pdf'), 'merge')).toEqual(['split', 'organize', 'bookmarks', 'text', 'ocr', 'edit', 'forms', 'redact', 'signatures', 'stamps', 'compress', 'pdf-images', 'passwords', 'workflows'])
    expect(ids(file('a_edited.pdf'), 'edit')).toEqual(['merge', 'split', 'organize', 'bookmarks', 'text', 'ocr', 'forms', 'redact', 'signatures', 'stamps', 'compress', 'pdf-images', 'passwords', 'workflows'])
    expect(ids(file('images.pdf', 'application/pdf'), 'images')).toEqual(['merge', 'split', 'organize', 'bookmarks', 'text', 'ocr', 'edit', 'forms', 'redact', 'signatures', 'stamps', 'compress', 'pdf-images', 'passwords', 'workflows'])
  })

  it('offers JPEG and PNG pictures to the picture tools', () => {
    expect(ids(file('me_passport.jpg', 'image/jpeg'), 'photo')).toEqual(['compress', 'images'])
    expect(ids(file('shot_compressed.png', 'image/png'), 'compress')).toEqual(['images', 'photo'])
  })

  it('has nowhere to send a WebP from Compress, or a zip', () => {
    expect(ids(file('shot_compressed.webp', 'image/webp'), 'compress')).toEqual([])
    expect(ids(file('a_split.zip', 'application/zip'), 'split')).toEqual([])
  })
})
