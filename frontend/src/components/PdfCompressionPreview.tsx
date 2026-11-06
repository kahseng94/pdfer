import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { closePdf, loadPdf, type PDFDocumentProxy } from '../lib/pdf'
import type { PdfCompressionBatch } from '../lib/pdfCompression'
import type { PdfCompressionItem } from '../lib/usePdfCompression'
import { targetSizeLabel } from '../lib/pdfTarget'
import { DocumentPreview } from './DocumentPreview'
import { ResultCard } from './ResultCard'
import { ErrorMessage, FIELD } from './ui'

const ignoreReady = () => {}

export function PdfCompressionPreview({ result, items, onDismiss }: {
  result: PdfCompressionBatch; items: PdfCompressionItem[]; onDismiss: () => void
}) {
  const [index, setIndex] = useState(0)
  const unmet = result.results.filter((entry) => entry.targetMet === false).length
  return <section aria-label="Compression preview" className="space-y-4 rounded-lg border border-zinc-200 bg-zinc-100/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/50">
    <h2 className="font-medium">Review compression quality</h2>
    {items.length > 1 && <label className="block space-y-1 text-sm">Preview PDF
      <select aria-label="Preview PDF" value={index} onChange={(event) => setIndex(Number(event.target.value))} className={`${FIELD} block w-full`}>
        {result.results.map((entry, i) => <option key={i} value={i}>{entry.name}</option>)}
      </select>
    </label>}
    <Comparison key={index} original={items[index].doc!} file={result.outputs[index]}>
      <p className="text-sm text-zinc-500">Downloads use these exact result bytes. {items.length > 1 && 'Select each PDF above to review it. The target applies to each PDF, not the ZIP.'}</p>
      {items.length > 1 && <ResultCard file={result.outputs[index]} from="compress" onDismiss={onDismiss} downloadLabel="Download this PDF">In ZIP: {result.results[index].name}</ResultCard>}
      <ResultCard file={result.file} from="compress" onDismiss={onDismiss} downloadLabel={items.length > 1 ? 'Download ZIP' : 'Download PDF'}>
        {unmet ? `Target not met${items.length > 1 ? ` for ${unmet} of ${items.length} PDFs` : ''}. Smallest results found within the quality floor.` : 'Ready to download.'}
      </ResultCard>
    </Comparison>
  </section>
}

function Comparison({ original, file, children }: { original: PDFDocumentProxy; file: File; children: ReactNode }) {
  const [loaded, setLoaded] = useState<{ file: File; doc: PDFDocumentProxy | null; error: string | null } | null>(null)
  // Never render an older document alongside a newly supplied download file,
  // even if the caller replaces results without unmounting this component.
  const doc = loaded?.file === file ? loaded.doc : null
  const error = loaded?.file === file ? loaded.error : null
  const [page, setPage] = useState(1)
  const [view, setView] = useState('result')
  const [rendered, setRendered] = useState<PDFDocumentProxy | null>(null)
  const onReady = useCallback((ready: PDFDocumentProxy | null) => setRendered(ready), [])
  useEffect(() => {
    const controller = new AbortController()
    let opened: PDFDocumentProxy | null = null
    loadPdf(file, controller.signal).then((next) => {
      if (controller.signal.aborted) { closePdf(next); return }
      opened = next
      setLoaded({ file, doc: next, error: null })
    }, (reason: Error) => { if (!controller.signal.aborted) setLoaded({ file, doc: null, error: reason.message }) })
    return () => { controller.abort(); closePdf(opened) }
  }, [file])

  return <div className="space-y-4">
    {error && <ErrorMessage>Could not open the result preview: {error}</ErrorMessage>}
    {!doc && !error && <p role="status" className="text-sm text-zinc-500">Opening result preview…</p>}
    {doc && <>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="text-rose-600 disabled:text-zinc-400">Previous page</button>
        <label>Page <select aria-label="Compression preview page" value={page} onChange={(event) => setPage(Number(event.target.value))} className={FIELD}>
          {Array.from({ length: doc.numPages }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
        </select> of {doc.numPages}</label>
        <button type="button" disabled={page >= doc.numPages} onClick={() => setPage(page + 1)} className="text-rose-600 disabled:text-zinc-400">Next page</button>
      </div>
      <fieldset className="flex flex-wrap gap-4 text-sm">
        <legend className="sr-only">Comparison view</legend>
        {(['original', 'result', 'both'] as const).map((value) => <label key={value} className="flex items-center gap-1.5">
          <input type="radio" name="compression-preview-view" value={value} checked={view === value} onChange={() => setView(value)} />
          {value === 'both' ? 'Side by side' : value === 'original' ? 'Original' : 'Result'}
        </label>)}
      </fieldset>
      <div className={view === 'both' ? 'grid gap-4 md:grid-cols-2' : ''}>
        {view !== 'result' && <div className="min-w-0 space-y-2"><h3 className="text-sm font-medium">Original</h3><DocumentPreview key={`original-${page}`} doc={original} page={page} onReady={ignoreReady} /></div>}
        {view !== 'original' && <div className="min-w-0 space-y-2"><h3 className="text-sm font-medium">Result · {file.size.toLocaleString()} bytes</h3><DocumentPreview key={`result-${page}`} doc={doc} page={page} onReady={onReady} /></div>}
      </div>
      {rendered === doc && children}
    </>}
  </div>
}

export function PdfTargetStatus({ target, targetMet, before, after }: { target?: number; targetMet?: boolean; before: number; after: number }) {
  if (target === undefined) return null
  return <p className={`text-sm ${targetMet ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`}>
    {targetMet ? before <= target ? 'Already within target; original kept' : 'Target met' : 'Target not met; smallest result within quality floor'}
    {' · '}{after.toLocaleString()} / {target.toLocaleString()} bytes (target {targetSizeLabel(target)})
  </p>
}
