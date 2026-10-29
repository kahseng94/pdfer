import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useCallback, useEffect, useRef, useState } from 'react'
import { imagesToPdf } from '../lib/api'
import { pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import { imageSize, named } from '../lib/images'
import { DEFAULT_IMAGE_LAYOUT, IMAGE_FITS, effectiveImageLayout, imageLayoutProblem, imageLayoutSummary, type ImagePdfLayout } from '../lib/imageLayout'
import { closePdf, formatSize, type PDFDocumentProxy } from '../lib/pdf'
import { useResult } from '../lib/result'
import { usePdfLoader } from '../lib/usePdfLoader'
import { useWindowDrop } from '../lib/windowDrop'
import { Button, DropOverlay, ErrorMessage, FIELD } from './ui'
import { Dropzone } from './Dropzone'
import { DocumentPreview } from './DocumentPreview'
import { GripIcon, XIcon } from './icons'
import { ResultCard } from './ResultCard'

type Item = {
  id: string
  file: File
  /** Object URL for the preview, revoked when the item goes away. */
  url: string
  size: { width: number; height: number } | null
  error: string | null
}

export function ImagesTool({ active = true }: { active?: boolean }) {
  const [items, setItems] = useState<Item[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [layout, setLayout] = useState<ImagePdfLayout>({ ...DEFAULT_IMAGE_LAYOUT })
  const [page, setPage] = useState(1)
  const [previewed, setPreviewed] = useState(false)
  const [rendered, setRendered] = useState<PDFDocumentProxy | null>(null)
  const previewDoc = useRef<PDFDocumentProxy | null>(null)
  const pending = useRef<AbortController | null>(null)
  const urls = useRef(new Set<string>())
  const loader = usePdfLoader()
  const outputLayout = effectiveImageLayout(layout)
  const problem = imageLayoutProblem(layout)
  const result = useResult<{ file: File; doc: PDFDocumentProxy }>([JSON.stringify(outputLayout), ...items.map((it) => it.file)])
  const onReady = useCallback((ready: PDFDocumentProxy | null) => setRendered(ready), [])

  useEffect(() => () => {
    pending.current?.abort()
    pending.current = null
    closePdf(previewDoc.current)
    for (const url of urls.current) URL.revokeObjectURL(url)
    urls.current.clear()
  }, [])

  function cancelPreview() {
    pending.current?.abort()
    pending.current = null
    loader.cancel()
    setBusy(false)
  }

  function invalidatePreview() {
    cancelPreview()
    result.clear()
    closePdf(previewDoc.current)
    previewDoc.current = null
    setRendered(null)
    setError(null)
  }

  function changeLayout(patch: Partial<ImagePdfLayout>) {
    invalidatePreview()
    setLayout((previous) => ({ ...previous, ...patch }))
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function addFiles(files: File[]) {
    invalidatePreview()
    const added = files.map(
      (file): Item => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file), size: null, error: null }),
    )
    for (const item of added) urls.current.add(item.url)
    setItems((prev) => [...prev, ...added])
    setError(null)
    for (const item of added) {
      // An item removed meanwhile is simply not found by update().
      imageSize(item.url).then(
        (size) => update(item.id, { size }),
        () => update(item.id, { error: 'Can’t read this image.' }),
      )
    }
  }

  function update(id: string, patch: Partial<Item>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)))
  }

  function remove(item: Item) {
    invalidatePreview()
    URL.revokeObjectURL(item.url)
    urls.current.delete(item.url)
    setItems((prev) => prev.filter((it) => it.id !== item.id))
  }

  function clear() {
    invalidatePreview()
    for (const it of items) URL.revokeObjectURL(it.url)
    urls.current.clear()
    setItems([])
    setPage(1)
    setPreviewed(false)
    setError(null)
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return
    invalidatePreview()
    setItems((prev) => {
      const from = prev.findIndex((it) => it.id === active.id)
      const to = prev.findIndex((it) => it.id === over.id)
      return from < 0 || to < 0 ? prev : arrayMove(prev, from, to)
    })
  }

  async function make() {
    if (busy || !items.length || problem || items.some((item) => !item.size || item.error)) return
    invalidatePreview()
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setError(null)
    const finish = result.begin()
    try {
      const file = await imagesToPdf(items.map((it) => it.file), outputLayout, controller.signal)
      if (controller.signal.aborted) return
      const doc = await loader.load(file)
      if (controller.signal.aborted || pending.current !== controller) { closePdf(doc); return }
      previewDoc.current = doc
      setPage((current) => Math.min(current, doc.numPages))
      setPreviewed(true)
      finish({ file, doc })
    } catch (err) {
      if (!controller.signal.aborted && pending.current === controller) setError((err as Error).message)
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false) }
    }
  }

  function take(files: File[]) {
    const { wanted } = pickFiles(files, 'image')
    if (wanted.length) addFiles(wanted)
  }

  const dragging = useWindowDrop(take, active)
  useReceive('images', take)

  // Paste adds images while this tab is showing, unless the paste is meant for a text field.
  const add = useRef(addFiles)
  useEffect(() => {
    add.current = addFiles
  })
  useEffect(() => {
    if (!active) return
    function onPaste(e: ClipboardEvent) {
      if ((e.target as Element | null)?.closest?.('input, textarea, [contenteditable]')) return
      const { wanted } = pickFiles(e.clipboardData?.files ?? [], 'image')
      if (!wanted.length) return
      e.preventDefault()
      add.current(wanted.map(named))
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [active])

  const unreadable = items.filter((it) => it.error).length
  const loading = items.some((it) => !it.size && !it.error)
  const count = items.length
  const empty = count === 0

  // The dropzone stays in the same place in the tree so its "skipped" notice
  // survives the switch from the empty state to the list.
  return (
    <div className="space-y-4">
      {dragging && <DropOverlay label="Drop images to add" />}
      {!empty && (
        <>
          <div className="flex items-baseline justify-between">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {count} {count === 1 ? 'image' : 'images'} · drag to reorder
            </p>
            <button
              type="button"
              onClick={clear}
              className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            >
              Clear all
            </button>
          </div>

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={items} strategy={verticalListSortingStrategy}>
              <ol className="space-y-2">
                {items.map((item, i) => (
                  <ImageRow key={item.id} item={item} position={i + 1} onRemove={() => remove(item)} />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        </>
      )}

      <Dropzone
        kind="image"
        multiple
        compact={!empty}
        title={empty ? 'Choose images to turn into a PDF' : 'Add more images'}
        onFiles={addFiles}
      />
      <p className="text-center text-sm text-zinc-500">You can also paste an image.</p>

      {!empty && (
        <>
          <fieldset className="space-y-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <legend className="px-1 font-medium">PDF page layout</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="space-y-1 text-sm">Paper size
                <select aria-label="Paper size" value={layout.paper} onChange={(e) => changeLayout({ paper: e.target.value as ImagePdfLayout['paper'] })} className={`${FIELD} block w-full py-2`}>
                  <option value="a4">A4 · 210 × 297 mm</option><option value="letter">Letter · 8.5 × 11 in</option><option value="image">Image size · original</option>
                </select>
              </label>
              {layout.paper !== 'image' && <>
                <label className="space-y-1 text-sm">Orientation
                  <select aria-label="Orientation" value={layout.orientation} onChange={(e) => changeLayout({ orientation: e.target.value as ImagePdfLayout['orientation'] })} className={`${FIELD} block w-full py-2`}>
                    <option value="portrait">Portrait</option><option value="landscape">Landscape</option>
                  </select>
                </label>
                <label className="space-y-1 text-sm">Margins (mm)
                  <input aria-label="Margins (mm)" type="number" min={0} max={100} step={1} value={Number.isNaN(layout.marginMm) ? '' : layout.marginMm} onChange={(e) => changeLayout({ marginMm: e.target.valueAsNumber })} aria-describedby="image-margins-hint" className={`${FIELD} block w-full px-2 py-2`} />
                </label>
              </>}
            </div>
            {layout.paper !== 'image' ? <>
              <p id="image-margins-hint" className="text-sm text-zinc-500">Margins apply equally to all four sides. Use 0 mm for no margins.</p>
              <fieldset>
                <legend className="mb-2 text-sm font-medium">Image fitting</legend>
                <div className="grid gap-2 sm:grid-cols-3">
                  {IMAGE_FITS.map((fit) => <label key={fit.value} className={`cursor-pointer rounded-lg border px-3 py-2.5 has-focus-visible:outline-2 has-focus-visible:outline-rose-600 ${layout.fit === fit.value ? 'border-rose-500 bg-rose-50 dark:bg-rose-950/30' : 'border-zinc-200 dark:border-zinc-800'}`}>
                    <input type="radio" name="image-pdf-fit" aria-label={fit.label} checked={layout.fit === fit.value} onChange={() => changeLayout({ fit: fit.value })} className="sr-only" />
                    <span className="block text-sm font-medium">{fit.label}</span><span className="block text-sm text-zinc-500">{fit.hint}</span>
                  </label>)}
                </div>
              </fieldset>
              <p className="text-sm text-zinc-500">Images are centered on the page. Their original pixels and transparency are preserved.</p>
            </> : <p className="text-sm text-zinc-500">Each page follows the image’s own size and resolution. Choose A4 or Letter to set orientation, margins and fitting.</p>}
          </fieldset>
          {!problem && <p className="text-sm text-zinc-500">{imageLayoutSummary(outputLayout)} · One page per image</p>}
          {problem && <ErrorMessage>{problem}</ErrorMessage>}
          {loading && <p role="status" className="text-sm text-zinc-500">Loading images…</p>}
          {unreadable > 0 && (
            <ErrorMessage>
              Remove the {unreadable === 1 ? 'image' : `${unreadable} images`} that can’t be read first.
            </ErrorMessage>
          )}
          {error && <ErrorMessage>{error}</ErrorMessage>}
          <Button onClick={make} disabled={busy || unreadable > 0 || loading || !!problem}>
            {busy ? 'Building preview…' : previewed ? 'Update preview' : 'Preview PDF'}
          </Button>
          {busy && <button type="button" onClick={cancelPreview} className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">Cancel preview</button>}
          <p className="text-sm text-zinc-500">{result.value ? 'This is the exact PDF that Download PDF will save.' : 'Preview the PDF before downloading. Changing the images, order or layout requires an updated preview.'}</p>
        </>
      )}
      {result.value && <>
        <section aria-label="Image PDF preview" className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-100 p-3 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium">PDF preview</h2>
            <div className="flex items-center gap-2 text-sm">
              <button type="button" aria-label="Previous image page" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border border-zinc-300 px-2 py-1 disabled:opacity-40 dark:border-zinc-700">Previous</button>
              <select aria-label="Image preview page" value={page} onChange={(e) => setPage(Number(e.target.value))} className={FIELD}>{Array.from({ length: result.value.doc.numPages }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} / {result.value!.doc.numPages}</option>)}</select>
              <button type="button" aria-label="Next image page" disabled={page >= result.value.doc.numPages} onClick={() => setPage(page + 1)} className="rounded border border-zinc-300 px-2 py-1 disabled:opacity-40 dark:border-zinc-700">Next</button>
            </div>
          </div>
          <p className="truncate text-xs text-zinc-500">{items[page - 1]?.file.name}</p>
          <DocumentPreview doc={result.value.doc} page={page} onReady={onReady} />
        </section>
        {rendered === result.value.doc && <ResultCard file={result.value.file} from="images" onDismiss={() => { invalidatePreview(); setPreviewed(false) }} downloadLabel="Download PDF">
          {result.value.doc.numPages} {result.value.doc.numPages === 1 ? 'page' : 'pages'} · {imageLayoutSummary(outputLayout)}
        </ResultCard>}
      </>}
    </div>
  )
}

function ImageRow({ item, position, onRemove }: { item: Item; position: number; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id })

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-3 rounded-lg border bg-white p-2 pr-3 dark:bg-zinc-900 ${
        isDragging
          ? 'relative z-10 border-rose-400 shadow-lg'
          : item.error
            ? 'border-red-300 dark:border-red-900'
            : 'border-zinc-200 dark:border-zinc-800'
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Move ${item.file.name}`}
        className="cursor-grab touch-none rounded p-1 text-zinc-400 hover:text-zinc-700 active:cursor-grabbing dark:hover:text-zinc-200"
      >
        <GripIcon className="size-5" />
      </button>
      <span className="w-5 text-right text-sm tabular-nums text-zinc-400">{position}</span>
      <div className="flex h-14 w-10 shrink-0 items-center justify-center">
        {!item.error && <img src={item.url} alt="" className="max-h-14 max-w-10 shadow-sm ring-1 ring-zinc-900/10" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">{item.file.name}</p>
        <p className={`text-sm ${item.error ? 'text-red-600 dark:text-red-400' : 'text-zinc-500'}`}>
          {item.error ??
            [item.size && `${item.size.width} × ${item.size.height}`, formatSize(item.file.size)].filter(Boolean).join(' · ')}
        </p>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${item.file.name}`}
        className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
      >
        <XIcon className="size-4" />
      </button>
    </li>
  )
}
