import { describe, expect, it } from 'vitest'
import { describeOrientation, formatCamera, formatLocation, mirrored, outputFormat, outputName, parsePhotoResults, resizePlan, resizeProblem, turned, turnStyle, UPRIGHT, type Orientation } from './photoEdits'

describe('resizePlan', () => {
  // The same cases as the backend's TestResizePlan, so both sides agree.
  it.each([
    [{ width: 4000, height: 3000 }, { width: 1200 }, [1200, 900], [1200, 900]],
    [{ width: 4000, height: 3000 }, { height: 600 }, [800, 600], [800, 600]],
    [{ width: 4000, height: 3000 }, { percent: 50 }, [2000, 1500], [2000, 1500]],
    [{ width: 4000, height: 3000 }, { longest: 1600 }, [1600, 1200], [1600, 1200]],
    [{ width: 3000, height: 4000 }, { longest: 1600 }, [1200, 1600], [1200, 1600]],
    [{ width: 4000, height: 3000 }, { width: 1200, height: 800 }, [1067, 800], [1067, 800]],
    [{ width: 4000, height: 3000 }, { width: 1200, height: 800, fit: 'cover' as const }, [1200, 900], [1200, 800]],
    [{ width: 4000, height: 3000 }, { width: 1200, height: 800, fit: 'stretch' as const }, [1200, 800], [1200, 800]],
    [{ width: 400, height: 300 }, { width: 1200 }, [400, 300], [400, 300]],
    [{ width: 400, height: 300 }, { width: 1200, height: 800, fit: 'stretch' as const }, [400, 300], [400, 300]],
    [{ width: 400, height: 300 }, { width: 1200, height: 800, fit: 'cover' as const }, [400, 300], [400, 300]],
    [{ width: 400, height: 300 }, { width: 1200, enlarge: true }, [1200, 900], [1200, 900]],
    [{ width: 400, height: 300 }, { percent: 250, enlarge: true }, [1000, 750], [1000, 750]],
    [{ width: 3, height: 3 }, { percent: 50 }, [2, 2], [2, 2]],
    [{ width: 1, height: 1 }, { percent: 1 }, [1, 1], [1, 1]],
  ])('%j resized by %j', (size, resize, scaled, final) => {
    const plan = resizePlan(size, resize)
    expect([plan.scaled.width, plan.scaled.height]).toEqual(scaled)
    expect([plan.final.width, plan.final.height]).toEqual(final)
  })

  it('leaves a picture alone when nothing is asked', () => {
    expect(resizePlan({ width: 40, height: 30 }, {})).toEqual({ scaled: { width: 40, height: 30 }, final: { width: 40, height: 30 } })
  })
})

describe('resizeProblem', () => {
  it('wants a size', () => {
    expect(resizeProblem({})).toBe('Enter a size.')
    expect(resizeProblem({ width: 100 })).toBeNull()
  })

  it('bounds the numbers', () => {
    expect(resizeProblem({ width: 0 })).toMatch(/width must be a whole number from 1 to 10,000/)
    expect(resizeProblem({ height: 10.5 })).toMatch(/height must be a whole number/)
    expect(resizeProblem({ longest: 20_000 })).toMatch(/longest side/)
    expect(resizeProblem({ percent: 0.5 })).toBe('The percentage must be between 1 and 400.')
    expect(resizeProblem({ percent: NaN })).toBe('The percentage must be between 1 and 400.')
  })
})

describe('outputFormat and outputName', () => {
  const file = (name: string, type = '') => ({ name, type })

  it('keeps JPEG, PNG and WebP and leaves the rest to the backend', () => {
    expect(outputFormat(file('a.JPG'), 'keep')).toBe('jpeg')
    expect(outputFormat(file('a', 'image/png'), 'keep')).toBe('png')
    expect(outputFormat(file('a.webp'), 'keep')).toBe('webp')
    expect(outputFormat(file('a.gif', 'image/gif'), 'keep')).toBe('auto')
    expect(outputFormat(file('a.gif'), 'png')).toBe('png')
  })

  it('names the result as the backend does', () => {
    expect(outputName('holiday.snap.png', 'jpeg', 'resized')).toBe('holiday.snap_resized.jpg')
    expect(outputName('holiday', 'webp', '')).toBe('holiday.webp')
    expect(outputName('', 'png', 'x')).toBe('photo_x.png')
    expect(outputName('scan.tif', 'auto', 'rotated')).toBe('scan_rotated.jpg or png')
  })
})

describe('parsePhotoResults', () => {
  const files = [{ name: 'a.jpg', size: 100 }, { name: 'b.png', size: 200 }]

  it('reads one entry per file, decoding names', () => {
    const header = JSON.stringify([
      { name: 'a_resized.jpg', before: 100, after: 40, width: 10, height: 5 },
      { name: '%C3%BC%20b_resized.png', before: 200, after: 250, width: 20, height: 10 },
    ])
    expect(parsePhotoResults(header, files)).toEqual([
      { name: 'a_resized.jpg', before: 100, after: 40, width: 10, height: 5 },
      { name: 'ü b_resized.png', before: 200, after: 250, width: 20, height: 10 },
    ])
  })

  it('falls back to the files when the header is missing or odd', () => {
    expect(parsePhotoResults(null, files)).toEqual([
      { name: 'a.jpg', before: 100, after: 100, width: 0, height: 0 },
      { name: 'b.png', before: 200, after: 200, width: 0, height: 0 },
    ])
    expect(parsePhotoResults('{not json', files)[1].after).toBe(200)
    expect(parsePhotoResults('[{"name": "%E0%A4%A"}]', files)[0].name).toBe('%E0%A4%A')
  })
})

describe('formatting photo details', () => {
  it('writes a location in degrees with hemispheres', () => {
    expect(formatLocation({ latitude: 37.775, longitude: -122.416667, altitude: null })).toBe('37.7750°N, 122.4167°W')
    expect(formatLocation({ latitude: -33.86, longitude: 151.21, altitude: 5 })).toBe('33.8600°S, 151.2100°E')
    expect(formatLocation(null)).toBeNull()
    expect(formatLocation({ latitude: 1, longitude: null, altitude: null })).toBeNull()
  })

  it('does not say the make twice', () => {
    expect(formatCamera({ make: 'Canon', model: 'Canon EOS R5', lens: null, software: null })).toBe('Canon EOS R5')
    expect(formatCamera({ make: 'Apple', model: 'iPhone 15', lens: null, software: null })).toBe('Apple iPhone 15')
    expect(formatCamera({ make: 'Nikon', model: null, lens: null, software: null })).toBe('Nikon')
    expect(formatCamera({ make: null, model: null, lens: null, software: null })).toBeNull()
  })
})

describe('orientation', () => {
  const right = (o: Orientation) => turned(o, true)
  const left = (o: Orientation) => turned(o, false)

  it('turns in quarter turns', () => {
    expect(right(UPRIGHT)).toEqual({ turns: 1, flip: 'none' })
    expect(right(right(right(right(UPRIGHT))))).toEqual(UPRIGHT)
    expect(left(UPRIGHT)).toEqual({ turns: 3, flip: 'none' })
  })

  it('turns a mirrored picture the way it looks on screen', () => {
    const mirror = mirrored(UPRIGHT, 'horizontal')
    expect(right(mirror)).toEqual({ turns: 3, flip: 'horizontal' })
    expect(left(mirror)).toEqual({ turns: 1, flip: 'horizontal' })
    expect(right(left(mirror))).toEqual(mirror)
  })

  it('mirrors, and mirroring both ways is a half turn', () => {
    expect(mirrored(mirrored(UPRIGHT, 'vertical'), 'vertical')).toEqual(UPRIGHT)
    expect(mirrored(mirrored(UPRIGHT, 'horizontal'), 'vertical')).toEqual({ turns: 2, flip: 'none' })
    expect(mirrored({ turns: 3, flip: 'vertical' }, 'horizontal')).toEqual({ turns: 1, flip: 'none' })
  })

  it('describes and styles the result', () => {
    expect(describeOrientation(UPRIGHT)).toBe('Not turned')
    expect(describeOrientation({ turns: 1, flip: 'none' })).toBe('Turned 90° clockwise')
    expect(describeOrientation({ turns: 0, flip: 'vertical' })).toBe('Mirrored top to bottom')
    expect(describeOrientation({ turns: 2, flip: 'horizontal' })).toBe('Turned 180° clockwise, then mirrored left to right')
    expect(turnStyle({ turns: 1, flip: 'horizontal' })).toBe('scaleX(-1) rotate(90deg)')
    expect(turnStyle(UPRIGHT)).toBe('rotate(0deg)')
  })
})
