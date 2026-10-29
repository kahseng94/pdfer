import { afterEach, describe, expect, it, vi } from 'vitest'
import { compressPdf, editPdf, filenameFrom, imagesToPdf, mergePdfs, organizePdf, parseImageResults, protectPdf, signPdf, splitPdf, stampPdf, unlockPdf } from './api'
import { pdfPassword, rememberPdfPassword } from './passwords'
import { DEFAULT_NUMBERS } from './stamps'
import { DEFAULT_IMAGE_LAYOUT } from './imageLayout'

afterEach(() => vi.unstubAllGlobals())

describe('filenameFrom', () => {
  it('prefers the UTF-8 name', () => {
    expect(filenameFrom(`attachment; filename="a_passport.jpg"; filename*=UTF-8''%C3%BC_passport.jpg`)).toBe('ü_passport.jpg')
    expect(filenameFrom('attachment; filename="plain.pdf"')).toBe('plain.pdf')
    expect(filenameFrom(null)).toBeNull()
  })
})

describe('password-aware PDF requests', () => {
  function setup() {
    const file = new File(['source'], 'source.pdf', { type: 'application/pdf' })
    rememberPdfPassword(file, 'original secret')
    const fetch = vi.fn(async () => new Response('result', { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="result.pdf"' } }))
    vi.stubGlobal('fetch', fetch)
    return { file, fetch }
  }

  it('sends input and new passwords only in the protect request body, then remembers the output password', async () => {
    const { file, fetch } = setup()
    const result = await protectPdf(file, 'new secret')
    const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/protect')
    expect((request.body as FormData).get('password')).toBe('original secret')
    expect((request.body as FormData).get('new_password')).toBe('new secret')
    expect(pdfPassword(result)).toBe('new secret')
  })

  it('does not attach the old password to an unlocked result', async () => {
    const { file, fetch } = setup()
    const result = await unlockPdf(file)
    const [, request] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect((request.body as FormData).get('password')).toBe('original secret')
    expect(pdfPassword(result)).toBe('')
  })

  it('sends merge passwords in current file order and remembers the first protected input password', async () => {
    const { file, fetch } = setup()
    const plain = new File(['plain'], 'plain.pdf')
    const other = new File(['other'], 'other.pdf')
    rememberPdfPassword(other, 'second secret')
    const result = await mergePdfs([plain, other, file])
    const [, request] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String((request.body as FormData).get('passwords')))).toEqual(['', 'second secret', 'original secret'])
    expect(pdfPassword(result)).toBe('second secret')
  })

  it('keeps the password with split, organize, edit and compress results for handoff', async () => {
    const { file, fetch } = setup()
    const results = [
      await splitPdf(file, 'extract', '1'),
      await organizePdf(file, [{ page: 1, rotation: 90 }]),
      await editPdf(file, [], []),
      (await compressPdf(file, 'light')).file,
    ]
    for (const result of results) expect(pdfPassword(result)).toBe('original secret')
    for (const call of fetch.mock.calls) {
      const [, request] = call as unknown as [string, RequestInit]
      expect((request.body as FormData).get('password')).toBe('original secret')
    }
  })

  it('sends stamp settings and a cancellation signal, keeping the returned PDF and password for preview', async () => {
    const { file, fetch } = setup()
    const controller = new AbortController()
    const settings = { pages: '2-4', numbers: DEFAULT_NUMBERS, watermark: null }
    const result = await stampPdf(file, settings, controller.signal)
    const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/stamp')
    expect(request.signal).toBe(controller.signal)
    expect(JSON.parse(String((request.body as FormData).get('settings')))).toEqual(settings)
    expect((request.body as FormData).get('password')).toBe('original secret')
    expect(await result.text()).toBe('result')
    expect(pdfPassword(result)).toBe('original secret')
  })

  it('sends crop and resize for selected output positions, with cancellable preview bytes', async () => {
    const { file, fetch } = setup()
    const controller = new AbortController()
    const layout = { pages: [2], crop: { top: 10, right: 5, bottom: 10, left: 5 }, resize: { width: 297, height: 210 } }
    const result = await organizePdf(file, [{ page: 3, rotation: 0 }, { page: 1, rotation: 90 }], layout, controller.signal)
    const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    const body = request.body as FormData
    expect(url).toBe('/api/organize')
    expect(body.get('pages')).toBe('3,1:90')
    expect(JSON.parse(String(body.get('layout')))).toEqual(layout)
    expect(request.signal).toBe(controller.signal)
    expect(pdfPassword(result)).toBe('original secret')
    expect(await result.text()).toBe('result')
  })

  it('preserves cancellation instead of reporting that the backend is unreachable', async () => {
    const { file } = setup()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError')))
    await expect(stampPdf(file, { pages: '1', numbers: DEFAULT_NUMBERS, watermark: null }, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('sends each PDF’s own password and the batch cancellation signal to compression', async () => {
    const { file, fetch } = setup()
    const second = new File(['other'], 'source.pdf', { type: 'application/pdf' })
    rememberPdfPassword(second, 'different secret')
    const controller = new AbortController()
    const firstResult = await compressPdf(file, 'strong', controller.signal)
    const secondResult = await compressPdf(second, 'strong', controller.signal)
    const requests = fetch.mock.calls as unknown as [string, RequestInit][]
    expect(requests.map(([, request]) => (request.body as FormData).get('password'))).toEqual(['original secret', 'different secret'])
    expect(requests.every(([, request]) => request.signal === controller.signal)).toBe(true)
    expect(pdfPassword(firstResult.file)).toBe('original secret')
    expect(pdfPassword(secondResult.file)).toBe('different secret')
  })

  it('keeps the exact signature preview bytes and password when naming the signed copy', async () => {
    const { file, fetch } = setup()
    const controller = new AbortController()
    const signature = new File(['png'], 'signature.png', { type: 'image/png' })
    const edits = [{ type: 'image' as const, page: 1, x: 10, y: 20, width: 120, height: 40, image: 0 }]
    const result = await signPdf(file, edits, [signature], controller.signal)
    expect(result.name).toBe('source_signed.pdf')
    expect(await result.text()).toBe('result')
    expect(pdfPassword(result)).toBe('original secret')
    const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/edit')
    expect(request.signal).toBe(controller.signal)
    expect(JSON.parse(String((request.body as FormData).get('edits')))).toEqual(edits)
    expect((request.body as FormData).getAll('images')).toHaveLength(1)
  })
})

describe('parseImageResults', () => {
  const files = [
    { name: 'a.jpg', size: 1000 },
    { name: 'ü b.png', size: 2000 },
  ]

  it('reads one entry per file, decoding names', () => {
    const header = JSON.stringify([
      { name: 'a_compressed.jpg', before: 1000, after: 400 },
      { name: '%C3%BC%20b_compressed.png', before: 2000, after: 2000 },
    ])
    expect(parseImageResults(header, files)).toEqual([
      { name: 'a_compressed.jpg', before: 1000, after: 400 },
      { name: 'ü b_compressed.png', before: 2000, after: 2000 },
    ])
  })

  it('falls back to the files when the header is missing or broken', () => {
    const unchanged = [
      { name: 'a.jpg', before: 1000, after: 1000 },
      { name: 'ü b.png', before: 2000, after: 2000 },
    ]
    expect(parseImageResults(null, files)).toEqual(unchanged)
    expect(parseImageResults('{nope', files)).toEqual(unchanged)
    expect(parseImageResults('[{"after": "x"}]', files)).toEqual(unchanged)
  })
})

describe('image PDF layout requests', () => {
  function setup() {
    const fetch = vi.fn(async (_url: string, _request: RequestInit) => new Response('preview bytes', { headers: { 'Content-Type': 'application/pdf' } }))
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  it('sends the layout, file order and cancellation signal, returning unchanged preview bytes', async () => {
    const fetch = setup()
    const files = [new File(['a'], 'first.png'), new File(['b'], 'second.jpg')]
    const controller = new AbortController()
    const output = await imagesToPdf(files, { ...DEFAULT_IMAGE_LAYOUT, paper: 'letter', orientation: 'landscape', fit: 'cover', marginMm: 12.5 }, controller.signal)
    const [url, request] = fetch.mock.calls[0]
    const body = request.body as FormData
    expect(url).toBe('/api/images')
    expect(request.signal).toBe(controller.signal)
    expect(body.getAll('files').map((file) => (file as File).name)).toEqual(['first.png', 'second.jpg'])
    expect([body.get('paper'), body.get('orientation'), body.get('fit'), body.get('margin_mm')]).toEqual(['letter', 'landscape', 'cover', '12.5'])
    expect(await output.text()).toBe('preview bytes')
  })

  it('keeps calls without layout options compatible with the original image-size API', async () => {
    const fetch = setup()
    await imagesToPdf([new File(['a'], 'first.png')])
    expect([...(fetch.mock.calls[0][1].body as FormData).keys()]).toEqual(['files'])
  })

  it('does not send stale hidden paper settings when matching the image size', async () => {
    const fetch = setup()
    await imagesToPdf([new File(['a'], 'first.png')], { ...DEFAULT_IMAGE_LAYOUT, paper: 'image', marginMm: NaN, fit: 'cover' })
    const body = fetch.mock.calls[0][1].body as FormData
    expect([body.get('paper'), body.get('orientation'), body.get('fit'), body.get('margin_mm')]).toEqual(['image', 'portrait', 'contain', '0'])
  })
})
