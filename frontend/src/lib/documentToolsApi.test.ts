import { afterEach, expect, it, vi } from 'vitest'
import { fillForms, readForms, rebuildRedactedPdf, writeBookmarks } from './api'
import { pdfPassword, rememberPdfPassword } from './passwords'

afterEach(() => vi.unstubAllGlobals())

it('sends field changes and explicit flattening, retaining opening passwords and cancellation', async () => {
  const fetch = vi.fn(async () => new Response('output', { headers: { 'Content-Type': 'application/pdf' } }))
  vi.stubGlobal('fetch', fetch)
  const file = new File(['private'], 'form.pdf')
  rememberPdfPassword(file, 'secret')
  const signal = new AbortController().signal
  const result = await fillForms(file, { 'field-0': 'Ada', 'field-1': true }, false, signal)
  const [path, request] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  const body = request.body as FormData
  expect(path).toBe('/api/forms/fill')
  expect(body.get('flatten')).toBe('false')
  expect(JSON.parse(String(body.get('values')))).toEqual({ 'field-0': 'Ada', 'field-1': true })
  expect(body.get('password')).toBe('secret')
  expect(request.signal).toBe(signal)
  expect(pdfPassword(result)).toBe('secret')
})

it('preserves bookmark source IDs, nesting and destinations in the write request', async () => {
  const fetch = vi.fn(async () => new Response('output', { headers: { 'Content-Type': 'application/pdf' } }))
  vi.stubGlobal('fetch', fetch)
  const entries = [{ id: '1', sourceId: 'bookmark-0', title: 'Renamed', page: 2, level: 0 }]
  await writeBookmarks(new File(['pdf'], 'source.pdf'), entries)
  const [path, request] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(path).toBe('/api/bookmarks')
  expect(JSON.parse(String((request.body as FormData).get('entries')))).toEqual(entries)
})

it('uploads only raster images and physical sizes for redaction, never the original PDF', async () => {
  const fetch = vi.fn(async () => new Response('clean PDF', { headers: { 'Content-Type': 'application/pdf' } }))
  vi.stubGlobal('fetch', fetch)
  const source = new File(['PRIVATE ORIGINAL'], 'private.pdf', { type: 'application/pdf' })
  rememberPdfPassword(source, 'secret')
  const signal = new AbortController().signal
  const result = await rebuildRedactedPdf(source, [new File(['masked pixels'], 'page.png', { type: 'image/png' })], [{ width: 612, height: 792 }], signal)
  const [path, request] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  const body = request.body as FormData
  expect(path).toBe('/api/redact')
  expect(body.has('file')).toBe(false)
  expect(body.getAll('pages')).toHaveLength(1)
  expect(await (body.get('pages') as File).text()).toBe('masked pixels')
  expect(body.get('password')).toBe('secret')
  expect(request.signal).toBe(signal)
  expect(result.name).toBe('private_redacted.pdf')
  expect(pdfPassword(result)).toBe('secret')
})

it('reports metadata errors and respects an aborted request', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'XFA forms are not supported.' }), { status: 400 })))
  await expect(readForms(new File(['pdf'], 'source.pdf'))).rejects.toThrow('XFA')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError')))
  await expect(readForms(new File(['pdf'], 'source.pdf'), AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
})
