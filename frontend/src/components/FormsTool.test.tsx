// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FormField, FormSchema } from '../lib/documentTools'
import { HandoffContext } from '../lib/handoff'
import { FormsTool } from './FormsTool'

const mocks = vi.hoisted(() => ({ read: vi.fn(), fill: vi.fn(), load: vi.fn(), cancel: vi.fn(), send: vi.fn() }))
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), readForms: mocks.read, fillForms: mocks.fill }))
vi.mock('../lib/pdf', () => ({ closePdf: vi.fn(), formatSize: () => '1 KB' }))
vi.mock('../lib/usePdfLoader', () => ({ usePdfLoader: () => ({ load: mocks.load, cancel: mocks.cancel }) }))
vi.mock('./Dropzone', () => ({ Dropzone: ({ onFiles }: { onFiles: (files: File[]) => void }) => <button onClick={() => onFiles([new File(['source'], 'source.pdf', { type: 'application/pdf' })])}>Choose fixture</button> }))
vi.mock('./PdfToolPreview', () => ({ PdfToolPreview: () => null }))

let root: Root, container: HTMLDivElement
const field = (patch: Partial<FormField>): FormField => ({ id: 'field-0', name: 'name', label: 'Name', pages: [1], required: false, readOnly: false, type: 'text', value: '', options: [], reason: null, multiline: false, maxLength: null, boxes: [{ page: 1, x: 50, y: 60, width: 200, height: 20 }], ...patch })
const schema = (patch: Partial<FormSchema> = {}): FormSchema => ({ fields: [field({})], pages: 1, signed: false, xfa: false, ...patch })
const form: FormSchema = schema({ pages: 2, fields: [
  field({}),
  field({ id: 'field-1', name: 'plan', label: 'Plan', type: 'radio', options: [{ value: 'basic', label: 'basic' }, { value: 'pro', label: 'pro' }], allowEmpty: false,
    boxes: [{ page: 1, x: 50, y: 100, width: 14, height: 14, option: 'basic' }, { page: 1, x: 100, y: 100, width: 14, height: 14, option: 'pro' }] }),
  field({ id: 'field-2', name: 'agree', label: 'Agree', type: 'checkbox', value: false, pages: [2], boxes: [{ page: 2, x: 50, y: 50, width: 14, height: 14, option: 'Yes' }] }),
  field({ id: 'field-3', name: 'locked', label: 'Locked', readOnly: true, value: 'Fixed', boxes: [{ page: 1, x: 50, y: 150, width: 200, height: 20 }] }),
] })
const onPage = (label: string) => container.querySelector<HTMLInputElement>(`[role="group"] [aria-label="${label}"]`)
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function click(label: string) { await act(async () => [...container.querySelectorAll('button')].find((node) => node.textContent === label)!.click()) }

beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class {
    callback: ResizeObserverCallback
    constructor(callback: ResizeObserverCallback) { this.callback = callback }
    observe() { this.callback([{ contentRect: { width: 612 } } as ResizeObserverEntry], this as unknown as ResizeObserver) }
    disconnect() {}
  })
  const page = { getViewport: () => ({ width: 612, height: 792 }), render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }) }
  mocks.load.mockImplementation(async () => ({ numPages: 2, getPage: async () => page }))
  mocks.fill.mockResolvedValue(new File(['filled'], 'source_filled.pdf', { type: 'application/pdf' }))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
async function open(read: FormSchema) {
  mocks.read.mockResolvedValue(read)
  await act(async () => root.render(<HandoffContext value={{ delivery: null, send: mocks.send }}><FormsTool /></HandoffContext>))
  await click('Choose fixture')
}

it('explains that a hybrid XFA form is saved as a standard PDF form', async () => {
  await open(schema({ xfa: true }))
  expect(container.textContent).toContain('Adobe XFA data')
  expect(container.querySelector<HTMLInputElement>('#form-field-0')?.disabled).toBe(false)
})

it('shows no XFA note for a standard form', async () => {
  await open(schema())
  expect(container.textContent).toContain('1 fields')
  expect(container.textContent).not.toContain('XFA')
})

it('fills fields on the page and in the list with the same answers', async () => {
  await open(form)
  const name = onPage('Name')!
  expect(name.style.left).toBe(`${50 / 612 * 100}%`)
  await type(name, 'Ada')
  expect(container.querySelector<HTMLInputElement>('#form-field-0')!.value).toBe('Ada')
  await type(container.querySelector<HTMLInputElement>('#form-field-0')!, 'Ada Lovelace')
  expect(onPage('Name')!.value).toBe('Ada Lovelace')
  await act(async () => onPage('Plan: pro')!.click())
  expect(container.querySelector<HTMLSelectElement>('#form-field-1')!.value).toBe('pro')
  expect(onPage('Locked')).toBeNull()
  await click('Preview filled PDF')
  expect(mocks.fill).toHaveBeenCalledWith(expect.any(File), { 'field-0': 'Ada Lovelace', 'field-1': 'pro' }, false, expect.any(AbortSignal))
})

it('turns to the field’s page and puts the keyboard in it there', async () => {
  await open(form)
  expect(onPage('Agree')).toBeNull()
  await click('Show on page 2')
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Form page"]')!.value).toBe('2')
  expect(document.activeElement).toBe(onPage('Agree'))
  await act(async () => onPage('Agree')!.click())
  expect(container.querySelector<HTMLInputElement>('#form-field-2')!.checked).toBe(true)
})
