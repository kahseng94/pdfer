import type { Box, EditPayload, ImageElement, Point } from './edits'

export type InkStroke = { points: Point[]; color: string; width: number }
export type SignaturePage = { width: number; height: number; unit: number }
export type SignaturePlacement = ImageElement & { signatureId: string; label: string; aspect: number }
export const PAD_WIDTH = 800
export const PAD_HEIGHT = 240

export function inkBounds(strokes: readonly InkStroke[]): Box | null {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
  for (const stroke of strokes) for (const [x, y] of stroke.points) {
    const padding = stroke.width / 2 + 8
    left = Math.min(left, x - padding); top = Math.min(top, y - padding)
    right = Math.max(right, x + padding); bottom = Math.max(bottom, y + padding)
  }
  return Number.isFinite(left) ? { x: left, y: top, width: right - left, height: bottom - top } : null
}

/** Export only the ink, with a transparent background and padding for round caps. */
export async function drawSignature(strokes: readonly InkStroke[]): Promise<File> {
  const box = inkBounds(strokes)
  if (!box) throw new Error('Draw a signature first.')
  const canvas = document.createElement('canvas')
  const scale = Math.min(2, 1600 / Math.max(box.width, box.height))
  canvas.width = Math.ceil(box.width * scale)
  canvas.height = Math.ceil(box.height * scale)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('The signature drawing could not be prepared.')
  try {
    context.scale(scale, scale)
    context.translate(-box.x, -box.y)
    context.lineCap = 'round'; context.lineJoin = 'round'
    for (const stroke of strokes) {
      if (!stroke.points.length) continue
      context.strokeStyle = stroke.color; context.fillStyle = stroke.color; context.lineWidth = stroke.width
      context.beginPath()
      if (stroke.points.length === 1) {
        context.arc(stroke.points[0][0], stroke.points[0][1], stroke.width / 2, 0, Math.PI * 2)
        context.fill()
      } else {
        context.moveTo(...stroke.points[0])
        for (const point of stroke.points.slice(1)) context.lineTo(...point)
        context.stroke()
      }
    }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Could not prepare the signature image.')), 'image/png'))
    return new File([blob], 'signature.png', { type: 'image/png' })
  } finally { canvas.width = 0; canvas.height = 0 }
}

export function fitSignature<T extends SignaturePlacement>(placement: T, page: SignaturePage): T {
  const maximum = Math.min(page.width, page.height * placement.aspect)
  const width = Math.min(Math.max(placement.width, Math.min(12, maximum)), maximum)
  const height = width / placement.aspect
  return { ...placement, width, height, x: Math.min(Math.max(0, placement.x), page.width - width), y: Math.min(Math.max(0, placement.y), page.height - height) }
}

export function initialSignatureBox(aspect: number, page: SignaturePage): Box {
  const margin = Math.min(24, page.width / 10, page.height / 10)
  const width = Math.min(180, page.width - margin * 2, (page.height - margin * 2) * aspect)
  const height = width / aspect
  return { x: (page.width - width) / 2, y: page.height - margin - height, width, height }
}

/** The editor uses physical points; the existing PDF painter uses page user units. */
export function signaturePayload(placements: readonly SignaturePlacement[], pages: readonly SignaturePage[]): { edits: EditPayload[]; images: File[] } {
  const images: File[] = []
  const indices = new Map<File, number>()
  const edits = placements.map((placement): EditPayload => {
    const page = pages[placement.page - 1]
    if (!page) throw new Error('A signature refers to a page that is no longer open.')
    let index = indices.get(placement.file)
    if (index === undefined) { index = images.push(placement.file) - 1; indices.set(placement.file, index) }
    const point = (value: number) => Math.round(value / page.unit * 1_000_000) / 1_000_000
    return { type: 'image', page: placement.page, x: point(placement.x), y: point(placement.y), width: point(placement.width), height: point(placement.height), image: index }
  })
  return { edits, images }
}
