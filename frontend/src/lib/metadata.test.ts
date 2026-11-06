import { afterEach, expect, it, vi } from 'vitest'
import { readMetadata, writeMetadata } from './api'
import { metadataMode, metadataProblem } from './metadata'
import { pdfPassword, rememberPdfPassword } from './passwords'

afterEach(() => vi.unstubAllGlobals())

it('distinguishes untouched, edited and cleared fields without treating empty input as deletion', () => {
  expect(metadataMode({}, 'title')).toBe('keep')
  expect(metadataMode({ title: null }, 'title')).toBe('clear')
  expect(metadataMode({ title: '' }, 'title')).toBe('edit')
  expect(metadataProblem({ title: '' })).toContain('Clear field')
  expect(metadataProblem({ title: 'x'.repeat(5001) })).toContain('5000')
  expect(metadataProblem({ title: 'Café 日本語 🐕', author: null })).toBeNull()
})

it('sends only requested edits and remembers the opening password on the returned file', async () => {
  const fetch = vi.fn(async () => new Response('output', { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="source_metadata.pdf"' } }))
  vi.stubGlobal('fetch', fetch)
  const file = new File(['private'], 'source.pdf')
  rememberPdfPassword(file, 'secret')
  const signal = new AbortController().signal
  const output = await writeMetadata(file, { title: '日本語 🐕', author: null }, false, signal)
  const [path, request] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  const body = request.body as FormData
  expect(path).toBe('/api/metadata')
  expect(body.get('password')).toBe('secret')
  expect(body.get('clear')).toBe('false')
  expect(JSON.parse(String(body.get('changes')))).toEqual({ title: '日本語 🐕', author: null })
  expect(request.signal).toBe(signal)
  expect(output.name).toBe('source_metadata.pdf')
  expect(pdfPassword(output)).toBe('secret')
})

it('uses a separate explicit request for clearing all document metadata', async () => {
  const fetch = vi.fn(async () => new Response('output', { headers: { 'Content-Type': 'application/pdf' } }))
  vi.stubGlobal('fetch', fetch)
  await writeMetadata(new File(['pdf'], 'source.pdf'), {}, true)
  const [, request] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect((request.body as FormData).get('clear')).toBe('true')
  expect((request.body as FormData).get('changes')).toBe('{}')
})

it('reads metadata with the password and propagates errors and cancellation', async () => {
  const fetch = vi.fn(async () => Response.json({ fields: {} }))
  vi.stubGlobal('fetch', fetch)
  const file = new File(['pdf'], 'source.pdf')
  rememberPdfPassword(file, 'secret')
  const signal = new AbortController().signal
  expect(await readMetadata(file, signal)).toEqual({ fields: {} })
  const [path, request] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(path).toBe('/api/metadata/read')
  expect((request.body as FormData).get('password')).toBe('secret')
  expect(request.signal).toBe(signal)
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ detail: 'Bad metadata' }, { status: 400 })))
  await expect(writeMetadata(file, {}, true)).rejects.toThrow('Bad metadata')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError')))
  await expect(readMetadata(file, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
})
