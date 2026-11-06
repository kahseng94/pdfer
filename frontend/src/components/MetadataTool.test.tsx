// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HandoffContext } from '../lib/handoff'
import { METADATA_FIELDS, METADATA_READ_ONLY, type MetadataSchema } from '../lib/metadata'
import { MetadataTool } from './MetadataTool'

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), load: vi.fn(), cancel: vi.fn(), save: vi.fn(), send: vi.fn() }))
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), readMetadata: mocks.read, writeMetadata: mocks.write, saveFile: mocks.save }))
vi.mock('../lib/pdf', () => ({ closePdf: vi.fn(), formatSize: () => '1 KB' }))
vi.mock('../lib/usePdfLoader', () => ({ usePdfLoader: () => ({ load: mocks.load, cancel: mocks.cancel }) }))
vi.mock('./Dropzone', () => ({ Dropzone: ({ onFiles }: { onFiles: (files: File[]) => void }) => <button onClick={() => onFiles([new File(['source'], 'source.pdf', { type: 'application/pdf' })])}>Choose fixture</button> }))
// Keep the actual preview gate and ResultCard. Rendering is explicitly completed by a click.
vi.mock('./DocumentPreview', () => ({ DocumentPreview: ({ doc, onReady }: { doc: never; onReady: (doc: never) => void }) => <button onClick={() => onReady(doc)}>Render output page</button> }))

let root: Root, container: HTMLDivElement
const sourceSchema = (): MetadataSchema => ({
  fields: Object.fromEntries([...METADATA_FIELDS, ...METADATA_READ_ONLY].map(({ id }) => [id, { value: `${id} XMP`, xmp: `${id} XMP`, documentInfo: `${id} legacy`, conflict: true }])) as MetadataSchema['fields'],
  hasXmp: true, hasDocumentInfo: true, canEdit: true, warnings: [],
})
const result = new File(['output'], 'source_metadata.pdf', { type: 'application/pdf' })
function button(text: string) {
  const found = [...container.querySelectorAll('button')].find((node) => node.textContent === text)
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function action(field: string, value: string) {
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>(`[aria-label="${field} action"]`)!
    select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocks.read.mockResolvedValue(sourceSchema())
  mocks.load.mockImplementation(async () => ({ numPages: 2 }))
  mocks.write.mockResolvedValue(result)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
async function open() {
  await act(async () => root.render(<HandoffContext value={{ delivery: null, send: mocks.send }}><MetadataTool /></HandoffContext>))
  await act(async () => button('Choose fixture').click())
}

it('keeps fields by default, shows conflicts, and sends explicit edit/clear choices', async () => {
  await open()
  expect(container.textContent).toContain('Stored values differ')
  expect(container.textContent).toContain('read-only')
  await action('Title', 'edit')
  await action('Author', 'clear')
  await action('Subject', 'edit')
  await action('Subject', 'keep')
  await act(async () => button('Preview metadata changes').click())
  expect(mocks.write.mock.calls[0][1]).toEqual({ title: 'title XMP', author: null })
  expect(mocks.write.mock.calls[0][2]).toBe(false)
  expect(mocks.save).not.toHaveBeenCalled()
})

it('reads the actual output and waits for its page render before download or handoff', async () => {
  await open()
  const outputSchema = sourceSchema()
  outputSchema.fields.title = { value: 'Actual output title', xmp: 'Actual output title', documentInfo: 'Actual output title', conflict: false }
  mocks.read.mockResolvedValue(outputSchema)
  await act(async () => button('Preview metadata changes').click())
  expect(mocks.read.mock.calls[1][0]).toBe(result)
  expect(mocks.load.mock.calls[1][0]).toBe(result)
  expect(container.querySelector('[aria-label="Output metadata"]')?.textContent).toContain('Actual output title')
  expect(container.textContent).not.toContain('Download PDF')
  await act(async () => button('Render output page').click())
  await act(async () => button('Download PDF').click())
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith(result)
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open in Bookmarks"]')!.click())
  expect(mocks.send).toHaveBeenCalledExactlyOnceWith('bookmarks', result)
  expect(container.querySelector('[aria-label="Open in Metadata"]')).toBeNull()
  await action('Title', 'clear')
  expect(container.querySelector('[aria-label="Output preview"]')).toBeNull()
  expect(container.querySelector('[aria-label="Output metadata"]')).toBeNull()
  expect(container.textContent).not.toContain('Download PDF')
})

it('stages document clearing explicitly, disables edits, and resets or invalidates old previews', async () => {
  await open()
  await action('Title', 'edit')
  await act(async () => button('Clear document metadata').click())
  expect(container.textContent).toContain('does not scrub hidden content')
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Title action"]')!.disabled).toBe(true)
  expect(mocks.write).not.toHaveBeenCalled()
  await act(async () => button('Preview PDF without document metadata').click())
  expect(mocks.write.mock.calls[0].slice(1, 3)).toEqual([{}, true])
  await act(async () => button('Reset changes').click())
  expect(container.querySelector('[aria-label="Output metadata"]')).toBeNull()
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Title action"]')!.value).toBe('keep')
  expect(button('Preview metadata changes').disabled).toBe(false)
})

it('cancels pending writes and ignores late results', async () => {
  const pending = deferred<File>(); mocks.write.mockReturnValue(pending.promise)
  await open()
  await act(async () => button('Preview metadata changes').click())
  const signal = mocks.write.mock.calls[0][3] as AbortSignal
  await act(async () => button('Cancel preview').click())
  expect(signal.aborted).toBe(true)
  await act(async () => pending.resolve(result))
  expect(container.textContent).toContain('Preview cancelled')
  expect(container.querySelector('[aria-label="Output preview"]')).toBeNull()
  expect(mocks.read).toHaveBeenCalledTimes(1)
})

it('invalidates pending inspection when another PDF arrives through handoff', async () => {
  await open()
  const pending = deferred<MetadataSchema>(); mocks.read.mockReturnValueOnce(pending.promise)
  await act(async () => button('Preview metadata changes').click())
  const signal = mocks.read.mock.calls[1][1] as AbortSignal
  const next = new File(['next'], 'next.pdf', { type: 'application/pdf' })
  await act(async () => root.render(<HandoffContext value={{ delivery: { id: 1, to: 'metadata', file: next }, send: mocks.send }}><MetadataTool /></HandoffContext>))
  expect(signal.aborted).toBe(true)
  await act(async () => pending.resolve(sourceSchema()))
  expect(container.textContent).toContain('next.pdf')
  expect(container.querySelector('[aria-label="Output preview"]')).toBeNull()
  expect(mocks.read.mock.calls[2][0]).toBe(next)
})

it('allows clearing malformed metadata and hides results if output inspection fails', async () => {
  mocks.read.mockResolvedValue({ ...sourceSchema(), canEdit: false, warnings: ['Malformed metadata'] })
  await open()
  expect(button('Preview metadata changes').disabled).toBe(true)
  await act(async () => button('Clear document metadata').click())
  mocks.read.mockRejectedValue(new Error('Could not inspect output'))
  await act(async () => button('Preview PDF without document metadata').click())
  expect(container.textContent).toContain('Could not inspect output')
  expect(container.querySelector('[aria-label="Output preview"]')).toBeNull()
  expect(container.textContent).not.toContain('Download PDF')
})
