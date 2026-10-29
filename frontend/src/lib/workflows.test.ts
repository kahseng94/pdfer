import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pdfPassword, rememberPdfPassword } from './passwords'
import { newWorkflowStep, starterWorkflow } from './workflowPresets'
import { runWorkflow } from './workflows'

afterEach(() => vi.unstubAllGlobals())
const pdf = (name: string, contents: string) => new File([contents], name, { type: 'application/pdf' })
const input = (name = 'sample.pdf', content = 'source', pageCount = 3) => ({ file: pdf(name, content), pageCount })
const options = () => ({ name: 'Share PDFs', password: 'new secret', signal: new AbortController().signal })

function backend() {
  const calls: { path: string; text: string; body: FormData; signal: AbortSignal | null | undefined }[] = []
  const fetch = vi.fn(async (path: string, request: RequestInit) => {
    const body = request.body as FormData
    const text = await (body.get('file') as File).text()
    calls.push({ path, text, body, signal: request.signal })
    return new Response(`${text}|${path.split('/').at(-1)}`, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="intermediate.pdf"' } })
  })
  vi.stubGlobal('fetch', fetch)
  return { calls, fetch }
}

describe('workflow batches', () => {
  it('feeds each result into the next step and runs files sequentially, returning exact final bytes in a ZIP', async () => {
    const { calls } = backend()
    const inputs = [input('Report.pdf', 'one'), input('report.pdf', 'two')]
    rememberPdfPassword(inputs[0].file, 'input secret')
    const config = options()
    const progress = vi.fn()
    const batch = await runWorkflow(inputs, starterWorkflow(), { ...config, onProgress: progress })
    expect(calls.map((call) => call.path)).toEqual(['/api/stamp', '/api/compress', '/api/protect', '/api/stamp', '/api/compress', '/api/protect'])
    expect(calls.map((call) => call.text)).toEqual(['one', 'one|stamp', 'one|stamp|compress', 'two', 'two|stamp', 'two|stamp|compress'])
    expect(calls.every((call) => call.signal === config.signal)).toBe(true)
    expect(calls.slice(0, 3).map((call) => call.body.get('password'))).toEqual(['input secret', 'input secret', 'input secret'])
    expect(calls[2].body.get('new_password')).toBe('new secret')
    expect(pdfPassword(inputs[0].file)).toBe('input secret')
    const entries = unzipSync(new Uint8Array(await batch.file.arrayBuffer()))
    expect(Object.keys(entries)).toEqual(['Report_processed.pdf', 'report_processed (2).pdf'])
    expect(Object.values(entries).map((bytes) => new TextDecoder().decode(bytes))).toEqual(['one|stamp|compress|protect', 'two|stamp|compress|protect'])
    expect(batch.outputs.map((output) => pdfPassword(output.file))).toEqual(['new secret', 'new secret'])
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ completed: 6, total: 6, completedFiles: 2 }))
  })
  it('honors reordered steps and carries a new password through later operations', async () => {
    const { calls } = backend()
    const steps = starterWorkflow()
    const batch = await runWorkflow([input()], [steps[2], steps[0], steps[1]], options())
    expect(calls.map((call) => call.path)).toEqual(['/api/protect', '/api/stamp', '/api/compress'])
    expect(calls.slice(1).map((call) => call.body.get('password'))).toEqual(['new secret', 'new secret'])
    expect(batch.file).toBe(batch.outputs[0].file)
    expect(await batch.file.text()).toBe('source|protect|stamp|compress')
    expect(pdfPassword(batch.file)).toBe('new secret')
  })
  it('resolves all pages separately for PDFs of different lengths and restarts page numbers', async () => {
    const { calls } = backend()
    await runWorkflow([input('short.pdf', 'a', 1), input('long.pdf', 'b', 5)], [newWorkflowStep('numbers')], { ...options(), password: '' })
    const settings = calls.map((call) => JSON.parse(String(call.body.get('settings'))))
    expect(settings.map((setting) => setting.pages)).toEqual(['1-1', '1-5'])
    expect(settings.map((setting) => setting.numbers.start)).toEqual([1, 1])
  })
  it('preflights every file before starting so an invalid range cannot yield partial work', async () => {
    const { fetch } = backend()
    const step = { ...newWorkflowStep('watermark'), pages: '3-4' }
    await expect(runWorkflow([input('long.pdf', '', 5), input('short.pdf', '', 2)], [step], options())).rejects.toMatchObject({ fileIndex: 1, stepIndex: 0 })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('stops at the failed step and does not return partial results', async () => {
    const { fetch, calls } = backend()
    fetch.mockImplementationOnce(async () => new Response('first', { headers: { 'Content-Type': 'application/pdf' } }))
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ detail: 'Cannot compress this PDF.' }), { status: 400 }))
    await expect(runWorkflow([input(), input('second.pdf')], starterWorkflow(), options())).rejects.toMatchObject({ fileIndex: 0, stepIndex: 1, message: 'sample.pdf · Compress: Cannot compress this PDF.' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(calls).toHaveLength(0)
  })
  it('discards late responses and stops before another step or file when cancelled', async () => {
    const { fetch } = backend()
    const controller = new AbortController()
    fetch.mockImplementationOnce(async () => { controller.abort(); return new Response('late', { headers: { 'Content-Type': 'application/pdf' } }) })
    await expect(runWorkflow([input(), input('second.pdf')], starterWorkflow(), { ...options(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('cancels between files without returning an incomplete ZIP', async () => {
    const { fetch } = backend()
    const controller = new AbortController()
    await expect(runWorkflow([input(), input('second.pdf')], [newWorkflowStep('compress')], {
      ...options(), signal: controller.signal, onProgress: (progress) => { if (progress.completedFiles === 1) controller.abort() },
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('rejects invalid credentials, empty inputs and pre-cancelled work without requests', async () => {
    const { fetch } = backend()
    await expect(runWorkflow([input()], starterWorkflow(), { ...options(), password: '' })).rejects.toThrow('password')
    await expect(runWorkflow([], starterWorkflow(), options())).rejects.toThrow('at least one')
    await expect(runWorkflow([input()], starterWorkflow(), { ...options(), signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
