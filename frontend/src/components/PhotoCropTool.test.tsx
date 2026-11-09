// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PhotoCropTool } from './PhotoCropTool'

const mocks = vi.hoisted(() => ({ edit: vi.fn() }))
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), editPhotos: mocks.edit }))
vi.mock('../lib/images', async (original) => ({ ...await original<typeof import('../lib/images')>(), imageSize: async () => ({ width: 4000, height: 3000 }) }))

let root: Root, container: HTMLDivElement
const button = (label: string) => {
  const node = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!node) throw new Error(`Missing ${label}`)
  return node
}
const field = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
const fields = () => ['Left', 'Top', 'Width', 'Height'].map((label) => Number(field(label).value))
async function set(label: string, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(label), value)
    field(label).dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function pick(label: string, value: string) {
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${Math.random()}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  mocks.edit.mockResolvedValue({ file: new File(['x'], 'a_cropped.jpg', { type: 'image/jpeg' }), results: [{ name: 'a_cropped.jpg', before: 1, after: 2, width: 1000, height: 1000 }] })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('starts with the whole photo, keeps the shape, follows a turn and sends the crop', async () => {
  await act(async () => root.render(<PhotoCropTool />))
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(fields()).toEqual([0, 0, 4000, 3000])
  expect(container.textContent).toContain('Output: 4000 × 3000 px')

  await pick('Shape', '1:1')
  expect(fields()).toEqual([500, 0, 3000, 3000])
  await set('Width', '1000')
  expect(fields()).toEqual([500, 0, 1000, 1000])
  await set('Left', '9000')
  expect(fields()).toEqual([3000, 0, 1000, 1000])
  await set('Left', '500')

  // Turned clockwise the picture is 3000 × 4000 and the same square sits top-right.
  await act(async () => button('Rotate right').click())
  expect(fields()).toEqual([2000, 500, 1000, 1000])
  expect(field('Left').max).toBe('3000')

  await act(async () => button('Flip horizontally').click())
  expect(fields()).toEqual([0, 500, 1000, 1000])

  await act(async () => button('Crop photo').click())
  expect(mocks.edit.mock.calls[0][1]).toEqual({
    rotate: 90, flip: 'horizontal', crop: { cx: 500, cy: 1000, width: 1000, height: 1000, angle: 0 }, suffix: 'cropped',
  })
  expect(container.textContent).toContain('a_cropped.jpg')
  expect(container.textContent).toContain('1000 × 1000 px')

  await act(async () => button('Reset frame').click())
  expect(fields()).toEqual([0, 500, 3000, 3000])
  expect(container.textContent).not.toContain('a_cropped.jpg')

  await pick('Shape', 'custom')
  await set('Shape width', '2')
  await set('Shape height', '1')
  expect(fields()).toEqual([0, 1250, 3000, 1500])
})
