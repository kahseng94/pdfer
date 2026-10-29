import type { FontFamily } from './edits'
import { pagesIn, parseSpec } from './ranges'

export const STAMP_POSITIONS = [
  ['top-left', 'Top left'], ['top-center', 'Top center'], ['top-right', 'Top right'],
  ['middle-left', 'Middle left'], ['center', 'Center'], ['middle-right', 'Middle right'],
  ['bottom-left', 'Bottom left'], ['bottom-center', 'Bottom center'], ['bottom-right', 'Bottom right'],
] as const
export type StampPosition = (typeof STAMP_POSITIONS)[number][0]
export const NUMBER_FORMATS = [
  ['number', '1'], ['page', 'Page 1'], ['of-total', '1 of 10'], ['page-of-total', 'Page 1 of 10'],
] as const

export type StampStyle = { position: StampPosition; size: number; margin: number; color: string; family: FontFamily }
export type NumberSettings = StampStyle & { start: number; mode: 'document' | 'selected'; format: (typeof NUMBER_FORMATS)[number][0] }
export type WatermarkSettings = StampStyle & { text: string; opacity: number; rotation: number }
export type StampSettings = { pages: string; numbers: NumberSettings | null; watermark: WatermarkSettings | null }

export const DEFAULT_NUMBERS: NumberSettings = { position: 'bottom-center', size: 12, margin: 24, color: '#374151', family: 'sans', start: 1, mode: 'document', format: 'page-of-total' }
export const DEFAULT_WATERMARK: WatermarkSettings = { position: 'center', size: 48, margin: 24, color: '#6b7280', family: 'sans', text: 'DRAFT', opacity: 0.2, rotation: -45 }

/** A description of the first selected page's number, using the same numbering rules as the PDF. */
export function numberText(settings: NumberSettings, page: number, index: number, selected: number, total: number): string {
  const number = settings.start + (settings.mode === 'document' ? page - 1 : index)
  const last = settings.start + (settings.mode === 'document' ? total : selected) - 1
  const prefix = settings.format === 'page' || settings.format === 'page-of-total' ? 'Page ' : ''
  const suffix = settings.format === 'of-total' || settings.format === 'page-of-total' ? ` of ${last}` : ''
  return `${prefix}${number}${suffix}`
}

const within = (n: number, min: number, max: number) => Number.isFinite(n) && n >= min && n <= max

/** Explain invalid inputs before starting a preview; the backend validates them again. */
export function stampProblem(settings: StampSettings, total: number): string | null {
  const { ranges, invalid } = parseSpec(settings.pages, total)
  if (invalid.length) return `Not valid for this ${total}-page file: ${invalid.join(', ')}`
  if (!pagesIn(ranges).size) return 'Choose at least one page.'
  if (!settings.numbers && !settings.watermark) return 'Enable page numbers, a watermark, or both.'
  for (const [label, style, max] of [['Number', settings.numbers, 72], ['Watermark', settings.watermark, 200]] as const) {
    if (!style) continue
    if (!within(style.size, 6, max)) return `${label} size must be from 6 to ${max} points.`
    if (!within(style.margin, 0, 144)) return `${label} margin must be from 0 to 144 points.`
  }
  if (settings.numbers && (!Number.isInteger(settings.numbers.start) || !within(settings.numbers.start, 1, 1_000_000))) return 'Start numbering with a whole number from 1 to 1000000.'
  if (settings.watermark) {
    const { text, opacity, rotation } = settings.watermark
    if (!text.trim()) return 'Enter some watermark text.'
    if (Array.from(text).length > 200) return 'Use at most 200 characters for the watermark.'
    if (Array.from(text).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) return 'Use a single line without control characters for the watermark.'
    if (!within(opacity, 0.01, 1)) return 'Watermark opacity must be from 1% to 100%.'
    if (!within(rotation, -180, 180)) return 'Watermark rotation must be from -180 to 180 degrees.'
  }
  return null
}
