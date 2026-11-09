import { describe, expect, it } from 'vitest'
import { aspectFor, clampBox, fitBox, flipBox, MIN_BOX, moveBox, resizeBox, rotateBox, toCrop, turnedSize } from './cropBox'

const image = { width: 400, height: 300 }

describe('fitBox', () => {
  it('takes the whole picture without an aspect', () => {
    expect(fitBox(image, null)).toEqual({ x: 0, y: 0, width: 400, height: 300 })
  })

  it('centres the largest box of the aspect', () => {
    expect(fitBox(image, 1)).toEqual({ x: 50, y: 0, width: 300, height: 300 })
    expect(fitBox(image, 4)).toEqual({ x: 0, y: 100, width: 400, height: 100 })
    expect(fitBox(image, 9 / 16)).toEqual({ x: 116, y: 0, width: 169, height: 300 })
  })
})

describe('clampBox', () => {
  it('moves a box back inside and rounds it', () => {
    expect(clampBox({ x: -10.4, y: 250, width: 100.5, height: 100 }, image, null)).toEqual({ x: 0, y: 200, width: 101, height: 100 })
  })

  it('shrinks a box that does not fit', () => {
    expect(clampBox({ x: 0, y: 0, width: 900, height: 900 }, image, null)).toEqual({ x: 0, y: 0, width: 400, height: 300 })
    expect(clampBox({ x: 100, y: 100, width: 900, height: 900 }, image, 1)).toEqual({ x: 100, y: 0, width: 300, height: 300 })
  })

  it('keeps a box at least MIN_BOX, by the shorter side with an aspect', () => {
    expect(clampBox({ x: 10, y: 10, width: 1, height: 1 }, image, null)).toEqual({ x: 10, y: 10, width: MIN_BOX, height: MIN_BOX })
    expect(clampBox({ x: 10, y: 10, width: 1, height: 1 }, image, 2)).toEqual({ x: 10, y: 10, width: 16, height: 8 })
    expect(clampBox({ x: 10, y: 10, width: 1, height: 1 }, image, 0.5)).toEqual({ x: 10, y: 10, width: 8, height: 16 })
  })
})

describe('moveBox', () => {
  it('slides inside the picture', () => {
    const box = { x: 100, y: 100, width: 100, height: 50 }
    expect(moveBox(box, 20, -30, image)).toEqual({ x: 120, y: 70, width: 100, height: 50 })
    expect(moveBox(box, 1000, 1000, image)).toEqual({ x: 300, y: 250, width: 100, height: 50 })
  })
})

describe('resizeBox', () => {
  const box = { x: 100, y: 100, width: 100, height: 50 }

  it('drags one side, leaving the others', () => {
    expect(resizeBox(box, 'e', 40, 99, image, null)).toEqual({ x: 100, y: 100, width: 140, height: 50 })
    expect(resizeBox(box, 'w', -20, 0, image, null)).toEqual({ x: 80, y: 100, width: 120, height: 50 })
    expect(resizeBox(box, 'n', -10, -10, image, null)).toEqual({ x: 100, y: 90, width: 100, height: 60 })
    expect(resizeBox(box, 's', 0, 25, image, null)).toEqual({ x: 100, y: 100, width: 100, height: 75 })
  })

  it('drags a corner', () => {
    expect(resizeBox(box, 'se', 30, 30, image, null)).toEqual({ x: 100, y: 100, width: 130, height: 80 })
    expect(resizeBox(box, 'nw', -30, -30, image, null)).toEqual({ x: 70, y: 70, width: 130, height: 80 })
  })

  it('stops at the picture edge and at the smallest size', () => {
    expect(resizeBox(box, 'e', 1000, 0, image, null)).toEqual({ x: 100, y: 100, width: 300, height: 50 })
    expect(resizeBox(box, 'nw', -1000, -1000, image, null)).toEqual({ x: 0, y: 0, width: 200, height: 150 })
    expect(resizeBox(box, 'e', -1000, 0, image, null)).toEqual({ x: 100, y: 100, width: MIN_BOX, height: 50 })
    expect(resizeBox(box, 'n', 0, 1000, image, null)).toEqual({ x: 100, y: 142, width: 100, height: MIN_BOX })
  })

  it('keeps the aspect from a corner with the far corner fixed', () => {
    const square = { x: 100, y: 100, width: 100, height: 100 }
    expect(resizeBox(square, 'se', 40, 10, image, 1)).toEqual({ x: 100, y: 100, width: 140, height: 140 })
    expect(resizeBox(square, 'se', 10, 40, image, 1)).toEqual({ x: 100, y: 100, width: 140, height: 140 })
    expect(resizeBox(square, 'nw', -50, -10, image, 1)).toEqual({ x: 50, y: 50, width: 150, height: 150 })
    // Pulled past the bottom edge: the box can only grow to the room left below.
    expect(resizeBox(square, 'se', 500, 500, image, 1)).toEqual({ x: 100, y: 100, width: 200, height: 200 })
  })

  it('keeps the aspect from a side about the centre', () => {
    const wide = { x: 100, y: 100, width: 200, height: 100 }
    expect(resizeBox(wide, 'e', 40, 0, image, 2)).toEqual({ x: 100, y: 90, width: 240, height: 120 })
    expect(resizeBox(wide, 's', 0, 20, image, 2)).toEqual({ x: 80, y: 100, width: 240, height: 120 })
    // Stopped by the right edge; the height follows about the centre, 150 from the top.
    expect(resizeBox(wide, 'e', 1000, 0, image, 2)).toEqual({ x: 100, y: 75, width: 300, height: 150 })
    // A tall aspect pulled sideways is limited by the top and bottom instead.
    expect(resizeBox({ x: 150, y: 100, width: 50, height: 100 }, 'e', 1000, 0, image, 0.5)).toEqual({ x: 150, y: 0, width: 150, height: 300 })
  })
})

it('turns a size with odd quarter turns', () => {
  expect(turnedSize(image, 1)).toEqual({ width: 300, height: 400 })
  expect(turnedSize(image, 2)).toEqual(image)
  expect(turnedSize(image, 3)).toEqual({ width: 300, height: 400 })
})

it('describes the box as an upright crop about its centre', () => {
  expect(toCrop({ x: 10, y: 20, width: 100, height: 50 })).toEqual({ cx: 60, cy: 45, width: 100, height: 50, angle: 0 })
})

it('resolves aspect choices', () => {
  expect(aspectFor('free', image, { width: 0, height: 0 })).toBeNull()
  expect(aspectFor('original', image, { width: 0, height: 0 })).toBeCloseTo(4 / 3)
  expect(aspectFor('16:9', image, { width: 0, height: 0 })).toBeCloseTo(16 / 9)
  expect(aspectFor('custom', image, { width: 5, height: 2 })).toBe(2.5)
  expect(aspectFor('custom', image, { width: 5, height: 0 })).toBeNull()
})

describe('rotateBox and flipBox', () => {
  // The red top-left quadrant of a 400 × 300 picture.
  const red = { x: 0, y: 0, width: 200, height: 150 }

  it('follows the picture round', () => {
    // Turned clockwise the picture is 300 × 400 and red is top-right.
    expect(rotateBox(red, image, true)).toEqual({ x: 150, y: 0, width: 150, height: 200 })
    // Turned the other way red is bottom-left.
    expect(rotateBox(red, image, false)).toEqual({ x: 0, y: 200, width: 150, height: 200 })
    expect(rotateBox(rotateBox(red, image, true), turnedSize(image, 1), false)).toEqual(red)
  })

  it('follows the picture across a mirror', () => {
    expect(flipBox(red, image, 'horizontal')).toEqual({ x: 200, y: 0, width: 200, height: 150 })
    expect(flipBox(red, image, 'vertical')).toEqual({ x: 0, y: 150, width: 200, height: 150 })
  })
})
