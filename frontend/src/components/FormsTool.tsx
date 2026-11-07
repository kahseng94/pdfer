import { useState } from 'react'
import { fillForms, readForms } from '../lib/api'
import { formChanges, type FormField, type FormSchema, type FormValue, type PdfSize } from '../lib/documentTools'
import { pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import { formatSize, type PDFDocumentProxy } from '../lib/pdf'
import { usePdfTask } from '../lib/usePdfTask'
import { useWindowDrop } from '../lib/windowDrop'
import { Dropzone } from './Dropzone'
import { FormFillPage, type FieldFocus } from './FormFillPage'
import { PdfToolPreview } from './PdfToolPreview'
import { Button, DropOverlay, ErrorMessage, FIELD } from './ui'

type Inspection = { schema: FormSchema; sizes: PdfSize[] }

async function inspect(file: File, doc: PDFDocumentProxy, signal: AbortSignal): Promise<Inspection> {
  const schema = await readForms(file, signal)
  const sizes: PdfSize[] = []
  for (let page = 1; page <= doc.numPages; page++) {
    signal.throwIfAborted()
    const view = (await doc.getPage(page)).getViewport({ scale: 1 })
    sizes.push({ width: view.width, height: view.height })
  }
  return { schema, sizes }
}
const initialValues = (schema: FormSchema) => Object.fromEntries(schema.fields.map((field) => [field.id, field.value]))

export function FormsTool({ active = true }: { active?: boolean }) {
  const [values, setValues] = useState<Record<string, FormValue>>({})
  const [flatten, setFlatten] = useState(false)
  const [page, setPage] = useState(1)
  const [previewPage, setPreviewPage] = useState(1)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [focus, setFocus] = useState<FieldFocus | null>(null)
  const task = usePdfTask(inspect, JSON.stringify({ values, flatten }))
  async function open(file: File) {
    setValues({}); setFlatten(false); setPage(1); setPreviewPage(1); setActiveId(null); setFocus(null)
    const data = await task.open(file)
    if (data) setValues(initialValues(data.schema))
  }
  function take(files: File[]) { const [file] = pickFiles(files, 'pdf').wanted; if (file) void open(file) }
  const dragging = useWindowDrop(take, active)
  useReceive('forms', take)
  const overlay = dragging && <DropOverlay label="Drop a PDF with fillable form fields" />
  if (!task.file) return <>{overlay}<Dropzone title="Choose a PDF form to fill" onFiles={take} /><p className="mt-3 text-sm text-zinc-500">Fill existing text fields, checkboxes, radio groups and dropdowns. To make a scanned or flat form fillable, use Create form.</p></>
  const schema = task.data?.schema
  const sizes = task.data?.sizes ?? []
  function change(field: FormField, value: FormValue) { task.invalidate(); setValues((previous) => ({ ...previous, [field.id]: value })) }
  /** Go to the field on its page and put the keyboard in it there. */
  function show(field: FormField, target: number) { setPage(target); setActiveId(field.id); setFocus((previous) => ({ id: field.id, key: (previous?.key ?? 0) + 1 })) }
  return <div className="space-y-5">
    {overlay}
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"><div className="min-w-0"><p className="truncate font-medium">{task.file.name}</p><p className="text-sm text-zinc-500">{formatSize(task.file.size)}{schema && ` · ${schema.fields.length} fields`}</p></div><button type="button" onClick={task.clear} className="shrink-0 text-sm text-zinc-500">Choose another file</button></div>
    {!task.doc && !task.error && <p role="status" className="text-sm text-zinc-500">Reading form fields…</p>}
    {task.error && <ErrorMessage>{task.error}</ErrorMessage>}
    {task.file && !task.doc && task.error && <Button onClick={() => void open(task.file!)}>Retry opening</Button>}
    {schema && task.doc && <>
      {schema.signed && <ErrorMessage>This PDF contains a digital signature. Use an unsigned copy before filling or flattening it.</ErrorMessage>}
      {schema.xfa && !schema.signed && <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">This form also contains Adobe XFA data. The filled copy is saved as a standard PDF form, so Adobe-only scripts and checks in the original are not kept.</p>}
      {!schema.fields.length && <p role="status" className="rounded-lg border border-zinc-200 p-4 text-sm text-zinc-500 dark:border-zinc-800">No fillable fields were found. Use Create form to add fields, or Edit to place text on a flat form.</p>}
      {schema.fields.length > 0 && <fieldset disabled={task.busy || schema.signed} className="space-y-4 disabled:opacity-60">
        <legend className="sr-only">PDF form values</legend>
        <div className="flex items-center justify-between gap-3"><h2 className="font-medium">Form fields</h2><button type="button" onClick={() => { task.invalidate(); setValues(initialValues(schema)); setFlatten(false) }} className="text-sm text-zinc-500 hover:underline">Reset changes</button></div>
        <p className="text-sm text-zinc-500">Fill in the boxes on the page or in the list. Both show the same answers.</p>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 space-y-3">
            {sizes.length > 1 && <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <button type="button" disabled={page <= 1} onClick={() => setPage((n) => n - 1)} className="text-rose-600 disabled:text-zinc-400">Previous page</button>
              <label className="flex items-center gap-2">Page<select aria-label="Form page" value={page} onChange={(e) => setPage(Number(e.target.value))} className={FIELD}>{sizes.map((_, index) => <option key={index} value={index + 1}>{index + 1}</option>)}</select>of {sizes.length}</label>
              <button type="button" disabled={page >= sizes.length} onClick={() => setPage((n) => n + 1)} className="text-rose-600 disabled:text-zinc-400">Next page</button>
            </div>}
            {sizes[page - 1] && <FormFillPage doc={task.doc} page={page} size={sizes[page - 1]} fields={schema.fields} values={values} activeId={activeId} focus={focus} onChange={change} onFocusField={setActiveId} />}
          </div>
          <div className="max-h-[48rem] space-y-3 overflow-y-auto p-1">
            {schema.fields.map((field) => {
              const target = field.boxes?.[0]?.page ?? field.pages[0]
              return <div key={field.id} onFocus={() => setActiveId(field.id)} className={`space-y-2 rounded-lg border bg-white p-3 dark:bg-zinc-900 ${field.id === activeId ? 'border-rose-400 dark:border-rose-700' : 'border-zinc-200 dark:border-zinc-800'}`}>
                <div className="flex items-center justify-between gap-3"><label htmlFor={`form-${field.id}`} className="text-sm font-medium">{field.label}{field.required && <span className="ml-1 text-zinc-500">(required)</span>}</label>{target && <button type="button" onClick={() => show(field, target)} className="shrink-0 text-xs text-rose-600">Show on page {target}</button>}</div>
                <FieldInput field={field} value={values[field.id] ?? field.value} onChange={(value) => change(field, value)} />
                {field.reason && <p className="text-xs text-zinc-500">{field.reason}</p>}
              </div>
            })}
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={flatten} onChange={(e) => { task.invalidate(); setFlatten(e.target.checked) }} className="mt-0.5 accent-rose-600" /><span>Flatten form fields<span className="block text-xs text-zinc-500">Make fields non-editable in the saved copy. Leave this off to keep the form interactive.</span></span></label>
      </fieldset>}
      {schema.fields.length > 0 && <Button disabled={task.busy || schema.signed} onClick={() => { setPreviewPage(page); void task.preview((file, signal) => fillForms(file, formChanges(schema.fields, values), flatten, signal)) }}>{task.busy ? 'Building preview…' : 'Preview filled PDF'}</Button>}
      {task.busy && <button type="button" onClick={task.cancel} className="text-sm text-zinc-500 hover:underline">Cancel preview</button>}
      {task.cancelled && <p role="status" className="text-sm text-zinc-500">Preview cancelled.</p>}
      {task.result && <PdfToolPreview result={task.result} from="forms" page={previewPage} onPage={setPreviewPage} onDismiss={task.dismiss} />}
    </>}
  </div>
}

function FieldInput({ field, value, onChange }: { field: FormField; value: FormValue; onChange: (value: FormValue) => void }) {
  const props = { id: `form-${field.id}`, 'aria-label': field.label, disabled: field.readOnly, className: `${FIELD} block w-full px-3 py-2` }
  if (field.type === 'checkbox') return <input {...props} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-rose-600" />
  if (field.type === 'unsupported') return <p className="text-sm text-zinc-500">Unsupported field</p>
  if (field.type === 'text' && field.multiline) return <textarea {...props} rows={3} maxLength={field.maxLength ?? 5000} value={String(value)} onChange={(e) => onChange(e.target.value)} />
  if (field.type === 'text' || (field.type === 'choice' && field.editable)) return <><input {...props} type="text" list={field.type === 'choice' ? `options-${field.id}` : undefined} maxLength={field.maxLength ?? 5000} value={String(value)} onChange={(e) => onChange(e.target.value)} />{field.type === 'choice' && <datalist id={`options-${field.id}`}>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</datalist>}</>
  return <select {...props} value={String(value)} onChange={(e) => onChange(e.target.value)}>
    <option value="" disabled={field.type === 'radio' && !field.allowEmpty && !!value}>Choose an option</option>
    {!!value && !field.options.some((option) => option.value === value) && <option value={String(value)}>{String(value)}</option>}
    {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>
}
