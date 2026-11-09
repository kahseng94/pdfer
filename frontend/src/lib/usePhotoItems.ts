// The photos a tool is working on: how they arrive (drop, paste, pick, hand-off), how they load, and what a batch can do.

import { useEffect, useRef, useState } from 'react'
import { pickFiles } from './files'
import { useReceive } from './handoff'
import { imageSize, named } from './images'
import { formatSize } from './pdf'
import type { Size } from './photo'
import type { PhotoResult } from './photoEdits'
import type { ToolId } from './tools'
import { useWindowDrop } from './windowDrop'

export type PhotoItem = {
  id: string
  file: File
  /** Object URL for the preview, revoked when the item goes away. */
  url: string
  /** Pixel size as the browser shows it; null until it has loaded, or for ever when the browser can't show it. */
  size: Size | null
  /** `none`: a format the backend reads but browsers don't show. `error`: a picture that can't be read at all. */
  preview: 'loading' | 'ready' | 'none' | 'error'
}

/** Whether the browser can decode this format; the backend reads TIFF and HEIC (iPhone photos), browsers don't. */
export function browserShows(file: File): boolean {
  return !(/^image\/(tiff|heic|heif)$/.test(file.type) || /\.(tiff?|heic|heif)$/i.test(file.name))
}

/**
 * Files arrive from the dropzone, a drop anywhere in the window, a paste
 * while the tool is showing, or another tool's result. With `single`, a new
 * photo replaces the old one.
 */
export function usePhotoItems(tool: ToolId, active: boolean, options: { single?: boolean } = {}) {
  const [items, setItems] = useState<PhotoItem[]>([])
  const [skipped, setSkipped] = useState(0)
  const urls = useRef(new Set<string>())
  const single = options.single ?? false

  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url)
      urls.current.clear()
    },
    [],
  )

  function release(list: PhotoItem[]) {
    for (const item of list) {
      URL.revokeObjectURL(item.url)
      urls.current.delete(item.url)
    }
  }

  function update(id: string, patch: Partial<PhotoItem>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)))
  }

  function add(files: File[]) {
    const { wanted, skipped } = pickFiles(files, 'photo')
    setSkipped(skipped)
    if (!wanted.length) return
    const chosen = single ? wanted.slice(0, 1) : wanted
    const added = chosen.map(
      (file): PhotoItem => ({
        id: crypto.randomUUID(),
        file,
        url: URL.createObjectURL(file),
        size: null,
        preview: browserShows(file) ? 'loading' : 'none',
      }),
    )
    for (const item of added) urls.current.add(item.url)
    setItems((prev) => {
      if (!single) return [...prev, ...added]
      release(prev)
      return added
    })
    for (const item of added) {
      if (item.preview === 'none') continue
      // An item removed meanwhile is simply not found by update().
      imageSize(item.url).then(
        (size) => update(item.id, { size, preview: 'ready' }),
        () => update(item.id, { preview: 'error' }),
      )
    }
  }

  /** The dropzone already keeps other kinds of file out; this just counts them for the notice. */
  function noteSkipped(files: File[]) {
    setSkipped(files.length)
  }

  function remove(item: PhotoItem) {
    release([item])
    setItems((prev) => prev.filter((it) => it.id !== item.id))
  }

  function clear() {
    setItems((prev) => {
      release(prev)
      return []
    })
    setSkipped(0)
  }

  const dragging = useWindowDrop(add, active)
  useReceive(tool, add)

  // Paste adds photos while this tab is showing, unless the paste is meant for a text field.
  const addLatest = useRef(add)
  useEffect(() => {
    addLatest.current = add
  })
  useEffect(() => {
    if (!active) return
    function onPaste(e: ClipboardEvent) {
      if ((e.target as Element | null)?.closest?.('input, textarea, [contenteditable]')) return
      const { wanted } = pickFiles(e.clipboardData?.files ?? [], 'photo')
      if (!wanted.length) return
      e.preventDefault()
      addLatest.current(wanted.map(named))
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [active])

  return { items, add, noteSkipped, remove, clear, dragging, skipped }
}

/** The one photo of a single-photo tool, or null before one is chosen. */
export function onlyItem(items: PhotoItem[]): PhotoItem | null {
  return items[0] ?? null
}

/** Which photos can be sent: those the browser could read or can't show, but not ones that are broken. */
export function readyItems(items: PhotoItem[]): PhotoItem[] {
  return items.filter((it) => it.preview === 'ready' || it.preview === 'none')
}

/** Why the batch can't run yet, or null. */
export function batchProblem(items: PhotoItem[]): string | null {
  const broken = items.filter((it) => it.preview === 'error').length
  return broken ? `Remove the ${broken === 1 ? 'photo' : `${broken} photos`} that can’t be read first.` : null
}

/** One line about what came out: the one photo's size, or how many there are and how big together. */
export function totalLine(results: Iterable<PhotoResult>, what: string): string {
  const list = [...results]
  if (list.length === 1) {
    const [only] = list
    return `${only.width > 0 ? `${only.width} × ${only.height} px · ` : ''}${formatSize(only.after)}`
  }
  const after = list.reduce((sum, r) => sum + r.after, 0)
  return `${list.length} photos ${what} · ${formatSize(after)} in a ZIP`
}
