import type { PageOp } from './ranges'

export const POINTS_PER_MM = 72 / 25.4
export type PageSize = { width: number; height: number }
export type CropMargins = { top: number; right: number; bottom: number; left: number }
export type OrganizeItem = PageOp & { id: string }
export type OrganizeSettings = {
  cropEnabled: boolean
  resizeEnabled: boolean
  crop: CropMargins
  paper: 'a4' | 'letter' | 'custom'
  orientation: 'portrait' | 'landscape'
  width: number
  height: number
}
export type PageLayout = { pages: number[]; crop: CropMargins | null; resize: PageSize | null }

export const EMPTY_CROP: CropMargins = { top: 0, right: 0, bottom: 0, left: 0 }
export const DEFAULT_ORGANIZE: OrganizeSettings = {
  cropEnabled: false, resizeEnabled: false, crop: EMPTY_CROP,
  paper: 'a4', orientation: 'portrait', width: 210, height: 297,
}

/** Sizes returned by pdf.js already include the source rotation and UserUnit. */
export function displayedSize(size: PageSize, rotation: number): PageSize {
  return rotation % 180 ? { width: size.height, height: size.width } : size
}

export function targetSize(settings: OrganizeSettings): PageSize {
  if (settings.paper === 'custom') return { width: settings.width, height: settings.height }
  const [width, height] = settings.paper === 'a4' ? [210, 297] : [215.9, 279.4]
  return settings.orientation === 'portrait' ? { width, height } : { width: height, height: width }
}

/** Selection follows card IDs across reorders, but the API uses output positions. */
export function pageLayout(items: readonly OrganizeItem[], selected: ReadonlySet<string>, settings: OrganizeSettings): PageLayout | undefined {
  if (!settings.cropEnabled && !settings.resizeEnabled) return undefined
  return {
    pages: items.flatMap((item, index) => selected.has(item.id) ? [index + 1] : []),
    crop: settings.cropEnabled ? settings.crop : null,
    resize: settings.resizeEnabled ? targetSize(settings) : null,
  }
}

export function layoutProblem(items: readonly OrganizeItem[], sizes: readonly PageSize[], layout: PageLayout | undefined): string | null {
  if (!layout) return null
  if (!layout.pages.length) return 'Select at least one page to crop or resize.'
  if (layout.resize && Object.values(layout.resize).some((n) => !Number.isFinite(n) || n < 1 || n > 5080)) {
    return 'Page width and height must be between 1 and 5080 mm.'
  }
  if (layout.crop) {
    const { top, right, bottom, left } = layout.crop
    if (Object.values(layout.crop).some((n) => !Number.isFinite(n) || n < 0 || n > 5080)) return 'Crop margins must be between 0 and 5080 mm.'
    for (const position of layout.pages) {
      const item = items[position - 1]
      if (!item || !sizes[item.page - 1]) return 'Wait for the page dimensions to load.'
      const size = displayedSize(sizes[item.page - 1], item.rotation)
      if (size.width / POINTS_PER_MM - left - right < 1 || size.height / POINTS_PER_MM - top - bottom < 1) {
        return `Crop margins leave less than 1 mm on output page ${position}. Reduce the margins.`
      }
    }
  }
  return null
}

/** A drag in either direction defines the retained rectangle, in physical mm. */
export function cropFromDrag(start: PageSize, end: PageSize, size: PageSize): CropMargins | null {
  const clamp = (n: number, max: number) => Math.max(0, Math.min(n, max))
  const left = clamp(Math.min(start.width, end.width), size.width)
  const right = clamp(Math.max(start.width, end.width), size.width)
  const top = clamp(Math.min(start.height, end.height), size.height)
  const bottom = clamp(Math.max(start.height, end.height), size.height)
  if (right - left < 1.2 || bottom - top < 1.2) return null
  const round = (n: number) => Math.round(n * 10) / 10
  return { top: round(top), right: round(size.width - right), bottom: round(size.height - bottom), left: round(left) }
}
