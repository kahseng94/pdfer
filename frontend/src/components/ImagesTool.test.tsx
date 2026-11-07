// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ImagesTool } from './ImagesTool'

const mocks = vi.hoisted(() => ({ convert: vi.fn(), load: vi.fn(), save: vi.fn() }))
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), imagesToPdf: mocks.convert, saveFile: mocks.save }))
vi.mock('../lib/pdf', () => ({ closePdf: vi.fn(), formatSize: () => '1 KB' }))
vi.mock('../lib/usePdfLoader', () => ({ usePdfLoader: () => ({ load: mocks.load, cancel: vi.fn() }) }))
vi.mock('../lib/images', async (original) => ({ ...await original<typeof import('../lib/images')>(), imageSize: async () => ({ width: 100, height: 80 }) }))
vi.mock('./DocumentPreview', () => ({ DocumentPreview: ({ doc, onReady }: { doc: never; onReady: (doc: never) => void }) => <button onClick={() => onReady(doc)}>Render output</button> }))

let root: Root, container: HTMLDivElement
const result = new File(['output'], 'images.pdf', { type: 'application/pdf' })
function button(scope: Element, label: string) {
  const node = [...scope.querySelectorAll('button')].find((element) => element.textContent === label)
  if (!node) throw new Error(`Missing ${label}`)
  return node
}
async function choose(scope: Element, names: string[]) {
  await act(async () => {
    const input = scope.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', { configurable: true, value: names.map((name) => new File(['image'], name)) })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${Math.random()}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  mocks.convert.mockResolvedValue(result); mocks.load.mockResolvedValue({ numPages: 2 })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it.each(['png', 'jpg'] as const)('%s converts only matching images in order and gates download on preview', async (kind) => {
  await act(async () => root.render(<ImagesTool kind={kind} />))
  const names = kind === 'png' ? ['first.PNG', 'wrong.jpg', 'last.png'] : ['first.JPG', 'wrong.png', 'last.jpeg']
  await choose(container, names)
  expect(container.textContent).toContain('Skipped 1 file')
  await act(async () => button(container, 'Preview PDF').click())
  expect(mocks.convert.mock.calls[0][0].map((file: File) => file.name)).toEqual([names[0], names[2]])
  expect([...container.querySelectorAll('button')].some((node) => node.textContent === 'Download PDF')).toBe(false)
  await act(async () => button(container, 'Render output').click())
  await act(async () => button(container, 'Download PDF').click())
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith(result)
  await act(async () => container.querySelector<HTMLInputElement>('[aria-label="Stretch"]')!.click())
  expect(container.querySelector('[aria-label="Image PDF preview"]')).toBeNull()
})

it('keeps separate image layout controls independent when all image tabs stay mounted', async () => {
  await act(async () => root.render(<><div id="png-tool"><ImagesTool kind="png" /></div><div id="jpg-tool"><ImagesTool kind="jpg" active={false} /></div><div id="mixed-tool"><ImagesTool active={false} /></div></>))
  const png = container.querySelector('#png-tool')!, jpg = container.querySelector('#jpg-tool')!, mixed = container.querySelector('#mixed-tool')!
  await choose(png, ['a.png']); await choose(jpg, ['b.jpg']); await choose(mixed, ['c.png'])
  const pngRadio = png.querySelector<HTMLInputElement>('[aria-label="Stretch"]')!
  const jpgRadio = jpg.querySelector<HTMLInputElement>('[aria-label="Stretch"]')!
  expect(pngRadio.name).not.toBe(jpgRadio.name)
  await act(async () => pngRadio.click())
  expect(pngRadio.checked).toBe(true)
  expect(jpgRadio.checked).toBe(false)
  const ids = [...container.querySelectorAll('[id]')].map((element) => element.id)
  expect(new Set(ids).size).toBe(ids.length)
})
