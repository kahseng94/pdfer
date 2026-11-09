// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PhotoResizeTool } from './PhotoResizeTool'

const mocks = vi.hoisted(() => ({ edit: vi.fn(), save: vi.fn() }))
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), editPhotos: mocks.edit, saveFile: mocks.save }))
vi.mock('../lib/images', async (original) => ({ ...await original<typeof import('../lib/images')>(), imageSize: async () => ({ width: 4000, height: 3000 }) }))

let root: Root, container: HTMLDivElement
const zip = new File(['zip'], 'photos_resized.zip', { type: 'application/zip' })
const button = (label: string) => {
  const node = [...container.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!node) throw new Error(`Missing ${label}`)
  return node
}
async function choose(names: string[]) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', { configurable: true, value: names.map((name) => new File(['x'], name, { type: name.endsWith('.txt') ? 'text/plain' : '' })) })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function set(label: string, value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${Math.random()}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('shows what each photo will become, resizes the batch and forgets the result when the size changes', async () => {
  mocks.edit.mockResolvedValue({ file: zip, results: [
    { name: 'a_resized.jpg', before: 1, after: 500, width: 1600, height: 1200 },
    { name: 'b_resized.png', before: 1, after: 700, width: 1600, height: 1200 },
  ] })
  await act(async () => root.render(<PhotoResizeTool />))
  await choose(['a.jpg', 'notes.txt', 'b.png'])
  expect(container.textContent).toContain('Skipped 1 file that isn’t a photo')
  expect(container.querySelectorAll('[aria-label="Photos"] li')).toHaveLength(2)
  expect(container.textContent).toContain('4000 × 3000 px')
  expect(container.textContent).toContain('→ 1600 × 1200 px')

  await act(async () => button('Resize 2 photos').click())
  const [files, edit] = mocks.edit.mock.calls[0]
  expect(files.map((f: File) => f.name)).toEqual(['a.jpg', 'b.png'])
  expect(edit).toEqual({ resize: { longest: 1600 }, suffix: 'resized' })
  expect(container.textContent).toContain('2 photos resized')
  expect(container.textContent).toContain('photos_resized.zip')

  await act(async () => button('Download').click())
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith(zip)

  await set('Longest side (px)', '800')
  expect(container.textContent).not.toContain('photos_resized.zip')
  expect(container.textContent).toContain('→ 800 × 600 px')
})

it('offers the box fitting only for a width and height, and refuses a bad size', async () => {
  await act(async () => root.render(<PhotoResizeTool />))
  await choose(['a.jpg'])
  const mode = container.querySelector<HTMLSelectElement>('[aria-label="Resize by"]')!
  await act(async () => { mode.value = 'box'; mode.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(container.querySelector('[aria-label="Fill and crop"]')).not.toBeNull()
  await act(async () => container.querySelector<HTMLInputElement>('[aria-label="Fill and crop"]')!.click())
  expect(container.textContent).toContain('→ 1200 × 800 px')
  await set('Width (px)', '0')
  expect(container.textContent).toContain('The width must be a whole number from 1 to 10,000 pixels.')
  expect(button('Resize 1 photo').disabled).toBe(true)
  await set('Width (px)', '6000')
  await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
  await act(async () => button('Resize 1 photo').click())
  expect(mocks.edit.mock.calls[0][1]).toEqual({ resize: { width: 6000, height: 800, fit: 'cover', enlarge: true }, suffix: 'resized' })
})
