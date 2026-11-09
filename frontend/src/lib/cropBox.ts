// A crop box drawn over a photo: where it is, how it moves and resizes, and
// how it stays inside the picture, in whole picture pixels.

import type { Crop, Size } from './photo'

export type Box = { x: number; y: number; width: number; height: number }

/** The sides and corners a box can be dragged by. */
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** The smallest a box gets, in picture pixels. */
export const MIN_BOX = 8

export type AspectChoice = { id: string; label: string; ratio: number | null }

/** Aspect ratios offered for a crop; `original` and `custom` are filled in by the tool. */
export const ASPECTS: readonly AspectChoice[] = [
  { id: 'free', label: 'Free', ratio: null },
  { id: 'original', label: 'Original', ratio: null },
  { id: '1:1', label: 'Square · 1:1', ratio: 1 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '3:2', label: '3:2', ratio: 3 / 2 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '4:5', label: 'Portrait · 4:5', ratio: 4 / 5 },
  { id: '9:16', label: 'Story · 9:16', ratio: 9 / 16 },
  { id: 'custom', label: 'Custom…', ratio: null },
]

/** The picture's size after `turns` clockwise quarter turns. */
export function turnedSize(size: Size, turns: number): Size {
  return turns % 2 ? { width: size.height, height: size.width } : size
}

function round(box: Box): Box {
  return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
}

/** The smallest allowed size for an aspect: MIN_BOX along the shorter side. */
function minSize(aspect: number | null): Size {
  if (aspect === null) return { width: MIN_BOX, height: MIN_BOX }
  return aspect >= 1 ? { width: MIN_BOX * aspect, height: MIN_BOX } : { width: MIN_BOX, height: MIN_BOX / aspect }
}

/**
 * Keep the box inside the picture and no smaller than MIN_BOX, shrinking it
 * about its own top-left corner when it doesn't fit and then moving it in.
 * With an aspect (width / height) the proportions are restored too.
 */
export function clampBox(box: Box, image: Size, aspect: number | null): Box {
  const min = minSize(aspect)
  let width = Math.min(Math.max(box.width, min.width), image.width)
  let height = Math.min(Math.max(box.height, min.height), image.height)
  if (aspect !== null) {
    width = Math.min(width, height * aspect)
    height = width / aspect
    if (height > image.height) {
      height = image.height
      width = height * aspect
    }
  }
  const placed = round({ ...box, width, height })
  return {
    ...placed,
    x: Math.min(Math.max(placed.x, 0), Math.max(0, image.width - placed.width)),
    y: Math.min(Math.max(placed.y, 0), Math.max(0, image.height - placed.height)),
  }
}

/** The largest box of `aspect` (null: the whole picture) centred in the picture. */
export function fitBox(image: Size, aspect: number | null): Box {
  if (aspect === null) return { x: 0, y: 0, width: image.width, height: image.height }
  const width = Math.min(image.width, image.height * aspect)
  const height = width / aspect
  return clampBox({ x: (image.width - width) / 2, y: (image.height - height) / 2, width, height }, image, aspect)
}

/** The box moved by (dx, dy) picture pixels, kept inside. */
export function moveBox(box: Box, dx: number, dy: number, image: Size): Box {
  return clampBox({ ...box, x: box.x + dx, y: box.y + dy }, image, null)
}

/**
 * The box after `handle` is dragged by (dx, dy) picture pixels. The opposite
 * side or corner stays put. With an aspect, dragging a corner keeps it with
 * the far corner fixed; dragging a side changes that side and lets the other
 * dimension grow or shrink about the box's centre.
 */
export function resizeBox(box: Box, handle: Handle, dx: number, dy: number, image: Size, aspect: number | null): Box {
  const min = minSize(aspect)
  let left = box.x
  let top = box.y
  let right = box.x + box.width
  let bottom = box.y + box.height
  const west = handle.includes('w')
  const east = handle.includes('e')
  const north = handle.includes('n')
  const south = handle.includes('s')

  if (west) left = Math.min(Math.max(0, left + dx), right - min.width)
  if (east) right = Math.max(Math.min(image.width, right + dx), left + min.width)
  if (north) top = Math.min(Math.max(0, top + dy), bottom - min.height)
  if (south) bottom = Math.max(Math.min(image.height, bottom + dy), top + min.height)

  if (aspect !== null) {
    const horizontal = west || east
    const vertical = north || south
    let width = right - left
    let height = bottom - top
    if (horizontal && vertical) {
      // A corner: the far corner stays; follow whichever side the pointer pulled further.
      if (width / aspect > height) height = width / aspect
      else width = height * aspect
      const roomX = west ? right : image.width - left
      const roomY = north ? bottom : image.height - top
      width = Math.min(width, roomX, roomY * aspect)
      height = width / aspect
      if (west) left = right - width
      else right = left + width
      if (north) top = bottom - height
      else bottom = top + height
    } else if (horizontal) {
      const cy = (top + bottom) / 2
      height = Math.min(width / aspect, 2 * cy, 2 * (image.height - cy))
      width = height * aspect
      if (west) left = right - width
      else right = left + width
      top = cy - height / 2
      bottom = cy + height / 2
    } else {
      const cx = (left + right) / 2
      width = Math.min(height * aspect, 2 * cx, 2 * (image.width - cx))
      height = width / aspect
      if (north) top = bottom - height
      else bottom = top + height
      left = cx - width / 2
      right = cx + width / 2
    }
  }
  return clampBox({ x: left, y: top, width: right - left, height: bottom - top }, image, aspect)
}

/** The same part of the picture after the picture (of `image` size before the turn) is turned a quarter turn. */
export function rotateBox(box: Box, image: Size, clockwise: boolean): Box {
  return clockwise
    ? { x: image.height - box.y - box.height, y: box.x, width: box.height, height: box.width }
    : { x: box.y, y: image.width - box.x - box.width, width: box.height, height: box.width }
}

/** The same part of the picture after it is mirrored. */
export function flipBox(box: Box, image: Size, flip: 'horizontal' | 'vertical'): Box {
  return flip === 'horizontal' ? { ...box, x: image.width - box.x - box.width } : { ...box, y: image.height - box.y - box.height }
}

/** The crop the backend takes for this box: its centre and size, upright. */
export function toCrop(box: Box): Crop {
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2, width: box.width, height: box.height, angle: 0 }
}

/** The ratio for a choice: the picture's own for `original`, the entered one for `custom`. */
export function aspectFor(choice: string, image: Size, custom: Size): number | null {
  if (choice === 'original') return image.width / image.height
  if (choice === 'custom') return custom.width > 0 && custom.height > 0 ? custom.width / custom.height : null
  return ASPECTS.find((a) => a.id === choice)?.ratio ?? null
}
