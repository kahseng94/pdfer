// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_STYLE, type Tool } from '../lib/edits'
import type { PDFDocumentProxy } from '../lib/pdf'
import { useEditHistory } from '../lib/useEditHistory'
import { EditPage, type Editor } from './EditPage'

vi.mock('./PageThumbnail', () => ({ PageThumbnail: () => <canvas /> }))

function Harness() {
  const history = useEditHistory()
  const [selected, select] = useState<string | null>(null)
  const [tool, setTool] = useState<Tool>('region')
  const editor: Editor = { ...history, select, edit: () => {}, stopEditing: () => {}, toolDone: () => setTool('select') }
  return <>
    <button onClick={history.undo}>Undo</button><button onClick={history.redo}>Redo</button>
    <button onClick={() => setTool('region')}>Move region</button><button onClick={() => setTool('select')}>Select</button>
    <button onClick={() => history.commit((els) => els.filter((el) => el.id !== selected))}>Restore original</button>
    <output>{JSON.stringify(history.elements)}</output>
    <EditPage doc={{} as PDFDocumentProxy} pageNumber={1} size={{ width: 200, height: 300 }} zoom={1}
      elements={history.elements} selectedId={selected} editingId={null} tool={tool} style={DEFAULT_STYLE} editor={editor} />
  </>
}

let root: Root, container: HTMLDivElement
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(SVGElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 200, height: 300 } as DOMRect)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<Harness />))
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(SVGElement.prototype, 'setPointerCapture')
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const elements = () => JSON.parse(container.querySelector('output')!.textContent!)
const svg = () => container.querySelector('svg')!
async function pointer(type: string, x: number, y: number, target: EventTarget = svg()) {
  await act(async () => { target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, pointerId: 1 })) })
}
async function drag(from: [number, number], to: [number, number], target: EventTarget = svg()) {
  await pointer('pointerdown', ...from, target)
  await pointer('pointermove', ...to)
  await pointer('pointerup', ...to)
}
async function click(label: string) {
  await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent === label)!.click() })
}

it('selects original content, moves and resizes it, and undoes each gesture as one action', async () => {
  await pointer('pointerdown', 30, 40)
  await pointer('pointermove', 90, 80)
  expect(elements()).toEqual([]) // unfinished selections are never autosaved
  await pointer('pointerup', 90, 80)
  const [initial] = elements()
  expect(initial).toMatchObject({ type: 'region', page: 1, x: 30, y: 40, width: 60, height: 40, source: { x: 30, y: 40, width: 60, height: 40 } })
  await drag([40, 50], [100, 150], container.querySelector('[data-id] rect')!)
  expect(elements()[0]).toMatchObject({ ...initial, x: 90, y: 140 })
  await drag([150, 180], [180, 200], container.querySelector('[data-handle="se"]')!)
  expect(elements()[0]).toMatchObject({ x: 90, y: 140, width: 90, height: 60, source: initial.source })
  await click('Undo')
  expect(elements()[0]).toMatchObject({ x: 90, y: 140, width: 60, height: 40 })
  await click('Undo')
  expect(elements()).toEqual([initial])
  await click('Undo')
  expect(elements()).toEqual([])
  await click('Redo')
  expect(elements()).toEqual([initial])
  await click('Restore original')
  expect(elements()).toEqual([])
})

it('cancels pointer selections and moves without committing partial edits', async () => {
  await pointer('pointerdown', 20, 20)
  await pointer('pointermove', 80, 60)
  await pointer('pointercancel', 80, 60)
  expect(elements()).toEqual([])
  await drag([20, 20], [80, 60])
  const initial = elements()
  await pointer('pointerdown', 25, 25, container.querySelector('[data-id] rect')!)
  await pointer('pointermove', 100, 100)
  await pointer('pointercancel', 100, 100)
  expect(elements()).toEqual(initial)
  await click('Undo')
  expect(elements()).toEqual([])
})

it('rejects overlapping source regions and clamps selections and moves to the page', async () => {
  await drag([20, 20], [80, 60])
  await click('Move region')
  await drag([40, 30], [100, 100])
  expect(elements()).toHaveLength(1)
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('overlaps')
  await drag([190, 290], [240, 340])
  expect(elements()[1]).toMatchObject({ source: { x: 190, y: 290, width: 10, height: 10 } })
  await drag([195, 295], [-100, -100], container.querySelectorAll('[data-id] rect')[1])
  expect(elements()[1]).toMatchObject({ x: 0, y: 0, width: 10, height: 10 })
})

it('switching tools discards an unfinished region', async () => {
  await pointer('pointerdown', 20, 20)
  await pointer('pointermove', 80, 60)
  await click('Select')
  await pointer('pointerup', 80, 60)
  expect(elements()).toEqual([])
  await click('Move region')
  await drag([50, 60], [110, 90])
  expect(elements()[0]).toMatchObject({ source: { x: 50, y: 60, width: 60, height: 30 } })
})
