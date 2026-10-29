import { useCallback, useEffect, useState } from 'react'
import { closePdf, formatSize, type PDFDocumentProxy } from '../lib/pdf'
import { usePdfLoader } from '../lib/usePdfLoader'
import type { WorkflowBatch } from '../lib/workflows'
import { DocumentPreview } from './DocumentPreview'
import { ResultCard } from './ResultCard'
import { ErrorMessage, FIELD } from './ui'

export function WorkflowResults({ batch, onDismiss }: { batch: WorkflowBatch; onDismiss: () => void }) {
  const [index, setIndex] = useState(0)
  const [page, setPage] = useState(1)
  const [loaded, setLoaded] = useState<{ file: File; doc: PDFDocumentProxy } | null>(null)
  const [failure, setFailure] = useState<{ file: File; message: string } | null>(null)
  const [rendered, setRendered] = useState<PDFDocumentProxy | null>(null)
  const { load, cancel } = usePdfLoader()
  const file = batch.outputs[index].file
  const doc = loaded?.file === file ? loaded.doc : null
  const error = failure?.file === file && !doc ? failure.message : null
  const onReady = useCallback((ready: PDFDocumentProxy | null) => setRendered(ready), [])

  function selectResult(next: number) {
    if (next !== index) {
      setLoaded(null)
      setFailure(null)
      setRendered(null)
      setIndex(next)
    }
    setPage(1)
  }

  useEffect(() => {
    let cancelled = false
    let opened: PDFDocumentProxy | null = null
    load(file, 'workflow-result').then((next) => {
      if (cancelled) { closePdf(next); return }
      opened = next
      setLoaded({ file, doc: next })
    }, (reason: Error) => { if (!cancelled) setFailure({ file, message: reason.message }) })
    return () => { cancelled = true; cancel('workflow-result'); closePdf(opened) }
  }, [file, load, cancel])

  return <section aria-label="Workflow results" className="space-y-4 rounded-lg border border-zinc-200 bg-zinc-100/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/50">
    <div className="flex items-center justify-between gap-3"><h2 className="font-medium">Workflow complete</h2><button type="button" onClick={onDismiss} className="text-sm text-zinc-500 hover:underline">Clear results</button></div>
    <ul className="max-h-48 space-y-2 overflow-y-auto text-sm">
      {batch.outputs.map((output, outputIndex) => <li key={output.file.name} className="flex flex-wrap justify-between gap-2"><button type="button" onClick={() => selectResult(outputIndex)} className="min-w-0 truncate text-left text-rose-600 hover:underline">{output.file.name}</button><span className="shrink-0 text-zinc-500">{formatSize(output.before)} → {formatSize(output.after)}</span></li>)}
    </ul>
    {batch.outputs.length > 1 && <ResultCard file={batch.file} from="workflows" onDismiss={onDismiss} downloadLabel="Download ZIP">{batch.outputs.length} processed PDFs · Preview individual results below.</ResultCard>}
    <label className="block space-y-1 text-sm">Preview result<select aria-label="Workflow result to preview" value={index} onChange={(e) => selectResult(Number(e.target.value))} className={`${FIELD} block w-full py-2`}>{batch.outputs.map((output, outputIndex) => <option key={output.file.name} value={outputIndex}>{output.file.name}</option>)}</select></label>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {!doc && !error && <p role="status" className="text-sm text-zinc-500">Opening result preview…</p>}
    {doc && <>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} className="text-rose-600 disabled:text-zinc-400">Previous page</button>
        <label className="flex items-center gap-2">Page<select aria-label="Workflow preview page" value={page} onChange={(e) => setPage(Number(e.target.value))} className={FIELD}>{Array.from({ length: doc.numPages }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select>of {doc.numPages}</label>
        <button type="button" disabled={page >= doc.numPages} onClick={() => setPage((value) => value + 1)} className="text-rose-600 disabled:text-zinc-400">Next page</button>
      </div>
      <DocumentPreview doc={doc} page={page} onReady={onReady} />
      {rendered === doc && <ResultCard file={file} from="workflows" onDismiss={onDismiss} downloadLabel="Download PDF">{batch.outputs.length > 1 ? 'This PDF matches the preview and its copy in the ZIP.' : 'This PDF matches the preview.'}</ResultCard>}
    </>}
  </section>
}
