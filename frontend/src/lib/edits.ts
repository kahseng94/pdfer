// What the Edit tool puts on pages, and how that turns into the backend's edits.
//
// Positions and sizes are in points on the page as pdf.js shows it: the
// origin is the top-left corner, x runs right and y runs down. The backend
// draws in the same frame, so nothing here needs to know about page rotation.

import { fontCss } from './fonts'

export type Point = [number, number]
export type Box = { x: number; y: number; width: number; height: number }

export type FontFamily = 'sans' | 'serif' | 'mono'
export type RegionRotation = 0 | 90 | 180 | 270
export const REGION_ROTATIONS: RegionRotation[] = [0, 90, 180, 270]

/** Same numbers as the backend: the first baseline below the top of a text box, and the line spacing, in ems. */
export const TEXT_ASCENT = 0.9
export const TEXT_LINE_HEIGHT = 1.2

export const FONT_SIZES = [8, 10, 12, 14, 18, 24, 36, 48, 72]
export const STROKE_WIDTHS = [1, 2, 4, 8]

type Base = { id: string; page: number }

export type TextElement = Base & {
  type: 'text'
  x: number
  y: number
  text: string
  size: number
  color: string
  family: FontFamily
  bold: boolean
  italic: boolean
}
export type ImageElement = Base & {
  type: 'image'
  x: number
  y: number
  width: number
  height: number
  file: File
  /** Object URL for the preview; lives as long as the tool has the file open. */
  url: string
}
/** A cutout of the original page; the source never changes when it is moved or resized. */
export type RegionElement = Base & Box & {
  type: 'region'
  sourcePage: number
  source: Box
  /** Clockwise quarter turns. Width and height describe the rotated visible box. */
  rotation?: RegionRotation
  /** An independent placement that never covers the original source. */
  copy?: boolean
  /** Keep the source covered without placing the cutout at its destination. */
  deleted?: boolean
}
export type ShapeElement = Base & {
  type: 'rect' | 'ellipse'
  x: number
  y: number
  width: number
  height: number
  stroke: string
  strokeWidth: number
  fill: string | null
}
export type HighlightElement = Base & { type: 'highlight'; x: number; y: number; width: number; height: number; color: string }
export type LineElement = Base & { type: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: string; strokeWidth: number }
export type DrawElement = Base & { type: 'draw'; points: Point[]; stroke: string; strokeWidth: number }

export type Element = TextElement | ImageElement | RegionElement | ShapeElement | HighlightElement | LineElement | DrawElement
export type BoxElement = ImageElement | RegionElement | ShapeElement | HighlightElement

export type Tool = 'select' | 'region' | 'text' | 'highlight' | 'rect' | 'ellipse' | 'line' | 'draw'

/** How new elements look. Restyling a selected element updates these too. */
export type Style = {
  color: string
  size: number
  family: FontFamily
  bold: boolean
  italic: boolean
  stroke: string
  strokeWidth: number
  fill: string | null
  highlight: string
}

export const DEFAULT_STYLE: Style = {
  color: '#18181b',
  size: 14,
  family: 'sans',
  bold: false,
  italic: false,
  stroke: '#e11d48',
  strokeWidth: 2,
  fill: null,
  highlight: '#fde047',
}

export const MIN_SIZE = 2

// --- Text ------------------------------------------------------------------

/** Line endings as the backend expects them, tabs as spaces, other control characters dropped. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '') // oxlint-disable-line no-control-regex
}

export function textLines(text: string): string[] {
  return text.split('\n')
}

let context: CanvasRenderingContext2D | null | undefined

function canvas(): CanvasRenderingContext2D | null {
  if (context === undefined) context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  return context
}

/** Width of one line in points. Without a DOM (in tests) a rough guess. */
export function lineWidth(line: string, el: Pick<TextElement, 'size' | 'family' | 'bold' | 'italic' | 'text'>): number {
  const c = canvas()
  if (!c) return line.length * el.size * 0.55
  c.font = fontCss(el)
  return c.measureText(line).width
}

/** The text's box: as wide as its widest line, as tall as its lines. */
export function textBox(el: TextElement): Box {
  const lines = textLines(el.text)
  const width = Math.max(el.size * 0.5, ...lines.map((l) => lineWidth(l, el)))
  return { x: el.x, y: el.y, width, height: lines.length * el.size * TEXT_LINE_HEIGHT }
}

/**
 * Where a textarea's top must go for its first baseline to land where the SVG
 * text's does. CSS centres the font's own ascent + descent in each line box;
 * SVG puts the baseline exactly where it is told.
 */
export function textareaTop(el: TextElement): number {
  const c = canvas()
  if (!c) return el.y
  c.font = fontCss(el)
  const m = c.measureText('Hg')
  const ascent = m.fontBoundingBoxAscent ?? el.size * 0.9
  const descent = m.fontBoundingBoxDescent ?? el.size * 0.2
  const cssBaseline = (el.size * TEXT_LINE_HEIGHT - (ascent + descent)) / 2 + ascent
  return el.y + el.size * TEXT_ASCENT - cssBaseline
}

// --- Geometry --------------------------------------------------------------

function boxAround(points: Point[], pad: number): Box {
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const x = Math.min(...xs) - pad
  const y = Math.min(...ys) - pad
  return { x, y, width: Math.max(...xs) + pad - x, height: Math.max(...ys) + pad - y }
}

export function bounds(el: Element): Box {
  switch (el.type) {
    case 'text':
      return textBox(el)
    case 'line':
      return boxAround([[el.x1, el.y1], [el.x2, el.y2]], el.strokeWidth / 2)
    case 'draw':
      return boxAround(el.points, el.strokeWidth / 2)
    default:
      return { x: el.x, y: el.y, width: el.width, height: el.height }
  }
}

export function moved<T extends Element>(el: T, dx: number, dy: number): T {
  switch (el.type) {
    case 'line':
      return { ...el, x1: el.x1 + dx, y1: el.y1 + dy, x2: el.x2 + dx, y2: el.y2 + dy }
    case 'draw':
      return { ...el, points: el.points.map(([x, y]): Point => [x + dx, y + dy]) }
    default:
      return { ...el, x: el.x + dx, y: el.y + dy }
  }
}

/** A boxed element moved and sized to the box. */
export function withBox<T extends BoxElement>(el: T, box: Box): T {
  return { ...el, x: box.x, y: box.y, width: box.width, height: box.height }
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** The box after one of its handles is dragged by (dx, dy). Corners keep the aspect ratio when asked. */
export function resized(box: Box, handle: Handle, dx: number, dy: number, keepAspect = false): Box {
  let { x, y, width, height } = box
  const right = x + width
  const bottom = y + height
  if (handle.includes('w')) {
    x = Math.min(x + dx, right - MIN_SIZE)
    width = right - x
  }
  if (handle.includes('e')) width = Math.max(width + dx, MIN_SIZE)
  if (handle.includes('n')) {
    y = Math.min(y + dy, bottom - MIN_SIZE)
    height = bottom - y
  }
  if (handle.includes('s')) height = Math.max(height + dy, MIN_SIZE)

  if (keepAspect && handle.length === 2) {
    // Follow whichever side grew more, in proportion.
    if (width / box.width >= height / box.height) height = (width * box.height) / box.width
    else width = (height * box.width) / box.height
    if (handle.includes('w')) x = right - width
    if (handle.includes('n')) y = bottom - height
  }
  return { x, y, width, height }
}

/** The box with the two points as opposite corners. */
export function boxBetween(a: Point, b: Point): Box {
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]) }
}

export function clampPoint(p: Point, page: { width: number; height: number }): Point {
  return [Math.max(0, Math.min(p[0], page.width)), Math.max(0, Math.min(p[1], page.height))]
}

/** Keep a region entirely on its page, shrinking proportionally when requested. */
export function constrainBox(box: Box, page: { width: number; height: number }, keepAspect = false): Box {
  const scale = keepAspect ? Math.min(1, page.width / box.width, page.height / box.height) : 1
  const width = Math.min(page.width, Math.max(MIN_SIZE, box.width * scale))
  const height = Math.min(page.height, Math.max(MIN_SIZE, box.height * scale))
  return { x: Math.max(0, Math.min(box.x, page.width - width)), y: Math.max(0, Math.min(box.y, page.height - height)), width, height }
}

/** Changing the destination never changes where the original cutout came from. */
export function regionOnPage(region: RegionElement, page: number, size: { width: number; height: number }): RegionElement {
  return { ...region, page, ...constrainBox(region, size, true) }
}

/** Rotate about the destination's center, fitting the new visible box on the page. */
export function rotateRegion(region: RegionElement, rotation: RegionRotation, size: { width: number; height: number }): RegionElement {
  if (rotation === (region.rotation ?? 0)) return region
  const swap = Math.abs(rotation - (region.rotation ?? 0)) % 180 !== 0
  const fitted = constrainBox({ x: 0, y: 0, width: swap ? region.height : region.width, height: swap ? region.width : region.height }, size, true)
  const box = constrainBox({ ...fitted, x: region.x + region.width / 2 - fitted.width / 2, y: region.y + region.height / 2 - fitted.height / 2 }, size)
  return { ...region, ...box, rotation }
}

export function copyRegionToPage(region: RegionElement, id: string, page: number, size: { width: number; height: number }): RegionElement {
  const { deleted: _deleted, ...original } = region
  const copy = regionOnPage({ ...original, id, copy: true }, page, size)
  if (page !== region.page) return copy
  // Reveal a same-page copy while keeping it inside the page. Near the
  // right/bottom edge, offset in the opposite direction instead.
  const offset = (position: number, limit: number) => {
    if (position + 12 <= limit) return position + 12
    if (position >= 12) return position - 12
    return limit - position >= position ? limit : 0
  }
  return { ...copy, x: offset(copy.x, size.width - copy.width), y: offset(copy.y, size.height - copy.height) }
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

/** Where a picture goes when added to a page: centred, at 96 dpi, and no more than 60% of the page. */
export function imagePlacement(natural: { width: number; height: number }, page: { width: number; height: number }): Box {
  let width = natural.width * 0.75
  let height = natural.height * 0.75
  const scale = Math.min(1, (page.width * 0.6) / width, (page.height * 0.6) / height)
  width *= scale
  height *= scale
  return { x: (page.width - width) / 2, y: (page.height - height) / 2, width, height }
}

// --- What the backend takes ------------------------------------------------

type Common = { page: number }
export type EditPayload =
  | (Common & { type: 'text'; x: number; y: number; text: string; size: number; color: string; family: FontFamily; bold: boolean; italic: boolean })
  | (Common & { type: 'image'; x: number; y: number; width: number; height: number; image: number })
  | (Common & Box & { type: 'region'; sourcePage: number; source: Box; rotation?: RegionRotation; copy?: boolean; deleted?: boolean })
  | (Common & { type: 'rect' | 'ellipse'; x: number; y: number; width: number; height: number; stroke: string; strokeWidth: number; fill: string | null })
  | (Common & { type: 'highlight'; x: number; y: number; width: number; height: number; color: string })
  | (Common & { type: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: string; strokeWidth: number })
  | (Common & { type: 'draw'; points: Point[]; stroke: string; strokeWidth: number })

const round = (n: number) => Math.round(n * 100) / 100
export const roundedBox = (box: Box): Box => ({ x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) })

/** The edits as JSON for the backend, and the image files they refer to by index. */
export function toPayload(elements: readonly Element[]): { edits: EditPayload[]; images: File[] } {
  const images: File[] = []
  const index = new Map<File, number>()
  const edits = elements.map((el): EditPayload => {
    switch (el.type) {
      case 'text':
        return {
          type: 'text',
          page: el.page,
          x: round(el.x),
          y: round(el.y),
          text: normalizeText(el.text),
          size: el.size,
          color: el.color,
          family: el.family,
          bold: el.bold,
          italic: el.italic,
        }
      case 'image': {
        let i = index.get(el.file)
        if (i === undefined) {
          i = images.push(el.file) - 1
          index.set(el.file, i)
        }
        return { type: 'image', page: el.page, x: round(el.x), y: round(el.y), width: round(el.width), height: round(el.height), image: i }
      }
      case 'region':
        return { type: 'region', page: el.page, sourcePage: el.sourcePage, ...roundedBox(el), source: roundedBox(el.source), ...(el.rotation ? { rotation: el.rotation } : {}), ...(el.copy ? { copy: true } : {}), ...(el.deleted ? { deleted: true } : {}) }
      case 'rect':
      case 'ellipse':
        return { type: el.type, page: el.page, x: round(el.x), y: round(el.y), width: round(el.width), height: round(el.height), stroke: el.stroke, strokeWidth: el.strokeWidth, fill: el.fill }
      case 'highlight':
        return { type: 'highlight', page: el.page, x: round(el.x), y: round(el.y), width: round(el.width), height: round(el.height), color: el.color }
      case 'line':
        return { type: 'line', page: el.page, x1: round(el.x1), y1: round(el.y1), x2: round(el.x2), y2: round(el.y2), stroke: el.stroke, strokeWidth: el.strokeWidth }
      case 'draw':
        return { type: 'draw', page: el.page, points: el.points.map(([x, y]): Point => [round(x), round(y)]), stroke: el.stroke, strokeWidth: el.strokeWidth }
    }
  })
  return { edits, images }
}
