import type { ReactNode } from 'react'
import { saveFile } from '../lib/api'
import { useHandoff } from '../lib/handoff'
import { formatSize } from '../lib/pdf'
import { targetsFor, type ToolId } from '../lib/tools'
import { pdfPassword } from '../lib/passwords'
import { CheckIcon, XIcon } from './icons'

/**
 * The file a tool just made, to download or to carry on with in the other
 * tools that take it. Nothing is saved until Download is pressed.
 */
export function ResultCard({
  file,
  from,
  onDismiss,
  children,
  downloadLabel = 'Download',
}: {
  file: File
  from: ToolId
  onDismiss: () => void
  /** A line about the result, under its name. */
  children?: ReactNode
  downloadLabel?: string
}) {
  const handoff = useHandoff()
  const targets = handoff ? targetsFor(file, from) : []

  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-sm text-zinc-600 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
      <div className="flex items-center gap-2">
        <CheckIcon className="size-4 shrink-0 text-rose-600 dark:text-rose-400" />
        <div role="status" className="min-w-0 flex-1">
          <p className="truncate">
            <span className="font-medium text-zinc-900 dark:text-zinc-100">{file.name}</span> · {formatSize(file.size)}
          </p>
          {children && <p>{children}</p>}
          {pdfPassword(file) && <p>Password protected</p>}
        </div>
        <button
          type="button"
          onClick={() => saveFile(file)}
          className="shrink-0 rounded-md bg-rose-600 px-3 py-1.5 font-medium text-white shadow-sm hover:bg-rose-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600"
        >
          {downloadLabel}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      {targets.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-6">
          <span className="mr-0.5">Open in</span>
          {targets.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => handoff?.send(t.id, file)}
              aria-label={`Open in ${t.label}`}
              className="rounded-md border border-zinc-300 px-2.5 py-1 font-medium text-zinc-800 hover:border-zinc-400 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600 dark:border-zinc-700 dark:text-zinc-200 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
