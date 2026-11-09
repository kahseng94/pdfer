// The one edit the photo tools send to the backend, and what it will make of a photo.
//
// Every tool fills in the parts it offers; the backend applies them in this
// order: EXIF orientation, rotate, flip, crop, resize, adjust, encode.

import type { Crop, Size } from './photo'

export type Fit = 'contain' | 'cover' | 'stretch'
export type Flip = 'none' | 'horizontal' | 'vertical'
export type PhotoMetadata = 'keep' | 'no-location' | 'none'
export type PhotoFormat = 'keep' | 'jpeg' | 'png' | 'webp'
export type Turn = 0 | 90 | 180 | 270

export type Resize = {
  width?: number
  height?: number
  /** Percentage of the current size; on its own. */
  percent?: number
  /** Longest side in pixels; on its own. */
  longest?: number
  /** With both width and height: keep the proportions inside the box, fill it and cut the overhang, or stretch. */
  fit?: Fit
  /** Whether a photo may be made bigger than it is; by default it never is. */
  enlarge?: boolean
}

export type Adjust = {
  brightness?: number
  contrast?: number
  saturation?: number
  sharpness?: number
  grayscale?: boolean
}

export type PhotoEdit = {
  /** Clockwise. */
  rotate?: Turn
  flip?: Flip
  /** In pixels of the photo after it has been turned and flipped. */
  crop?: Crop
  resize?: Resize
  adjust?: Adjust
  format?: PhotoFormat
  /** JPEG and WebP quality, 1–100. */
  quality?: number
  /** What shows through transparency in a JPEG, as #rrggbb. */
  background?: string
  metadata?: PhotoMetadata
  /** Goes between the file's name and its extension; empty for none. */
  suffix?: string
}

/**
 * How a photo is shown: turned `turns` quarter turns clockwise, then mirrored.
 * Every mix of turns and flips comes down to one of these, which is also
 * the order the backend applies them in.
 */
export type Orientation = { turns: 0 | 1 | 2 | 3; flip: Flip }

export const UPRIGHT: Orientation = { turns: 0, flip: 'none' }

/** The orientation after the picture on screen is turned a quarter turn. */
export function turned(o: Orientation, clockwise: boolean): Orientation {
  // A mirrored picture turning clockwise on screen is the unmirrored one turning the other way.
  const step = (clockwise ? 1 : 3) * (o.flip === 'none' ? 1 : 3)
  return { ...o, turns: ((o.turns + step) % 4) as Orientation['turns'] }
}

/** The orientation after the picture on screen is mirrored. */
export function mirrored(o: Orientation, flip: Exclude<Flip, 'none'>): Orientation {
  if (o.flip === 'none') return { ...o, flip }
  if (o.flip === flip) return { ...o, flip: 'none' }
  // Mirrored both ways is a half turn.
  return { turns: ((o.turns + 2) % 4) as Orientation['turns'], flip: 'none' }
}

/** The CSS transform that shows a picture this way: the turn first, then the mirror. */
export function turnStyle(o: Orientation): string {
  const mirror = o.flip === 'horizontal' ? 'scaleX(-1) ' : o.flip === 'vertical' ? 'scaleY(-1) ' : ''
  return `${mirror}rotate(${o.turns * 90}deg)`
}

/** "Turned 90° clockwise, then mirrored left to right", or "Not turned". */
export function describeOrientation(o: Orientation): string {
  const parts = [
    o.turns ? `Turned ${o.turns * 90}° clockwise` : null,
    o.flip !== 'none' ? `mirrored ${o.flip === 'horizontal' ? 'left to right' : 'top to bottom'}` : null,
  ].filter(Boolean)
  if (!parts.length) return 'Not turned'
  const [first, second] = parts
  return second ? `${first}, then ${second}` : (first as string)[0].toUpperCase() + (first as string).slice(1)
}

/** The most pixels a photo may have along either side after resizing or cropping; the backend's limit. */
export const MAX_PHOTO_SIDE = 10_000
export const MAX_PERCENT = 400

export const PHOTO_FORMATS: readonly { value: Exclude<PhotoFormat, 'keep'>; label: string; hint: string }[] = [
  { value: 'jpeg', label: 'JPEG', hint: 'Smallest for photos; no transparency' },
  { value: 'png', label: 'PNG', hint: 'Lossless, keeps transparency; large for photos' },
  { value: 'webp', label: 'WebP', hint: 'Small, keeps transparency; not every app opens it' },
]

/** The sizes a photo goes through: `scaled` is what it is resampled to, `final` what is cut from its middle. Mirrors photos.resize_plan. */
export function resizePlan(size: Size, resize: Resize): { scaled: Size; final: Size } {
  const { width, height } = size
  const cap = (scale: number) => (resize.enlarge ? scale : Math.min(scale, 1))
  let sx: number
  let sy: number
  if (resize.percent !== undefined) {
    sx = sy = cap(resize.percent / 100)
  } else if (resize.longest !== undefined) {
    sx = sy = cap(resize.longest / Math.max(width, height))
  } else if (resize.width !== undefined && resize.height !== undefined) {
    if (resize.fit === 'stretch') {
      sx = cap(resize.width / width)
      sy = cap(resize.height / height)
    } else {
      const pick = resize.fit === 'cover' ? Math.max : Math.min
      sx = sy = cap(pick(resize.width / width, resize.height / height))
    }
  } else if (resize.width !== undefined) {
    sx = sy = cap(resize.width / width)
  } else if (resize.height !== undefined) {
    sx = sy = cap(resize.height / height)
  } else {
    sx = sy = 1
  }
  const scaled = { width: px(width * sx), height: px(height * sy) }
  if (resize.fit === 'cover' && resize.width !== undefined && resize.height !== undefined) {
    return { scaled, final: { width: Math.min(scaled.width, resize.width), height: Math.min(scaled.height, resize.height) } }
  }
  return { scaled, final: scaled }
}

/** Round half up, like the backend, and never below one pixel. */
function px(value: number): number {
  return Math.max(1, Math.floor(value + 0.5))
}

/** Why the resize can't be sent, or null when it can. */
export function resizeProblem(resize: Resize): string | null {
  const whole = (value: number | undefined, what: string) =>
    value !== undefined && (!Number.isInteger(value) || value < 1 || value > MAX_PHOTO_SIDE)
      ? `${what} must be a whole number from 1 to ${MAX_PHOTO_SIDE.toLocaleString()} pixels.`
      : null
  if (resize.percent !== undefined && (!Number.isFinite(resize.percent) || resize.percent < 1 || resize.percent > MAX_PERCENT)) {
    return `The percentage must be between 1 and ${MAX_PERCENT}.`
  }
  const problem = whole(resize.width, 'The width') ?? whole(resize.height, 'The height') ?? whole(resize.longest, 'The longest side')
  if (problem) return problem
  if (resize.width === undefined && resize.height === undefined && resize.percent === undefined && resize.longest === undefined) {
    return 'Enter a size.'
  }
  return null
}

export type OutputFormat = Exclude<PhotoFormat, 'keep'> | 'auto'

/**
 * What the backend will save `file` as. 'auto' is a picture that isn't a
 * JPEG, PNG or WebP (a GIF, BMP, TIFF, AVIF or HEIC): it becomes a PNG when
 * it has transparency, else a JPEG.
 */
export function outputFormat(file: { name: string; type: string }, format: PhotoFormat): OutputFormat {
  if (format !== 'keep') return format
  if (file.type === 'image/jpeg' || /\.jpe?g$/i.test(file.name)) return 'jpeg'
  if (file.type === 'image/png' || /\.png$/i.test(file.name)) return 'png'
  if (file.type === 'image/webp' || /\.webp$/i.test(file.name)) return 'webp'
  return 'auto'
}

const EXTENSIONS: Record<OutputFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', auto: 'jpg or png' }

/** The name the backend gives the result: the file's stem, the suffix, and the new extension. */
export function outputName(name: string, format: OutputFormat, suffix: string): string {
  const stem = (name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name) || 'photo'
  return `${stem}${suffix ? `_${suffix}` : ''}.${EXTENSIONS[format]}`
}

/** What one photo came out as, in the order the files were sent. */
export type PhotoResult = { name: string; before: number; after: number; width: number; height: number }

/** The `X-Results` header as one entry per file; a missing or odd header counts a file as unchanged and its size as unknown. */
export function parsePhotoResults(header: string | null, files: readonly { name: string; size: number }[]): PhotoResult[] {
  let parsed: unknown = null
  try {
    parsed = header ? JSON.parse(header) : null
  } catch {
    parsed = null
  }
  const list = Array.isArray(parsed) ? parsed : []
  return files.map((file, i) => {
    const entry = list[i] as Partial<Record<keyof PhotoResult, unknown>> | undefined
    const number = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
    const before = number(entry?.before, file.size)
    return {
      name: typeof entry?.name === 'string' ? safeDecode(entry.name) : file.name,
      before,
      after: number(entry?.after, before),
      width: number(entry?.width, 0),
      height: number(entry?.height, 0),
    }
  })
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** What a photo is and records, from `/api/photos/info`. */
export type PhotoInfo = {
  name: string
  bytes: number
  format: string
  media_type: string
  width: number
  height: number
  mode: string
  transparency: boolean
  frames: number
  dpi: [number, number] | null
  orientation: number | null
  camera: { make: string | null; model: string | null; lens: string | null; software: string | null }
  taken: string | null
  exposure: {
    time: string | null
    aperture: string | null
    iso: number | null
    focal_length: string | null
    focal_length_35mm: string | null
  }
  gps: { latitude: number | null; longitude: number | null; altitude: number | null } | null
  author: { artist: string | null; copyright: string | null; description: string | null }
  metadata: { exif_tags: number; xmp: boolean; icc_profile: boolean; iptc: boolean }
}

/** "37.775°N, 122.4167°W" for a location, or null without one. */
export function formatLocation(gps: PhotoInfo['gps']): string | null {
  if (!gps || gps.latitude === null || gps.longitude === null) return null
  const part = (value: number, positive: string, negative: string) => `${Math.abs(value).toFixed(4)}°${value < 0 ? negative : positive}`
  return `${part(gps.latitude, 'N', 'S')}, ${part(gps.longitude, 'E', 'W')}`
}

/** "14 EXIF tags with a location · XMP · colour profile", or "none". */
export function summarizeMetadata(info: PhotoInfo): string {
  const tags = info.metadata.exif_tags
  const parts = [
    tags ? `${tags} EXIF ${tags === 1 ? 'tag' : 'tags'}${info.gps ? ' with a location' : ''}` : null,
    info.metadata.xmp ? 'XMP' : null,
    info.metadata.iptc ? 'IPTC' : null,
    info.metadata.icc_profile ? 'colour profile' : null,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'none'
}

/** The suffix for converting a batch: none, unless a photo is already in the target format and would otherwise keep its name. */
export function convertSuffix(files: readonly { name: string; type: string }[], format: Exclude<PhotoFormat, 'keep'>): string {
  return files.some((file) => outputFormat(file, 'keep') === format) ? 'converted' : ''
}

/** The camera as one line: make and model, without repeating the make. */
export function formatCamera(camera: PhotoInfo['camera']): string | null {
  const { make, model } = camera
  if (!model) return make
  if (!make || model.toLowerCase().startsWith(make.toLowerCase())) return model
  return `${make} ${model}`
}
