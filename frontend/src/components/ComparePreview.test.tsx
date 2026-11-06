// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from '../lib/pdf'
import { createComparisonScheduler } from '../lib/pdfCompare'
import { ComparePreview } from './ComparePreview'

const mocks = vi.hoisted(() => ({ render: vi.fn() }))
vi.mock('../lib/pdfCompare', async (original) => ({ ...await original<typeof import('../lib/pdfCompare')>(), renderComparisonPage: mocks.render }))
type PdfPage = Awaited<ReturnType<PDFDocumentProxy['getPage']>>
let root: Root, container: HTMLDivElement
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
const page = (width = 200) => ({ getViewport: () => ({ width, height: 150 }), cleanup: vi.fn() }) as unknown as PdfPage
const doc = (source = page()) => ({ numPages: 2, getPage: vi.fn(async () => source), cleanup: vi.fn(async () => {}) }) as unknown as PDFDocumentProxy
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocks.render.mockImplementation(async (_page, canvas, size) => { canvas.width = size.width; canvas.height = size.height })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('releases both canvases and page resources after a failed render', async () => {
  const original = doc(), revised = doc()
  mocks.render.mockImplementationOnce(async (_page, canvas, size) => { canvas.width = size.width; canvas.height = size.height })
    .mockImplementationOnce(async (_page, canvas, size) => { canvas.width = size.width; canvas.height = size.height; throw new Error('bad page') })
  await act(async () => root.render(<ComparePreview original={original} revised={revised} page={1} dpi={96} />))
  expect(container.textContent).toContain('Could not preview page 1: bad page')
  expect(mocks.render.mock.calls.every(([, canvas]) => !canvas.width && !canvas.height)).toBe(true)
  expect((await original.getPage(1)).cleanup).toHaveBeenCalled()
  expect((await revised.getPage(1)).cleanup).toHaveBeenCalled()
})

it('clears stale previews immediately on prop changes without requiring a parent key', async () => {
  const old = doc(page(200)), fresh = doc(page(300)), waiting = deferred<PdfPage>()
  await act(async () => root.render(<ComparePreview original={old} revised={null} page={1} dpi={96} />))
  expect(container.textContent).toContain('200.0 × 150.0 pt')
  vi.mocked(fresh.getPage).mockReturnValue(waiting.promise)
  await act(async () => root.render(<ComparePreview original={fresh} revised={null} page={1} dpi={96} />))
  expect(container.textContent).not.toContain('200.0 × 150.0 pt')
  expect(container.textContent).toContain('Rendering side-by-side previews')
  await act(async () => waiting.resolve(page(300)))
  expect(container.textContent).toContain('300.0 × 150.0 pt')
  expect(fresh.cleanup).toHaveBeenCalledOnce()
})

it('does not resize active canvases and drains cancelled preview work before a comparison starts', async () => {
  const schedule = createComparisonScheduler(), source = doc(), pending = deferred<void>()
  mocks.render.mockImplementationOnce(async (_page, canvas, size, signal: AbortSignal) => {
    canvas.width = size.width; canvas.height = size.height
    await pending.promise; signal.throwIfAborted()
  })
  await act(async () => root.render(<ComparePreview original={source} revised={null} page={1} dpi={96} schedule={schedule} />))
  const canvas = mocks.render.mock.calls[0][1] as HTMLCanvasElement, signal = mocks.render.mock.calls[0][3] as AbortSignal
  await act(async () => root.render(<div />))
  expect(signal.aborted).toBe(true)
  expect(canvas.width).toBeGreaterThan(0) // PDF.js still owns its context until the render promise settles.
  const compare = vi.fn(async () => { expect(canvas.width).toBe(0) })
  const next = schedule(new AbortController().signal, compare)
  expect(compare).not.toHaveBeenCalled()
  await act(async () => { pending.resolve(); await next })
  expect(compare).toHaveBeenCalledOnce()
  expect(canvas.width).toBe(0); expect(canvas.height).toBe(0)
})

it('ignores late page loads after unmount without allocating a rendered canvas', async () => {
  const source = doc(), waiting = deferred<PdfPage>(), late = page()
  vi.mocked(source.getPage).mockReturnValue(waiting.promise)
  await act(async () => root.render(<ComparePreview original={source} revised={null} page={1} dpi={96} />))
  await act(async () => root.render(<div />))
  await act(async () => waiting.resolve(late))
  expect(late.cleanup).toHaveBeenCalledOnce()
  expect(mocks.render).not.toHaveBeenCalled()
})

it('releases successful preview rasters when navigating away', async () => {
  const source = doc()
  await act(async () => root.render(<ComparePreview original={source} revised={source} page={1} dpi={96} />))
  expect(container.querySelectorAll('canvas')).toHaveLength(2)
  expect(source.cleanup).toHaveBeenCalledOnce()
  await act(async () => root.render(<div />))
  expect(mocks.render.mock.calls.every(([, canvas]) => !canvas.width && !canvas.height)).toBe(true)
})
