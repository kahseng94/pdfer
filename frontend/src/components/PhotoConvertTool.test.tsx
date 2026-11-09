// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { convertSuffix } from '../lib/photoEdits'
import { PhotoConvertTool } from './PhotoConvertTool'

const mocks = vi.hoisted(() => ({ edit: vi.fn() }))
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), editPhotos: mocks.edit }))
vi.mock('../lib/images', async (original) => ({ ...await original<typeof import('../lib/images')>(), imageSize: async () => ({ width: 40, height: 30 }) }))

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
  mocks.edit.mockResolvedValue({ file: new File(['x'], 'photos.zip', { type: 'application/zip' }), results: [{ name: 'a.png', before: 1, after: 2, width: 40, height: 30 }, { name: 'b.png', before: 1, after: 2, width: 40, height: 30 }] })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('adds a suffix only when a photo would otherwise keep its name', () => {
  const files = [{ name: 'a.jpg', type: 'image/jpeg' }, { name: 'b.png', type: 'image/png' }]
  expect(convertSuffix(files, 'webp')).toBe('')
  expect(convertSuffix(files, 'jpeg')).toBe('converted')
  expect(convertSuffix([{ name: 'clip.gif', type: 'image/gif' }], 'jpeg')).toBe('')
})

it('names the results, shows the right options for each format and sends them', async () => {
  await act(async () => root.render(<PhotoConvertTool />))
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'a.jpg', { type: 'image/jpeg' }), new File(['x'], 'b.png', { type: 'image/png' })] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(container.textContent).toContain('→ a_converted.jpg')
  expect(container.textContent).toContain('→ b_converted.jpg')
  expect(container.querySelector('[aria-label="Quality"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="Colour behind transparency"]')).not.toBeNull()

  await act(async () => container.querySelector<HTMLInputElement>('[aria-label="WebP"]')!.click())
  expect(container.textContent).toContain('→ a.webp')
  expect(container.querySelector('[aria-label="Colour behind transparency"]')).toBeNull()

  await act(async () => container.querySelector<HTMLInputElement>('[aria-label="PNG"]')!.click())
  expect(container.querySelector('[aria-label="Quality"]')).toBeNull()
  expect(container.textContent).toContain('→ b_converted.png')
  await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
  await act(async () => button('Convert 2 images to PNG').click())
  expect(mocks.edit.mock.calls[0][1]).toEqual({ format: 'png', metadata: 'none', suffix: 'converted' })

  await act(async () => container.querySelector<HTMLInputElement>('[aria-label="JPEG"]')!.click())
  await act(async () => button('Convert 2 images to JPEG').click())
  expect(mocks.edit.mock.calls[1][1]).toEqual({ format: 'jpeg', quality: 90, background: '#ffffff', metadata: 'none', suffix: 'converted' })
})
