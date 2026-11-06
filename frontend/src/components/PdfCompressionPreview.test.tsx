// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from '../lib/pdf'
import type { PdfCompressionBatch } from '../lib/pdfCompression'
import type { PdfCompressionItem } from '../lib/usePdfCompression'
import { PdfCompressionPreview, PdfTargetStatus } from './PdfCompressionPreview'

const mocks = vi.hoisted(() => ({ load: vi.fn(), close: vi.fn(), save: vi.fn() }))
vi.mock('../lib/pdf', () => ({ loadPdf: mocks.load, closePdf: mocks.close, formatSize: (size: number) => `${size} bytes` }))
vi.mock('../lib/api', () => ({ saveFile: mocks.save }))
vi.mock('./DocumentPreview', () => ({ DocumentPreview: ({ doc, page, onReady }: { doc: PDFDocumentProxy; page: number; onReady: (doc: PDFDocumentProxy) => void }) => {
  useEffect(() => onReady(doc), [doc, onReady])
  return <div>Rendered {doc.fingerprints[0]}, page {page}</div>
} }))
let root: Root, container: HTMLDivElement
const doc = (name: string) => ({ numPages: 2, fingerprints: [name] }) as PDFDocumentProxy
const pdf = (name: string) => new File([name], name, { type: 'application/pdf' })
function button(label: string) { return [...container.querySelectorAll('button')].find((node) => node.textContent === label)! }
function fixture(batch = false) {
  const outputs = batch ? [pdf('one.pdf'), pdf('two.pdf')] : [pdf('one.pdf')]
  const result: PdfCompressionBatch = { file: batch ? new File(['zip'], 'results.zip', { type: 'application/zip' }) : outputs[0], outputs, results: outputs.map((file) => ({ name: file.name, before: 50, after: file.size })) }
  const items: PdfCompressionItem[] = outputs.map((file, i) => ({ id: `${i}`, file, doc: doc(`original-${i}`), error: null }))
  return { result, items }
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocks.load.mockImplementation(async (file: File) => doc(file.name))
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('previews and explicitly downloads the same File, with page navigation and original comparison', async () => {
  const data = fixture()
  await act(async () => root.render(<PdfCompressionPreview {...data} onDismiss={() => {}} />))
  expect(mocks.load.mock.calls[0][0]).toBe(data.result.file)
  expect(mocks.save).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Rendered one.pdf, page 1')
  await act(async () => button('Next page').click())
  expect(container.textContent).toContain('Rendered one.pdf, page 2')
  await act(async () => container.querySelector<HTMLInputElement>('input[value="both"]')!.click())
  expect(container.textContent).toContain('Rendered original-0, page 2')
  expect(container.textContent).toContain('Rendered one.pdf, page 2')
  await act(async () => button('Download PDF').click())
  expect(mocks.save).toHaveBeenCalledWith(data.result.file)
})

it('selects each batch result for preview, cleans up old documents and downloads the existing ZIP', async () => {
  const data = fixture(true)
  await act(async () => root.render(<PdfCompressionPreview {...data} onDismiss={() => {}} />))
  const firstDoc = await mocks.load.mock.results[0].value
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Preview PDF"]')!
    select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(mocks.close).toHaveBeenCalledWith(firstDoc)
  expect(mocks.load.mock.calls[1][0]).toBe(data.result.outputs[1])
  expect(container.textContent).toContain('Rendered two.pdf, page 1')
  await act(async () => button('Download ZIP').click())
  expect(mocks.save).toHaveBeenCalledWith(data.result.file)
  await act(async () => button('Download this PDF').click())
  expect(mocks.save).toHaveBeenLastCalledWith(data.result.outputs[1])
})

it('does not expose a download if the preview cannot open', async () => {
  mocks.load.mockRejectedValue(new Error('Unreadable result'))
  await act(async () => root.render(<PdfCompressionPreview {...fixture()} onDismiss={() => {}} />))
  expect(container.textContent).toContain('Could not open the result preview')
  expect(button('Download PDF')).toBeUndefined()
})

it('hides the old preview and download while replacement bytes are opening', async () => {
  const first = fixture(), next = fixture()
  await act(async () => root.render(<PdfCompressionPreview {...first} onDismiss={() => {}} />))
  let finish!: (value: PDFDocumentProxy) => void
  mocks.load.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  await act(async () => root.render(<PdfCompressionPreview {...next} onDismiss={() => {}} />))
  expect(button('Download PDF')).toBeUndefined()
  expect(container.textContent).not.toContain('Rendered')
  await act(async () => finish(doc('replacement')))
  await act(async () => button('Download PDF').click())
  expect(mocks.save).toHaveBeenCalledWith(next.result.file)
})

it('aborts preview loading on dismissal and closes any late document without rendering it', async () => {
  let finish!: (value: PDFDocumentProxy) => void
  mocks.load.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  await act(async () => root.render(<PdfCompressionPreview {...fixture()} onDismiss={() => {}} />))
  const signal = mocks.load.mock.calls[0][1] as AbortSignal
  await act(async () => root.render(null))
  expect(signal.aborted).toBe(true)
  const late = doc('late')
  await act(async () => finish(late))
  expect(mocks.close).toHaveBeenCalledWith(late)
  expect(container.textContent).toBe('')
  expect(mocks.save).not.toHaveBeenCalled()
})

it('shows the measured best result and an explicit unmet target', async () => {
  await act(async () => root.render(<PdfTargetStatus before={5000} after={1500} target={1000} targetMet={false} />))
  expect(container.textContent).toContain('Target not met')
  expect(container.textContent).toContain('1,500 / 1,000 bytes')
})
