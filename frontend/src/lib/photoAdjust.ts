// Pillow's enhancement maths, so the preview on a canvas looks like what the backend saves.
//
// Each step blends the picture with a "degenerate" version of itself: black
// for brightness, flat grey for contrast, greyscale for saturation and a
// smoothed copy for sharpness. A factor of 1 leaves the picture alone, 0 gives
// the degenerate version, and more than 1 pushes past the picture. Pillow
// truncates the blended values, so this does too.

import type { Adjust } from './photoEdits'

export type AdjustSettings = {
  brightness: number
  contrast: number
  saturation: number
  sharpness: number
  grayscale: boolean
}

export const DEFAULT_ADJUST: AdjustSettings = { brightness: 1, contrast: 1, saturation: 1, sharpness: 1, grayscale: false }

/** The sliders, in the order they are applied. */
export const ADJUST_KEYS = ['brightness', 'contrast', 'saturation', 'sharpness'] as const

/** The edit for the backend: only what differs from leaving the photo alone. */
export function toAdjust(settings: AdjustSettings): Adjust {
  const adjust: Adjust = {}
  for (const key of ADJUST_KEYS) if (settings[key] !== 1) adjust[key] = settings[key]
  if (settings.grayscale) adjust.grayscale = true
  return adjust
}

/** Sliders go from 0 (none) to 2 (double); sharpness to 3, where Pillow's effect is still sensible. */
export const ADJUST_RANGES: Record<Exclude<keyof AdjustSettings, 'grayscale'>, { min: number; max: number; step: number }> = {
  brightness: { min: 0, max: 2, step: 0.02 },
  contrast: { min: 0, max: 2, step: 0.02 },
  saturation: { min: 0, max: 2, step: 0.02 },
  sharpness: { min: 0, max: 3, step: 0.05 },
}

export function isIdentity(settings: AdjustSettings): boolean {
  return (
    !settings.grayscale &&
    settings.brightness === 1 &&
    settings.contrast === 1 &&
    settings.saturation === 1 &&
    settings.sharpness === 1
  )
}

/** Luminance as Pillow converts RGB to L, with its fixed-point rounding. */
export function luminance(r: number, g: number, b: number): number {
  return (r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16
}

function clip(value: number): number {
  return value <= 0 ? 0 : value >= 255 ? 255 : Math.trunc(value)
}

/** `from + factor * (to - from)` per channel, truncated and clipped as Pillow blends. */
function blend(from: number, to: number, factor: number): number {
  return clip(from + factor * (to - from))
}

/**
 * The RGBA pixels of a `width` × `height` picture with `settings` applied, in a new array.
 * Alpha is left alone throughout.
 */
export function adjustPixels(pixels: Uint8ClampedArray, width: number, height: number, settings: AdjustSettings): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels)
  const count = width * height
  if (settings.brightness !== 1) {
    for (let i = 0; i < count * 4; i += 4) {
      for (let c = 0; c < 3; c++) out[i + c] = blend(0, out[i + c], settings.brightness)
    }
  }
  if (settings.contrast !== 1) {
    let total = 0
    for (let i = 0; i < count * 4; i += 4) total += luminance(out[i], out[i + 1], out[i + 2])
    const mean = Math.floor(total / count + 0.5)
    for (let i = 0; i < count * 4; i += 4) {
      for (let c = 0; c < 3; c++) out[i + c] = blend(mean, out[i + c], settings.contrast)
    }
  }
  if (settings.saturation !== 1) {
    for (let i = 0; i < count * 4; i += 4) {
      const grey = luminance(out[i], out[i + 1], out[i + 2])
      for (let c = 0; c < 3; c++) out[i + c] = blend(grey, out[i + c], settings.saturation)
    }
  }
  if (settings.sharpness !== 1) {
    const smooth = smoothed(out, width, height)
    for (let i = 0; i < count * 4; i += 4) {
      for (let c = 0; c < 3; c++) out[i + c] = blend(smooth[i + c], out[i + c], settings.sharpness)
    }
  }
  if (settings.grayscale) {
    for (let i = 0; i < count * 4; i += 4) {
      const grey = luminance(out[i], out[i + 1], out[i + 2])
      out[i] = out[i + 1] = out[i + 2] = grey
    }
  }
  return out
}

/** Pillow's SMOOTH filter: a 3 × 3 kernel weighted 5 in the middle and 1 around, over 13; the border is copied. */
function smoothed(pixels: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels)
  if (width < 3 || height < 3) return out
  const row = width * 4
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 4
      for (let c = 0; c < 3; c++) {
        const k = i + c
        const sum =
          pixels[k - row - 4] + pixels[k - row] + pixels[k - row + 4] +
          pixels[k - 4] + 5 * pixels[k] + pixels[k + 4] +
          pixels[k + row - 4] + pixels[k + row] + pixels[k + row + 4]
        out[k] = clip(sum / 13)
      }
    }
  }
  return out
}
