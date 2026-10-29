// @vitest-environment happy-dom
/// <reference types="node" />
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { IDBFactory } from 'fake-indexeddb'
import { act, useLayoutEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_STYLE } from './edits'
import * as storage from './projects'
import type { ProjectDraft } from './projects'
import { PROJECT_AUTOSAVE_DELAY, PROJECT_AUTOSAVE_MAX_WAIT, ProjectContext, useProject, useProjectManager } from './useProject'

function draft(label = 'draft'): ProjectDraft<'edit'> {
  return { tool: 'edit', file: new File(['pdf bytes'], `${label}.pdf`, { type: 'application/pdf' }), state: { elements: [{ id: 'text', type: 'text', page: 1, x: 10, y: 20, text: label, size: 14, color: '#000000', family: 'sans', bold: false, italic: false }], style: DEFAULT_STYLE, zoom: 1 } }
}
let root: Root
let container: HTMLDivElement
let initial: ProjectDraft<'edit'> | null
let restoreSucceeds: boolean
let api: {
  session: ReturnType<typeof useProject<'edit'>>
  manager: ReturnType<typeof useProjectManager>
  change: (draft: ProjectDraft<'edit'> | null) => void
  current: ProjectDraft<'edit'> | null
}

function Workspace({ manager }: { manager: ReturnType<typeof useProjectManager> }) {
  const [current, change] = useState(initial)
  const session = useProject('edit', current, !!current?.state.elements.length, async (restored) => {
    if (restoreSucceeds) change(restored)
    return restoreSucceeds
  })
  useLayoutEffect(() => { api = { session, manager, change, current } }, [session, manager, change, current])
  return <span>{session.dirty ? 'Unsaved changes' : 'Saved'}</span>
}
function Harness() {
  const manager = useProjectManager(() => {})
  return <ProjectContext value={manager}><Workspace manager={manager} /></ProjectContext>
}
async function mount() {
  await act(async () => { root.render(<Harness />) })
  if (vi.isFakeTimers()) {
    await act(async () => { await vi.advanceTimersByTimeAsync(0); await api.manager.refresh() })
    return
  }
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(api.manager.loading).toBe(false)
  })
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('File', NodeFile)
  vi.stubGlobal('indexedDB', new IDBFactory())
  let nextUrl = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:restored-${++nextUrl}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.stubGlobal('confirm', vi.fn(() => true))
  initial = draft()
  restoreSucceeds = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  vi.useRealTimers()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('automatic project saving', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }))

  async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
  async function settled() {
    await vi.waitFor(async () => {
      await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)) })
      expect(api.session.saving).toBe(false)
    })
  }
  function changeText(text: string) {
    const current = api.current!
    const element = draft().state.elements[0]
    if (element.type !== 'text') throw new Error('Missing fixture text')
    api.change({ ...current, state: { ...current.state, elements: [{ ...element, text }] } })
  }

  it('starts on the first edit and debounces further edits into the same project', async () => {
    initial = { ...draft(), state: { ...draft().state, elements: [] } }
    const save = vi.spyOn(storage, 'saveProject')
    await mount()
    await advance(PROJECT_AUTOSAVE_MAX_WAIT * 2)
    expect(save).not.toHaveBeenCalled()
    await act(async () => { changeText('First edit') })
    await advance(PROJECT_AUTOSAVE_DELAY - 1)
    expect(save).not.toHaveBeenCalled()
    await advance(1); await settled()
    const first = api.session.saved!
    expect(first).not.toBe(null)
    expect(api.session.dirty).toBe(false)
    await act(async () => { changeText('Second edit') })
    await advance(600)
    await act(async () => { changeText('Latest edit') })
    await advance(PROJECT_AUTOSAVE_DELAY - 1)
    expect(save).toHaveBeenCalledTimes(1)
    await advance(1); await settled()
    expect(api.session.saved?.id).toBe(first.id)
    expect(api.session.saved?.revision).toBe(2)
    expect(await storage.listProjects()).toHaveLength(1)
    const stored = await storage.readProject(first.id)
    expect(stored.content.state).toHaveProperty('elements.0.text', 'Latest edit')
    await act(async () => { api.change({ ...api.current!, state: { ...api.current!.state, elements: [] } }) })
    await advance(PROJECT_AUTOSAVE_DELAY); await settled()
    expect((await storage.readProject(first.id)).content.state).toHaveProperty('elements', [])
  })

  it('saves within five seconds during continuous editing', async () => {
    const save = vi.spyOn(storage, 'saveProject')
    await mount()
    for (let edit = 1; edit <= 12; edit++) {
      await advance(400)
      await act(async () => { changeText(`Edit ${edit}`) })
    }
    expect(save).not.toHaveBeenCalled()
    await advance(PROJECT_AUTOSAVE_MAX_WAIT - 4800); await settled()
    expect(save).toHaveBeenCalledTimes(1)
    expect((await storage.readProject(api.session.saved!.id)).content.state).toHaveProperty('elements.0.text', 'Edit 12')
  })

  it('serializes writes and catches up with edits and renames made during a slow save', async () => {
    const gate = deferred()
    const original = storage.saveProject
    const save = vi.spyOn(storage, 'saveProject').mockImplementationOnce(async (...args) => { await gate.promise; return original(...args) })
    await mount()
    await advance(PROJECT_AUTOSAVE_DELAY)
    expect(api.session.saving).toBe(true)
    await act(async () => { changeText('Typed during save'); api.session.setName('Renamed during save') })
    await advance(PROJECT_AUTOSAVE_MAX_WAIT * 2)
    expect(save).toHaveBeenCalledTimes(1)
    await act(async () => { gate.resolve() })
    await settled()
    expect(api.session.name).toBe('Renamed during save')
    expect(api.session.dirty).toBe(true)
    const firstId = api.session.saved!.id
    await advance(PROJECT_AUTOSAVE_DELAY); await settled()
    expect(save).toHaveBeenCalledTimes(2)
    expect(api.session.saved?.id).toBe(firstId)
    expect(api.session.dirty).toBe(false)
    const stored = await storage.readProject(firstId)
    expect(stored.summary.name).toBe('Renamed during save')
    expect(stored.content.state).toHaveProperty('elements.0.text', 'Typed during save')
  })

  it('does not duplicate manual saves or copies when an autosave is pending', async () => {
    const save = vi.spyOn(storage, 'saveProject')
    await mount()
    await act(async () => { await api.session.save() })
    const originalId = api.session.saved!.id
    await advance(PROJECT_AUTOSAVE_MAX_WAIT * 2)
    expect(save).toHaveBeenCalledTimes(1)
    await act(async () => { changeText('Copy this version') })
    await act(async () => { await api.session.save(true) })
    await advance(PROJECT_AUTOSAVE_MAX_WAIT * 2)
    expect(save).toHaveBeenCalledTimes(2)
    expect(api.session.saved?.id).not.toBe(originalId)
    expect(await storage.listProjects()).toHaveLength(2)
  })

  it('pauses after failure without a retry loop, and resumes after a successful retry', async () => {
    const save = vi.spyOn(storage, 'saveProject').mockRejectedValueOnce(new DOMException('Full', 'QuotaExceededError'))
    await mount()
    await advance(PROJECT_AUTOSAVE_DELAY); await settled()
    expect(api.session.autosavePaused).toBe('error')
    expect(api.session.dirty).toBe(true)
    await act(async () => { changeText('Keep this unsaved edit') })
    await advance(PROJECT_AUTOSAVE_MAX_WAIT * 3)
    expect(save).toHaveBeenCalledTimes(1)
    await act(async () => { await api.session.save() })
    expect(api.session.autosavePaused).toBe(null)
    expect(api.session.dirty).toBe(false)
    await act(async () => { changeText('Autosave works again') })
    await advance(PROJECT_AUTOSAVE_DELAY); await settled()
    expect(save).toHaveBeenCalledTimes(3)
    expect(api.session.dirty).toBe(false)
  })

  it('pauses on another tab’s newer revision and can continue as a new project', async () => {
    await mount()
    await advance(PROJECT_AUTOSAVE_DELAY); await settled()
    const saved = api.session.saved!
    await storage.saveProject(draft('external'), 'From another tab', saved)
    await act(async () => { changeText('My local edit') })
    await advance(PROJECT_AUTOSAVE_DELAY); await settled()
    expect(api.session.error).toContain('another tab')
    await advance(PROJECT_AUTOSAVE_MAX_WAIT * 2)
    expect((await storage.readProject(saved.id)).summary.name).toBe('From another tab')
    await act(async () => { await api.session.save(true) })
    expect(api.session.saved?.id).not.toBe(saved.id)
    expect(api.session.autosavePaused).toBe(null)
  })

  it('does not recreate a deleted project until explicitly saved as a new one', async () => {
    const save = vi.spyOn(storage, 'saveProject')
    await mount()
    await advance(PROJECT_AUTOSAVE_DELAY); await settled()
    const id = api.session.saved!.id
    await act(async () => { changeText('Pending edit') })
    await act(async () => { await api.manager.remove(id) })
    await advance(PROJECT_AUTOSAVE_MAX_WAIT * 2)
    expect(save).toHaveBeenCalledTimes(1)
    expect(api.session.autosavePaused).toBe('deleted')
    expect(await storage.listProjects()).toHaveLength(0)
    await act(async () => { await api.session.save() })
    expect(api.session.saved?.id).not.toBe(id)
    expect(api.session.autosavePaused).toBe(null)
  })

  it('cancels pending saves on replacement and unmount', async () => {
    const save = vi.spyOn(storage, 'saveProject')
    await mount()
    await advance(PROJECT_AUTOSAVE_DELAY / 2)
    await act(async () => {
      api.session.reset()
      api.change({ ...draft('replacement'), state: { ...draft().state, elements: [] } })
    })
    await advance(PROJECT_AUTOSAVE_MAX_WAIT * 2)
    expect(save).not.toHaveBeenCalled()
    await act(async () => { changeText('Replacement edit') })
    await advance(PROJECT_AUTOSAVE_DELAY); await settled()
    expect(api.session.saved?.filename).toBe('replacement.pdf')
    await act(async () => { changeText('Pending on unmount'); root.render(null) })
    await advance(PROJECT_AUTOSAVE_MAX_WAIT * 2)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('flushes when the window loses focus or the document becomes hidden', async () => {
    const save = vi.spyOn(storage, 'saveProject')
    await mount()
    await act(async () => { window.dispatchEvent(new Event('blur')) })
    await settled()
    expect(save).toHaveBeenCalledTimes(1)
    await act(async () => { changeText('Save before backgrounding') })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('blur'))
    })
    await settled()
    expect(save).toHaveBeenCalledTimes(2)
    expect(api.session.dirty).toBe(false)
  })

  it('pauses for an empty name and supplies a valid default for unusually long filenames', async () => {
    initial = draft('x'.repeat(200))
    await mount()
    expect(api.session.name).toHaveLength(120)
    await act(async () => { api.session.setName(' ') })
    await advance(PROJECT_AUTOSAVE_MAX_WAIT * 2)
    expect(api.session.saved).toBe(null)
    expect(api.session.autosavePaused).toBe('name')
    await act(async () => { api.session.setName('A valid project name') })
    await advance(PROJECT_AUTOSAVE_DELAY); await settled()
    expect(api.session.saved?.name).toBe('A valid project name')
    expect(api.session.dirty).toBe(false)
  })
})

describe('project workspace lifecycle', () => {
  it('restores after remount, starts saved, and can continue editing the same project', async () => {
    await mount()
    await act(async () => { await api.session.save() })
    const saved = api.session.saved!
    expect(api.session.dirty).toBe(false)
    const savedUnload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(savedUnload)
    expect(savedUnload.defaultPrevented).toBe(false)
    await act(async () => root.unmount())
    root = createRoot(container)
    initial = null
    await mount()
    expect(api.current).toBe(null)
    await act(async () => { await api.manager.resume(saved.id) })
    expect(api.current?.state.elements).toEqual(draft().state.elements)
    expect(api.session.saved?.id).toBe(saved.id)
    expect(api.session.dirty).toBe(false)
    await act(async () => { api.change({ ...api.current!, state: { ...api.current!.state, elements: [] } }) })
    expect(api.session.dirty).toBe(true)
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
    await act(async () => { api.session.setName('Renamed project') })
    await act(async () => { await api.session.save() })
    expect(api.session.dirty).toBe(false)
    expect((await storage.readProject(saved.id)).summary.name).toBe('Renamed project')
    await act(async () => { await api.session.save(true) })
    expect(api.session.saved?.id).not.toBe(saved.id)
    expect(api.manager.projects).toHaveLength(2)
  })

  it('does not label edits made during an asynchronous save as saved', async () => {
    await mount()
    const gate = deferred()
    const save = storage.saveProject
    vi.spyOn(storage, 'saveProject').mockImplementation(async (...args) => { await gate.promise; return save(...args) })
    let pending!: Promise<void>
    await act(async () => { pending = api.session.save() })
    expect(api.session.saving).toBe(true)
    await act(async () => { api.change({ ...api.current!, state: { ...api.current!.state, elements: [] } }) })
    await act(async () => { gate.resolve(); await pending })
    expect(api.session.saved).not.toBe(null)
    expect(api.session.dirty).toBe(true)
    const stored = await storage.readProject(api.session.saved!.id)
    expect(stored.content.state).toHaveProperty('elements', draft().state.elements)
  })

  it('does not attach a late save to a replacement document', async () => {
    await mount()
    const gate = deferred()
    const save = storage.saveProject
    vi.spyOn(storage, 'saveProject').mockImplementation(async (...args) => { await gate.promise; return save(...args) })
    let pending!: Promise<void>
    await act(async () => { pending = api.session.save() })
    await act(async () => { api.session.reset(); api.change(draft('replacement')) })
    await act(async () => { gate.resolve(); await pending })
    expect(api.session.saved).toBe(null)
    expect(api.session.name).toBe('replacement')
    expect(api.manager.projects).toHaveLength(1)
    expect(api.manager.projects[0].filename).toBe('draft.pdf')
  })

  it('allows cancelling replacement and releases restored images when opening fails', async () => {
    const incoming = draft('incoming')
    incoming.state.elements.push({ id: 'image', type: 'image', page: 1, x: 1, y: 1, width: 30, height: 20, file: new File(['pixels'], 'image.png'), url: 'blob:old' })
    const saved = await storage.saveProject(incoming, 'Incoming')
    await mount()
    vi.mocked(window.confirm).mockReturnValue(false)
    await act(async () => { await api.manager.resume(saved.id) })
    expect(api.current?.file.name).toBe('draft.pdf')
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    vi.mocked(window.confirm).mockReturnValue(true)
    restoreSucceeds = false
    await act(async () => { await api.manager.resume(saved.id) })
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:restored-1')
    expect(api.session.saved).toBe(null)
    expect(await storage.listProjects()).toHaveLength(1)
  })

  it('keeps failed saves dirty, supports retry, and preserves the workspace after deleting its saved copy', async () => {
    await mount()
    vi.spyOn(storage, 'saveProject').mockRejectedValueOnce(new DOMException('Full', 'QuotaExceededError'))
    await act(async () => { await api.session.save() })
    expect(api.session.error).toContain('Browser storage is full')
    expect(api.session.saved).toBe(null)
    expect(api.session.dirty).toBe(true)
    await act(async () => { await api.session.save() })
    expect(api.session.error).toBe(null)
    await act(async () => { await api.manager.remove(api.session.saved!.id) })
    expect(api.session.saved).toBe(null)
    expect(api.current?.state.elements).toEqual(draft().state.elements)
    expect(api.session.dirty).toBe(true)
    await act(async () => { await api.session.save() })
    expect(api.manager.projects).toHaveLength(1)
    expect(api.session.dirty).toBe(false)
  })

  it('detaches a deleted project immediately while the list refresh is still pending', async () => {
    await mount()
    await act(async () => { await api.session.save() })
    const saved = api.session.saved!
    const refreshStarted = deferred()
    const gate = deferred()
    const list = storage.listProjects
    vi.spyOn(storage, 'listProjects').mockImplementation(async () => {
      refreshStarted.resolve()
      await gate.promise
      return list()
    })
    let pending!: Promise<void>
    await act(async () => { pending = api.manager.remove(saved.id); await refreshStarted.promise })
    expect(api.manager.loading).toBe(true)
    expect(api.session.saved).toBe(null)
    expect(api.session.dirty).toBe(true)
    await act(async () => { gate.resolve(); await pending })
    expect(api.session.saved).toBe(null)
  })
})
