// The pieces the photo tools share on screen: the empty state, the chosen photo, the list of a batch and what each came out as.

import type { CSSProperties, ReactNode } from 'react'
import { formatSize } from '../lib/pdf'
import type { PhotoResult } from '../lib/photoEdits'
import type { PhotoItem } from '../lib/usePhotoItems'
import { Dropzone } from './Dropzone'
import { ImageIcon, XIcon } from './icons'
import { DropOverlay } from './ui'

/** "1200 × 800 px · 240 KB", or the trouble with the file. */
export function Describe({ item }: { item: PhotoItem }) {
  if (item.preview === 'error') return <span className="text-red-600 dark:text-red-400">Can’t read this photo.</span>
  const parts = [item.size && `${item.size.width} × ${item.size.height} px`, formatSize(item.file.size)]
  if (item.preview === 'none') parts.push('no preview for this format')
  return <>{parts.filter(Boolean).join(' · ')}</>
}

/** The notice that some chosen files weren't photos, or nothing. */
export function SkippedNotice({ count }: { count: number }) {
  if (!count) return null
  return (
    <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
      Skipped {count} {count === 1 ? 'file that isn’t a photo' : 'files that aren’t photos'}.
    </p>
  )
}

/** The empty state: a dropzone and the paste hint. */
export function PhotoEmpty({ title, multiple, onFiles, onSkipped, dragging, skipped }: {
  title: string
  multiple: boolean
  onFiles: (files: File[]) => void
  onSkipped: (files: File[]) => void
  dragging: boolean
  skipped: number
}) {
  return (
    <div className="space-y-4">
      {dragging && <DropOverlay label={multiple ? 'Drop photos to add' : 'Drop a photo to open'} />}
      <SkippedNotice count={skipped} />
      <Dropzone kind="photo" multiple={multiple} title={title} onFiles={onFiles} onSkipped={onSkipped} />
      <p className="text-center text-sm text-zinc-500">You can also paste a photo.</p>
    </div>
  )
}

/** The chosen photo of a single-photo tool, with a way to swap it. */
export function PhotoHeader({ item, onReset }: { item: PhotoItem; onReset: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex min-w-0 items-center gap-3">
        <Thumb item={item} className="size-12 shrink-0 rounded" />
        <div className="min-w-0">
          <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">{item.file.name}</p>
          <p className="text-sm text-zinc-500"><Describe item={item} /></p>
        </div>
      </div>
      <button type="button" onClick={onReset} className="shrink-0 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        Choose another photo
      </button>
    </div>
  )
}

/** A small preview, or a placeholder for formats the browser can't show. */
export function Thumb({ item, className = '', style }: { item: PhotoItem; className?: string; style?: CSSProperties }) {
  if (item.preview === 'none' || item.preview === 'error') {
    return (
      <span className={`inline-flex items-center justify-center bg-zinc-100 text-zinc-400 ring-1 ring-zinc-900/10 dark:bg-zinc-800 ${className}`}>
        <ImageIcon className="size-5" />
      </span>
    )
  }
  return <img src={item.url} alt="" draggable={false} style={style} className={`object-cover ring-1 ring-zinc-900/10 ${className}`} />
}

/** The photos a batch tool is working on, each with what it will become or became, and a place to add more. */
export function PhotoList({ items, onAdd, onSkipped, onRemove, onClear, detail, thumbStyle }: {
  items: PhotoItem[]
  onAdd: (files: File[]) => void
  onSkipped: (files: File[]) => void
  onRemove: (item: PhotoItem) => void
  onClear: () => void
  /** Something about this photo, after its size. */
  detail?: (item: PhotoItem) => ReactNode
  /** How to show the preview, for tools that turn or mirror it. */
  thumbStyle?: CSSProperties
}) {
  const count = items.length
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {count} {count === 1 ? 'photo' : 'photos'}
        </p>
        <button type="button" onClick={onClear} className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
          Clear all
        </button>
      </div>
      <ul className="space-y-2" aria-label="Photos">
        {items.map((item) => (
          <li
            key={item.id}
            className={`flex items-center gap-3 rounded-lg border bg-white p-2 pr-3 dark:bg-zinc-900 ${
              item.preview === 'error' ? 'border-red-300 dark:border-red-900' : 'border-zinc-200 dark:border-zinc-800'
            }`}
          >
            <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden">
              <Thumb item={item} className="max-h-14 max-w-14 object-contain" style={thumbStyle} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">{item.file.name}</p>
              <p className="text-sm text-zinc-500">
                <Describe item={item} />
                {detail && item.preview !== 'error' && <span> {detail(item)}</span>}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onRemove(item)}
              aria-label={`Remove ${item.file.name}`}
              className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <XIcon className="size-4" />
            </button>
          </li>
        ))}
      </ul>
      <Dropzone kind="photo" multiple compact title="Add more photos" onFiles={onAdd} onSkipped={onSkipped} />
    </div>
  )
}

/** "→ 1200 × 800 px · 240 KB" for what a photo came out as. */
export function Outcome({ result }: { result: PhotoResult }) {
  return (
    <span>
      {'→ '}
      <span className="font-medium text-zinc-900 dark:text-zinc-100">
        {result.width > 0 ? `${result.width} × ${result.height} px · ` : ''}
        {formatSize(result.after)}
      </span>
    </span>
  )
}
