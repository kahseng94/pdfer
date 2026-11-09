// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ToolNavigation } from './ToolNavigation'

let container: HTMLDivElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container) })
afterEach(() => { container.remove(); vi.unstubAllGlobals() })

it('shows a sidebar footer only when given something to put in it', async () => {
  const root = createRoot(container)
  await act(async () => root.render(<ToolNavigation selected="merge" onSelect={() => {}} />))
  expect(container.querySelector('.sidebar-footer')).toBeNull()
  expect(container.textContent).not.toContain('Files stay on your computer')
  await act(async () => root.render(<ToolNavigation selected="merge" onSelect={() => {}} footer={<button type="button">Footer action</button>} />))
  expect(container.querySelector('.sidebar-footer')?.textContent).toBe('Footer action')
  await act(async () => root.unmount())
})
