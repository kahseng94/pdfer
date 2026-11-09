import { describe, expect, it } from 'vitest'
import { adjustPixels, DEFAULT_ADJUST, isIdentity, luminance } from './photoAdjust'

/** A 3 × 3 picture: pure red, with a white middle pixel and a half-transparent corner. */
function picture(): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(9 * 4)
  for (let i = 0; i < 9; i++) pixels.set([255, 0, 0, 255], i * 4)
  pixels.set([255, 255, 255, 255], 4 * 4)
  pixels[3] = 128
  return pixels
}

const pixel = (pixels: Uint8ClampedArray, index: number) => [...pixels.slice(index * 4, index * 4 + 4)]

it('knows when nothing changes', () => {
  expect(isIdentity(DEFAULT_ADJUST)).toBe(true)
  expect(isIdentity({ ...DEFAULT_ADJUST, grayscale: true })).toBe(false)
  expect(isIdentity({ ...DEFAULT_ADJUST, sharpness: 1.5 })).toBe(false)
})

it('greys as Pillow does', () => {
  expect(luminance(255, 0, 0)).toBe(76)
  expect(luminance(0, 255, 0)).toBe(150)
  expect(luminance(0, 0, 255)).toBe(29)
  expect(luminance(255, 255, 255)).toBe(255)
})

describe('adjustPixels', () => {
  it('returns a copy and leaves the picture alone by default', () => {
    const source = picture()
    const out = adjustPixels(source, 3, 3, DEFAULT_ADJUST)
    expect(out).not.toBe(source)
    expect([...out]).toEqual([...source])
  })

  it('scales brightness and keeps alpha', () => {
    const out = adjustPixels(picture(), 3, 3, { ...DEFAULT_ADJUST, brightness: 0.5 })
    expect(pixel(out, 0)).toEqual([127, 0, 0, 128])
    expect(pixel(out, 4)).toEqual([127, 127, 127, 255])
    expect(pixel(adjustPixels(picture(), 3, 3, { ...DEFAULT_ADJUST, brightness: 0 }), 1)).toEqual([0, 0, 0, 255])
    expect(pixel(adjustPixels(picture(), 3, 3, { ...DEFAULT_ADJUST, brightness: 2 }), 1)).toEqual([255, 0, 0, 255])
  })

  it('pulls towards the mean grey for contrast', () => {
    // Eight reds (76) and one white (255): mean 95.9, rounded to 96.
    const flat = adjustPixels(picture(), 3, 3, { ...DEFAULT_ADJUST, contrast: 0 })
    expect(pixel(flat, 0)).toEqual([96, 96, 96, 128])
    expect(pixel(flat, 4)).toEqual([96, 96, 96, 255])
    const half = adjustPixels(picture(), 3, 3, { ...DEFAULT_ADJUST, contrast: 0.5 })
    expect(pixel(half, 0)).toEqual([175, 48, 48, 128])
  })

  it('pulls towards grey for saturation', () => {
    const grey = adjustPixels(picture(), 3, 3, { ...DEFAULT_ADJUST, saturation: 0 })
    expect(pixel(grey, 0)).toEqual([76, 76, 76, 128])
    const vivid = adjustPixels(picture(), 3, 3, { ...DEFAULT_ADJUST, saturation: 1.5 })
    expect(pixel(vivid, 1)).toEqual([255, 0, 0, 255])
    expect(pixel(adjustPixels(picture(), 3, 3, { ...DEFAULT_ADJUST, saturation: 0.5 }), 1)).toEqual([165, 38, 38, 255])
  })

  it('blends with a smoothed copy for sharpness, copying the border', () => {
    const soft = adjustPixels(picture(), 3, 3, { ...DEFAULT_ADJUST, sharpness: 0 })
    // The middle white pixel averaged with its eight red neighbours: (5·255 + 8·255, 5·255, 5·255) / 13.
    expect(pixel(soft, 4)).toEqual([255, 98, 98, 255])
    expect(pixel(soft, 0)).toEqual([255, 0, 0, 128])
    const sharp = adjustPixels(picture(), 3, 3, { ...DEFAULT_ADJUST, sharpness: 2 })
    expect(pixel(sharp, 4)).toEqual([255, 255, 255, 255])
    expect(pixel(sharp, 1)).toEqual([255, 0, 0, 255])
  })

  it('makes every pixel grey for grayscale, after the other steps', () => {
    const out = adjustPixels(picture(), 3, 3, { ...DEFAULT_ADJUST, brightness: 0.5, grayscale: true })
    expect(pixel(out, 0)).toEqual([38, 38, 38, 128])
    expect(pixel(out, 4)).toEqual([127, 127, 127, 255])
  })

  it('copes with a picture too small to smooth', () => {
    const tiny = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255])
    expect([...adjustPixels(tiny, 2, 1, { ...DEFAULT_ADJUST, sharpness: 2 })]).toEqual([...tiny])
  })
})
