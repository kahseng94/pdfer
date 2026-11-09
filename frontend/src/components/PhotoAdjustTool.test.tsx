// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_ADJUST, toAdjust } from '../lib/photoAdjust'
import { PhotoAdjustTool } from './PhotoAdjustTool'

const mocks = vi.hoisted(() => ({ edit: vi.fn() }))
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), editPhotos: mocks.edit }))
vi.mock('../lib/images', async (original) => ({ ...await original<typeof import('../lib/images')>(), imageSize: async () => ({ width: 40, height: 30 }) }))

let root: Root, container: HTMLDivElement
const button = (label: string) => {
  const node = [...container.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!node) throw new Error(`Missing ${label}`)
  return node
}
async function slide(label: string, value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${Math.random()}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  mocks.edit.mockResolvedValue({ file: new File(['x'], 'a_adjusted.jpg', { type: 'image/jpeg' }), results: [{ name: 'a_adjusted.jpg', before: 1, after: 2, width: 40, height: 30 }] })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('sends only what changed', () => {
  expect(toAdjust(DEFAULT_ADJUST)).toEqual({})
  expect(toAdjust({ ...DEFAULT_ADJUST, contrast: 1.3, grayscale: true })).toEqual({ contrast: 1.3, grayscale: true })
})

it('enables saving once a slider moves, shows the change as a percentage and resets', async () => {
  await act(async () => root.render(<PhotoAdjustTool />))
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(button('Move a slider to begin').disabled).toBe(true)
  expect(button('Reset all').disabled).toBe(true)

  await slide('Brightness', '1.2')
  await slide('Sharpness', '0.5')
  expect(container.textContent).toContain('+20%')
  expect(container.textContent).toContain('−50%')
  await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
  await act(async () => button('Save adjusted photo').click())
  expect(mocks.edit.mock.calls[0][1]).toEqual({ adjust: { brightness: 1.2, sharpness: 0.5, grayscale: true }, suffix: 'adjusted' })
  expect(container.textContent).toContain('a_adjusted.jpg')

  await act(async () => button('Reset all').click())
  expect(button('Move a slider to begin').disabled).toBe(true)
  expect(container.textContent).not.toContain('a_adjusted.jpg')
})
