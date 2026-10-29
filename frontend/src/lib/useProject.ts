import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { deleteProject, listProjects, projectError, projectFingerprint, readProject, restoreProject, saveProject, type ProjectDraft, type ProjectSummary, type ProjectTool, type SavedProject } from './projects'

type Receiver = (project: SavedProject) => Promise<boolean>
export const PROJECT_AUTOSAVE_DELAY = 1000
export const PROJECT_AUTOSAVE_MAX_WAIT = 5000

export function useProjectManager(select: (tool: ProjectTool) => void) {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  const receivers = useRef(new Map<ProjectTool, Receiver>())
  const listing = useRef(0)
  const running = useRef(false)
  const refresh = useCallback(async () => {
    const request = ++listing.current
    setLoading(true)
    try {
      const saved = await listProjects()
      if (request === listing.current) { setProjects(saved); setError(null) }
    } catch (error) { if (request === listing.current) setError(projectError(error)) }
    finally { if (request === listing.current) setLoading(false) }
  }, [])
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 0)
    window.addEventListener('focus', refresh)
    return () => { clearTimeout(timer); listing.current += 1; window.removeEventListener('focus', refresh) }
  }, [refresh])
  const register = useCallback((tool: ProjectTool, receiver: Receiver) => {
    receivers.current.set(tool, receiver)
    return () => { if (receivers.current.get(tool) === receiver) receivers.current.delete(tool) }
  }, [])
  const persist = useCallback(async (draft: ProjectDraft, name: string, previous?: ProjectSummary) => {
    const saved = await saveProject(draft, name, previous)
    setProjects((projects) => [saved, ...projects.filter((project) => project.id !== saved.id)])
    await refresh()
    return saved
  }, [refresh])
  async function resume(id: string) {
    if (running.current) return
    running.current = true
    setWorking(id); setError(null)
    try {
      const saved = await readProject(id)
      const receiver = receivers.current.get(saved.summary.tool)
      if (!receiver) throw new Error('This project’s tool is unavailable.')
      select(saved.summary.tool)
      if (await receiver(saved)) {
        document.getElementById(`tab-${saved.summary.tool}`)?.focus()
        document.getElementById(`panel-${saved.summary.tool}`)?.scrollIntoView({ block: 'start' })
      }
    } catch (error) { setError(projectError(error)) }
    finally { running.current = false; setWorking(null) }
  }
  async function remove(id: string) {
    if (running.current) return
    running.current = true
    setWorking(id); setError(null)
    try {
      await deleteProject(id)
      setProjects((projects) => projects.filter((project) => project.id !== id))
      await refresh()
    }
    catch (error) { setError(projectError(error)) }
    finally { running.current = false; setWorking(null) }
  }
  return { projects, loading, error, working, refresh, register, persist, resume, remove }
}

export const ProjectContext = createContext<ReturnType<typeof useProjectManager> | null>(null)

export function useProject<T extends ProjectTool>(
  tool: T,
  draft: ProjectDraft<T> | null,
  hasChanges: boolean,
  restore: (draft: ProjectDraft<T>) => Promise<boolean>,
) {
  const manager = useContext(ProjectContext)
  const [association, setSaved] = useState<ProjectSummary | null>(null)
  const [nameInput, setName] = useState<string | null>(null)
  const [baseline, setBaseline] = useState<{ file: File; key: string; name: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const epoch = useRef(0)
  const writing = useRef(false)
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSince = useRef<number | null>(null)
  const clearAutosave = useCallback(() => {
    if (autosaveTimer.current !== null) clearTimeout(autosaveTimer.current)
    autosaveTimer.current = null
  }, [])
  // A deletion must not be undone by the next autosave of its still-open workspace.
  const deleted = !!association && !!manager && !manager.error && !manager.projects.some((project) => project.id === association.id)
  const saved = deleted ? null : association
  const key = useMemo(() => draft ? projectFingerprint(draft.state) : '', [draft])
  const name = nameInput ?? (draft ? draft.file.name.replace(/\.pdf$/i, '').slice(0, 120).trim() || 'Untitled project' : '')
  const validName = name.trim().length > 0 && name.trim().length <= 120
  const dirty = !!draft && (saved && baseline ? baseline.file !== draft.file || baseline.key !== key || baseline.name !== name.trim() : hasChanges || !!association)
  function canReplace() { return !dirty || window.confirm('Discard changes that have not been saved yet? Wait for autosave or choose Save now to keep them.') }
  const reset = useCallback(() => {
    clearAutosave()
    pendingSince.current = null
    epoch.current += 1
    writing.current = false
    setSaved(null); setBaseline(null); setName(null); setError(null); setSaving(false)
  }, [clearAutosave])

  const latest = useRef({ restore, canReplace })
  useEffect(() => { latest.current = { restore, canReplace } })
  const register = manager?.register
  useEffect(() => register?.(tool, async (project) => {
    if (!latest.current.canReplace()) return false
    const restored = restoreProject(project.content)
    if (restored.draft.tool !== tool) { restored.dispose(); return false }
    let accepted = false
    try {
      reset()
      const current = epoch.current
      accepted = await latest.current.restore(restored.draft as ProjectDraft<T>)
      if (!accepted || current !== epoch.current) { accepted = false; return false }
      setSaved(project.summary); setName(project.summary.name)
      setBaseline({ file: restored.draft.file, key: projectFingerprint(restored.draft.state), name: project.summary.name })
      return true
    } finally { if (!accepted) restored.dispose() }
  }), [register, tool, reset])

  useEffect(() => {
    if (!dirty && !saving) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, saving])

  async function save(asNew = false) {
    if (!draft || !manager || writing.current) return
    clearAutosave()
    pendingSince.current = null
    writing.current = true
    const current = epoch.current
    setSaving(true); setError(null)
    try {
      const summary = await manager.persist(draft as ProjectDraft, name, asNew ? undefined : saved ?? undefined)
      if (current !== epoch.current) return
      setSaved(summary)
      // Typing a new name while this snapshot is written must not be overwritten.
      setName((current) => current === null || current.trim() === name.trim() ? summary.name : current)
      setBaseline({ file: draft.file, key, name: summary.name })
    } catch (error) { if (current === epoch.current) setError(projectError(error)) }
    finally { if (current === epoch.current) { writing.current = false; setSaving(false) } }
  }
  const saveLatest = useRef(save)
  useEffect(() => { saveLatest.current = save })
  const autosavePaused = deleted ? 'deleted' : error ? 'error' : !validName ? 'name' : null
  const shouldAutosave = !!draft && !!manager && dirty && !saving && !autosavePaused
  useEffect(() => {
    if (!shouldAutosave) { pendingSince.current = null; return }
    pendingSince.current ??= Date.now()
    const remaining = PROJECT_AUTOSAVE_MAX_WAIT - (Date.now() - pendingSince.current)
    const current = epoch.current
    autosaveTimer.current = setTimeout(() => {
      if (current === epoch.current) void saveLatest.current()
    }, Math.max(0, Math.min(PROJECT_AUTOSAVE_DELAY, remaining)))
    return clearAutosave
  }, [shouldAutosave, key, name, draft?.file, clearAutosave])

  useEffect(() => {
    if (!shouldAutosave) return
    const flush = () => { void saveLatest.current() }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('blur', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', flush)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [shouldAutosave])

  return { name, setName, saved, saving, dirty, error, save, reset, canReplace, autosavePaused, enabled: !!draft && !!manager }
}

export type ProjectSession = ReturnType<typeof useProject>
