// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FormSchema } from '../lib/documentTools'
import { HandoffContext } from '../lib/handoff'
import { FormBuilderTool } from './FormBuilderTool'

const mocks = vi.hoisted(() => ({ read: vi.fn(), create: vi.fn(), load: vi.fn(), cancel: vi.fn(), send: vi.fn() }))
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), readForms: mocks.read, createFormFields: mocks.create }))
vi.mock('../lib/pdf', () => ({ closePdf: vi.fn(), formatSize: () => '1 KB' }))
vi.mock('../lib/usePdfLoader', () => ({ usePdfLoader: () => ({ load: mocks.load, cancel: mocks.cancel }) }))
vi.mock('./Dropzone', () => ({ Dropzone: ({ onFiles }: { onFiles: (files: File[]) => void }) => <button onClick={() => onFiles([new File(['source'], 'source.pdf', { type: 'application/pdf' })])}>Choose fixture</button> }))
vi.mock('./PdfToolPreview', () => ({ PdfToolPreview: () => <p>Output preview</p> }))

let root: Root, container: HTMLDivElement
const schema = (patch: Partial<FormSchema> = {}): FormSchema => ({ fields: [], pages: 1, signed: false, xfa: false, ...patch })
const svg = () => container.querySelector<SVGSVGElement>('svg[data-form-page="1"]')!
function button(label: string) {
  const found = [...container.querySelectorAll('button')].find((node) => node.textContent === label || node.getAttribute('aria-label') === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}
async function click(label: string) { await act(async () => button(label).click()) }
async function pointer(target: Element, steps: [string, number, number][]) {
  for (const [type, x, y] of steps) {
    await act(async () => { target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, pointerId: 1 })) })
  }
}
const drag = (x0: number, y0: number, x1: number, y1: number, target: Element = svg()) => pointer(target, [['pointerdown', x0, y0], ['pointermove', x1, y1], ['pointerup', x1, y1]])
const tap = (x: number, y: number) => pointer(svg(), [['pointerdown', x, y], ['pointerup', x, y]])
async function type(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function open(read: FormSchema = schema()) {
  mocks.read.mockResolvedValue(read)
  await act(async () => root.render(<HandoffContext value={{ delivery: null, send: mocks.send }}><FormBuilderTool /></HandoffContext>))
  await click('Choose fixture')
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class {
    callback: ResizeObserverCallback
    constructor(callback: ResizeObserverCallback) { this.callback = callback }
    observe() { this.callback([{ contentRect: { width: 400 } } as ResizeObserverEntry], this as unknown as ResizeObserver) }
    disconnect() {}
  })
  Object.defineProperty(SVGElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 200, height: 300 } as DOMRect)
  const page = { getViewport: () => ({ width: 200, height: 300 }), render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }) }
  mocks.load.mockResolvedValue({ numPages: 1, getPage: async () => page })
  mocks.create.mockResolvedValue(new File(['made'], 'source_form.pdf', { type: 'application/pdf' }))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  Reflect.deleteProperty(SVGElement.prototype, 'setPointerCapture')
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('draws a text box, renames it and previews the fields it describes', async () => {
  await open()
  await drag(20, 40, 180, 62)
  expect(container.querySelector<HTMLInputElement>('[aria-label="Field name"]')!.value).toBe('Text 1')
  await type('Field name', 'Full name')
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  await click('Preview fillable PDF')
  expect(mocks.create).toHaveBeenCalledWith(expect.any(File), [{ type: 'text', name: 'Full name', page: 1, x: 20, y: 40, width: 160, height: 22, required: true }], expect.any(AbortSignal))
  expect(container.textContent).toContain('Output preview')
})

it('groups radio buttons drawn while one of the group is selected', async () => {
  await open()
  await click('Radio button')
  await tap(20, 100)
  expect(container.textContent).toContain('Radio group “Radio group 1” needs at least 2 buttons.')
  expect(button('Preview fillable PDF').disabled).toBe(true)
  await tap(60, 100)
  expect(container.textContent).not.toContain('needs at least 2 buttons')
  await type('Group name', 'Plan')
  await click('Preview fillable PDF')
  expect(mocks.create.mock.calls[0][1]).toEqual([
    { type: 'radio', name: 'Plan', page: 1, x: 20, y: 100, width: 14, height: 14, option: 'Option 1' },
    { type: 'radio', name: 'Plan', page: 1, x: 60, y: 100, width: 14, height: 14, option: 'Option 2' },
  ])
})

it('moves a field, then undoes and redoes the move and the drawing', async () => {
  await open()
  await drag(20, 40, 180, 62)
  await click('Select')
  await drag(30, 50, 50, 80, svg().querySelector('[data-id] rect')!)
  const box = () => { const rect = svg().querySelector('[data-id] rect')!; return ['x', 'y'].map((key) => Number(rect.getAttribute(key))) }
  expect(box()).toEqual([40, 70])
  await click('Undo')
  expect(box()).toEqual([20, 40])
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true })))
  expect(svg().querySelector('[data-id]')).toBeNull()
  await click('Redo')
  expect(box()).toEqual([20, 40])
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' })))
  expect(container.textContent).toContain('0 new fields')
})

it('outlines existing fields, refuses their names, and locks a signed PDF', async () => {
  const existing = { id: 'field-0', name: 'Text 1', label: 'Text 1', pages: [1], required: false, readOnly: false, type: 'text' as const, value: '', options: [], reason: null, boxes: [{ page: 1, x: 10, y: 200, width: 80, height: 20 }] }
  await open(schema({ fields: [existing] }))
  expect(svg().querySelector('title')!.textContent).toBe('Existing field: Text 1')
  await drag(20, 40, 180, 62)
  expect(container.querySelector<HTMLInputElement>('[aria-label="Field name"]')!.value).toBe('Text 2')
  await type('Field name', 'Text 1')
  expect(container.textContent).toContain('this PDF already has a field with that name')
  await act(async () => root.unmount()); root = createRoot(container)
  await open(schema({ signed: true }))
  expect(container.textContent).toContain('digital signature')
  expect(container.querySelector('fieldset')!.disabled).toBe(true)
})
