import { useState } from 'react'
import { readBookmarks, writeBookmarks } from '../lib/api'
import { bookmarkProblem, indentBookmark, moveBookmark, previousSibling, subtreeEnd, type BookmarkEntry } from '../lib/documentTools'
import { pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import { formatSize, type PDFDocumentProxy } from '../lib/pdf'
import { usePdfTask } from '../lib/usePdfTask'
import { useWindowDrop } from '../lib/windowDrop'
import { Dropzone } from './Dropzone'
import { PdfPages, PdfToolPreview } from './PdfToolPreview'
import { Button, DropOverlay, ErrorMessage, FIELD } from './ui'

const inspect = (file: File, _doc: PDFDocumentProxy, signal: AbortSignal) => readBookmarks(file, signal)

export function BookmarksTool({ active = true }: { active?: boolean }) {
  const [entries, setEntries] = useState<BookmarkEntry[]>([])
  const [page, setPage] = useState(1)
  const [original, setOriginal] = useState(false)
  const task = usePdfTask(inspect, JSON.stringify(entries))
  async function open(file: File) {
    setEntries([]); setPage(1); setOriginal(false)
    const data = await task.open(file)
    if (data) setEntries(data.bookmarks)
  }
  function change(next: BookmarkEntry[]) { task.invalidate(); setEntries(next) }
  function take(files: File[]) { const [file] = pickFiles(files, 'pdf').wanted; if (file) void open(file) }
  const dragging = useWindowDrop(take, active)
  useReceive('bookmarks', take)
  const overlay = dragging && <DropOverlay label="Drop a PDF to edit its bookmarks" />
  if (!task.file) return <>{overlay}<Dropzone title="Choose a PDF to add or edit bookmarks" onFiles={take} /></>
  const total = task.doc?.numPages ?? 0
  const problem = bookmarkProblem(entries, total)
  return <div className="space-y-5">
    {overlay}
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"><div className="min-w-0"><p className="truncate font-medium">{task.file.name}</p><p className="text-sm text-zinc-500">{formatSize(task.file.size)}{task.doc && ` · ${entries.length} bookmarks`}</p></div><button type="button" onClick={task.clear} className="shrink-0 text-sm text-zinc-500">Choose another file</button></div>
    {!task.doc && !task.error && <p role="status" className="text-sm text-zinc-500">Reading bookmarks…</p>}
    {task.error && <ErrorMessage>{task.error}</ErrorMessage>}
    {task.file && !task.doc && task.error && <Button onClick={() => void open(task.file!)}>Retry opening</Button>}
    {task.doc && task.data && <>
      <fieldset disabled={task.busy} className="space-y-4 disabled:opacity-60">
        <legend className="sr-only">Bookmarks</legend>
        <div className="flex flex-wrap justify-between gap-3"><h2 className="font-medium">Document bookmarks</h2><button type="button" onClick={() => change(task.data!.bookmarks)} className="text-sm text-zinc-500 hover:underline">Reset changes</button></div>
        <p className="text-sm text-zinc-500">Move whole sections up or down, and indent to create subsections. Existing links and page positions are retained unless you change their destination.</p>
        {!entries.length && <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">No bookmarks. Add one for the current preview page.</p>}
        <ol className="max-h-[36rem] space-y-3 overflow-y-auto p-1">
          {entries.map((entry, index) => <li key={entry.id} className="space-y-2 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900" style={{ marginLeft: Math.min(entry.level, 5) * 16 }}>
            <div className="flex flex-wrap gap-2">
              <input aria-label={`Bookmark ${index + 1} title`} value={entry.title} maxLength={200} onChange={(e) => change(entries.map((item) => item.id === entry.id ? { ...item, title: e.target.value } : item))} className={`${FIELD} min-w-0 flex-1 px-3 py-2`} />
              <select aria-label={`Bookmark ${index + 1} destination`} value={entry.page ?? ''} onChange={(e) => change(entries.map((item) => item.id === entry.id ? { ...item, page: e.target.value ? Number(e.target.value) : null } : item))} className={`${FIELD} max-w-full py-2`}>
                {entry.page === null && <option value="">Keep existing action</option>}
                {Array.from({ length: total }, (_, i) => <option key={i} value={i + 1}>Page {i + 1}</option>)}
              </select>
            </div>
            <div className="flex flex-wrap gap-3 text-xs">
              <button type="button" aria-label={`Move bookmark ${index + 1} up`} disabled={previousSibling(entries, index) < 0} onClick={() => change(moveBookmark(entries, index, -1))} className="text-zinc-500 hover:underline disabled:opacity-30">Move up</button>
              <button type="button" aria-label={`Move bookmark ${index + 1} down`} disabled={subtreeEnd(entries, index) >= entries.length || entries[subtreeEnd(entries, index)].level !== entry.level} onClick={() => change(moveBookmark(entries, index, 1))} className="text-zinc-500 hover:underline disabled:opacity-30">Move down</button>
              <button type="button" aria-label={`Indent bookmark ${index + 1}`} disabled={previousSibling(entries, index) < 0 || entry.level >= 16} onClick={() => change(indentBookmark(entries, index, 1))} className="text-zinc-500 hover:underline disabled:opacity-30">Indent</button>
              <button type="button" aria-label={`Outdent bookmark ${index + 1}`} disabled={!entry.level} onClick={() => change(indentBookmark(entries, index, -1))} className="text-zinc-500 hover:underline disabled:opacity-30">Outdent</button>
              {entry.page !== null && <button type="button" onClick={() => { setPage(entry.page!); setOriginal(true) }} className="text-rose-600 hover:underline">Go to page {entry.page}</button>}
              <button type="button" aria-label={`Remove bookmark ${index + 1} and its children`} onClick={() => change([...entries.slice(0, index), ...entries.slice(subtreeEnd(entries, index))])} className="text-rose-600 hover:underline">Remove{index + 1 < subtreeEnd(entries, index) ? ' section' : ''}</button>
            </div>
          </li>)}
        </ol>
        <button type="button" disabled={entries.length >= 2000} onClick={() => change([...entries, { id: crypto.randomUUID(), sourceId: null, title: `Page ${page}`, page, level: 0 }])} className="rounded-lg border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700">Add bookmark for page {page}</button>
      </fieldset>
      <button type="button" aria-expanded={original} onClick={() => setOriginal((value) => !value)} className="text-sm text-rose-600 hover:underline">{original ? 'Hide document' : 'Browse document pages'}</button>
      {original && <PdfPages doc={task.doc} page={page} onPage={setPage} label="Bookmark destination" />}
      {problem && <ErrorMessage>{problem}</ErrorMessage>}
      <Button disabled={task.busy || !!problem} onClick={() => void task.preview((file, signal) => writeBookmarks(file, entries, signal))}>{task.busy ? 'Building preview…' : 'Preview PDF with bookmarks'}</Button>
      {task.busy && <button type="button" onClick={task.cancel} className="text-sm text-zinc-500">Cancel preview</button>}
      {task.cancelled && <p role="status" className="text-sm text-zinc-500">Preview cancelled.</p>}
      {task.result && <PdfToolPreview result={task.result} from="bookmarks" page={page} onPage={setPage} onDismiss={task.dismiss} />}
    </>}
  </div>
}
