import type { ProjectSession } from '../lib/useProject'
import { ErrorMessage, FIELD } from './ui'

export function ProjectControls({ project }: { project: ProjectSession }) {
  const status = project.saving ? 'Saving locally… Keep this tab open until saving finishes.'
    : project.autosavePaused === 'deleted' ? 'Autosave paused for this deleted project. Save as new project to continue.'
    : project.autosavePaused === 'error' ? 'Autosave paused. Your latest changes are not saved; retry saving or save as a new project.'
    : project.autosavePaused === 'name' ? 'Enter a project name to resume autosave.'
    : project.dirty ? 'Unsaved changes · Autosaving soon…'
    : project.saved ? `All changes saved locally · ${new Date(project.saved.updatedAt).toLocaleString()}`
    : 'Autosave is on. Your first change starts a project in this browser.'
  return <section aria-label="Save project" className="space-y-2 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-40 flex-1 space-y-1 text-sm">Project name
        <input value={project.name} maxLength={120} onChange={(event) => project.setName(event.target.value)} className={`${FIELD} block w-full px-2 py-2`} />
      </label>
      <button type="button" disabled={!project.enabled || project.saving || project.autosavePaused === 'name' || (!!project.saved && !project.dirty && !project.error)} onClick={() => void project.save()}
        className="rounded-md bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50">
        {project.saving ? 'Saving project…' : project.autosavePaused === 'deleted' ? 'Save as new project' : project.error ? 'Retry saving' : 'Save now'}
      </button>
      {project.saved && <button type="button" disabled={!project.enabled || project.saving || project.autosavePaused === 'name'} onClick={() => void project.save(true)} className="py-2 text-sm text-rose-600 disabled:opacity-50 dark:text-rose-400">Save as new project</button>}
    </div>
    <p role="status" className="text-xs text-zinc-500">{status}</p>
    {project.error && <ErrorMessage>{project.error}</ErrorMessage>}
  </section>
}
