// Passport and visa photo sizes, and the geometry of cropping a picture to one.
//
// A crop is described in pixels of the picture as the browser shows it (EXIF
// orientation applied): its centre, its size, and how far the picture is turned
// clockwise before the rectangle is taken. The backend takes the same numbers.

export type Size = { width: number; height: number }

export type Crop = {
  cx: number
  cy: number
  width: number
  height: number
  /** Degrees the picture is turned clockwise about the centre. */
  angle: number
}

export type Preset = {
  id: string
  /** Country or service, without the size. */
  label: string
  /** Printed size in millimetres. */
  width: number
  height: number
  /** Allowed height of the head from chin to crown, in millimetres. */
  head?: [number, number]
  /** Pixel size the online service asks for, when it has one, and its file size limit. */
  digital?: { width: number; height: number; maxKb?: number }
}

const INCH = 25.4

/** Common requirements, as published by each country; a guide, not the rulebook. */
export const PRESETS: readonly Preset[] = [
  { id: 'us', label: 'United States (passport & visa)', width: 2 * INCH, height: 2 * INCH, head: [25, 35], digital: { width: 600, height: 600, maxKb: 240 } },
  { id: 'schengen', label: 'Schengen visa & most EU passports', width: 35, height: 45, head: [32, 36] },
  { id: 'uk', label: 'United Kingdom', width: 35, height: 45, head: [29, 34], digital: { width: 600, height: 750 } },
  { id: 'canada', label: 'Canada', width: 50, height: 70, head: [31, 36] },
  { id: 'australia', label: 'Australia', width: 35, height: 45, head: [32, 36] },
  { id: 'india', label: 'India (passport & visa)', width: 2 * INCH, height: 2 * INCH, head: [25, 35] },
  { id: 'china', label: 'China (visa)', width: 33, height: 48, head: [28, 33], digital: { width: 354, height: 472, maxKb: 120 } },
  { id: 'japan', label: 'Japan', width: 35, height: 45, head: [32, 36] },
  { id: 'singapore', label: 'Singapore', width: 35, height: 45, head: [25, 35], digital: { width: 400, height: 514 } },
  { id: 'malaysia', label: 'Malaysia', width: 35, height: 50 },
  { id: 'custom', label: 'Custom size', width: 35, height: 45 },
]

export const CUSTOM_ID = 'custom'

/** "35 × 45 mm", or "2 × 2 in" for sizes given in inches. */
export function sizeLabel({ width, height }: Size): string {
  const inches = [width, height].map((v) => v / INCH)
  if (inches.every((v) => Math.abs(v - Math.round(v * 4) / 4) < 0.001)) {
    return `${inches.map(trim).join(' × ')} in`
  }
  return `${trim(width)} × ${trim(height)} mm`
}

function trim(n: number): string {
  return String(Math.round(n * 100) / 100)
}

export type HeadGuide = {
  /** Millimetres from the top of the photo to the top of the head. */
  crown: number
  /** Smallest and largest allowed head height, chin to crown, in millimetres. */
  min: number
  max: number
}

/** Where the head should sit in the photo. Without a published range, a typical 60–75% of the height. */
export function headGuide(size: Size & { head?: [number, number] }): HeadGuide {
  const [min, max] = size.head ?? [size.height * 0.6, size.height * 0.75]
  // A little more room under the chin than over the crown, which is how the eye-line rules work out.
  const crown = (size.height - (min + max) / 2) * 0.45
  return { crown, min, max }
}

/** Smallest crop, in picture pixels, so zooming can't go on for ever. */
export const MIN_CROP = 32

function between(v: number, lo: number, hi: number): number {
  return lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v))
}

/** Half the width and height of the smallest upright box around the (turned) crop. */
export function boundsHalf(crop: Crop): { x: number; y: number } {
  const a = (crop.angle * Math.PI) / 180
  const c = Math.abs(Math.cos(a))
  const s = Math.abs(Math.sin(a))
  return { x: (crop.width * c + crop.height * s) / 2, y: (crop.width * s + crop.height * c) / 2 }
}

/** Keep the crop inside the picture: shrink it when it doesn't fit, then move it in. */
export function clampCrop(crop: Crop, image: Size): Crop {
  let { width, height } = crop
  let b = boundsHalf(crop)
  const k = Math.min(1, image.width / (2 * b.x), image.height / (2 * b.y))
  if (k < 1) {
    width *= k
    height *= k
    b = boundsHalf({ ...crop, width, height })
  }
  return {
    ...crop,
    width,
    height,
    cx: between(crop.cx, b.x, image.width - b.x),
    cy: between(crop.cy, b.y, image.height - b.y),
  }
}

/** The largest crop of this aspect (width / height) that fits, centred. */
export function fitCrop(image: Size, aspect: number, angle = 0): Crop {
  // Start far too big; clampCrop shrinks it to fit exactly.
  const width = Math.max(image.width, image.height) * 4
  return clampCrop({ cx: image.width / 2, cy: image.height / 2, width, height: width / aspect, angle }, image)
}

/**
 * Follow a drag of (dx, dy) CSS pixels, with `scale` CSS pixels per picture
 * pixel. The picture moves with the pointer, so the crop goes the other way.
 */
export function panCrop(crop: Crop, dx: number, dy: number, scale: number, image: Size): Crop {
  const a = (crop.angle * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  // Undo the display rotation on the delta, then scale to picture pixels.
  const px = (dx * c + dy * s) / scale
  const py = (-dx * s + dy * c) / scale
  return clampCrop({ ...crop, cx: crop.cx - px, cy: crop.cy - py }, image)
}

/** Zoom about the frame's centre; a factor above 1 zooms in. */
export function zoomCrop(crop: Crop, factor: number, image: Size): Crop {
  const width = Math.max(MIN_CROP, crop.width / factor)
  return clampCrop({ ...crop, width, height: width * (crop.height / crop.width) }, image)
}

/** How far in the slider and the wheel can zoom, relative to the largest crop that fits. */
export const MAX_ZOOM = 8

/** Keep the crop no smaller than a MAX_ZOOM-th of the largest that fits, so the wheel and the slider agree. */
export function limitZoom(crop: Crop, image: Size): Crop {
  const minWidth = fitCrop(image, crop.width / crop.height, crop.angle).width / MAX_ZOOM
  return crop.width < minWidth ? zoomCrop(crop, crop.width / minWidth, image) : crop
}

/** Same centre and width, new aspect (width / height) and angle. */
export function reshapeCrop(crop: Crop, aspect: number, angle: number, image: Size): Crop {
  return clampCrop({ ...crop, height: crop.width / aspect, angle }, image)
}

/** The frame in CSS pixels: the biggest box of this aspect inside the stage, keeping a margin. */
export function frameSize(stage: Size, aspect: number, margin: number): Size {
  const w = Math.max(1, stage.width - 2 * margin)
  const h = Math.max(1, stage.height - 2 * margin)
  return w / h > aspect ? { width: h * aspect, height: h } : { width: w, height: w / aspect }
}

/** Pixels needed to print a size in millimetres at `dpi`. */
export function pixelsAt(mm: Size, dpi: number): Size {
  return { width: Math.round((mm.width / INCH) * dpi), height: Math.round((mm.height / INCH) * dpi) }
}

export type Paper = '4x6' | 'a4' | 'letter'

export const PAPERS: Record<Paper, { label: string; width: number; height: number }> = {
  '4x6': { label: '4 × 6 in photo paper', width: 101.6, height: 152.4 },
  a4: { label: 'A4', width: 210, height: 297 },
  letter: { label: 'US Letter', width: 215.9, height: 279.4 },
}

/** Millimetres kept clear around the sheet, and between photos; the same as the backend's. */
export const SHEET_MARGIN = 4
export const SHEET_GAP = 2

export type SheetLayout = { cols: number; rows: number; landscape: boolean; copies: number }

/** How many photos fit on the paper, turning it landscape when that fits more. Mirrors core.sheet_layout. */
export function sheetLayout(paper: Size, photo: Size): SheetLayout {
  function fit(w: number, h: number) {
    const cols = Math.max(0, Math.floor((w - 2 * SHEET_MARGIN + SHEET_GAP) / (photo.width + SHEET_GAP)))
    const rows = Math.max(0, Math.floor((h - 2 * SHEET_MARGIN + SHEET_GAP) / (photo.height + SHEET_GAP)))
    return { cols, rows, copies: cols * rows }
  }
  const portrait = fit(paper.width, paper.height)
  const landscape = fit(paper.height, paper.width)
  if (landscape.copies > portrait.copies) return { ...landscape, landscape: true }
  if (portrait.copies === 0) return { cols: 0, rows: 0, landscape: false, copies: 0 }
  return { ...portrait, landscape: false }
}
