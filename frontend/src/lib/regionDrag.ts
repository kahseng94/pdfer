import { constrainBox, regionOnPage, type Point, type RegionElement } from './edits'

export type RegionPageSurface = {
  page: number
  size: { width: number; height: number }
  rect: { left: number; top: number; width: number; height: number }
}

/** Keep the grabbed point under the pointer, including when a smaller page scales the region. */
export function placeDraggedRegion(original: RegionElement, client: Point, grab: Point, surfaces: RegionPageSurface[], fallbackPage: number): RegionElement {
  const usable = surfaces.filter(({ rect }) => rect.width > 0 && rect.height > 0)
  const target = usable.find(({ rect }) => client[0] >= rect.left && client[0] <= rect.left + rect.width && client[1] >= rect.top && client[1] <= rect.top + rect.height)
    ?? usable.find(({ page }) => page === fallbackPage)
  if (!target) return original
  const fitted = regionOnPage(original, target.page, target.size)
  const x = (client[0] - target.rect.left) / target.rect.width * target.size.width - grab[0] * fitted.width
  const y = (client[1] - target.rect.top) / target.rect.height * target.size.height - grab[1] * fitted.height
  return { ...fitted, ...constrainBox({ ...fitted, x, y }, target.size) }
}

/** Scroll faster as a held pointer approaches the visible editing area's edges. */
export function regionScrollDelta(y: number, top: number, bottom: number, elapsedMs: number): number {
  if (bottom <= top) return 0
  const band = Math.min(64, (bottom - top) / 3)
  const speed = y < top + band ? -Math.min(1, (top + band - y) / band)
    : y > bottom - band ? Math.min(1, (y - bottom + band) / band) : 0
  return speed * 700 * Math.min(32, Math.max(0, elapsedMs)) / 1000
}
