// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HandoffContext } from '../lib/handoff'
import { OfficeTool } from './OfficeTool'

const mocks = vi.hoisted(() => ({ status: vi.fn(), convert: vi.fn(), load: vi.fn(), cancel: vi.fn(), close: vi.fn(), save: vi.fn(), send: vi.fn() }))
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), readOfficeStatus: mocks.status, officeToPdf: mocks.convert, saveFile: mocks.save }))
vi.mock('../lib/pdf', () => ({ closePdf: mocks.close, formatSize: () => '1 KB' }))
vi.mock('../lib/usePdfLoader', () => ({ usePdfLoader: () => ({ load: mocks.load, cancel: mocks.cancel }) }))
vi.mock('./DocumentPreview', () => ({ DocumentPreview: ({ doc, onReady }: { doc: never; onReady: (doc: never) => void }) => <button onClick={() => onReady(doc)}>Render output</button> }))

let root: Root, container: HTMLDivElement
const result = new File(['output'], 'report.pdf', { type: 'application/pdf' })
function button(label: string) {
  const node = [...container.querySelectorAll('button')].find((element) => element.textContent === label)
  if (!node) throw new Error(`Missing button ${label}`)
  return node
}
function deferred<T>() {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve: (value: T) => resolve(value) }
}
async function choose(name = 'report.docx', contents = 'source') {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([contents], name)] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function open(active = true) {
  await act(async () => root.render(<HandoffContext value={{ delivery: null, send: mocks.send }}><OfficeTool kind="word" active={active} /></HandoffContext>))
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocks.status.mockResolvedValue({ available: true, message: null })
  mocks.convert.mockResolvedValue(result)
  mocks.load.mockResolvedValue({ numPages: 2 })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('checks availability only while active and supports setup retry without losing the source', async () => {
  await open(false)
  expect(mocks.status).not.toHaveBeenCalled()
  mocks.status.mockResolvedValue({ available: false, message: 'Install LibreOffice' })
  await open()
  await choose()
  expect(button('Convert to PDF').disabled).toBe(true)
  expect(container.textContent).toContain('Install LibreOffice')
  mocks.status.mockResolvedValue({ available: true, message: null })
  await act(async () => button('Check again').click())
  expect(button('Convert to PDF').disabled).toBe(false)
  expect(container.textContent).toContain('report.docx')
})

it('previews the exact PDF before enabling download and handoff; replacing input clears it', async () => {
  await open(); await choose()
  await act(async () => button('Convert to PDF').click())
  expect(mocks.convert.mock.calls[0][0].name).toBe('report.docx')
  expect(mocks.convert.mock.calls[0][1]).toBe('word')
  expect(mocks.load).toHaveBeenCalledWith(result)
  expect(container.textContent).not.toContain('Download PDF')
  expect(mocks.save).not.toHaveBeenCalled()
  await act(async () => button('Render output').click())
  await act(async () => button('Download PDF').click())
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith(result)
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open in Merge"]')!.click())
  expect(mocks.send).toHaveBeenCalledWith('merge', result)
  await choose('next.doc')
  expect(container.querySelector('[aria-label="Output preview"]')).toBeNull()
  expect(container.textContent).not.toContain('Download PDF')
  expect(mocks.close).toHaveBeenCalledWith({ numPages: 2 })
})

it('cancels the request and ignores late results when cancelled or replaced', async () => {
  const pending = deferred<File>(); mocks.convert.mockReturnValue(pending.promise)
  await open(); await choose()
  await act(async () => button('Convert to PDF').click())
  const signal = mocks.convert.mock.calls[0][2] as AbortSignal
  await act(async () => button('Cancel conversion').click())
  expect(signal.aborted).toBe(true)
  expect(container.textContent).toContain('Conversion cancelled.')
  await act(async () => pending.resolve(result))
  expect(mocks.load).not.toHaveBeenCalled()
  expect(container.querySelector('[aria-label="Output preview"]')).toBeNull()

  const next = deferred<File>(); mocks.convert.mockReturnValue(next.promise)
  await act(async () => button('Convert to PDF').click())
  const nextSignal = mocks.convert.mock.calls[1][2] as AbortSignal
  await choose('other.docx')
  expect(nextSignal.aborted).toBe(true)
  await act(async () => next.resolve(result))
  expect(mocks.load).not.toHaveBeenCalled()
})

it('discards a stale preview load and cancels conversion on unmount', async () => {
  const pending = deferred<{ numPages: number }>(); mocks.load.mockReturnValue(pending.promise)
  await open(); await choose()
  await act(async () => button('Convert to PDF').click())
  await act(async () => button('Remove').click())
  const doc = { numPages: 3 }
  await act(async () => pending.resolve(doc))
  expect(mocks.close).toHaveBeenCalledWith(doc)
  expect(container.querySelector('[aria-label="Output preview"]')).toBeNull()
  await choose()
  mocks.convert.mockReturnValue(new Promise(() => {}))
  await act(async () => button('Convert to PDF').click())
  const signal = mocks.convert.mock.calls[1][2] as AbortSignal
  await act(async () => root.render(null))
  expect(signal.aborted).toBe(true)
})

it('rejects wrong formats and empty files and reports conversion failures', async () => {
  await open(); await choose('bad.xlsx')
  expect(container.textContent).toContain('Skipped 1 file')
  expect(container.textContent).not.toContain('Convert to PDF')
  await choose('empty.docx', '')
  expect(button('Convert to PDF').disabled).toBe(true)
  expect(container.textContent).toContain('This file is empty')
  await choose()
  mocks.convert.mockRejectedValue(new Error('The file is password protected.'))
  await act(async () => button('Convert to PDF').click())
  expect(container.textContent).toContain('The file is password protected.')
  expect(button('Convert to PDF').disabled).toBe(false)
})
