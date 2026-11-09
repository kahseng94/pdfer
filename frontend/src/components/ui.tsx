import type { ButtonHTMLAttributes, ReactNode } from 'react'

/** Classes for a small select or text input. */
export const FIELD = 'ui-field'

export function Button({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`ui-button ${className}`}
      {...props}
    />
  )
}

export function ErrorMessage({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
      {children}
    </p>
  )
}

/** Full-window hint while files are dragged over the page; lets events through to what is under it. */
export function DropOverlay({ label }: { label: string }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-rose-50/80 ring-4 ring-inset ring-rose-400 dark:bg-rose-950/60"
    >
      <p className="rounded-lg bg-white px-4 py-2 text-lg font-medium text-zinc-900 shadow-lg dark:bg-zinc-900 dark:text-zinc-100">
        {label}
      </p>
    </div>
  )
}

/** A small square button holding an icon. Pressing it leaves keyboard focus where it was. */
export function IconButton({ label, title, disabled, onClick, children }: { label: string; title?: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="inline-flex size-8 items-center justify-center rounded text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 disabled:text-zinc-300 disabled:hover:bg-transparent dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 dark:disabled:text-zinc-700"
    >
      {children}
    </button>
  )
}
