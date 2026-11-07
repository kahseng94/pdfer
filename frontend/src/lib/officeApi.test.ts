import { afterEach, expect, it, vi } from 'vitest'
import { officeToPdf, readOfficeStatus } from './api'

afterEach(() => vi.unstubAllGlobals())

it('posts an Office document with its kind and cancellation signal, retaining the PDF filename', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('converted', { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf" } }))
  vi.stubGlobal('fetch', fetch)
  const source = new File(['input'], 'résumé.docx')
  const signal = new AbortController().signal
  const output = await officeToPdf(source, 'word', signal)
  expect(fetch.mock.calls[0][0]).toBe('/api/office')
  const options = fetch.mock.calls[0][1] as RequestInit
  expect(options.signal).toBe(signal)
  expect((options.body as FormData).get('file')).toBe(source)
  expect((options.body as FormData).get('kind')).toBe('word')
  expect(output.name).toBe('résumé.pdf')
  expect(output.type).toBe('application/pdf')
  expect(await output.text()).toBe('converted')
})

it('surfaces actionable backend errors and preserves cancellation', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'Install LibreOffice' }), { status: 400 }))
  vi.stubGlobal('fetch', fetch)
  await expect(officeToPdf(new File(['x'], 'a.xlsx'), 'excel')).rejects.toThrow('Install LibreOffice')
  const controller = new AbortController(); controller.abort()
  fetch.mockRejectedValue(new Error('aborted'))
  await expect(officeToPdf(new File(['x'], 'a.pptx'), 'powerpoint', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
})

it('checks local availability without caching', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ available: true, message: null })))
  vi.stubGlobal('fetch', fetch)
  const signal = new AbortController().signal
  expect(await readOfficeStatus(signal)).toEqual({ available: true, message: null })
  expect(fetch).toHaveBeenCalledWith('/api/office/status', { cache: 'no-store', signal })
})
