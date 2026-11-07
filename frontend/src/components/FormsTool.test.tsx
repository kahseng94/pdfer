// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FormSchema } from '../lib/documentTools'
import { HandoffContext } from '../lib/handoff'
import { FormsTool } from './FormsTool'

const mocks = vi.hoisted(() => ({ read: vi.fn(), fill: vi.fn(), load: vi.fn(), cancel: vi.fn(), send: vi.fn() }))
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), readForms: mocks.read, fillForms: mocks.fill }))
vi.mock('../lib/pdf', () => ({ closePdf: vi.fn(), formatSize: () => '1 KB' }))
vi.mock('../lib/usePdfLoader', () => ({ usePdfLoader: () => ({ load: mocks.load, cancel: mocks.cancel }) }))
vi.mock('./Dropzone', () => ({ Dropzone: ({ onFiles }: { onFiles: (files: File[]) => void }) => <button onClick={() => onFiles([new File(['source'], 'source.pdf', { type: 'application/pdf' })])}>Choose fixture</button> }))
vi.mock('./PdfToolPreview', () => ({ PdfPages: () => null, PdfToolPreview: () => null }))

let root: Root, container: HTMLDivElement
const schema = (xfa: boolean): FormSchema => ({
  fields: [{ id: 'field-0', name: 'name', label: 'Name', pages: [1], required: false, readOnly: false, type: 'text', value: '', options: [], reason: null, multiline: false, maxLength: null }],
  pages: 1, signed: false, xfa,
})
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocks.load.mockImplementation(async () => ({ numPages: 1 }))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
async function open() {
  await act(async () => root.render(<HandoffContext value={{ delivery: null, send: mocks.send }}><FormsTool /></HandoffContext>))
  await act(async () => [...container.querySelectorAll('button')].find((node) => node.textContent === 'Choose fixture')!.click())
}

it('explains that a hybrid XFA form is saved as a standard PDF form', async () => {
  mocks.read.mockResolvedValue(schema(true))
  await open()
  expect(container.textContent).toContain('Adobe XFA data')
  expect(container.querySelector<HTMLInputElement>('#form-field-0')?.disabled).toBe(false)
})

it('shows no XFA note for a standard form', async () => {
  mocks.read.mockResolvedValue(schema(false))
  await open()
  expect(container.textContent).toContain('1 fields')
  expect(container.textContent).not.toContain('XFA')
})
