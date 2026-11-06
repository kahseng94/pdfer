// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OcrTool } from './OcrTool'

const mocks = vi.hoisted(() => ({ status: vi.fn(), recognize: vi.fn(), load: vi.fn(), cancel: vi.fn() }))
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), readOcrStatus: mocks.status }))
vi.mock('../lib/ocr', async (original) => ({ ...await original<typeof import('../lib/ocr')>(), recognizePdf: mocks.recognize }))
vi.mock('../lib/pdf', () => ({ closePdf: vi.fn(), formatSize: () => '1 KB' }))
vi.mock('../lib/usePdfLoader', () => ({ usePdfLoader: () => ({ load: mocks.load, cancel: mocks.cancel }) }))
vi.mock('./Dropzone', () => ({ Dropzone: ({ onFiles }: { onFiles: (files: File[]) => void }) => <button onClick={() => onFiles([new File(['scan'], 'scan.pdf', { type: 'application/pdf' })])}>Choose fixture</button> }))
vi.mock('./PdfToolPreview', () => ({ PdfPages: () => <div>Original preview</div>, PdfToolPreview: () => <div>Completed PDF preview</div> }))

let root: Root, container: HTMLDivElement
const ready = { available: true, languages: ['eng'], can_rotate: true, message: null }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function button(text: string) {
  const found = [...container.querySelectorAll('button')].find((node) => node.textContent === text)
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}
async function choose(engine: string) {
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('[aria-label="OCR engine"]')!
    select.value = engine
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocks.status.mockImplementation(async (_signal, engine) => engine === 'paddleocr' ? { ...ready, languages: ['auto'] } : ready)
  mocks.load.mockResolvedValue({ numPages: 1 })
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
async function open() {
  await act(async () => root.render(<OcrTool />))
  await act(async () => button('Choose fixture').click())
}

it('defaults to Tesseract and invalidates a completed preview when the engine changes', async () => {
  mocks.recognize.mockResolvedValue(new File(['result'], 'searchable.pdf', { type: 'application/pdf' }))
  await open()
  await act(async () => button('Recognize text').click())
  expect(mocks.recognize.mock.calls[0][7]).toBe(false)
  expect(mocks.recognize.mock.calls[0][8]).toBe('tesseract')
  expect(container.textContent).toContain('Completed PDF preview')
  await choose('paddleocr')
  expect(container.textContent).not.toContain('Completed PDF preview')
  expect(container.textContent).toContain('Automatic multilingual recognition')
  await act(async () => button('Recognize text').click())
  expect(mocks.recognize.mock.calls[1][3]).toEqual(['auto'])
  expect(mocks.recognize.mock.calls[1][8]).toBe('paddleocr')
})

it('cancels an active run when switching engines and ignores its late result', async () => {
  const old = deferred<File>()
  mocks.recognize.mockReturnValue(old.promise)
  await open()
  await act(async () => button('Recognize text').click())
  const signal = mocks.recognize.mock.calls[0][5] as AbortSignal
  expect(signal.aborted).toBe(false)
  await choose('paddleocr')
  expect(signal.aborted).toBe(true)
  await act(async () => old.resolve(new File(['old'], 'old.pdf')))
  expect(container.textContent).not.toContain('Completed PDF preview')
  expect(button('Recognize text').disabled).toBe(false)
})

it('ignores stale availability responses and keeps Tesseract usable without Paddle setup', async () => {
  const pending = deferred<typeof ready>()
  mocks.status.mockImplementationOnce(() => pending.promise)
    .mockResolvedValueOnce({ available: false, languages: [], message: 'PaddleOCR setup is missing' })
    .mockResolvedValue(ready)
  await open()
  const firstSignal = mocks.status.mock.calls[0][0] as AbortSignal
  await choose('paddleocr')
  expect(firstSignal.aborted).toBe(true)
  expect(container.textContent).toContain('PaddleOCR setup is missing')
  expect(button('Recognize text').disabled).toBe(true)
  await act(async () => pending.resolve(ready))
  expect(container.textContent).toContain('PaddleOCR setup is missing')
  expect(button('Recognize text').disabled).toBe(true)
  await choose('tesseract')
  expect(button('Recognize text').disabled).toBe(false)
  expect(container.textContent).toContain('Document languages')
})

it('preserves optional rotation across engines when orientation data is available', async () => {
  mocks.recognize.mockResolvedValue(new File(['result'], 'searchable.pdf', { type: 'application/pdf' }))
  await open()
  const rotation = [...container.querySelectorAll('label')].find((label) => label.textContent?.includes('Automatically correct'))!.querySelector('input')!
  await act(async () => rotation.click())
  await choose('paddleocr')
  expect(rotation.checked).toBe(true)
  await act(async () => button('Recognize text').click())
  expect(mocks.recognize.mock.calls[0][7]).toBe(true)
  expect(mocks.recognize.mock.calls[0][8]).toBe('paddleocr')
})

it('allows Paddle recognition without Tesseract orientation data', async () => {
  mocks.status.mockResolvedValue({ ...ready, languages: ['auto'], can_rotate: false })
  mocks.recognize.mockResolvedValue(new File(['result'], 'searchable.pdf', { type: 'application/pdf' }))
  await open()
  await choose('paddleocr')
  const rotation = [...container.querySelectorAll('label')].find((label) => label.textContent?.includes('Automatically correct'))!.querySelector('input')!
  expect(rotation.disabled).toBe(true)
  await act(async () => button('Recognize text').click())
  expect(mocks.recognize.mock.calls[0][7]).toBe(false)
  expect(mocks.recognize.mock.calls[0][8]).toBe('paddleocr')
})
