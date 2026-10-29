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
import { useRef, useState } from 'react'
import { mergePdfs } from '../lib/api'
import { pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import { closePdf, formatSize, type PDFDocumentProxy } from '../lib/pdf'
import { pdfPassword } from '../lib/passwords'
import { usePdfLoader } from '../lib/usePdfLoader'
import { useResult } from '../lib/result'
import { useWindowDrop } from '../lib/windowDrop'
import { Button, DropOverlay, ErrorMessage } from './ui'
import { Dropzone } from './Dropzone'
import { GripIcon, XIcon } from './icons'
import { PageThumbnail } from './PageThumbnail'
import { ResultCard } from './ResultCard'

type Item = {
  id: string
  file: File
  doc: PDFDocumentProxy | null
  error: string | null
}

export function MergeTool({ active = true }: { active?: boolean }) {
  const [items, setItems] = useState<Item[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const result = useResult<File>(items.map((it) => it.file))
  // Files removed while their preview was still loading; their docs get destroyed on arrival.
  const removed = useRef(new Set<string>())
  const loader = usePdfLoader()

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function addFiles(files: File[]) {
    const added = files.map((file) => ({ id: crypto.randomUUID(), file, doc: null, error: null }))
    setItems((prev) => [...prev, ...added])
    setError(null)
    for (const item of added) {
      loader.load(item.file, item.id).then(
        (doc) => (removed.current.has(item.id) ? closePdf(doc) : update(item.id, { doc })),
        (err: Error) => update(item.id, { error: err.message }),
      )
    }
  }

  function update(id: string, patch: Partial<Item>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)))
  }

  function discard(item: Item) {
    removed.current.add(item.id)
    loader.cancel(item.id)
    closePdf(item.doc)
  }

  function remove(item: Item) {
    discard(item)
    setItems((prev) => prev.filter((it) => it.id !== item.id))
  }

  function clear() {
    items.forEach(discard)
    setItems([])
    setError(null)
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return
    setItems((prev) => {
      const from = prev.findIndex((it) => it.id === active.id)
      const to = prev.findIndex((it) => it.id === over.id)
      return arrayMove(prev, from, to)
    })
  }

  async function merge() {
    setBusy(true)
    setError(null)
    const finish = result.begin()
    try {
      finish(await mergePdfs(items.map((it) => it.file)))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function take(files: File[]) {
    const { wanted } = pickFiles(files, 'pdf')
    if (wanted.length) addFiles(wanted)
  }

  const dragging = useWindowDrop(take, active)
  useReceive('merge', take)

  const unreadable = items.filter((it) => it.error).length
  const totalPages = items.reduce((n, it) => n + (it.doc?.numPages ?? 0), 0)
  const protectedInput = items.find((it) => it.doc && pdfPassword(it.file))

  const empty = items.length === 0

  // The dropzone stays in the same place in the tree so its "skipped" notice
  // survives the switch from the empty state to the file list.
  return (
    <div className="space-y-4">
      {dragging && <DropOverlay label="Drop PDFs to merge" />}
      {!empty && (
        <>
          <div className="flex items-baseline justify-between">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {items.length} {items.length === 1 ? 'file' : 'files'}
              {totalPages > 0 && ` · ${totalPages} pages`} · drag to reorder
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
                  <FileRow key={item.id} item={item} position={i + 1} onRemove={() => remove(item)} />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        </>
      )}

      <Dropzone
        multiple
        compact={!empty}
        title={empty ? 'Choose PDFs to merge' : 'Add more PDFs'}
        onFiles={addFiles}
      />

      {!empty && (
        <>
          {unreadable > 0 && (
            <ErrorMessage>
              Remove the {unreadable === 1 ? 'file' : `${unreadable} files`} that can’t be read before merging.
            </ErrorMessage>
          )}
          {error && <ErrorMessage>{error}</ErrorMessage>}
          {protectedInput && <p className="text-sm text-zinc-500">The merged PDF will use the password for {protectedInput.file.name}.</p>}
          {result.value && <ResultCard file={result.value} from="merge" onDismiss={result.clear} />}

          <Button onClick={merge} disabled={busy || items.length < 2 || items.some((it) => !it.doc)}>
            {busy ? 'Merging…' : items.length < 2 ? 'Add at least two PDFs' : `Merge ${items.length} PDFs`}
          </Button>
        </>
      )}
    </div>
  )
}

function FileRow({ item, position, onRemove }: { item: Item; position: number; onRemove: () => void }) {
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
        {item.doc && <PageThumbnail doc={item.doc} pageNumber={1} width={40} />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">{item.file.name}</p>
        <p className={`text-sm ${item.error ? 'text-red-600 dark:text-red-400' : 'text-zinc-500'}`}>
          {item.error ??
            [item.doc && `${item.doc.numPages} ${item.doc.numPages === 1 ? 'page' : 'pages'}`, formatSize(item.file.size)]
              .filter(Boolean)
              .join(' · ')}
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
