import { useState } from 'react'
import type { PdfSize, Redaction } from '../lib/documentTools'
import { pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import { pdfPassword } from '../lib/passwords'
import { formatSize, type PDFDocumentProxy } from '../lib/pdf'
import { REDACTION_DPI, redactionProblem, renderRedactedPdf, type RedactionProgress } from '../lib/redactions'
import { usePdfTask } from '../lib/usePdfTask'
import { useWindowDrop } from '../lib/windowDrop'
import { Dropzone } from './Dropzone'
import { PdfToolPreview } from './PdfToolPreview'
import { RedactionPage } from './RedactionPage'
import { Button, DropOverlay, ErrorMessage, FIELD } from './ui'

async function inspect(_file: File, doc: PDFDocumentProxy, signal: AbortSignal): Promise<{ sizes: PdfSize[] }> {
  if (doc.numPages > 1000) throw new Error('Split documents longer than 1000 pages before redacting.')
  const sizes: PdfSize[] = []
  for (let page = 1; page <= doc.numPages; page++) {
    signal.throwIfAborted()
    const source = await doc.getPage(page)
    const view = source.getViewport({ scale: 1 })
    sizes.push({ width: view.width, height: view.height })
  }
  return { sizes }
}

export function RedactTool({ active = true }: { active?: boolean }) {
  const [areas, setAreas] = useState<Redaction[]>([])
  const [page, setPage] = useState(1)
  const [dpi, setDpi] = useState(150)
  const [selectedId, setSelectedId] = useState('')
  const [progress, setProgress] = useState<RedactionProgress | null>(null)
  const task = usePdfTask(inspect, JSON.stringify({ areas, dpi }))
  async function open(file: File) { setAreas([]); setPage(1); setSelectedId(''); setProgress(null); await task.open(file) }
  function change(next: Redaction[]) { task.invalidate(); setAreas(next) }
  function take(files: File[]) { const [file] = pickFiles(files, 'pdf').wanted; if (file) void open(file) }
  const dragging = useWindowDrop(take, active)
  useReceive('redact', take)
  const overlay = dragging && <DropOverlay label="Drop a PDF to redact permanently" />
  if (!task.file) return <>{overlay}<Dropzone title="Choose a PDF to redact permanently" onFiles={take} /><p className="mt-3 text-sm text-zinc-500">Mark areas for removal, then preview a new image-based PDF.</p></>
  const sizes = task.data?.sizes ?? []
  const size = sizes[page - 1]
  const currentAreas = areas.filter((area) => area.page === page)
  const selected = currentAreas.find((area) => area.id === selectedId) ?? currentAreas[0]
  const problem = redactionProblem(areas, sizes)
  function add(area: Redaction) { change([...areas, area]); setSelectedId(area.id) }
  return <div className="space-y-5">
    {overlay}
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"><div className="min-w-0"><p className="truncate font-medium">{task.file.name}</p><p className="text-sm text-zinc-500">{formatSize(task.file.size)} · {areas.length} redaction areas</p></div><button type="button" onClick={task.clear} className="shrink-0 text-sm text-zinc-500">Choose another file</button></div>
    <p className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">The export is rebuilt as page images after masking the marked areas. Original text, hidden content, attachments and metadata are removed. Text selection, links, form fields and bookmarks are also removed. All pages remain in the copy.</p>
    {!task.doc && !task.error && <p role="status" className="text-sm text-zinc-500">Reading PDF pages…</p>}
    {task.error && <ErrorMessage>{task.error}</ErrorMessage>}
    {task.file && !task.doc && task.error && <Button onClick={() => void open(task.file!)}>Retry opening</Button>}
    {task.doc && size && <>
      <fieldset disabled={task.busy} className="space-y-4 disabled:opacity-60">
        <legend className="sr-only">Redaction areas and resolution</legend>
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <button type="button" disabled={page <= 1} onClick={() => setPage((n) => n - 1)} className="text-rose-600 disabled:text-zinc-400">Previous page</button>
          <label className="flex items-center gap-2">Page<select aria-label="Page to redact" value={page} onChange={(e) => setPage(Number(e.target.value))} className={FIELD}>{sizes.map((_, index) => <option key={index} value={index + 1}>{index + 1}</option>)}</select>of {sizes.length}</label>
          <button type="button" disabled={page >= sizes.length} onClick={() => setPage((n) => n + 1)} className="text-rose-600 disabled:text-zinc-400">Next page</button>
        </div>
        <p className="text-sm text-zinc-500">Drag rectangles over content to remove. Use the controls below to adjust or remove an area.</p>
        <RedactionPage doc={task.doc} page={page} size={size} areas={currentAreas} disabled={task.busy} onAdd={add} />
        <div className="flex flex-wrap gap-3 text-sm">
          <button type="button" disabled={areas.length >= 2000} onClick={() => add({ id: crypto.randomUUID(), page, x: size.width / 4, y: size.height / 4, width: size.width / 2, height: Math.max(1, size.height / 12) })} className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700">Add area with controls</button>
          <button type="button" disabled={!areas.length} onClick={() => change(areas.slice(0, -1))} className="text-zinc-500 disabled:opacity-30">Undo last area</button>
          <button type="button" disabled={!areas.length} onClick={() => change([])} className="text-zinc-500 disabled:opacity-30">Clear all areas</button>
        </div>
        {currentAreas.length > 0 && <label className="block space-y-1 text-sm">Area on this page<select aria-label="Redaction area to adjust" value={selected?.id ?? ''} onChange={(e) => setSelectedId(e.target.value)} className={`${FIELD} block w-full py-2`}>{currentAreas.map((area, index) => <option key={area.id} value={area.id}>Area {index + 1}</option>)}</select></label>}
        {selected && <div className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{(['x', 'y', 'width', 'height'] as const).map((key) => <label key={key} className="space-y-1 text-sm">{key === 'x' ? 'Left' : key === 'y' ? 'Top' : key === 'width' ? 'Width' : 'Height'} (pt)<input aria-label={`Redaction ${key}`} type="number" min={key === 'x' || key === 'y' ? 0 : 1} step={0.1} value={Number.isFinite(selected[key]) ? Number(selected[key].toFixed(2)) : ''} onChange={(e) => change(areas.map((area) => area.id === selected.id ? { ...area, [key]: e.target.valueAsNumber } : area))} className={`${FIELD} block w-full px-2 py-2`} /></label>)}</div>
          <button type="button" onClick={() => change(areas.filter((area) => area.id !== selected.id))} className="text-sm text-rose-600 hover:underline">Remove this area</button>
        </div>}
        <label className="block space-y-1 text-sm">Output resolution<select aria-label="Redacted PDF resolution" value={dpi} onChange={(e) => { task.invalidate(); setDpi(Number(e.target.value)) }} className={`${FIELD} block w-full py-2`}>{REDACTION_DPI.map((value) => <option key={value} value={value}>{value} DPI{value === 72 ? ' · smaller file' : value === 150 ? ' · standard' : ' · sharper text, larger file'}</option>)}</select></label>
      </fieldset>
      {areas.length > 0 && problem && <ErrorMessage>{problem}</ErrorMessage>}
      {pdfPassword(task.file) && <p className="text-sm text-zinc-500">The redacted copy keeps this PDF’s opening password.</p>}
      {task.busy && progress && <div className="space-y-2 text-sm"><p role="status">{progress.phase === 'build' ? 'Building the redacted PDF…' : `Rendering page ${progress.completed + 1} of ${progress.total}…`}</p><progress aria-label="Redaction progress" value={progress.completed} max={progress.total} className="h-2 w-full accent-rose-600" /></div>}
      <Button disabled={task.busy || !!problem} onClick={() => { setProgress(null); void task.preview((file, signal) => renderRedactedPdf(task.doc!, file, areas, sizes, dpi, signal, setProgress)) }}>{task.busy ? 'Building redacted PDF…' : 'Build permanently redacted PDF'}</Button>
      {task.busy && <button type="button" onClick={task.cancel} className="text-sm text-zinc-500">Cancel redaction</button>}
      {task.cancelled && <p role="status" className="text-sm text-zinc-500">Redaction cancelled. No download was created.</p>}
      {task.result && <PdfToolPreview result={task.result} from="redact" page={page} onPage={setPage} onDismiss={task.dismiss} />}
    </>}
  </div>
}
