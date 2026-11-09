import { describe, expect, it } from 'vitest'
import { browserShows } from './usePhotoItems'

const file = (name: string, type = '') => new File([''], name, { type })

describe('browserShows', () => {
  it('previews what browsers decode', () => {
    for (const f of [file('a.jpg', 'image/jpeg'), file('b.png'), file('c.webp'), file('d.gif', 'image/gif'), file('e.avif')]) {
      expect(browserShows(f)).toBe(true)
    }
  })

  it('leaves TIFF and HEIC to the backend, by type or extension', () => {
    for (const f of [file('scan.tif'), file('scan.TIFF'), file('scan', 'image/tiff'), file('IMG_0001.HEIC'), file('a.heif'), file('shot', 'image/heic'), file('shot', 'image/heif')]) {
      expect(browserShows(f)).toBe(false)
    }
  })
})
