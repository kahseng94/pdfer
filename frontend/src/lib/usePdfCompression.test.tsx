// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PdfCompressionBatch } from './pdfCompression'
import { usePdfCompression } from './usePdfCompression'

const mocks = vi.hoisted(() => ({ batch: vi.fn(), load: vi.fn(), close: vi.fn(), cancel: vi.fn() }))
vi.mock('./pdfCompression', async (original) => ({ ...await original<typeof import('./pdfCompression')>(), compressPdfBatch: mocks.batch }))
vi.mock('./pdf', () => ({ closePdf: mocks.close }))
vi.mock('./usePdfLoader', () => ({ usePdfLoader: () => ({ load: mocks.load, cancel: mocks.cancel }) }))
let api: ReturnType<typeof usePdfCompression>
let root: Root, container: HTMLDivElement
function Harness() {
  const batch = usePdfCompression()
  useLayoutEffect(() => { api = batch })
  return null
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const source = () => new File(['original'], 'source.pdf', { type: 'application/pdf' })
function output(): PdfCompressionBatch {
  const file = new File(['result'], 'result.pdf', { type: 'application/pdf' })
  return { file, outputs: [file], results: [{ name: file.name, before: 8, after: 6 }] }
}
beforeEach(async () => {
  vi.resetAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocks.load.mockResolvedValue({ numPages: 2 })
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<Harness />))
  await act(async () => api.add([source()]))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('uses preset behavior by default and sends a validated decimal target only when enabled', async () => {
  mocks.batch.mockResolvedValue(output())
  await act(async () => api.run())
  expect(mocks.batch.mock.calls[0][4]).toBeUndefined()
  expect(api.result).not.toBeNull()
  await act(async () => api.changeTarget(true, '2', 'MB'))
  expect(api.result).toBeNull()
  await act(async () => api.run())
  expect(mocks.batch.mock.calls[1][4]).toBe(2_000_000)
  await act(async () => api.changeTarget(true, '0', 'KB'))
  expect(api.targetError).toContain('1 KB')
  expect(api.result).toBeNull()
  await act(async () => api.run())
  expect(mocks.batch).toHaveBeenCalledTimes(2)
})

it.each(['target', 'unit', 'level', 'add', 'remove', 'clear', 'cancel'] as const)('cancels and rejects late output after %s changes', async (change) => {
  const pending = deferred<PdfCompressionBatch>()
  mocks.batch.mockReturnValue(pending.promise)
  await act(async () => { void api.run() })
  const signal = mocks.batch.mock.calls[0][2] as AbortSignal
  await act(async () => {
    if (change === 'target') api.changeTarget(true, '1')
    else if (change === 'unit') api.changeTarget(true, '2', 'KB')
    else if (change === 'level') api.changeLevel('light')
    else if (change === 'add') api.add([source()])
    else if (change === 'remove') api.remove(api.items[0].id)
    else if (change === 'clear') api.clear()
    else api.cancel()
  })
  expect(signal.aborted).toBe(true)
  await act(async () => pending.resolve(output()))
  expect(api.result).toBeNull()
  expect(api.progress).toBeNull()
  expect(api.busy).toBe(false)
})

it('a late cancelled run cannot replace the new run or clear its busy state', async () => {
  const old = deferred<PdfCompressionBatch>(), fresh = deferred<PdfCompressionBatch>()
  mocks.batch.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  await act(async () => { void api.run() })
  await act(async () => api.changeTarget(true, '1'))
  await act(async () => { void api.run() })
  await act(async () => old.resolve(output()))
  expect(api.busy).toBe(true)
  expect(api.result).toBeNull()
  const expected = output()
  await act(async () => fresh.resolve(expected))
  expect(api.result).toBe(expected)
  expect(api.busy).toBe(false)
})

it('clears partial batch progress on failure and aborts active requests on unmount', async () => {
  mocks.batch.mockImplementation(async (_files, _level, _signal, progress) => {
    progress({ completed: 1, total: 2, current: 'second.pdf', results: output().results })
    throw new Error('Failed second PDF')
  })
  await act(async () => api.add([source()]))
  await act(async () => api.run())
  expect(api.result).toBeNull()
  expect(api.progress).toBeNull()
  expect(api.error).toContain('No ZIP was created')
  const pending = deferred<PdfCompressionBatch>()
  mocks.batch.mockReturnValue(pending.promise)
  await act(async () => { void api.run() })
  const signal = mocks.batch.mock.calls[1][2] as AbortSignal
  await act(async () => root.render(null))
  expect(signal.aborted).toBe(true)
  await act(async () => pending.resolve(output()))
  expect(mocks.close).toHaveBeenCalledTimes(2)
})
