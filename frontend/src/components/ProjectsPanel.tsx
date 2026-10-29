import { useContext, useState } from 'react'
import { formatSize } from '../lib/pdf'
import { ProjectContext } from '../lib/useProject'
import { ErrorMessage } from './ui'

const LABELS = { edit: 'Edit', organize: 'Organize', signatures: 'Signatures' }

export function ProjectsPanel() {
  const manager = useContext(ProjectContext)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  if (!manager) return null
  return <details className="mb-6 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
    <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Saved projects{manager.projects.length > 0 && ` (${manager.projects.length})`}{manager.error && ' · Needs attention'}</summary>
    <div className="space-y-3 border-t border-zinc-200 p-4 dark:border-zinc-800">
      <p className="text-sm text-zinc-500">Work in Edit, Organize, and Signatures is saved automatically as you make changes. Projects include your PDF and placed images, and stay in this browser on this device. Clearing site data removes them. Passwords are never saved.</p>
      <button type="button" disabled={manager.loading || !!manager.working} onClick={() => void manager.refresh()} className="text-sm text-rose-600 disabled:opacity-50 dark:text-rose-400">Refresh projects</button>
      {manager.loading && <p role="status" className="text-sm text-zinc-500">Loading projects…</p>}
      {manager.error && <ErrorMessage>{manager.error}</ErrorMessage>}
      {!manager.loading && !manager.error && !manager.projects.length && <p className="text-sm text-zinc-500">No saved projects yet. Open a PDF in one of these tools and start editing, or choose Save now.</p>}
      <ul className="max-h-96 space-y-3 overflow-y-auto">
        {manager.projects.map((project) => <li key={project.id} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{project.name}</p>
              <p className="truncate text-xs text-zinc-500">{LABELS[project.tool]} · {project.filename} · {formatSize(project.size)}</p>
              <p className="text-xs text-zinc-500">Saved {new Date(project.updatedAt).toLocaleString()}</p>
            </div>
            <button type="button" aria-label={`Resume ${project.name}`} disabled={!!manager.working} onClick={() => void manager.resume(project.id)} className="text-sm font-medium text-rose-600 disabled:opacity-50 dark:text-rose-400">{manager.working === project.id ? 'Working…' : 'Resume'}</button>
            <button type="button" aria-label={`Delete project ${project.name}`} disabled={!!manager.working} onClick={() => setConfirmDelete(project.id)} className="text-sm text-zinc-500 disabled:opacity-50">Delete</button>
          </div>
          {confirmDelete === project.id && <div className="mt-3 space-y-2 text-sm">
            <p>Delete this saved project and its local copy of the files? Your open workspace and downloaded PDFs stay available.</p>
            <div className="flex gap-4"><button type="button" disabled={!!manager.working} onClick={async () => { await manager.remove(project.id); setConfirmDelete(null) }} className="text-red-600">Confirm delete project</button><button type="button" disabled={!!manager.working} onClick={() => setConfirmDelete(null)}>Cancel</button></div>
          </div>}
        </li>)}
      </ul>
    </div>
  </details>
}
