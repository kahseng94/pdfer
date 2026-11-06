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
  expect([...request.body.keys()]).toEqual(['image', 'languages', 'dpi', 'rotate'])
  expect(request.body.get('languages')).toBe('eng+fra')
  expect(request.body.get('rotate')).toBe('false')
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

it('carries orientation corrections from recognition into the assembled document', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('text layer', { headers: { 'content-type': 'application/pdf', 'X-OCR-Rotation': '270' } }))
  vi.stubGlobal('fetch', fetch)
  const signal = new AbortController().signal
  const result = await recognizePage(new Blob(['image']), ['eng'], 300, signal, true)
  expect(result.rotation).toBe(270)
  expect(fetch.mock.calls[0][1].body.get('rotate')).toBe('true')
  fetch.mockResolvedValue(new Response('searchable', { headers: { 'content-type': 'application/pdf' } }))
  await assembleOcr(new File(['pdf'], 'scan.pdf'), [result.file], [3], signal, [result.rotation])
  expect(fetch.mock.calls[1][1].body.get('rotations')).toBe('[270]')
})

it.each(['45', '-90', '360', 'NaN'])('rejects invalid rotation headers (%s)', async (rotation) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('text layer', { headers: { 'X-OCR-Rotation': rotation } })))
  await expect(recognizePage(new Blob(['image']), ['eng'], 300, new AbortController().signal, true)).rejects.toThrow('invalid page rotation')
})
