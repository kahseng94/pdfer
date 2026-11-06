import { useState } from 'react'
import { readMetadata, writeMetadata } from '../lib/api'
import { pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import { METADATA_FIELDS, METADATA_READ_ONLY, metadataMode, metadataProblem, type MetadataChanges, type MetadataSchema, type MetadataValue } from '../lib/metadata'
import { formatSize, type PDFDocumentProxy } from '../lib/pdf'
import { usePdfTask } from '../lib/usePdfTask'
import { useWindowDrop } from '../lib/windowDrop'
import { Dropzone } from './Dropzone'
import { PdfToolPreview } from './PdfToolPreview'
import { Button, DropOverlay, ErrorMessage, FIELD } from './ui'

const inspect = (file: File, _doc: PDFDocumentProxy, signal: AbortSignal) => readMetadata(file, signal)
const display = (value: string | null, readable: boolean) => !readable ? 'Unavailable' : value === null ? 'Not present' : value === '' ? '(empty)' : value

function StoredValues({ value }: { value: MetadataValue }) {
  return <dl className="grid gap-1 break-words text-xs text-zinc-500 sm:grid-cols-2">
    <div><dt className="font-medium">XMP</dt><dd className="whitespace-pre-wrap">{display(value.xmp, value.xmpReadable)}</dd></div>
    <div><dt className="font-medium">DocumentInfo</dt><dd className="whitespace-pre-wrap">{display(value.documentInfo, value.documentInfoReadable)}</dd></div>
  </dl>
}

function MetadataSummary({ schema }: { schema: MetadataSchema }) {
  return <section aria-label="Output metadata" className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
    <h2 className="font-medium">Metadata in the output PDF</h2>
    <p className="text-sm text-zinc-500">Read back from the generated file. XMP: {schema.hasXmp ? 'present' : 'absent'} · DocumentInfo: {schema.hasDocumentInfo ? 'present' : 'absent'}.</p>
    {[...METADATA_FIELDS, ...METADATA_READ_ONLY].map(({ id, label }) => <div key={id}><h3 className="mb-1 text-sm font-medium">{label}</h3><StoredValues value={schema.fields[id]} /></div>)}
    {schema.warnings.map((warning) => <p key={warning} className="text-sm text-amber-700 dark:text-amber-400">{warning}</p>)}
  </section>
}

export function MetadataTool({ active = true }: { active?: boolean }) {
  const [changes, setChanges] = useState<MetadataChanges>({})
  const [clearAll, setClearAll] = useState(false)
  const [page, setPage] = useState(1)
  const [output, setOutput] = useState<{ file: File; schema: MetadataSchema } | null>(null)
  const task = usePdfTask(inspect, JSON.stringify({ changes, clearAll }))
  function change(next: MetadataChanges) { task.invalidate(); setChanges(next) }
  function reset() { change({}); setClearAll(false) }
  function take(files: File[]) {
    const [file] = pickFiles(files, 'pdf').wanted
    if (file) { reset(); setPage(1); setOutput(null); void task.open(file) }
  }
  async function make(file: File, signal: AbortSignal) {
    const made = await writeMetadata(file, clearAll ? {} : changes, clearAll, signal)
    signal.throwIfAborted()
    const schema = await readMetadata(made, signal)
    signal.throwIfAborted()
    setOutput({ file: made, schema })
    return made
  }
  const dragging = useWindowDrop(take, active)
  useReceive('metadata', take)
  const overlay = dragging && <DropOverlay label="Drop a PDF to edit document metadata" />
  if (!task.file) return <>{overlay}<Dropzone title="Choose a PDF to view or edit metadata" onFiles={take} /><p className="mt-3 text-sm text-zinc-500">Edit title, author, subject and keywords, or clear document metadata in a new copy.</p></>
  const schema = task.data
  const problem = clearAll ? null : metadataProblem(changes)
  return <div className="space-y-5">
    {overlay}
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"><div className="min-w-0"><p className="truncate font-medium">{task.file.name}</p><p className="text-sm text-zinc-500">{formatSize(task.file.size)}</p></div><button type="button" onClick={task.clear} className="shrink-0 text-sm text-zinc-500">Choose another file</button></div>
    {!task.doc && !task.error && <p role="status" className="text-sm text-zinc-500">Reading metadata…</p>}
    {task.error && <ErrorMessage>{task.error}</ErrorMessage>}
    {!task.doc && task.error && <Button onClick={() => take([task.file!])}>Retry opening</Button>}
    {schema && task.doc && <>
      {schema.warnings.map((warning) => <p role="status" key={warning} className="text-sm text-amber-700 dark:text-amber-400">{warning}</p>)}
      <fieldset disabled={task.busy} className="space-y-4 disabled:opacity-60">
        <legend className="sr-only">Document metadata</legend>
        <div className="flex items-center justify-between gap-3"><h2 className="font-medium">Document metadata</h2><button type="button" onClick={reset} className="text-sm text-zinc-500 hover:underline">Reset changes</button></div>
        <p className="text-sm text-zinc-500">Keep original leaves both stored values unchanged. Edit updates XMP and DocumentInfo together; Clear field removes that property from both. Existing differences are shown below.</p>
        <p className="text-xs text-zinc-500">Author edits store one author value. Title and subject edits also update language variants that match the old default; other translations are kept. Clearing a field removes all its translations. Keywords edits affect PDF keywords; separate XMP keyword lists are preserved.</p>
        {METADATA_FIELDS.map(({ id, label }) => {
          const value = schema.fields[id]
          const mode = metadataMode(changes, id)
          return <div key={id} className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex items-center justify-between gap-3"><label htmlFor={`metadata-${id}`} className="text-sm font-medium">{label}</label>
              <select aria-label={`${label} action`} disabled={clearAll || !schema.canEdit} value={mode} onChange={(event) => {
                const next = { ...changes }
                if (event.target.value === 'keep') delete next[id]
                else next[id] = event.target.value === 'clear' ? null : value.value ?? ''
                change(next)
              }} className={`${FIELD} max-w-full py-1 text-sm`}><option value="keep">Keep original</option><option value="edit">Edit</option><option value="clear">Clear field</option></select>
            </div>
            <textarea id={`metadata-${id}`} aria-label={label} rows={2} disabled={clearAll || !schema.canEdit || mode !== 'edit'} value={clearAll || mode === 'clear' ? '' : changes[id] ?? value.value ?? ''} onChange={(event) => change({ ...changes, [id]: event.target.value })} className={`${FIELD} block w-full px-3 py-2 disabled:opacity-60`} />
            {value.conflict && <p className="text-xs text-amber-700 dark:text-amber-400">Stored values differ. Choose Edit to use the displayed XMP value in both, or enter a new value.</p>}
            <StoredValues value={value} />
          </div>
        })}
        <details className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"><summary className="cursor-pointer text-sm font-medium">Creator, producer and dates (read-only)</summary><div className="mt-3 space-y-3">{METADATA_READ_ONLY.map(({ id, label }) => <div key={id}><h3 className="mb-1 text-sm">{label}</h3><StoredValues value={schema.fields[id]} /></div>)}<p className="text-xs text-zinc-500">Dates are shown as stored. These fields stay unchanged during field edits.</p></div></details>
        <div className="space-y-2 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
          <button type="button" disabled={clearAll} onClick={() => { task.invalidate(); setClearAll(true) }} className="text-sm font-medium text-rose-600 disabled:text-zinc-500">Clear document metadata</button>
          <p className="text-sm text-zinc-500">Removes the entire document XMP packet and DocumentInfo dictionary, including custom fields, creator/producer and dates. This does not scrub hidden content elsewhere in the PDF, such as attachments, comments or metadata on pages and images.</p>
          {clearAll && <p role="status" className="text-sm font-medium">Document metadata will be removed in the preview copy. Reset changes to undo.</p>}
        </div>
      </fieldset>
      {problem && <ErrorMessage>{problem}</ErrorMessage>}
      <Button disabled={task.busy || !!problem || (!clearAll && !schema.canEdit)} onClick={() => void task.preview(make)}>{task.busy ? 'Building preview…' : clearAll ? 'Preview PDF without document metadata' : 'Preview metadata changes'}</Button>
      {task.busy && <button type="button" onClick={task.cancel} className="text-sm text-zinc-500">Cancel preview</button>}
      {task.cancelled && <p role="status" className="text-sm text-zinc-500">Preview cancelled.</p>}
      {task.result && output?.file === task.result.file && <><MetadataSummary schema={output.schema} /><PdfToolPreview result={task.result} from="metadata" page={page} onPage={setPage} onDismiss={task.dismiss} /></>}
    </>}
  </div>
}
