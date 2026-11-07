// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { TOOLS } from './lib/tools'

// Exercise app navigation without starting the individual tools' I/O.
beforeAll(() => {
  for (const name of ['CompressTool', 'EditTool', 'ImagesTool', 'MergeTool', 'OrganizeTool', 'PdfImagesTool', 'PasswordTool', 'PdfPasswordDialog', 'PhotoTool', 'SplitTool', 'StampTool', 'SignatureTool', 'TextTool', 'CompareTool', 'OcrTool', 'WorkflowTool', 'BookmarksTool', 'MetadataTool', 'FormsTool', 'RedactTool', 'ProjectsPanel']) {
    vi.doMock(`./components/${name}`, () => ({ [name]: ({ active }: { active?: boolean }) => <span data-active={active}>{name}</span> }))
  }
})
vi.mock('./lib/useProject', async () => {
  const { createContext } = await import('react')
  return { ProjectContext: createContext(null), useProjectManager: () => null }
})
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals() })

it('mounts every registered tool and remembers Metadata across navigation', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const { default: App } = await import('./App')
  const container = document.createElement('div'); document.body.append(container)
  let root = createRoot(container)
  try {
    await act(async () => root.render(<App />))
    for (const tool of TOOLS) {
      const tab = container.querySelector<HTMLButtonElement>(`#tab-${tool.id}`)!
      const panel = container.querySelector<HTMLElement>(`#panel-${tool.id}`)!
      expect(tab.textContent).toBe(tool.label)
      await act(async () => tab.click())
      expect(tab.getAttribute('aria-selected')).toBe('true')
      expect(panel.hidden).toBe(false)
      expect(container.querySelectorAll('[role="tabpanel"]:not([hidden])')).toHaveLength(1)
      expect(panel.querySelector('[data-active="true"]')).not.toBeNull()
    }
    await act(async () => container.querySelector<HTMLButtonElement>('#tab-metadata')!.click())
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(<App />))
    expect(container.querySelector<HTMLElement>('#panel-metadata')!.hidden).toBe(false)
    expect(container.querySelector('#tab-metadata')!.getAttribute('aria-selected')).toBe('true')
  } finally {
    await act(async () => root.unmount()); container.remove()
  }
})

it('supports keyboard tabs and the compact picker without losing the selected tool', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const { default: App } = await import('./App')
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const tab = (id: string) => container.querySelector<HTMLButtonElement>(`#tab-${id}`)!
  async function press(key: string) {
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
  }
  try {
    await act(async () => root.render(<App />))
    expect(container.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1)
    tab('merge').focus()
    await press('ArrowDown')
    expect(document.activeElement).toBe(tab('split'))
    expect(tab('split').getAttribute('aria-selected')).toBe('true')
    expect(tab('merge').tabIndex).toBe(-1)
    await press('End')
    expect(document.activeElement).toBe(tab('photo'))
    await press('ArrowDown')
    expect(document.activeElement).toBe(tab('merge'))
    await press('ArrowUp')
    expect(document.activeElement).toBe(tab('photo'))
    await press('Home')
    expect(document.activeElement).toBe(tab('merge'))

    const picker = container.querySelector<HTMLSelectElement>('#tool-picker')!
    expect(picker.value).toBe('merge')
    await act(async () => {
      picker.value = 'edit'
      picker.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.querySelector('h1')!.textContent).toBe('Edit a PDF')
    expect(container.querySelector<HTMLElement>('#panel-edit')!.hidden).toBe(false)
    expect(tab('edit').getAttribute('aria-selected')).toBe('true')
    expect(container.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1)
    expect(localStorage.getItem('pdfer.tool')).toBe('edit')
  } finally {
    await act(async () => root.unmount()); container.remove()
  }
})
