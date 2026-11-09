// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EditTool } from './EditTool'
import type { RegionElement } from '../lib/edits'

const mocks = vi.hoisted(() => ({ load: vi.fn(), cancel: vi.fn(), edit: vi.fn(), scroll: vi.fn() }))
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), editPdf: mocks.edit }))
vi.mock('../lib/pdf', () => ({ closePdf: vi.fn(), formatSize: () => '1 KB' }))
vi.mock('../lib/usePdfLoader', () => ({ usePdfLoader: () => ({ load: mocks.load, cancel: mocks.cancel }) }))
vi.mock('../lib/fonts', async (original) => ({ ...await original<typeof import('../lib/fonts')>(), loadFonts: async () => true }))
vi.mock('../lib/useProject', () => ({ useProject: () => ({ canReplace: () => true, reset: () => {} }) }))
vi.mock('./ProjectControls', () => ({ ProjectControls: () => null }))
vi.mock('./PageThumbnail', () => ({ PageThumbnail: () => <canvas /> }))
vi.mock('./RegionPreview', () => ({ RegionPreview: ({ region }: { region: RegionElement }) => <foreignObject data-preview-source={region.sourcePage} /> }))
vi.mock('./Dropzone', () => ({ Dropzone: ({ onFiles }: { onFiles: (files: File[]) => void }) => <button onClick={() => onFiles([new File(['source'], 'source.pdf', { type: 'application/pdf' })])}>Choose fixture</button> }))

let root: Root, container: HTMLDivElement
function button(label: string) {
  const found = [...container.querySelectorAll('button')].find((node) => node.textContent === label || node.getAttribute('aria-label') === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}
async function click(label: string) { await act(async () => button(label).click()) }
async function choosePage(page: number) {
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Move region to page"]')!
    select.value = String(page)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function chooseCopyPage(page: number) {
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Region copy page"]')!
    select.value = String(page)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function drawRegion() {
  await click('Move region')
  for (const [type, x, y] of [['pointerdown', 20, 40], ['pointermove', 180, 140], ['pointerup', 180, 140]] as const) {
    await act(async () => { page(1).dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, pointerId: 1 })) })
  }
}
function page(number: number) { return container.querySelector<SVGSVGElement>(`svg[aria-label="Edit page ${number}"]`)! }
async function selectRegion(number: number) {
  const target = page(number).querySelector('[data-id] rect')!
  for (const type of ['pointerdown', 'pointerup']) {
    await act(async () => { target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX: 30, clientY: 60, pointerId: 1 })) })
  }
}
beforeEach(async () => {
  vi.resetAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0 })
  Object.defineProperty(SVGElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(mocks.scroll)
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: SVGElement) {
    return (this.getAttribute('data-editor-page') === '2'
      ? { left: 40, top: 340, width: 120, height: 160 }
      : { left: 0, top: 0, width: 200, height: 300 }) as DOMRect
  })
  mocks.load.mockResolvedValue({ numPages: 2, getPage: async (number: number) => ({ getViewport: () => number === 1 ? { width: 200, height: 300 } : { width: 120, height: 160 } }) })
  mocks.edit.mockResolvedValue(new File(['edited'], 'source_edited.pdf', { type: 'application/pdf' }))
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<EditTool />))
  await click('Choose fixture')
  await drawRegion()
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  document.documentElement.scrollTop = 0
  Reflect.deleteProperty(SVGElement.prototype, 'setPointerCapture')
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('moves to another page, keeps the source mask in place, and exports both page references', async () => {
  await choosePage(2)
  expect(mocks.scroll).toHaveBeenCalled()
  expect(page(1).querySelector('[data-region-source]')).not.toBeNull()
  expect(page(1).querySelector('[data-id]')).toBeNull()
  expect(page(2).querySelector('[data-region-source]')).toBeNull()
  expect(page(2).querySelector('[data-preview-source="1"]')).not.toBeNull()
  expect(container.textContent).toContain('From page 1')
  await click('Save with 1 edit')
  expect(mocks.edit.mock.calls[0][1]).toEqual([expect.objectContaining({ page: 2, sourcePage: 1, x: 0, y: 40, width: 120, height: 75, source: { x: 20, y: 40, width: 160, height: 100 } })])
  expect(container.textContent).toContain('source_edited.pdf')
  await choosePage(1)
  expect(container.textContent).not.toContain('source_edited.pdf')
  await click('Undo')
  expect(page(2).querySelector('[data-preview-source="1"]')).not.toBeNull()
  await click('Undo')
  expect(page(1).querySelector('[data-preview-source="1"]')).not.toBeNull()
  expect(container.querySelector<HTMLInputElement>('[aria-label="Region width"]')!.value).toBe('160')
  await click('Redo')
  expect(page(2).querySelector('[data-preview-source="1"]')).not.toBeNull()
  await click('Restore original')
  expect(container.querySelector('[data-region-source]')).toBeNull()
  expect(container.querySelector('[data-preview-source]')).toBeNull()
})

it('returns keyboard focus to the region after using the destination control', async () => {
  await choosePage(2)
  container.querySelector<HTMLSelectElement>('[aria-label="Move region to page"]')!.focus()
  const region = page(2).querySelector('[data-id] rect')!
  for (const type of ['pointerdown', 'pointerup']) {
    await act(async () => { region.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX: 30, clientY: 60, pointerId: 1 })) })
  }
  expect(document.activeElement).toBe(page(2))
  await act(async () => { page(2).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  await click('Save with 1 edit')
  expect(mocks.edit.mock.calls[0][1][0]).toMatchObject({ page: 2, sourcePage: 1, y: 41 })
})

it.each([[1, 'button'], [2, 'Delete'], [2, 'Backspace']] as const)('deletes a region on page %i with %s, keeps its source covered, and supports undo/redo', async (destination, action) => {
  await choosePage(destination)
  await click('Save with 1 edit')
  expect(container.textContent).toContain('source_edited.pdf')
  if (action === 'button') await click('Delete region')
  else await act(async () => { page(destination).dispatchEvent(new KeyboardEvent('keydown', { key: action, bubbles: true })) })
  expect(container.querySelector('[data-preview-source]')).toBeNull()
  expect(page(1).querySelector('[data-region-source]')).not.toBeNull()
  expect(page(2).querySelector('[data-region-source]')).toBeNull()
  expect(container.textContent).toContain('Deleted regions (1)')
  expect(container.textContent).not.toContain('source_edited.pdf')
  await click('Save with 1 edit')
  expect(mocks.edit.mock.calls.at(-1)![1][0]).toMatchObject({ type: 'region', page: destination, sourcePage: 1, deleted: true, source: { x: 20, y: 40, width: 160, height: 100 } })
  await click('Undo')
  expect(page(destination).querySelector('[data-preview-source="1"]')).not.toBeNull()
  expect(container.textContent).not.toContain('Deleted regions (1)')
  await click('Redo')
  expect(container.querySelector('[data-preview-source]')).toBeNull()
  await click('Restore deleted region 1 on page 1')
  expect(container.querySelector('[data-region-source]')).toBeNull()
  expect(container.textContent).toContain('No edits yet')
})

it('does not delete a region while typing in a position control', async () => {
  const input = container.querySelector<HTMLInputElement>('[aria-label="Region x"]')!
  input.focus()
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })) })
  expect(container.querySelector('[data-preview-source]')).not.toBeNull()
  expect(container.textContent).not.toContain('Deleted regions (1)')
})

it('continues to remove added shapes without turning them into region deletions', async () => {
  await click('Rectangle')
  for (const [type, x, y] of [['pointerdown', 10, 10], ['pointermove', 30, 30], ['pointerup', 30, 30]] as const) {
    await act(async () => { page(1).dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, pointerId: 1 })) })
  }
  expect(container.textContent).toContain('2 edits')
  await click('Delete')
  await click('Save with 1 edit')
  expect(mocks.edit.mock.calls.at(-1)![1]).toHaveLength(1)
  expect(mocks.edit.mock.calls.at(-1)![1][0]).toMatchObject({ type: 'region', sourcePage: 1 })
  expect(mocks.edit.mock.calls.at(-1)![1][0].deleted).toBeUndefined()
})

it('copies to another page without changing the selected region, with independent movement and undo', async () => {
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Region copy page"]')!.value).toBe('2')
  await click('Save with 1 edit')
  const original = mocks.edit.mock.calls.at(-1)![1][0]
  await click('Copy region')
  expect(container.textContent).not.toContain('source_edited.pdf')
  expect(page(1).querySelector('[data-preview-source="1"]')).not.toBeNull()
  expect(page(2).querySelector('[data-preview-source="1"]')).not.toBeNull()
  expect(container.querySelectorAll('[data-region-source]')).toHaveLength(1)
  expect(container.textContent).toContain('Copy of page 1')
  await click('Save with 2 edits')
  expect(mocks.edit.mock.calls.at(-1)![1]).toEqual([original, expect.objectContaining({ page: 2, sourcePage: 1, copy: true, x: 0, y: 40, width: 120, height: 75, source: original.source })])
  await choosePage(1)
  expect(page(1).querySelectorAll('[data-preview-source="1"]')).toHaveLength(2)
  expect(page(2).querySelector('[data-preview-source]')).toBeNull()
  await click('Undo')
  expect(page(2).querySelector('[data-preview-source="1"]')).not.toBeNull()
  await click('Undo')
  expect(page(2).querySelector('[data-preview-source]')).toBeNull()
  expect(page(1).querySelector('[data-preview-source="1"]')).not.toBeNull()
  await click('Redo')
  await click('Delete copy')
  expect(page(1).querySelector('[data-preview-source="1"]')).not.toBeNull()
  expect(page(2).querySelector('[data-preview-source]')).toBeNull()
  expect(container.textContent).not.toContain('Deleted regions')
  await click('Save with 1 edit')
  expect(mocks.edit.mock.calls.at(-1)![1]).toEqual([original])
})

it('copies an already moved region and copies of it without tying their lifetimes together', async () => {
  await choosePage(2)
  await click('Copy region') // Original stays on page 2; new copy goes to page 1.
  await click('Copy region') // Copying the copy creates another region on page 2.
  expect(page(1).querySelectorAll('[data-preview-source]')).toHaveLength(1)
  expect(page(2).querySelectorAll('[data-preview-source]')).toHaveLength(2)
  await click('Save with 3 edits')
  const edits = mocks.edit.mock.calls.at(-1)![1]
  expect(edits[0]).toMatchObject({ page: 2, sourcePage: 1 })
  expect(edits[0].copy).toBeUndefined()
  expect(edits.slice(1)).toEqual([expect.objectContaining({ page: 1, sourcePage: 1, copy: true }), expect.objectContaining({ page: 2, sourcePage: 1, copy: true })])
  await selectRegion(1)
  await act(async () => { page(1).dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })) })
  expect(page(1).querySelector('[data-preview-source]')).toBeNull()
  expect(page(2).querySelectorAll('[data-preview-source]')).toHaveLength(2)
  expect(container.textContent).not.toContain('Deleted regions')
  await selectRegion(2) // first placement is the original moved region
  await click('Restore original')
  expect(container.querySelector('[data-region-source]')).toBeNull()
  expect(page(2).querySelectorAll('[data-preview-source]')).toHaveLength(1)
  await click('Save with 1 edit')
  expect(mocks.edit.mock.calls.at(-1)![1][0]).toMatchObject({ page: 2, sourcePage: 1, copy: true })
})

it('duplicates on the current page, selects the new copy, and drags it independently without jumping the view', async () => {
  await click('Save with 1 edit')
  const original = mocks.edit.mock.calls.at(-1)![1][0]
  await chooseCopyPage(1)
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Region copy page"]')!.selectedOptions[0].textContent).toBe('Page 1 (current)')
  await click('Copy region')
  expect(mocks.scroll).not.toHaveBeenCalled()
  expect(page(1).querySelectorAll('[data-preview-source]')).toHaveLength(2)
  expect(container.querySelectorAll('[data-region-source]')).toHaveLength(1)
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Move region to page"]')!.value).toBe('1')
  expect(container.querySelector<HTMLInputElement>('[aria-label="Region x"]')!.value).toBe('32')
  expect(container.querySelector<HTMLInputElement>('[aria-label="Region y"]')!.value).toBe('52')
  const target = page(1).querySelectorAll('[data-id] rect')[1]
  for (const [type, x, y] of [['pointerdown', 50, 70], ['pointermove', 0, 150], ['pointerup', 0, 150]] as const) {
    await act(async () => { (type === 'pointerdown' ? target : page(1)).dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, pointerId: 1 })) })
  }
  await click('Save with 2 edits')
  expect(mocks.edit.mock.calls.at(-1)![1]).toEqual([original, expect.objectContaining({ page: 1, sourcePage: 1, copy: true, x: 0, y: 132, width: 160, height: 100, source: original.source })])
  await click('Undo')
  expect(container.querySelector<HTMLInputElement>('[aria-label="Region x"]')!.value).toBe('32')
  expect(container.querySelector<HTMLInputElement>('[aria-label="Region y"]')!.value).toBe('52')
  await click('Undo')
  expect(page(1).querySelectorAll('[data-preview-source]')).toHaveLength(1)
  await click('Redo')
  await click('Delete copy')
  await click('Save with 1 edit')
  expect(mocks.edit.mock.calls.at(-1)![1]).toEqual([original])
})

it('allows same-page copying in a one-page PDF', async () => {
  await click('Choose another file')
  mocks.load.mockResolvedValue({ numPages: 1, getPage: async () => ({ getViewport: () => ({ width: 200, height: 300 }) }) })
  await click('Choose fixture')
  await drawRegion()
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Region copy page"]')!
  expect(select.value).toBe('1')
  expect(select.disabled).toBe(false)
  expect(button('Copy region').disabled).toBe(false)
  await click('Copy region')
  expect(page(1).querySelectorAll('[data-preview-source]')).toHaveLength(2)
})

it('rotates a region, then drags and resizes its visible box with independent undo steps', async () => {
  await click('Save with 1 edit')
  const original = mocks.edit.mock.calls.at(-1)![1][0]
  await click('Rotate region right')
  expect(container.textContent).not.toContain('source_edited.pdf')
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Region rotation"]')!.value).toBe('90')
  expect(container.querySelector<HTMLInputElement>('[aria-label="Region width"]')!.value).toBe('100')
  expect(container.querySelector<HTMLInputElement>('[aria-label="Region height"]')!.value).toBe('160')
  const target = page(1).querySelector('[data-id] rect')!
  for (const [type, x, y] of [['pointerdown', 60, 20], ['pointermove', 80, 70], ['pointerup', 80, 70]] as const) {
    await act(async () => { (type === 'pointerdown' ? target : page(1)).dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, pointerId: 1 })) })
  }
  const corner = page(1).querySelector('[data-handle="se"]')!
  for (const [type, x, y] of [['pointerdown', 170, 220], ['pointermove', 190, 252], ['pointerup', 190, 252]] as const) {
    await act(async () => { (type === 'pointerdown' ? corner : page(1)).dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, pointerId: 1 })) })
  }
  await click('Save with 1 edit')
  expect(mocks.edit.mock.calls.at(-1)![1][0]).toMatchObject({ rotation: 90, x: 70, y: 60, width: 120, height: 192, source: original.source })
  await click('Undo'); await click('Undo'); await click('Undo')
  await click('Save with 1 edit')
  expect(mocks.edit.mock.calls.at(-1)![1][0]).toEqual(original)
  await click('Redo')
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Region rotation"]')!.value).toBe('90')
})

it('copies rotation across pages and rotates the copy without changing the original', async () => {
  await click('Rotate region right')
  await click('Copy region')
  await click('Rotate region left')
  await click('Save with 2 edits')
  expect(mocks.edit.mock.calls.at(-1)![1]).toEqual([
    expect.objectContaining({ rotation: 90, page: 1, x: 50, y: 10, width: 100, height: 160 }),
    expect.objectContaining({ copy: true, page: 2, x: 0, y: 42.5, width: 120, height: 75 }),
  ])
  expect(mocks.edit.mock.calls.at(-1)![1][1].rotation).toBeUndefined() // zero degrees is optional on the wire
  await click('Undo')
  await click('Save with 2 edits')
  expect(mocks.edit.mock.calls.at(-1)![1][1]).toMatchObject({ copy: true, page: 2, rotation: 90, width: 100, height: 160 })
})

it('wraps counterclockwise turns and resets orientation through the rotation selector', async () => {
  await click('Rotate region left')
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Region rotation"]')!.value).toBe('270')
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Region rotation"]')!
    select.value = '0'; select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(container.querySelector<HTMLInputElement>('[aria-label="Region width"]')!.value).toBe('160')
  expect(container.querySelector<HTMLInputElement>('[aria-label="Region height"]')!.value).toBe('100')
})

it('moves a rotated selection to another page without changing its source or rotation', async () => {
  await click('Rotate region right')
  await choosePage(2)
  expect(page(1).querySelector('[data-id]')).toBeNull()
  expect(page(1).querySelector('[data-region-source]')).not.toBeNull()
  expect(page(2).querySelector('[data-preview-source="1"]')).not.toBeNull()
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Region rotation"]')!.value).toBe('90')
  await click('Save with 1 edit')
  expect(mocks.edit.mock.calls.at(-1)![1][0]).toMatchObject({ page: 2, sourcePage: 1, rotation: 90, x: 20, y: 0, width: 100, height: 160, source: { x: 20, y: 40, width: 160, height: 100 } })
  await click('Undo')
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Move region to page"]')!.value).toBe('1')
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Region rotation"]')!.value).toBe('90')
})

it('drags a region directly onto another page as one undoable gesture', async () => {
  const original = page(1).querySelector('[data-id] rect')!
  for (const [type, x, y] of [['pointerdown', 60, 70], ['pointermove', 80, 200], ['pointermove', 100, 400], ['pointerup', 100, 400]] as const) {
    await act(async () => { (type === 'pointerdown' ? original : page(1)).dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, pointerId: 1 })) })
  }
  expect(page(1).querySelector('[data-id]')).toBeNull()
  expect(page(1).querySelector('[data-region-source]')).not.toBeNull()
  expect(page(2).querySelector('[data-id]')).not.toBeNull()
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Move region to page"]')!.value).toBe('2')
  await click('Save with 1 edit')
  expect(mocks.edit.mock.calls.at(-1)![1][0]).toMatchObject({ page: 2, sourcePage: 1, x: 0, y: 37.5, width: 120, height: 75, source: { x: 20, y: 40, width: 160, height: 100 } })
  await click('Undo')
  expect(page(1).querySelector('[data-id]')).not.toBeNull()
  expect(page(2).querySelector('[data-id]')).toBeNull()
  expect(container.querySelector<HTMLInputElement>('[aria-label="Region x"]')!.value).toBe('20')
  await click('Redo')
  expect(page(2).querySelector('[data-id]')).not.toBeNull()
})

it.each(['pointercancel', 'Escape'])('cancels a cross-page drag with %s without leaving a partial move', async (cancel) => {
  const original = page(1).querySelector('[data-id] rect')!
  await act(async () => { original.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 60, clientY: 70, pointerId: 1 })) })
  await act(async () => { page(1).dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 100, clientY: 400, pointerId: 1 })) })
  expect(page(2).querySelector('[data-id]')).not.toBeNull()
  await act(async () => {
    page(1).dispatchEvent(cancel === 'Escape' ? new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      : new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }))
  })
  expect(page(1).querySelector('[data-id]')).not.toBeNull()
  expect(page(2).querySelector('[data-id]')).toBeNull()
  await click('Undo')
  expect(container.textContent).toContain('No edits yet')
})

it('drags a rotated copy across pages without changing its original', async () => {
  await click('Rotate region right')
  await chooseCopyPage(1)
  await click('Copy region')
  const copy = page(1).querySelectorAll('[data-id] rect')[1]
  await act(async () => { copy.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 70, clientY: 30, pointerId: 1 })) })
  for (const type of ['pointermove', 'pointerup']) {
    await act(async () => { page(1).dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: 110, clientY: 430, pointerId: 1 })) })
  }
  expect(page(1).querySelectorAll('[data-id]')).toHaveLength(1)
  expect(page(2).querySelectorAll('[data-id]')).toHaveLength(1)
  await click('Save with 2 edits')
  expect(mocks.edit.mock.calls.at(-1)![1]).toEqual([
    expect.objectContaining({ page: 1, sourcePage: 1, rotation: 90, x: 50, y: 10, width: 100, height: 160 }),
    expect.objectContaining({ page: 2, sourcePage: 1, copy: true, rotation: 90, width: 100, height: 160 }),
  ])
})

it('keeps scrolling with a held pointer and stops the frame loop when the drag is cancelled', async () => {
  let sequence = 0
  const frames = new Map<number, FrameRequestCallback>()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++sequence; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.spyOn(window, 'scrollBy').mockImplementation((options: ScrollToOptions | number, y?: number) => {
    document.documentElement.scrollTop += typeof options === 'number' ? y ?? 0 : options.top ?? 0
  })
  vi.mocked(SVGElement.prototype.getBoundingClientRect).mockImplementation(function (this: SVGElement) {
    return (this.getAttribute('data-editor-page') === '2'
      ? { left: 40, top: window.innerHeight + 20 - window.scrollY, width: 120, height: 160 }
      : { left: 0, top: -window.scrollY, width: 200, height: 300 }) as DOMRect
  })
  const original = page(1).querySelector('[data-id] rect')!
  await act(async () => { original.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 60, clientY: 70, pointerId: 1 })) })
  await act(async () => { page(1).dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 100, clientY: window.innerHeight - 2, pointerId: 1 })) })
  for (let i = 1; i <= 4; i++) {
    const [id, callback] = [...frames][0]
    frames.delete(id)
    await act(async () => { callback(i * 16) })
  }
  expect(window.scrollY).toBeGreaterThan(20)
  expect(page(2).querySelector('[data-id]')).not.toBeNull()
  expect(frames.size).toBe(1)
  await act(async () => { page(1).dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 })) })
  expect(frames.size).toBe(0)
  expect(page(1).querySelector('[data-id]')).not.toBeNull()
  expect(page(2).querySelector('[data-id]')).toBeNull()
})

it('works on one PDF: no second PDF to copy from, while Copy and Paste duplicate a region of this one', async () => {
  expect(container.querySelector('[aria-label="PDF to copy from"]')).toBeNull()
  expect(container.textContent).not.toContain('Copy from another PDF')
  expect(container.textContent).not.toContain('Paste into')
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true })) })
  await act(async () => { document.dispatchEvent(new Event('paste', { bubbles: true })) })
  await click('Save with 2 edits')
  const [, edits, , , sources] = mocks.edit.mock.calls.at(-1)!
  expect(edits[1]).toMatchObject({ type: 'region', copy: true, sourcePage: 1, source: edits[0].source })
  expect(edits[1].sourceDocument).toBeUndefined()
  expect(sources).toEqual([])
})
