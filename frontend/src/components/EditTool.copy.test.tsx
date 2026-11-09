// @vitest-environment happy-dom
// The Copy between PDFs tab: the Edit tool in copy mode, with the PDF to copy from beside the one to paste into.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EditTool } from './EditTool'
import { DEFAULT_STYLE, type RegionElement } from '../lib/edits'
import type { ProjectDraft } from '../lib/projects'

const mocks = vi.hoisted(() => ({ load: vi.fn(), cancel: vi.fn(), edit: vi.fn(), scroll: vi.fn(), closePdf: vi.fn(), restore: null as null | ((draft: ProjectDraft<'copy-pdf'>) => Promise<boolean>) }))
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), editPdf: mocks.edit }))
vi.mock('../lib/pdf', () => ({ closePdf: mocks.closePdf, formatSize: () => '1 KB' }))
vi.mock('../lib/usePdfLoader', () => ({ usePdfLoader: () => ({ load: mocks.load, cancel: mocks.cancel }) }))
vi.mock('../lib/fonts', async (original) => ({ ...await original<typeof import('../lib/fonts')>(), loadFonts: async () => true }))
vi.mock('../lib/useProject', () => ({ useProject: (_tool: string, _draft: unknown, _changes: boolean, restore: (draft: ProjectDraft<'copy-pdf'>) => Promise<boolean>) => { mocks.restore = restore; return { canReplace: () => true, reset: () => {} } } }))
vi.mock('./ProjectControls', () => ({ ProjectControls: () => null }))
vi.mock('./PageThumbnail', () => ({ PageThumbnail: () => <canvas /> }))
vi.mock('./RegionPreview', () => ({ RegionPreview: ({ region }: { region: RegionElement }) => <foreignObject data-preview-source={region.sourcePage} data-preview-file={region.sourceFile?.name ?? ''} /> }))
vi.mock('./Dropzone', () => ({ Dropzone: ({ title, onFiles }: { title: string; onFiles: (files: File[]) => void }) =>
  <button onClick={() => onFiles([title.includes('copy from') ? other() : new File(['source'], 'source.pdf', { type: 'application/pdf' })])}>{title}</button> }))

function other() { return new File(['other'], 'other.pdf', { type: 'application/pdf', lastModified: 7 }) }
const docs: Record<string, { numPages: number; sizes: { width: number; height: number }[] }> = {
  'source.pdf': { numPages: 2, sizes: [{ width: 200, height: 300 }, { width: 120, height: 160 }] },
  'other.pdf': { numPages: 1, sizes: [{ width: 150, height: 200 }] },
}

let root: Root, container: HTMLDivElement
function button(label: string) {
  const found = [...container.querySelectorAll('button')].find((node) => node.textContent === label || node.getAttribute('aria-label') === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}
async function click(label: string) { await act(async () => button(label).click()) }
function page(number: number) { return container.querySelector<SVGSVGElement>(`svg[aria-label="Edit page ${number}"]`)! }
function sourcePage(number: number) { return container.querySelector<SVGSVGElement>(`svg[aria-label="Copy from page ${number}"]`)! }
async function pointer(target: Element, type: string, x: number, y: number) {
  await act(async () => { target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, pointerId: 1 })) })
}
async function openOther() {
  await click('Choose a PDF to copy from')
}
function pane() { return container.querySelector('[aria-label="PDF to copy from"]')! }
/** Select a 60 × 80 pt rectangle at (10, 20) on the other PDF's page. */
async function selectOnOther() {
  for (const [type, x, y] of [['pointerdown', 410, 20], ['pointermove', 470, 100], ['pointerup', 470, 100]] as const) await pointer(sourcePage(1), type, x, y)
}
function previews(where: Element, file = 'other.pdf') { return where.querySelectorAll(`[data-preview-file="${file}"]`) }
async function key(key: string, init: KeyboardEventInit = {}) {
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init })) })
}
function lastEdits() { return mocks.edit.mock.calls.at(-1)![1] }

beforeEach(async () => {
  vi.resetAllMocks()
  mocks.restore = null
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0 })
  Object.defineProperty(SVGElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(mocks.scroll)
  // The edited PDF's pages are at the top left and lower left; the other PDF's page is to the right.
  const first = { left: 0, top: 0, right: 200, bottom: 300, width: 200, height: 300 } as DOMRect
  const second = { left: 40, top: 340, right: 160, bottom: 500, width: 120, height: 160 } as DOMRect
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: SVGElement) {
    if (this.hasAttribute('data-source-page')) return { left: 400, top: 0, right: 550, bottom: 200, width: 150, height: 200 } as DOMRect
    return this.getAttribute('data-editor-page') === '2' ? second : first
  })
  // The list items holding each page, which decide the page in view, sit where their pages do.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.querySelector('[data-editor-page="2"]') ? second : first
  })
  mocks.load.mockImplementation(async (file: File) => {
    const spec = docs[file.name]
    if (!spec) throw new Error(`${file.name} isn't a valid PDF.`)
    return { numPages: spec.numPages, getPage: async (number: number) => ({ getViewport: () => spec.sizes[number - 1] }) }
  })
  mocks.edit.mockResolvedValue(new File(['edited'], 'source_edited.pdf', { type: 'application/pdf' }))
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<EditTool mode="copy" />))
  await click('Choose the PDF to paste into')
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  Reflect.deleteProperty(SVGElement.prototype, 'setPointerCapture')
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('shows both PDFs side by side, selects a rectangle and pastes it as a copy that exports with the other PDF', async () => {
  expect(pane().textContent).toContain('Choose the PDF to copy content from')
  expect(container.querySelector('[aria-label="PDF to paste into"]')!.textContent).toContain('Paste into')
  // Only copying here: none of Edit's drawing tools.
  expect(container.querySelector('[aria-label="Tools"]')).toBeNull()
  expect(container.textContent).toContain('Nothing pasted yet')
  await openOther()
  expect(pane().textContent).toContain('other.pdf')
  expect(pane().textContent).toContain('Drag a rectangle around the content to copy')
  expect(mocks.load).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'other.pdf' }), 'other')
  await selectOnOther()
  expect(pane().textContent).toContain('Page 1 · 60 × 80 pt')
  expect(sourcePage(1).querySelector('[data-source-selection]')).not.toBeNull()
  await click('Paste')
  expect(previews(page(1))).toHaveLength(1)
  expect(container.textContent).toContain('Copy of page 1 of other.pdf')
  expect(container.textContent).toContain('1 copy')
  expect(mocks.scroll).toHaveBeenCalled()
  await click('Save with 1 copy')
  const [file, edits, images, , sources] = mocks.edit.mock.calls.at(-1)!
  expect(file.name).toBe('source.pdf')
  expect(edits).toEqual([expect.objectContaining({ type: 'region', page: 1, sourcePage: 1, sourceDocument: 0, copy: true, x: 70, y: 110, width: 60, height: 80, source: { x: 10, y: 20, width: 60, height: 80 } })])
  expect(images).toEqual([])
  expect(sources.map((source: File) => source.name)).toEqual(['other.pdf'])
  expect(container.textContent).toContain('source_edited.pdf')
  // The pasted copy is an ordinary region: it can go to another page and be deleted on its own.
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Move region to page"]')!
    select.value = '2'; select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(previews(page(2))).toHaveLength(1)
  await click('Save with 1 copy')
  expect(lastEdits()[0]).toMatchObject({ page: 2, sourceDocument: 0, width: 60, height: 80 })
  await click('Delete copy')
  expect(container.textContent).toContain('Nothing pasted yet')
  expect(container.textContent).not.toContain('Deleted regions')
  await click('Undo')
  expect(previews(page(2))).toHaveLength(1)
})

it('keeps the PDF to copy from, and its selection, when the PDF to paste into changes', async () => {
  await openOther()
  await selectOnOther()
  await click('Paste')
  expect(previews(page(1))).toHaveLength(1)
  await click('Choose another file')
  // Only the PDF pasted into is released; the other stays open with its selection.
  expect(mocks.closePdf.mock.calls.filter(([opened]) => opened)).toHaveLength(1)
  expect(container.querySelector('[aria-label="PDF to paste into"]')!.textContent).toContain('Choose the PDF to paste into')
  expect(pane().textContent).toContain('other.pdf')
  expect(sourcePage(1).querySelector('[data-source-selection]')).not.toBeNull()
  expect(pane().textContent).toContain('Choose the PDF to paste into, then paste or drag the selection onto it')
  expect(button('Paste').disabled).toBe(true)
  await click('Choose the PDF to paste into')
  expect(mocks.load).toHaveBeenCalledTimes(3) // the PDF to paste into twice, the other PDF once
  expect(container.textContent).toContain('Nothing pasted yet')
  await click('Paste')
  expect(previews(page(1))).toHaveLength(1)
  await click('Save with 1 copy')
  expect(lastEdits()).toEqual([expect.objectContaining({ sourceDocument: 0, sourcePage: 1, copy: true })])
})

it('copies with the keyboard, pastes onto the page in view, and pastes a selected copy again', async () => {
  await openOther()
  await selectOnOther()
  await key('c', { metaKey: true })
  await act(async () => { document.dispatchEvent(new Event('paste', { bubbles: true })) })
  // The page nearest the middle of the window is page 2.
  expect(previews(page(2))).toHaveLength(1)
  expect(previews(page(1))).toHaveLength(0)
  expect(mocks.scroll).not.toHaveBeenCalled()
  await click('Save with 1 copy')
  expect(lastEdits()[0]).toMatchObject({ page: 2, sourceDocument: 0, copy: true, x: 30, y: 40, width: 60, height: 80 })
  // With nothing selected in the PDF to copy from, Copy takes the selected copy instead.
  await pointer(sourcePage(1), 'pointerdown', 540, 190)
  await pointer(sourcePage(1), 'pointerup', 540, 190)
  expect(sourcePage(1).querySelector('[data-source-selection]')).toBeNull()
  await key('c', { metaKey: true })
  await act(async () => { document.dispatchEvent(new Event('paste', { bubbles: true })) })
  expect(previews(page(2))).toHaveLength(2)
  await click('Save with 2 copies')
  expect(lastEdits()[1]).toMatchObject({ page: 2, sourceDocument: 0, copy: true, source: { x: 10, y: 20, width: 60, height: 80 } })
})

it('drags the selection onto a page of the edited PDF as one undo step, and drops it when released elsewhere', async () => {
  await openOther()
  await selectOnOther()
  const svg = sourcePage(1)
  const dropTargets = () => [1, 2].map((number) => page(number).closest('li')!.getAttribute('data-drop-target'))
  expect(dropTargets()).toEqual([null, null])
  // Grab a third of the way across and halfway down the selection: every page lights up at the press itself.
  await pointer(svg, 'pointerdown', 430, 60)
  expect(dropTargets()).toEqual(['ready', 'ready'])
  expect(container.textContent).toContain('Drag over a page of source.pdf to paste the copy there')
  await pointer(svg, 'pointermove', 100, 150)
  expect(previews(page(1))).toHaveLength(1)
  expect(dropTargets()).toEqual(['hover', 'ready'])
  expect(container.textContent).toContain('Release to paste the copy onto page 1')
  await pointer(svg, 'pointermove', 300, 600)
  expect(previews(page(1))).toHaveLength(0)
  expect(previews(page(2))).toHaveLength(0)
  expect(dropTargets()).toEqual(['ready', 'ready'])
  await pointer(svg, 'pointermove', 60, 400)
  expect(previews(page(2))).toHaveLength(1)
  expect(dropTargets()).toEqual(['ready', 'hover'])
  await pointer(svg, 'pointerup', 60, 400)
  expect(previews(page(2))).toHaveLength(1)
  expect(dropTargets()).toEqual([null, null])
  expect(container.textContent).toContain('Copy of page 1 of other.pdf')
  await click('Save with 1 copy')
  expect(lastEdits()).toEqual([expect.objectContaining({ page: 2, sourceDocument: 0, copy: true, x: 0, y: 20, width: 60, height: 80 })])
  await click('Undo')
  expect(container.textContent).toContain('Nothing pasted yet')
  expect(button('Undo').hasAttribute('disabled')).toBe(true)
  // Escape cancels a drag in progress; releasing off every page adds nothing either.
  await pointer(svg, 'pointerdown', 430, 60)
  await pointer(svg, 'pointermove', 100, 150)
  expect(previews(page(1))).toHaveLength(1)
  await act(async () => { svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(previews(page(1))).toHaveLength(0)
  expect(dropTargets()).toEqual([null, null])
  await pointer(svg, 'pointerdown', 430, 60)
  await pointer(svg, 'pointermove', 100, 150)
  await pointer(svg, 'pointerup', 700, 700)
  expect(container.textContent).toContain('Nothing pasted yet')
  expect(button('Undo').hasAttribute('disabled')).toBe(true)
})

it('reopens the other PDFs of a saved project beside it and checks their pages', async () => {
  const source = other()
  const region: RegionElement = { id: 'kept', type: 'region', page: 1, copy: true, sourceFile: source, sourcePage: 1, source: { x: 10, y: 20, width: 60, height: 80 }, x: 5, y: 5, width: 60, height: 80 }
  const file = new File(['source'], 'source.pdf', { type: 'application/pdf' })
  expect(await act(async () => mocks.restore!({ tool: 'copy-pdf', file, state: { elements: [region], style: DEFAULT_STYLE, zoom: 1 } }))).toBe(true)
  expect(pane().textContent).toContain('other.pdf')
  expect(previews(page(1))).toHaveLength(1)
  await click('Save with 1 copy')
  expect(lastEdits()[0]).toMatchObject({ sourceDocument: 0, sourcePage: 1 })
  expect(mocks.edit.mock.calls.at(-1)![4][0]).toBe(source)
  expect(await act(async () => mocks.restore!({ tool: 'copy-pdf', file, state: { elements: [{ ...region, sourcePage: 2 }], style: DEFAULT_STYLE, zoom: 1 } }))).toBe(false)
  expect(container.textContent).toContain('damaged')
})

it('reports a PDF that cannot be opened and lets another be chosen', async () => {
  docs['broken.pdf'] = undefined as never
  const pane = container.querySelector('[aria-label="PDF to copy from"]')!
  expect(pane.textContent).toContain('Choose the PDF to copy content from')
  await click('Choose a PDF to copy from')
  expect(pane.textContent).toContain('other.pdf')
  await act(async () => {
    const chooser = pane.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(chooser, 'files', { configurable: true, value: [new File(['x'], 'broken.pdf', { type: 'application/pdf' })] })
    chooser.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(pane.textContent).toContain("broken.pdf isn't a valid PDF.")
  expect(pane.textContent).not.toContain('other.pdf')
  await click('Choose a PDF to copy from')
  expect(pane.textContent).toContain('other.pdf')
  expect(pane.textContent).not.toContain("isn't a valid PDF")
})
