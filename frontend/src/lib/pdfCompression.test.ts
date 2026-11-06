import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compressPdf } from './api'
import { compressPdfBatch, PdfCompressionError, uniquePdfName } from './pdfCompression'
import { pdfPassword, rememberPdfPassword } from './passwords'

vi.mock('./api', () => ({ compressPdf: vi.fn() }))
const compress = vi.mocked(compressPdf)
const pdf = (name: string, contents: string) => new File([contents], name, { type: 'application/pdf' })
const response = (file: File) => ({ file, before: 9999, after: 9999 })
afterEach(() => vi.resetAllMocks())

describe('PDF batch compression', () => {
  it('retains the exact preview files and packages their bytes, reporting mixed target outcomes per PDF', async () => {
    const first = pdf('same_compressed.pdf', 'x'.repeat(900))
    const second = pdf('same_compressed.pdf', 'y'.repeat(1500))
    compress.mockResolvedValueOnce({ ...response(first), targetMet: false })
    compress.mockResolvedValueOnce({ ...response(second), targetMet: true })
    const originals = [pdf('same.pdf', 'a'.repeat(2000)), pdf('same.pdf', 'b'.repeat(3000))]
    const signal = new AbortController().signal
    const result = await compressPdfBatch(originals, 'balanced', signal, undefined, 1000)
    expect(result.outputs).toEqual([first, second])
    expect(result.results.map((entry) => [entry.target, entry.targetMet, entry.after])).toEqual([[1000, true, 900], [1000, false, 1500]])
    const archive = unzipSync(new Uint8Array(await result.file.arrayBuffer()))
    for (const [index, entry] of result.results.entries()) {
      expect(archive[entry.name]).toEqual(new Uint8Array(await result.outputs[index].arrayBuffer()))
      expect(compress).toHaveBeenNthCalledWith(index + 1, originals[index], 'balanced', signal, 1000)
    }
  })

  it('returns a readable ZIP with exact result bytes and savings measured from the files', async () => {
    const originals = [pdf('résumé.pdf', 'original-one'), pdf('small.pdf', 'original-two')]
    compress.mockResolvedValueOnce(response(pdf('résumé_compressed.pdf', 'one')))
    compress.mockResolvedValueOnce(response(pdf('small_compressed.pdf', 'original-two')))
    const progress = vi.fn()
    const signal = new AbortController().signal
    const result = await compressPdfBatch(originals, 'strong', signal, progress)
    expect(result.file.name).toBe('pdfs_compressed.zip')
    expect(result.file.type).toBe('application/zip')
    expect(result.results).toEqual([
      { name: 'résumé_compressed.pdf', before: 12, after: 3 },
      { name: 'small_compressed.pdf', before: 12, after: 12 },
    ])
    const entries = unzipSync(new Uint8Array(await result.file.arrayBuffer()))
    expect(Object.keys(entries)).toEqual(result.results.map((entry) => entry.name))
    expect(new TextDecoder().decode(entries['résumé_compressed.pdf'])).toBe('one')
    expect(new TextDecoder().decode(entries['small_compressed.pdf'])).toBe('original-two')
    expect(compress).toHaveBeenNthCalledWith(1, originals[0], 'strong', signal)
    expect(compress).toHaveBeenNthCalledWith(2, originals[1], 'strong', signal)
    expect(progress.mock.calls.map(([update]) => update.completed)).toEqual([0, 1, 1, 2])
    expect(progress.mock.calls[1][0].results).toHaveLength(1)
  })

  it('keeps the existing single-PDF result, including its session password', async () => {
    const original = pdf('private.pdf', 'private-original')
    const output = pdf('private_compressed.pdf', 'private-result')
    rememberPdfPassword(output, 'session secret')
    compress.mockResolvedValue(response(output))
    const result = await compressPdfBatch([original], 'light', new AbortController().signal)
    expect(result.file).toBe(output)
    expect(pdfPassword(result.file)).toBe('session secret')
    expect(result.results).toEqual([{ name: output.name, before: original.size, after: output.size }])
  })

  it('processes files sequentially, rather than starting every compression at once', async () => {
    let finishFirst: (value: Awaited<ReturnType<typeof compressPdf>>) => void = () => {}
    compress.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve }))
    compress.mockResolvedValueOnce(response(pdf('b_compressed.pdf', 'b')))
    const running = compressPdfBatch([pdf('a.pdf', 'aaaa'), pdf('b.pdf', 'bbbb')], 'balanced', new AbortController().signal)
    await Promise.resolve()
    expect(compress).toHaveBeenCalledTimes(1)
    finishFirst(response(pdf('a_compressed.pdf', 'a')))
    await running
    expect(compress).toHaveBeenCalledTimes(2)
  })

  it('retains all duplicate filenames without overwriting ZIP entries', async () => {
    compress.mockResolvedValueOnce(response(pdf('Report_compressed.pdf', 'one')))
    compress.mockResolvedValueOnce(response(pdf('report_compressed.pdf', 'two')))
    compress.mockResolvedValueOnce(response(pdf('report_compressed (2).pdf', 'three')))
    const result = await compressPdfBatch([pdf('same.pdf', 'a'), pdf('same.pdf', 'b'), pdf('same (2).pdf', 'c')], 'light', new AbortController().signal)
    const entries = unzipSync(new Uint8Array(await result.file.arrayBuffer()))
    expect(Object.keys(entries)).toEqual(['Report_compressed.pdf', 'report_compressed (2).pdf', 'report_compressed (2) (2).pdf'])
    expect(Object.values(entries).map((bytes) => new TextDecoder().decode(bytes))).toEqual(['one', 'two', 'three'])
    expect(result.results.map((entry) => entry.name)).toEqual(Object.keys(entries))
  })

  it('stops after a failed file and never returns a partial archive', async () => {
    compress.mockResolvedValueOnce(response(pdf('a_compressed.pdf', 'a')))
    compress.mockRejectedValueOnce(new Error('Backend unavailable'))
    await expect(compressPdfBatch([pdf('a.pdf', 'aa'), pdf('b.pdf', 'bb'), pdf('c.pdf', 'cc')], 'balanced', new AbortController().signal))
      .rejects.toMatchObject({ index: 1, message: 'Could not compress b.pdf: Backend unavailable' })
    expect(compress).toHaveBeenCalledTimes(2)
    expect(new PdfCompressionError(0, 'a.pdf', 'failure')).toBeInstanceOf(Error)
  })

  it('cancels between files without starting the rest or returning a partial ZIP', async () => {
    const controller = new AbortController()
    compress.mockResolvedValue(response(pdf('a_compressed.pdf', 'a')))
    await expect(compressPdfBatch([pdf('a.pdf', 'aa'), pdf('b.pdf', 'bb')], 'balanced', controller.signal, (progress) => {
      if (progress.completed === 1) controller.abort()
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(compress).toHaveBeenCalledTimes(1)
  })

  it('ignores a late response if cancellation happened while that file was processing', async () => {
    const controller = new AbortController()
    compress.mockImplementationOnce(async () => {
      controller.abort()
      return response(pdf('late.pdf', 'late result'))
    })
    await expect(compressPdfBatch([pdf('a.pdf', 'aa'), pdf('b.pdf', 'bb')], 'balanced', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(compress).toHaveBeenCalledTimes(1)
  })

  it('rejects empty and already-cancelled batches without a request', async () => {
    await expect(compressPdfBatch([], 'light', new AbortController().signal)).rejects.toThrow('Choose at least one')
    await expect(compressPdfBatch([pdf('a.pdf', 'a')], 'light', AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    expect(compress).not.toHaveBeenCalled()
  })
})

describe('ZIP filenames', () => {
  it('removes path separators, control characters and reserved device names', () => {
    const used = new Set<string>()
    const unsafe = uniquePdfName('../../private\\file\0.pdf', used)
    expect(unsafe).not.toMatch(/[\\/\0]/)
    expect(unsafe.startsWith('.')).toBe(false)
    expect(uniquePdfName('CON.pdf', used)).toBe('_CON.pdf')
    expect(uniquePdfName('.pdf', used)).toBe('document_compressed.pdf')
  })

  it('handles canonically equivalent Unicode and long multibyte names safely', () => {
    const used = new Set<string>()
    expect(uniquePdfName('é.pdf', used)).toBe('é.pdf')
    expect(uniquePdfName('e\u0301.pdf', used)).toBe('é (2).pdf')
    const name = uniquePdfName('📄'.repeat(200) + '.pdf', used)
    expect(new TextEncoder().encode(name).length).toBeLessThan(220)
    expect(name.endsWith('.pdf')).toBe(true)
    expect(name).not.toContain('�')
  })
})
