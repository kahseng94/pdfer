// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PhotoRotateTool } from './PhotoRotateTool'

const mocks = vi.hoisted(() => ({ edit: vi.fn() }))
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), editPhotos: mocks.edit }))
vi.mock('../lib/images', async (original) => ({ ...await original<typeof import('../lib/images')>(), imageSize: async () => ({ width: 4000, height: 3000 }) }))

let root: Root, container: HTMLDivElement
const button = (label: string) => {
  const node = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!node) throw new Error(`Missing ${label}`)
  return node
}
const status = () => container.querySelector('p[role="status"]')!.textContent
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${Math.random()}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  mocks.edit.mockResolvedValue({ file: new File(['x'], 'a_flipped.jpg', { type: 'image/jpeg' }), results: [{ name: 'a_flipped.jpg', before: 1, after: 2, width: 4000, height: 3000 }] })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('turns the previews the way the buttons say and sends the orientation', async () => {
  await act(async () => root.render(<PhotoRotateTool />))
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(button('Choose a turn or a flip').disabled).toBe(true)
  expect(status()).toBe('Not turned')

  await act(async () => button('Rotate right').click())
  expect(status()).toBe('Turned 90° clockwise')
  expect(container.textContent).toContain('→ 3000 × 4000 px')
  expect(container.querySelector<HTMLImageElement>('[aria-label="Photos"] img')!.style.transform).toBe('rotate(90deg)')

  await act(async () => button('Flip horizontally').click())
  expect(status()).toBe('Turned 90° clockwise, then mirrored left to right')
  expect(button('Flip horizontally').getAttribute('aria-pressed')).toBe('true')

  // Turning the mirrored picture clockwise on screen undoes the quarter turn underneath.
  await act(async () => button('Rotate right').click())
  expect(status()).toBe('Mirrored left to right')
  expect(container.querySelector<HTMLImageElement>('[aria-label="Photos"] img')!.style.transform).toBe('scaleX(-1) rotate(0deg)')

  await act(async () => button('Apply to 1 photo').click())
  expect(mocks.edit.mock.calls[0][1]).toEqual({ rotate: 0, flip: 'horizontal', suffix: 'flipped' })
  expect(container.textContent).toContain('a_flipped.jpg')

  await act(async () => button('Reset').click())
  expect(status()).toBe('Not turned')
  expect(container.textContent).not.toContain('a_flipped.jpg')
})
