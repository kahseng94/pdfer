import { afterEach, expect, it, vi } from 'vitest'
import { assembleOcr, readOcrStatus, recognizePage } from './api'
import { pdfPassword, rememberPdfPassword } from './passwords'

afterEach(() => { vi.unstubAllGlobals() })

it('checks local engine availability without caching the result', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ available: true, languages: ['eng'], message: null }))
  vi.stubGlobal('fetch', fetch)
  const signal = new AbortController().signal
  expect((await readOcrStatus(signal)).languages).toEqual(['eng'])
  expect(fetch).toHaveBeenCalledWith('/api/ocr/status', { signal, cache: 'no-store' })
})

it('sends only the page image and OCR options to the recognition endpoint', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('text layer', { headers: { 'content-type': 'application/pdf' } }))
  vi.stubGlobal('fetch', fetch)
  const signal = new AbortController().signal
  await recognizePage(new Blob(['image'], { type: 'image/png' }), ['eng', 'fra'], 300, signal)
  const [path, request] = fetch.mock.calls[0]
  expect(path).toBe('/api/ocr/page')
  expect(request.signal).toBe(signal)
  expect([...request.body.keys()]).toEqual(['image', 'languages', 'dpi', 'engine'])
  expect(request.body.get('languages')).toBe('eng+fra')
  expect(request.body.get('engine')).toBe('tesseract')
})

it('requests Paddle availability and sends the explicit selected engine', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ available: false, languages: [], message: 'Run setup' }))
    .mockResolvedValueOnce(new Response('layer', { headers: { 'content-type': 'application/pdf' } }))
  vi.stubGlobal('fetch', fetch)
  const signal = new AbortController().signal
  expect((await readOcrStatus(signal, 'paddleocr')).available).toBe(false)
  expect(fetch).toHaveBeenNthCalledWith(1, '/api/ocr/status?engine=paddleocr', { signal, cache: 'no-store' })
  await recognizePage(new Blob(['image']), ['auto'], 150, signal, 'paddleocr')
  expect(fetch.mock.calls[1][1].body.get('engine')).toBe('paddleocr')
  expect(fetch.mock.calls[1][1].body.get('languages')).toBe('auto')
})

it('retains passwords in the assembled result and forwards cancellation', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('searchable', { headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="scan_searchable.pdf"' } }))
  vi.stubGlobal('fetch', fetch)
  const source = new File(['original'], 'scan.pdf', { type: 'application/pdf' })
  rememberPdfPassword(source, 'secret')
  const signal = new AbortController().signal
  const result = await assembleOcr(source, [new File(['text layer'], 'text.pdf')], [2], signal)
  const [path, request] = fetch.mock.calls[0]
  expect(path).toBe('/api/ocr/assemble')
  expect(request.signal).toBe(signal)
  expect(request.body.get('password')).toBe('secret')
  expect(request.body.get('pages')).toBe('[2]')
  expect(await request.body.get('file').text()).toBe('original')
  expect(result.name).toBe('scan_searchable.pdf')
  expect(pdfPassword(result)).toBe('secret')
})
