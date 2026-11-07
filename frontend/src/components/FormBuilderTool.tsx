import { useEffect, useMemo, useState } from 'react'
import { createFormFields, readForms } from '../lib/api'
import type { FormSchema, PdfSize } from '../lib/documentTools'
import type { Box } from '../lib/edits'
import { builderProblem, FIELD_TYPES, newField, toSpec, TYPE_LABELS, type BuilderTool, type DraftField } from '../lib/formBuilder'
import { pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import { pdfPassword } from '../lib/passwords'
import { formatSize, type PDFDocumentProxy } from '../lib/pdf'
import { useEditHistory } from '../lib/useEditHistory'
import { usePdfTask } from '../lib/usePdfTask'
import { useWindowDrop } from '../lib/windowDrop'
import { Dropzone } from './Dropzone'
import { FormBuilderPage, type FieldEditor } from './FormBuilderPage'
import { PdfToolPreview } from './PdfToolPreview'
import { Button, DropOverlay, ErrorMessage, FIELD } from './ui'

type Inspection = { sizes: PdfSize[]; schema: FormSchema }

async function inspect(file: File, doc: PDFDocumentProxy, signal: AbortSignal): Promise<Inspection> {
  if (doc.numPages > 1000) throw new Error('Split documents longer than 1000 pages before adding form fields.')
  const schema = await readForms(file, signal)
  const sizes: PdfSize[] = []
  for (let page = 1; page <= doc.numPages; page++) {
    signal.throwIfAborted()
    const view = (await doc.getPage(page)).getViewport({ scale: 1 })
    sizes.push({ width: view.width, height: view.height })
  }
  return { sizes, schema }
}

const TOOLBAR: { tool: BuilderTool; label: string }[] = [{ tool: 'select', label: 'Select' }, ...FIELD_TYPES.map(({ type, label }) => ({ tool: type, label }))]

export function FormBuilderTool({ active = true }: { active?: boolean }) {
  const history = useEditHistory<DraftField>()
  const fields = history.elements
  const [tool, setTool] = useState<BuilderTool>('text')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [previewPage, setPreviewPage] = useState(1)
  const task = usePdfTask(inspect, JSON.stringify(fields))
  const { undo, redo, commit, reset } = history
  async function open(file: File) {
    reset(); setTool('text'); setSelectedId(null); setPage(1); setPreviewPage(1)
    await task.open(file)
  }
  function take(files: File[]) { const [file] = pickFiles(files, 'pdf').wanted; if (file) void open(file) }
  const dragging = useWindowDrop(take, active)
  useReceive('form-builder', take)

  const sizes = task.data?.sizes ?? []
  const schema = task.data?.schema
  const existingNames = useMemo(() => schema?.fields.map((field) => field.name) ?? [], [schema])
  const selected = fields.find((field) => field.id === selectedId)
  const locked = task.busy || !!schema?.signed

  useEffect(() => {
    if (!active || !task.doc || locked) return
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]')) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo() }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo() }
      else if (!mod && (e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault(); commit((items) => items.filter((field) => field.id !== selectedId)); setSelectedId(null)
      } else if (e.key === 'Escape') {
        if (tool !== 'select') setTool('select')
        else setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, task.doc, locked, selectedId, tool, undo, redo, commit])

  const overlay = dragging && <DropOverlay label="Drop a PDF to add form fields" />
  if (!task.file) return <>{overlay}<Dropzone title="Choose a PDF to make fillable" onFiles={take} /><p className="mt-3 text-sm text-zinc-500">Draw text boxes, checkboxes, dropdowns and radio buttons on the pages, then preview a fillable PDF.</p></>
  const size = sizes[page - 1]
  const existing = (schema?.fields ?? []).flatMap((field) => (field.boxes ?? []).filter((box) => box.page === page).map((box) => ({ ...box, name: field.name })))
  const problem = schema && fields.length ? builderProblem(fields, existingNames, schema.fields.length, sizes) : null

  const editor: FieldEditor = {
    create(box: Box) {
      if (tool === 'select') return
      const group = tool === 'radio' && selected?.type === 'radio' ? selected.name : undefined
      const field = newField(tool, page, box, fields, existingNames, group)
      commit((items) => [...items, field]); setSelectedId(field.id)
    },
    select: setSelectedId,
    begin: history.begin,
    change: (id, box) => history.change((items) => items.map((field) => field.id === id ? { ...field, ...box } : field)),
    end: history.end,
  }
  /** Name, label and required belong to a whole radio group, so they change on every button in it. */
  function update(patch: Partial<DraftField>, wholeGroup = false) {
    if (!selected) return
    const together = wholeGroup && selected.type === 'radio'
    commit((items) => items.map((field) => field.id === selected.id || (together && field.type === 'radio' && field.name === selected.name) ? { ...field, ...patch } : field))
  }
  function remove(id: string) { commit((items) => items.filter((field) => field.id !== id)); if (id === selectedId) setSelectedId(null) }
  function show(field: DraftField) { setPage(field.page); setSelectedId(field.id); setTool('select') }

  return <div className="space-y-5">
    {overlay}
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"><div className="min-w-0"><p className="truncate font-medium">{task.file.name}</p><p className="text-sm text-zinc-500">{formatSize(task.file.size)} · {fields.length} new {fields.length === 1 ? 'field' : 'fields'}</p></div><button type="button" onClick={task.clear} className="shrink-0 text-sm text-zinc-500">Choose another file</button></div>
    {!task.doc && !task.error && <p role="status" className="text-sm text-zinc-500">Reading PDF pages…</p>}
    {task.error && <ErrorMessage>{task.error}</ErrorMessage>}
    {task.file && !task.doc && task.error && <Button onClick={() => void open(task.file!)}>Retry opening</Button>}
    {task.doc && schema && size && <>
      {schema.signed && <ErrorMessage>This PDF contains a digital signature. Use an unsigned copy before adding form fields.</ErrorMessage>}
      {schema.xfa && !schema.signed && <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">This form also contains Adobe XFA data. The new copy is saved as a standard PDF form, so Adobe-only scripts and checks in the original are not kept.</p>}
      {schema.fields.length > 0 && <p className="text-sm text-zinc-500">This PDF already has {schema.fields.length} form {schema.fields.length === 1 ? 'field' : 'fields'}. They are kept as they are and shown with grey dashed outlines.</p>}
      <fieldset disabled={locked} className="space-y-4 disabled:opacity-60">
        <legend className="sr-only">Form fields to add</legend>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="toolbar" aria-label="Field tools" className="inline-flex flex-wrap rounded-lg bg-zinc-200/70 p-1 dark:bg-zinc-800/70">
            {TOOLBAR.map((item) => <button key={item.tool} type="button" aria-pressed={tool === item.tool} onClick={() => setTool(item.tool)} className={`rounded-md px-2.5 py-1.5 text-sm font-medium ${tool === item.tool ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100' : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'}`}>{item.label}</button>)}
          </div>
          <div className="flex gap-3 text-sm">
            <button type="button" disabled={!history.canUndo} onClick={undo} className="text-zinc-600 hover:underline disabled:text-zinc-300 dark:text-zinc-400 dark:disabled:text-zinc-700">Undo</button>
            <button type="button" disabled={!history.canRedo} onClick={redo} className="text-zinc-600 hover:underline disabled:text-zinc-300 dark:text-zinc-400 dark:disabled:text-zinc-700">Redo</button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <button type="button" disabled={page <= 1} onClick={() => setPage((n) => n - 1)} className="text-rose-600 disabled:text-zinc-400">Previous page</button>
          <label className="flex items-center gap-2">Page<select aria-label="Page to add fields to" value={page} onChange={(e) => setPage(Number(e.target.value))} className={FIELD}>{sizes.map((_, index) => <option key={index} value={index + 1}>{index + 1}</option>)}</select>of {sizes.length}</label>
          <button type="button" disabled={page >= sizes.length} onClick={() => setPage((n) => n + 1)} className="text-rose-600 disabled:text-zinc-400">Next page</button>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_17rem]">
          <FormBuilderPage doc={task.doc} page={page} size={size} fields={fields.filter((field) => field.page === page)} existing={existing} tool={tool} selectedId={selectedId} disabled={locked} editor={editor} />
          <div className="space-y-4">
            {selected ? <FieldProperties field={selected} onChange={update} onRemove={() => remove(selected.id)} /> : <p className="rounded-lg border border-dashed border-zinc-300 p-3 text-sm text-zinc-500 dark:border-zinc-700">Choose a field type, then click or drag on the page. Select a field to name it and change its settings.{tool === 'radio' && ' New radio buttons join the selected radio group.'}</p>}
            {fields.length > 0 && <section aria-label="New fields" className="space-y-2">
              <h2 className="text-sm font-medium">New fields</h2>
              <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
                {fields.map((field) => <li key={field.id} className={`flex items-center justify-between gap-2 rounded px-2 py-1 ${field.id === selectedId ? 'bg-rose-50 dark:bg-rose-950/30' : ''}`}>
                  <button type="button" onClick={() => show(field)} className="min-w-0 truncate text-left hover:underline">{field.type === 'radio' ? `${field.name}: ${field.option}` : field.name}<span className="ml-1 text-xs text-zinc-500">{TYPE_LABELS[field.type]} · page {field.page}</span></button>
                  <button type="button" aria-label={`Delete ${field.name}`} onClick={() => remove(field.id)} className="shrink-0 text-xs text-zinc-500 hover:text-rose-600">Delete</button>
                </li>)}
              </ul>
            </section>}
          </div>
        </div>
      </fieldset>
      {problem && <ErrorMessage>{problem}</ErrorMessage>}
      {pdfPassword(task.file) && <p className="text-sm text-zinc-500">The new copy keeps this PDF’s opening password.</p>}
      <Button disabled={locked || !fields.length || !!problem} onClick={() => { setPreviewPage(page); void task.preview((file, signal) => createFormFields(file, toSpec(fields), signal)) }}>{task.busy ? 'Building preview…' : 'Preview fillable PDF'}</Button>
      {task.busy && <button type="button" onClick={task.cancel} className="text-sm text-zinc-500 hover:underline">Cancel preview</button>}
      {task.cancelled && <p role="status" className="text-sm text-zinc-500">Preview cancelled.</p>}
      {task.result && <PdfToolPreview result={task.result} from="form-builder" page={previewPage} onPage={setPreviewPage} onDismiss={task.dismiss} />}
    </>}
  </div>
}

function FieldProperties({ field, onChange, onRemove }: { field: DraftField; onChange: (patch: Partial<DraftField>, wholeGroup?: boolean) => void; onRemove: () => void }) {
  const input = `${FIELD} block w-full px-2 py-1.5`
  const radio = field.type === 'radio'
  return <section aria-label="Field settings" className="space-y-3 rounded-lg border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
    <h2 className="font-medium">{TYPE_LABELS[field.type]}</h2>
    <label className="block space-y-1">{radio ? 'Group name' : 'Field name'}<input aria-label={radio ? 'Group name' : 'Field name'} value={field.name} maxLength={100} onChange={(e) => onChange({ name: e.target.value }, true)} className={input} /></label>
    {radio && <label className="block space-y-1">This button’s option<input aria-label="Radio option" value={field.option} maxLength={60} onChange={(e) => onChange({ option: e.target.value })} className={input} /></label>}
    <label className="block space-y-1">Label<span className="block text-xs text-zinc-500">Optional. Shown to the person filling the form.</span><input aria-label="Field label" value={field.label} maxLength={200} onChange={(e) => onChange({ label: e.target.value }, true)} className={input} /></label>
    <label className="flex items-center gap-2"><input type="checkbox" checked={field.required} onChange={(e) => onChange({ required: e.target.checked }, true)} className="accent-rose-600" />Required</label>
    {field.type === 'text' && <>
      <label className="flex items-center gap-2"><input type="checkbox" checked={field.multiline} onChange={(e) => onChange({ multiline: e.target.checked })} className="accent-rose-600" />Multiple lines</label>
      <label className="block space-y-1">Maximum length<input aria-label="Maximum length" type="number" min={1} max={5000} step={1} placeholder="No limit" value={field.maxLength === null || Number.isNaN(field.maxLength) ? '' : field.maxLength} onChange={(e) => onChange({ maxLength: e.target.value === '' ? null : e.target.valueAsNumber })} className={input} /></label>
    </>}
    {field.type === 'choice' && <>
      <label className="block space-y-1">Options<span className="block text-xs text-zinc-500">One per line.</span><textarea aria-label="Dropdown options" rows={4} value={field.options.join('\n')} onChange={(e) => onChange({ options: e.target.value.split('\n') })} className={input} /></label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={field.editable} onChange={(e) => onChange({ editable: e.target.checked })} className="accent-rose-600" />Allow custom text</label>
    </>}
    <button type="button" onClick={onRemove} className="text-rose-600 hover:underline">Delete this field</button>
  </section>
}
