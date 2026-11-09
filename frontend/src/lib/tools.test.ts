import { describe, expect, it } from 'vitest'
import { targetsFor, TOOL_IDS } from './tools'

const file = (name: string, type = '') => new File([''], name, { type })
const ids = (f: File, from: Parameters<typeof targetsFor>[1]) => targetsFor(f, from).map((t) => t.id)

describe('targetsFor', () => {
  it('offers a PDF to every PDF tool but the one that made it', () => {
    expect(ids(file('merged.pdf', 'application/pdf'), 'merge')).toEqual(['split', 'organize', 'bookmarks', 'metadata', 'text', 'compare', 'ocr', 'edit', 'forms', 'form-builder', 'redact', 'signatures', 'stamps', 'compress', 'pdf-images', 'passwords', 'workflows'])
    expect(ids(file('a_edited.pdf'), 'edit')).toEqual(['merge', 'split', 'organize', 'bookmarks', 'metadata', 'text', 'compare', 'ocr', 'forms', 'form-builder', 'redact', 'signatures', 'stamps', 'compress', 'pdf-images', 'passwords', 'workflows'])
    expect(ids(file('images.pdf', 'application/pdf'), 'images')).toEqual(['merge', 'split', 'organize', 'bookmarks', 'metadata', 'text', 'compare', 'ocr', 'edit', 'forms', 'form-builder', 'redact', 'signatures', 'stamps', 'compress', 'pdf-images', 'passwords', 'workflows'])
  })

  const photoTools = ['photo-resize', 'photo-crop', 'photo-rotate', 'photo-convert', 'photo-adjust', 'photo-info']

  it('offers JPEG and PNG pictures to the picture tools', () => {
    expect(ids(file('me_passport.jpg', 'image/jpeg'), 'photo')).toEqual(['compress', 'jpg', 'images', ...photoTools])
    expect(ids(file('shot_compressed.png', 'image/png'), 'compress')).toEqual(['png', 'images', ...photoTools, 'photo'])
    expect(ids(file('a_resized.jpg', 'image/jpeg'), 'photo-resize')).toEqual(['compress', 'jpg', 'images', ...photoTools.filter((id) => id !== 'photo-resize'), 'photo'])
  })

  it('sends a WebP or a GIF only to the photo tools that take them, and a zip nowhere', () => {
    expect(ids(file('shot_compressed.webp', 'image/webp'), 'compress')).toEqual(photoTools)
    expect(ids(file('clip.gif', 'image/gif'), 'photo-convert')).toEqual(photoTools.filter((id) => id !== 'photo-convert'))
    expect(ids(file('a_split.zip', 'application/zip'), 'split')).toEqual([])
  })
})

it('registers metadata for persisted navigation and both directions of PDF handoff', () => {
  expect(TOOL_IDS).toContain('metadata')
  expect(ids(file('source.pdf'), 'passwords')).toContain('metadata')
  expect(ids(file('source_metadata.pdf'), 'metadata')).toContain('bookmarks')
  expect(ids(file('source_metadata.pdf'), 'metadata')).toContain('ocr')
  expect(ids(file('source_metadata.pdf'), 'metadata')).toContain('compare')
  expect(ids(file('source_compressed.pdf'), 'compress')).toContain('metadata')
  expect(ids(file('source_compressed.pdf'), 'compress')).toContain('compare')
  expect(ids(file('source_metadata.pdf'), 'metadata')).not.toContain('metadata')
  expect(ids(file('image.png', 'image/png'), 'photo')).not.toContain('metadata')
})
