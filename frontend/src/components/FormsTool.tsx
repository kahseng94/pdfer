import { useState } from 'react'
import { fillForms, readForms } from '../lib/api'
import { formChanges, type FormField, type FormSchema, type FormValue } from '../lib/documentTools'
import { pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import { formatSize, type PDFDocumentProxy } from '../lib/pdf'
import { usePdfTask } from '../lib/usePdfTask'
import { useWindowDrop } from '../lib/windowDrop'
import { Dropzone } from './Dropzone'
import { PdfPages, PdfToolPreview } from './PdfToolPreview'
import { Button, DropOverlay, ErrorMessage, FIELD } from './ui'

const inspect = (file: File, _doc: PDFDocumentProxy, signal: AbortSignal) => readForms(file, signal)
const initialValues = (schema: FormSchema) => Object.fromEntries(schema.fields.map((field) => [field.id, field.value]))

export function FormsTool({ active = true }: { active?: boolean }) {
  const [values, setValues] = useState<Record<string, FormValue>>({})
  const [flatten, setFlatten] = useState(false)
  const [page, setPage] = useState(1)
  const [original, setOriginal] = useState(false)
  const task = usePdfTask(inspect, JSON.stringify({ values, flatten }))
  async function open(file: File) {
    setValues({}); setFlatten(false); setPage(1); setOriginal(false)
    const schema = await task.open(file)
    if (schema) setValues(initialValues(schema))
  }
  function take(files: File[]) { const [file] = pickFiles(files, 'pdf').wanted; if (file) void open(file) }
  const dragging = useWindowDrop(take, active)
  useReceive('forms', take)
  const overlay = dragging && <DropOverlay label="Drop a PDF with fillable form fields" />
  if (!task.file) return <>{overlay}<Dropzone title="Choose a PDF form to fill" onFiles={take} /><p className="mt-3 text-sm text-zinc-500">Fill existing text fields, checkboxes, radio groups and dropdowns. For a scanned or flat form, use Edit to add text.</p></>
  const schema = task.data
  return <div className="space-y-5">
    {overlay}
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"><div className="min-w-0"><p className="truncate font-medium">{task.file.name}</p><p className="text-sm text-zinc-500">{formatSize(task.file.size)}{schema && ` · ${schema.fields.length} fields`}</p></div><button type="button" onClick={task.clear} className="shrink-0 text-sm text-zinc-500">Choose another file</button></div>
    {!task.doc && !task.error && <p role="status" className="text-sm text-zinc-500">Reading form fields…</p>}
    {task.error && <ErrorMessage>{task.error}</ErrorMessage>}
    {task.file && !task.doc && task.error && <Button onClick={() => void open(task.file!)}>Retry opening</Button>}
    {schema && task.doc && <>
      {schema.signed && <ErrorMessage>This PDF contains a digital signature. Use an unsigned copy before filling or flattening it.</ErrorMessage>}
      {!schema.fields.length && <p role="status" className="rounded-lg border border-zinc-200 p-4 text-sm text-zinc-500 dark:border-zinc-800">No fillable fields were found. Use the Edit tab to place text on a flat form.</p>}
      <fieldset disabled={task.busy || schema.signed} className="space-y-4 disabled:opacity-60">
        <legend className="sr-only">PDF form values</legend>
        <div className="flex items-center justify-between gap-3"><h2 className="font-medium">Form fields</h2><button type="button" onClick={() => { task.invalidate(); setValues(initialValues(schema)); setFlatten(false) }} className="text-sm text-zinc-500 hover:underline">Reset changes</button></div>
        <div className="max-h-[36rem] space-y-3 overflow-y-auto p-1">
          {schema.fields.map((field) => <div key={field.id} className="space-y-2 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center justify-between gap-3"><label htmlFor={`form-${field.id}`} className="text-sm font-medium">{field.label}{field.required && <span className="ml-1 text-zinc-500">(required)</span>}</label>{field.pages[0] && <button type="button" onClick={() => { setPage(field.pages[0]); setOriginal(true) }} className="shrink-0 text-xs text-rose-600">Show page {field.pages[0]}</button>}</div>
            <FieldInput field={field} value={values[field.id] ?? field.value} onChange={(value) => { task.invalidate(); setValues((previous) => ({ ...previous, [field.id]: value })) }} />
            {field.reason && <p className="text-xs text-zinc-500">{field.reason}</p>}
          </div>)}
        </div>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={flatten} onChange={(e) => { task.invalidate(); setFlatten(e.target.checked) }} className="mt-0.5 accent-rose-600" /><span>Flatten form fields<span className="block text-xs text-zinc-500">Make fields non-editable in the saved copy. Leave this off to keep the form interactive.</span></span></label>
      </fieldset>
      <button type="button" aria-expanded={original} onClick={() => setOriginal((value) => !value)} className="text-sm text-rose-600 hover:underline">{original ? 'Hide original PDF' : 'Show original PDF'}</button>
      {original && <PdfPages doc={task.doc} page={page} onPage={setPage} label="Original form" />}
      {schema.fields.length > 0 && <Button disabled={task.busy || schema.signed} onClick={() => void task.preview((file, signal) => fillForms(file, formChanges(schema.fields, values), flatten, signal))}>{task.busy ? 'Building preview…' : 'Preview filled PDF'}</Button>}
      {task.busy && <button type="button" onClick={task.cancel} className="text-sm text-zinc-500 hover:underline">Cancel preview</button>}
      {task.cancelled && <p role="status" className="text-sm text-zinc-500">Preview cancelled.</p>}
      {task.result && <PdfToolPreview result={task.result} from="forms" page={page} onPage={setPage} onDismiss={task.dismiss} />}
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
