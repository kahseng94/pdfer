// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CompareTool } from './CompareTool'
import { HandoffContext, type Delivery } from '../lib/handoff'
import type { ComparisonPage, CompareProgress } from '../lib/pdfCompare'

const mocks = vi.hoisted(() => ({ load: vi.fn(), cancel: vi.fn(), compare: vi.fn(), close: vi.fn(), save: vi.fn() }))
vi.mock('../lib/pdf', () => ({ closePdf: mocks.close, formatSize: () => '1 KB' }))
vi.mock('../lib/usePdfLoader', () => ({ usePdfLoader: () => ({ load: mocks.load, cancel: mocks.cancel }) }))
vi.mock('../lib/pdfCompare', async (original) => ({ ...await original<typeof import('../lib/pdfCompare')>(), comparePdfs: mocks.compare }))
vi.mock('../lib/api', () => ({ saveFile: mocks.save }))
vi.mock('./ComparePreview', () => ({ ComparePreview: ({ page }: { page: number }) => <div>Preview pair {page}</div> }))
vi.mock('./Dropzone', () => ({ Dropzone: ({ title, onFiles }: { title: string; onFiles: (files: File[]) => void }) => <button onClick={() => onFiles([new File(['pdf'], `${title}.pdf`)])}>{title}</button> }))

let root: Root, container: HTMLDivElement
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function button(text: string) {
  const found = [...container.querySelectorAll('button')].find((n) => n.textContent === text)
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}
async function click(text: string) { await act(async () => button(text).click()) }
const result: ComparisonPage[] = [1, 2].map((page) => ({ page, status: page === 1 ? 'unchanged' : 'changed',
  original: { width: 200, height: 150 }, revised: { width: 200, height: 150 }, geometryChanged: false,
  regions: page === 1 ? [] : [{ x: 10, y: 20, width: 30, height: 40 }], changedPixels: 10, groupedRegions: false,
  dpi: 96, textChanges: page === 1 ? [] : [{ removed: 'old', added: 'new' }], coarseText: false,
  originalHasText: true, revisedHasText: true, warnings: [],
}))
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocks.load.mockImplementation(async (file: File) => ({ name: file.name, numPages: 2 }))
  mocks.compare.mockResolvedValue(result)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
async function open() {
  await act(async () => root.render(<CompareTool />))
  await click('Choose original PDF'); await click('Choose revised PDF')
}
async function setting(label: string, value: string) {
  await act(async () => { const node = container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })) })
}

it('requires two inputs, synchronizes navigation, shows text edits, and downloads only on request', async () => {
  await act(async () => root.render(<CompareTool />))
  await click('Choose original PDF')
  expect(button('Compare PDFs').disabled).toBe(true)
  await click('Choose revised PDF'); await click('Compare PDFs')
  expect(mocks.load.mock.calls.map((args) => args[1])).toEqual(['original', 'revised'])
  expect(container.textContent).toContain('1 unchanged · 1 changed · 0 added · 0 removed')
  expect(container.textContent).toContain('Preview pair 2')
  expect(container.textContent).toContain('Removed: old')
  expect(container.textContent).toContain('Added: new')
  await click('Next difference')
  expect(container.textContent).toContain('Difference 2 of 2 · text')
  await click('Next difference')
  expect(container.textContent).toContain('Difference 1 of 2 · visual region')
  await click('Previous page')
  expect(container.textContent).toContain('Preview pair 1')
  expect(mocks.save).not.toHaveBeenCalled()
  await click('Download comparison TXT')
  expect(mocks.save).toHaveBeenCalledOnce()
})

it.each(['original', 'revised'])('invalidates completed results when replacing %s', async (side) => {
  await open(); await click('Compare PDFs'); await click(`Replace ${side} PDF`)
  expect(container.textContent).not.toContain('Comparison complete')
  expect(container.textContent).not.toContain('Download comparison TXT')
  expect(mocks.close).toHaveBeenCalledWith(expect.objectContaining({ name: `Choose ${side} PDF.pdf` }))
})

it.each([['Comparison resolution', '144'], ['Comparison noise tolerance', 'precise']])('cancels and rejects stale work on %s changes', async (label, value) => {
  const old = deferred<ComparisonPage[]>()
  mocks.compare.mockReturnValueOnce(old.promise)
  await open(); await click('Compare PDFs')
  const options = mocks.compare.mock.calls[0][3] as { signal: AbortSignal; onProgress: (p: CompareProgress) => void }
  await setting(label, value)
  expect(options.signal.aborted).toBe(true)
  await act(async () => { options.onProgress({ completed: 50, total: 100, phase: 'stale progress' }); old.resolve(result) })
  expect(container.textContent).not.toContain('Comparison complete')
  expect(container.textContent).not.toContain('stale progress')
  await click('Compare PDFs')
  expect(container.textContent).toContain('Comparison complete')
})

it('serializes a rapid cancellation/retry so late work cannot overwrite the new result', async () => {
  const old = deferred<ComparisonPage[]>()
  mocks.compare.mockReturnValueOnce(old.promise)
  await open(); await click('Compare PDFs')
  const signal = mocks.compare.mock.calls[0][3].signal as AbortSignal
  await click('Cancel comparison'); await click('Compare PDFs')
  expect(signal.aborted).toBe(true)
  expect(mocks.compare).toHaveBeenCalledTimes(1)
  await act(async () => old.resolve([{ ...result[0], status: 'removed' }]))
  expect(mocks.compare).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('1 unchanged · 1 changed')
  expect(container.textContent).not.toContain('1 removed')
})

it('ignores late input loads and cancels only the replaced side’s password loader', async () => {
  const old = deferred<{ numPages: number }>()
  mocks.load.mockReturnValueOnce(old.promise)
  await act(async () => root.render(<CompareTool />))
  await click('Choose original PDF'); await click('Replace original PDF')
  await act(async () => old.resolve({ numPages: 999 }))
  expect(container.textContent).not.toContain('999 pages')
  expect(mocks.cancel.mock.calls.map(([key]) => key)).toEqual(['original', 'original'])
  expect(mocks.close).toHaveBeenCalledWith({ numPages: 999 })
})

it('puts incoming handoffs in Original first, then replaces Revised without losing Original', async () => {
  const send = vi.fn()
  const deliver = async (delivery: Delivery) => act(async () => root.render(<HandoffContext value={{ delivery, send }}><CompareTool /></HandoffContext>))
  const one = new File(['one'], 'one.pdf'), two = new File(['two'], 'two.pdf'), three = new File(['three'], 'three.pdf')
  await deliver({ id: 1, to: 'compare', file: one }); await deliver({ id: 2, to: 'compare', file: two }); await deliver({ id: 3, to: 'compare', file: three })
  expect(mocks.load.mock.calls.map(([file, key]) => [file.name, key])).toEqual([['one.pdf', 'original'], ['two.pdf', 'revised'], ['three.pdf', 'revised']])
  expect(container.textContent).toContain('one.pdf'); expect(container.textContent).toContain('three.pdf'); expect(container.textContent).not.toContain('two.pdf')
})

it('aborts comparison on replacement and unmount, discarding late completions', async () => {
  const old = deferred<ComparisonPage[]>()
  mocks.compare.mockReturnValue(old.promise)
  await open(); await click('Compare PDFs')
  const signal = mocks.compare.mock.calls[0][3].signal as AbortSignal
  await click('Replace revised PDF'); expect(signal.aborted).toBe(true)
  await act(async () => old.resolve(result)); expect(container.textContent).not.toContain('Comparison complete')
  const pending = deferred<ComparisonPage[]>()
  mocks.compare.mockReturnValue(pending.promise)
  await click('Compare PDFs')
  const nextSignal = mocks.compare.mock.calls[1][3].signal as AbortSignal
  await act(async () => root.render(<div />)); expect(nextSignal.aborted).toBe(true)
  await act(async () => pending.resolve(result)); expect(container.textContent).not.toContain('Comparison complete')
})

it('rejects oversized handoffs before loading and closes documents over the page limit', async () => {
  const large = new File(['pdf'], 'large.pdf')
  Object.defineProperty(large, 'size', { value: 101 * 1024 * 1024 })
  await act(async () => root.render(<HandoffContext value={{ delivery: { id: 1, to: 'compare', file: large }, send: vi.fn() }}><CompareTool /></HandoffContext>))
  expect(mocks.load).not.toHaveBeenCalled()
  expect(container.textContent).toContain('smaller than 100 MB')
  mocks.load.mockResolvedValueOnce({ numPages: 1001 })
  await click('Replace original PDF')
  expect(container.textContent).toContain('1000 pages per input')
  expect(mocks.close).toHaveBeenCalledWith({ numPages: 1001 })
  expect(button('Compare PDFs').disabled).toBe(true)
})
