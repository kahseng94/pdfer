// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HandoffContext } from '../lib/handoff'
import { MarkdownTool } from './MarkdownTool'

const mocks = vi.hoisted(() => ({ save: vi.fn(), send: vi.fn() }))
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), saveFile: mocks.save }))

let root: Root, container: HTMLDivElement
const area = () => container.querySelector<HTMLTextAreaElement>('textarea')!
const preview = () => container.querySelector<HTMLElement>('.markdown-body')
function button(label: string) {
  const node = [...container.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label')?.startsWith(label))
  if (!node) throw new Error(`Missing button ${label}`)
  return node
}
async function mount() {
  await act(async () => root.render(<HandoffContext value={{ delivery: null, send: mocks.send }}><MarkdownTool /></HandoffContext>))
}
async function type(value: string, cursor = value.length) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area(), value)
    area().dispatchEvent(new Event('input', { bubbles: true }))
  })
  area().setSelectionRange(cursor, cursor)
}
async function choose(file: File) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('writes a new document with a live preview and downloads it', async () => {
  await mount()
  await act(async () => button('Start a new document').click())
  expect(container.textContent).toContain('All changes downloaded')
  await type('# Plan\n\n- [ ] tea\n- [x] cups')
  expect(preview()!.querySelector('h1')!.textContent).toBe('Plan')
  expect(container.textContent).toContain('Not downloaded yet')
  expect(container.textContent).toContain('3 words · 4 lines')

  await act(async () => preview()!.querySelector<HTMLInputElement>('input[data-task="0"]')!.click())
  expect(area().value).toBe('# Plan\n\n- [x] tea\n- [x] cups')

  const name = container.querySelector<HTMLInputElement>('input:not([type])')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'plan')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('Download').click())
  const saved = mocks.save.mock.calls[0][0] as File
  expect(saved.name).toBe('plan.md')
  expect(await saved.text()).toBe('# Plan\n\n- [x] tea\n- [x] cups')
  expect(container.textContent).toContain('All changes downloaded')
})

it('formats with the toolbar and shortcuts and continues lists on Enter', async () => {
  await mount()
  await act(async () => button('Start a new document').click())
  await type('make this bold')
  area().setSelectionRange(10, 14)
  await act(async () => button('Bold').click())
  expect(area().value).toBe('make this **bold**')
  expect([area().selectionStart, area().selectionEnd]).toEqual([12, 16])

  await type('- milk')
  await act(async () => area().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  expect(area().value).toBe('- milk\n- ')
  await act(async () => area().dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })))
  expect(area().value).toBe('- milk\n- [link text](https://)')
  await act(async () => area().dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true })))
  expect(mocks.save).toHaveBeenCalledTimes(1)
})

it('opens a file, keeps its line endings and asks before discarding changes', async () => {
  await mount()
  await choose(new File(['# Notes\r\nSee [intro](#notes) and [docs](docs/a.md).\r\n'], 'notes.md'))
  expect(area().value).toBe('# Notes\nSee [intro](#notes) and [docs](docs/a.md).\n')
  const scrolled = vi.fn()
  preview()!.querySelector('h1')!.scrollIntoView = scrolled
  const [intro, docs] = preview()!.querySelectorAll('a')
  const click = (link: Element) => { const event = new MouseEvent('click', { bubbles: true, cancelable: true }); link.dispatchEvent(event); return event.defaultPrevented }
  await act(async () => { expect(click(intro)).toBe(true) })
  expect(scrolled).toHaveBeenCalled()
  expect(click(docs)).toBe(true)

  await type('# Notes\nchanged\n')
  await act(async () => button('Download').click())
  expect(await (mocks.save.mock.calls[0][0] as File).text()).toBe('# Notes\r\nchanged\r\n')

  await type('# Notes\nchanged again\n')
  await act(async () => button('New').click())
  expect(container.querySelector('[role=alert]')!.textContent).toContain('notes.md has changes that haven’t been downloaded')
  await act(async () => button('Cancel').click())
  expect(area().value).toBe('# Notes\nchanged again\n')
  await act(async () => button('New').click())
  await act(async () => button('Discard changes').click())
  expect(area().value).toBe('')
  expect(container.querySelector<HTMLInputElement>('input:not([type])')!.value).toBe('Untitled.md')
})

it('reopens the last document and remembers the view', async () => {
  vi.useFakeTimers()
  localStorage.setItem('pdfer.markdown.draft', JSON.stringify({ name: 'draft.md', text: '**kept**', edited: true, crlf: false }))
  await mount()
  expect(container.textContent).toContain('Reopened draft.md from your last session.')
  expect(container.textContent).toContain('Not downloaded yet')
  expect(preview()!.innerHTML).toBe('<p><strong>kept</strong></p>')
  await act(async () => button('Preview').click())
  expect(area()).toBeNull()
  expect(localStorage.getItem('pdfer.markdown.mode')).toBe('preview')
  await act(async () => button('Close').click())
  await act(async () => button('Discard changes').click())
  await act(async () => { vi.advanceTimersByTime(400) })
  expect(localStorage.getItem('pdfer.markdown.draft')).toBeNull()
  expect(container.textContent).toContain('Start a new document')
})
