// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { loadSidebarHidden, saveSidebarHidden } from './sidebarPreference'

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

it('shows the sidebar unless it was hidden before', () => {
  expect(loadSidebarHidden()).toBe(false)
  saveSidebarHidden(true)
  expect(loadSidebarHidden()).toBe(true)
  saveSidebarHidden(false)
  expect(loadSidebarHidden()).toBe(false)
})

it('shows the sidebar when storage is blocked', () => {
  const blocked = () => { throw new Error('blocked') }
  vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked })
  expect(() => saveSidebarHidden(true)).not.toThrow()
  expect(loadSidebarHidden()).toBe(false)
})
