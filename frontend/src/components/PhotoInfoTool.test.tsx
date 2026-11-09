// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PhotoInfo } from '../lib/photoEdits'
import { PhotoInfoTool } from './PhotoInfoTool'

const mocks = vi.hoisted(() => ({ edit: vi.fn(), info: vi.fn() }))
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), editPhotos: mocks.edit, readPhotoInfo: mocks.info }))
vi.mock('../lib/images', async (original) => ({ ...await original<typeof import('../lib/images')>(), imageSize: async () => ({ width: 4000, height: 3000 }) }))

const INFO: PhotoInfo = {
  name: 'IMG_1.jpg', bytes: 2_400_000, format: 'JPEG', media_type: 'image/jpeg', width: 4000, height: 3000, mode: 'Colour', transparency: false,
  frames: 1, dpi: [300, 300], orientation: 6,
  camera: { make: 'Canon', model: 'Canon EOS R5', lens: 'RF 50mm', software: null },
  taken: '2026-11-08 10:00:00',
  exposure: { time: '1/250 s', aperture: 'f/2.8', iso: 400, focal_length: '50 mm', focal_length_35mm: null },
  gps: { latitude: 37.775, longitude: -122.416667, altitude: 120 },
  author: { artist: null, copyright: null, description: null },
  metadata: { exif_tags: 19, xmp: true, icc_profile: false, iptc: false },
}

let root: Root, container: HTMLDivElement
const button = (label: string) => {
  const node = [...container.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!node) throw new Error(`Missing ${label}`)
  return node
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${Math.random()}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('lays out what the photo records and makes a copy without the location', async () => {
  const copy = new File(['x'], 'IMG_1_no-location.jpg', { type: 'image/jpeg' })
  mocks.info.mockResolvedValueOnce(INFO).mockResolvedValueOnce({ ...INFO, gps: null, metadata: { ...INFO.metadata, exif_tags: 13 } })
  mocks.edit.mockResolvedValue({ file: copy, results: [{ name: copy.name, before: 1, after: 2, width: 4000, height: 3000 }] })
  await act(async () => root.render(<PhotoInfoTool />))
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'IMG_1.jpg', { type: 'image/jpeg' })] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(mocks.info).toHaveBeenCalledTimes(1)
  const text = container.textContent!
  for (const expected of ['Canon EOS R5', 'RF 50mm', '2026-11-08 10:00:00', '1/250 s', 'f/2.8', '400', '50 mm', '37.7750°N, 122.4167°W', '120 m above sea level', '300 dpi', 'orientation tag (6)', '19 EXIF tags with a location · XMP']) {
    expect(text).toContain(expected)
  }
  expect(container.querySelector('[aria-label="Author"]')!.textContent).toContain('No author or description.')

  await act(async () => button('Copy without location').click())
  expect(mocks.edit.mock.calls[0][1]).toEqual({ metadata: 'no-location', suffix: 'no-location' })
  await act(async () => { await Promise.resolve() })
  expect(container.textContent).toContain('IMG_1_no-location.jpg')
  expect(container.textContent).toContain('Now: 13 EXIF tags · XMP')
  expect(mocks.info).toHaveBeenCalledTimes(2)
  expect(mocks.info.mock.calls[1][0]).toBe(copy)
})

it('has nothing to remove from a plain picture', async () => {
  mocks.info.mockResolvedValue({ ...INFO, camera: { make: null, model: null, lens: null, software: null }, taken: null, exposure: { time: null, aperture: null, iso: null, focal_length: null, focal_length_35mm: null }, gps: null, orientation: null, metadata: { exif_tags: 0, xmp: false, icc_profile: true, iptc: false } })
  await act(async () => root.render(<PhotoInfoTool />))
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'a.png', { type: 'image/png' })] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(container.querySelector('[aria-label="Camera"]')!.textContent).toContain('No camera data.')
  expect(container.querySelector('[aria-label="Location"]')!.textContent).toContain('No location data.')
  expect(container.textContent).toContain('Metadata in the file: colour profile')
  expect(button('No location to remove').disabled).toBe(true)
  expect(button('No metadata to remove').disabled).toBe(true)
})
