import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { organizePdf } from '../lib/api'
import { pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import { DEFAULT_ORGANIZE, EMPTY_CROP, POINTS_PER_MM, displayedSize, layoutProblem, pageLayout, type OrganizeItem, type OrganizeSettings, type PageSize } from '../lib/organize'
import { pdfPassword } from '../lib/passwords'
import { closePdf, formatSize, type PDFDocumentProxy } from '../lib/pdf'
import { turn } from '../lib/ranges'
import { useResult } from '../lib/result'
import { usePdfLoader } from '../lib/usePdfLoader'
import { useWindowDrop } from '../lib/windowDrop'
import { checkProjectPages, type ProjectDraft, type ProjectStates } from '../lib/projects'
import { useProject } from '../lib/useProject'
import { ProjectControls } from './ProjectControls'
import { DocumentPreview } from './DocumentPreview'
import { Dropzone } from './Dropzone'
import { CopyIcon, RotateIcon, XIcon } from './icons'
import { PageThumbnail } from './PageThumbnail'
import { PdfCropEditor } from './PdfCropEditor'
import { ResultCard } from './ResultCard'
import { Button, DropOverlay, ErrorMessage, FIELD } from './ui'

type Preview = { file: File; doc: PDFDocumentProxy }
function allPages(total: number): OrganizeItem[] {
  return Array.from({ length: total }, (_, i) => ({ id: crypto.randomUUID(), page: i + 1, rotation: 0 }))
}

export function OrganizeTool({ active = true }: { active?: boolean }) {
  const [file, setFile] = useState<File | null>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [items, setItems] = useState<OrganizeItem[]>([])
  const [sizes, setSizes] = useState<PageSize[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [settings, setSettings] = useState<OrganizeSettings>(DEFAULT_ORGANIZE)
  const [referenceId, setReferenceId] = useState('')
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rendered, setRendered] = useState<PDFDocumentProxy | null>(null)
  const [previewed, setPreviewed] = useState(false)
  const sourceRef = useRef<PDFDocumentProxy | null>(null)
  const previewRef = useRef<PDFDocumentProxy | null>(null)
  const opening = useRef(0)
  const pending = useRef<AbortController | null>(null)
  const loader = usePdfLoader()
  const layout = pageLayout(items, selected, settings)
  const result = useResult<Preview>([file, items, JSON.stringify(layout)])
  const problem = layoutProblem(items, sizes, layout)
  const checkedItems = items.filter((item) => selected.has(item.id))
  const reference = checkedItems.find((item) => item.id === referenceId) ?? checkedItems[0]
  const referenceSize = reference && sizes[reference.page - 1] ? displayedSize(sizes[reference.page - 1], reference.rotation) : null
  const onReady = useCallback((ready: PDFDocumentProxy | null) => setRendered(ready), [])
  const changed = !!doc && (items.length !== doc.numPages || items.some((item, i) => item.page !== i + 1 || item.rotation !== 0) || settings.cropEnabled || settings.resizeEnabled)
  const draft = useMemo<ProjectDraft<'organize'> | null>(() => file && doc ? { tool: 'organize', file, state: { items, selected: [...selected], settings, referenceId } } : null, [file, doc, items, selected, settings, referenceId])
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  useEffect(() => () => {
    opening.current += 1
    pending.current?.abort()
    closePdf(sourceRef.current)
    closePdf(previewRef.current)
  }, [])

  function cancelPreview() {
    pending.current?.abort()
    pending.current = null
    loader.cancel('preview')
    setBusy(false)
  }
  function invalidate() {
    cancelPreview()
    result.clear()
    closePdf(previewRef.current)
    previewRef.current = null
    setRendered(null)
    setError(null)
  }
  function resetPages(total: number) {
    const next = allPages(total)
    setItems(next)
    setSelected(new Set(next.map((item) => item.id)))
    setSettings(DEFAULT_ORGANIZE)
    setReferenceId('')
    setPage(1)
  }
  function resetWorkspace() {
    opening.current += 1
    invalidate()
    loader.cancel()
    closePdf(sourceRef.current)
    sourceRef.current = null
    setDoc(null)
    setFile(null)
    setSizes([])
    resetPages(0)
    setPreviewed(false)
  }
  function chooseAnother() { if (project.canReplace()) { project.reset(); resetWorkspace() } }
  async function open(next: File, saved?: ProjectStates['organize']): Promise<boolean> {
    resetWorkspace()
    const version = opening.current
    setFile(next)
    try {
      const loaded = await loader.load(next)
      if (opening.current !== version) { closePdf(loaded); return false }
      sourceRef.current = loaded
      if (saved) checkProjectPages(saved, loaded.numPages)
      const dimensions: PageSize[] = []
      for (let number = 1; number <= loaded.numPages; number++) {
        const source = await loaded.getPage(number)
        if (opening.current !== version) return false
        const viewport = source.getViewport({ scale: 1 })
        dimensions.push({ width: viewport.width, height: viewport.height })
      }
      setSizes(dimensions)
      setDoc(loaded)
      if (saved) {
        setItems(saved.items); setSelected(new Set(saved.selected)); setSettings(saved.settings); setReferenceId(saved.referenceId)
      } else resetPages(loaded.numPages)
      return true
    } catch (err) {
      if (opening.current === version) {
        closePdf(sourceRef.current)
        sourceRef.current = null
        setError((err as Error).message)
      }
      return false
    }
  }
  const project = useProject('organize', draft, changed || selected.size !== items.length || settings !== DEFAULT_ORGANIZE, (saved) => open(saved.file, saved.state))
  function changeSettings(patch: Partial<OrganizeSettings>) {
    invalidate()
    setSettings((previous) => ({ ...previous, ...patch }))
  }
  function select(ids: Set<string>) { invalidate(); setSelected(ids) }
  function toggle(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else { next.add(id); setReferenceId(id) }
    select(next)
  }
  function rotate(id?: string) {
    invalidate()
    setItems((previous) => previous.map((item) => !id || item.id === id ? { ...item, rotation: turn(item.rotation) } : item))
  }
  function duplicate(item: OrganizeItem) {
    invalidate()
    const copy = { ...item, id: crypto.randomUUID() }
    setItems((previous) => previous.flatMap((entry) => entry.id === item.id ? [entry, copy] : [entry]))
    if (selected.has(item.id)) setSelected(new Set([...selected, copy.id]))
  }
  function remove(id: string) {
    invalidate()
    setItems((previous) => previous.filter((item) => item.id !== id))
    setSelected((previous) => new Set([...previous].filter((key) => key !== id)))
  }
  function onDragEnd({ active, over }: DragEndEvent) {
    if (busy || !over || active.id === over.id) return
    invalidate()
    setItems((previous) => arrayMove(previous, previous.findIndex((item) => item.id === active.id), previous.findIndex((item) => item.id === over.id)))
  }
  async function preview() {
    if (!file || !doc || busy || problem || !items.length) return
    invalidate()
    const controller = new AbortController()
    pending.current = controller
    const finish = result.begin()
    setBusy(true)
    setPreviewed(false)
    try {
      const output = await organizePdf(file, items, layout, controller.signal)
      if (controller.signal.aborted) return
      const loaded = await loader.load(output, 'preview')
      if (controller.signal.aborted || pending.current !== controller) { closePdf(loaded); return }
      previewRef.current = loaded
      setPage(layout?.pages[0] ?? 1)
      setPreviewed(true)
      finish({ file: output, doc: loaded })
    } catch (err) {
      if (!controller.signal.aborted && pending.current === controller) setError((err as Error).message)
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false) }
    }
  }
  function take(files: File[]) {
    const [next] = pickFiles(files, 'pdf').wanted
    if (next && project.canReplace()) { project.reset(); void open(next) }
  }
  const dragging = useWindowDrop(take, active)
  useReceive('organize', take)
  const overlay = dragging && <DropOverlay label="Drop a PDF to organize" />
  if (!file) return <>{overlay}<Dropzone title="Choose a PDF to organize" onFiles={take} /></>
  const total = doc?.numPages ?? 0
  const count = items.length

  return <div className="space-y-5">
    {overlay}
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="min-w-0">
        <p className="truncate font-medium">{file.name}</p>
        <p className="text-sm text-zinc-500">{doc ? `${total} ${total === 1 ? 'page' : 'pages'} · ` : ''}{formatSize(file.size)}</p>
        {doc && pdfPassword(file) && <p className="text-sm text-zinc-500">The output keeps this file’s password.</p>}
      </div>
      <button type="button" onClick={chooseAnother} className="shrink-0 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Choose another file</button>
    </div>
    {!doc && !error && <p role="status" className="text-sm text-zinc-500">Opening PDF…</p>}
    {doc && <>
      <ProjectControls project={project} />
      <fieldset disabled={busy} className="min-w-0 space-y-5 disabled:opacity-60">
        <legend className="sr-only">Organize pages and set crop and size</legend>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{count} {count === 1 ? 'page' : 'pages'} · drag to reorder</p>
          <div className="flex gap-4 text-sm">
            {count > 0 && <button type="button" onClick={() => rotate()} className="text-zinc-500 hover:underline">Rotate all</button>}
            {changed && <button type="button" onClick={() => { invalidate(); resetPages(total); setPreviewed(false) }} className="text-zinc-500 hover:underline">Reset all changes</button>}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <p className="font-medium">{checkedItems.length} of {count} pages selected for crop & resize</p>
          <div className="flex gap-3">
            <button type="button" onClick={() => select(new Set(items.map((item) => item.id)))} className="text-rose-600 hover:underline dark:text-rose-400">Select all</button>
            <button type="button" onClick={() => select(new Set())} className="text-zinc-500 hover:underline">Clear selection</button>
          </div>
        </div>
        {count === 0 ? <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700">Every page has been removed. Reset to bring them back.</p> :
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={items.map((item) => item.id)} strategy={rectSortingStrategy}>
              <ol className="grid max-h-96 grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-3 overflow-y-auto p-1">
                {items.map((item, index) => <PageCard key={item.id} doc={doc} item={item} position={index + 1} selected={selected.has(item.id)} disabled={busy}
                  onSelect={() => toggle(item.id)} onRotate={() => rotate(item.id)} onDuplicate={() => duplicate(item)} onRemove={() => remove(item.id)} />)}
              </ol>
            </SortableContext>
          </DndContext>}
        <div className="space-y-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={settings.cropEnabled} onChange={(e) => changeSettings({ cropEnabled: e.target.checked })} className="size-4 accent-rose-600" />Crop margins</label>
          {settings.cropEnabled && <>
            <p className="text-sm text-zinc-500">Trim from the edges as each page is displayed, after rotation. Cropping hides content outside the retained area; it does not permanently redact it.</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(['top', 'right', 'bottom', 'left'] as const).map((edge) => <DimensionField key={edge} label={`${edge[0].toUpperCase()}${edge.slice(1)} margin (mm)`} value={settings.crop[edge]} min={0}
                onChange={(value) => changeSettings({ crop: { ...settings.crop, [edge]: value } })} />)}
            </div>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <label className="min-w-0 flex-1 space-y-1 text-sm">Crop reference page
                <select aria-label="Crop reference page" value={reference?.id ?? ''} disabled={!reference} onChange={(e) => setReferenceId(e.target.value)} className={`${FIELD} block w-full py-2`}>
                  {!reference && <option value="">Select pages above</option>}
                  {checkedItems.map((item) => <option key={item.id} value={item.id}>Output page {items.indexOf(item) + 1} · source page {item.page}</option>)}
                </select>
              </label>
              <button type="button" onClick={() => changeSettings({ crop: EMPTY_CROP })} className="py-2 text-sm text-rose-600 hover:underline dark:text-rose-400">Clear crop margins</button>
            </div>
            {reference && referenceSize && <>
              <p className="text-sm text-zinc-500">Source size: {(referenceSize.width / POINTS_PER_MM).toFixed(1)} × {(referenceSize.height / POINTS_PER_MM).toFixed(1)} mm</p>
              <PdfCropEditor doc={doc} page={reference.page} rotation={reference.rotation} size={{ width: referenceSize.width / POINTS_PER_MM, height: referenceSize.height / POINTS_PER_MM }} crop={settings.crop} disabled={busy} onChange={(crop) => changeSettings({ crop })} />
            </>}
          </>}
        </div>
        <div className="space-y-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={settings.resizeEnabled} onChange={(e) => changeSettings({ resizeEnabled: e.target.checked })} className="size-4 accent-rose-600" />Resize pages</label>
          {settings.resizeEnabled && <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm">Paper size<select aria-label="Paper size" value={settings.paper} onChange={(e) => changeSettings({ paper: e.target.value as OrganizeSettings['paper'] })} className={`${FIELD} block w-full py-2`}>
                <option value="a4">A4 (210 × 297 mm)</option><option value="letter">Letter (215.9 × 279.4 mm)</option><option value="custom">Custom size</option>
              </select></label>
              {settings.paper !== 'custom' && <label className="space-y-1 text-sm">Orientation<select aria-label="Orientation" value={settings.orientation} onChange={(e) => changeSettings({ orientation: e.target.value as OrganizeSettings['orientation'] })} className={`${FIELD} block w-full py-2`}>
                <option value="portrait">Portrait</option><option value="landscape">Landscape</option>
              </select></label>}
            </div>
            {settings.paper === 'custom' && <div className="grid grid-cols-2 gap-3">
              <DimensionField label="Page width (mm)" value={settings.width} min={1} onChange={(width) => changeSettings({ width })} />
              <DimensionField label="Page height (mm)" value={settings.height} min={1} onChange={(height) => changeSettings({ height })} />
            </div>}
            <p className="text-sm text-zinc-500">Fit the retained content proportionally and center it on the new page. Extra space stays blank. Unchecked pages keep their size and crop.</p>
          </>}
        </div>
      </fieldset>
      {problem && <ErrorMessage>{problem}</ErrorMessage>}
      {previewed && !result.value && !busy && <p role="status" className="text-sm text-zinc-500">Settings changed. Preview the PDF again to download the updated version.</p>}
      <Button onClick={preview} disabled={busy || !!problem || count === 0}>{busy ? 'Building preview…' : count === 0 ? 'Keep at least one page' : 'Preview PDF'}</Button>
      {busy && <button type="button" onClick={cancelPreview} className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">Cancel preview</button>}
      {result.value && <div className="space-y-4 rounded-lg border border-zinc-200 bg-zinc-100/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/50">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">Output preview</h2>
          <div className="flex items-center gap-3 text-sm">
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="text-rose-600 disabled:text-zinc-400">Previous</button>
            <label className="flex items-center gap-2">Page<select aria-label="Output preview page" value={page} onChange={(e) => setPage(Number(e.target.value))} className={`${FIELD} py-1`}>
              {items.map((item, index) => <option key={item.id} value={index + 1}>{index + 1}</option>)}
            </select>of {count}</label>
            <button type="button" disabled={page >= count} onClick={() => setPage((p) => p + 1)} className="text-rose-600 disabled:text-zinc-400">Next</button>
          </div>
        </div>
        <PreviewSize doc={result.value.doc} page={page} />
        <DocumentPreview doc={result.value.doc} page={page} onReady={onReady} />
        {rendered === result.value.doc && <ResultCard file={result.value.file} from="organize" downloadLabel="Download PDF" onDismiss={() => { invalidate(); setPreviewed(false) }}>
          {count} {count === 1 ? 'page' : 'pages'} · This download matches the preview.
        </ResultCard>}
      </div>}
    </>}
    {error && <ErrorMessage>{error}</ErrorMessage>}
  </div>
}

function PreviewSize({ doc, page }: { doc: PDFDocumentProxy; page: number }) {
  const [measured, setMeasured] = useState<{ doc: PDFDocumentProxy; page: number; size: PageSize } | null>(null)
  const size = measured?.doc === doc && measured.page === page ? measured.size : null
  useEffect(() => {
    let cancelled = false
    doc.getPage(page).then((source) => {
      const viewport = source.getViewport({ scale: 1 })
      if (!cancelled) setMeasured({ doc, page, size: { width: viewport.width / POINTS_PER_MM, height: viewport.height / POINTS_PER_MM } })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [doc, page])
  return size && <p className="text-sm text-zinc-500">{size.width.toFixed(1)} × {size.height.toFixed(1)} mm</p>
}
function DimensionField({ label, value, min, onChange }: { label: string; value: number; min: number; onChange: (value: number) => void }) {
  return <label className="space-y-1 text-sm">{label}<input type="number" aria-label={label} value={Number.isFinite(value) ? value : ''} min={min} max={5080} step="0.1" onChange={(e) => onChange(e.target.valueAsNumber)} className={`${FIELD} block w-full px-2 py-2`} /></label>
}
function PageCard({ doc, item, position, selected, disabled, onSelect, onRotate, onDuplicate, onRemove }: {
  doc: PDFDocumentProxy; item: OrganizeItem; position: number; selected: boolean; disabled: boolean
  onSelect: () => void; onRotate: () => void; onDuplicate: () => void; onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled })
  return <li ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }}
    className={`flex flex-col rounded-lg border bg-white p-2 dark:bg-zinc-900 ${isDragging ? 'relative z-10 border-rose-400 shadow-lg' : selected ? 'border-rose-400 ring-1 ring-rose-400/30' : 'border-zinc-200 dark:border-zinc-800'}`}>
    <label className="mb-2 flex cursor-pointer items-center gap-2 text-xs font-medium"><input type="checkbox" checked={selected} onChange={onSelect} aria-label={`Select output page ${position}`} className="size-4 accent-rose-600" />Page {position}</label>
    <button type="button" {...attributes} {...listeners} aria-label={`Move output page ${position}`} className="flex flex-1 cursor-grab touch-none items-center justify-center rounded py-1 active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-rose-600">
      <PageThumbnail doc={doc} pageNumber={item.page} width={90} rotation={item.rotation} />
    </button>
    <p className="mt-2 text-center text-xs text-zinc-500">Source {item.page}{item.rotation > 0 && <span className="ml-1 text-rose-600">+{item.rotation}°</span>}</p>
    <div className="mt-1 flex justify-between gap-1">
      <IconButton label={`Rotate output page ${position}`} onClick={onRotate}><RotateIcon className="size-4" /></IconButton>
      <IconButton label={`Duplicate output page ${position}`} onClick={onDuplicate}><CopyIcon className="size-4" /></IconButton>
      <IconButton label={`Remove output page ${position}`} onClick={onRemove}><XIcon className="size-4" /></IconButton>
    </div>
  </li>
}
function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} aria-label={label} className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200">{children}</button>
}
