import { useCallback, useState } from 'react'
import type { PDFDocumentProxy } from '../lib/pdf'
import type { PdfOutput } from '../lib/usePdfTask'
import type { ToolId } from '../lib/tools'
import { DocumentPreview } from './DocumentPreview'
import { ResultCard } from './ResultCard'
import { FIELD } from './ui'

const ready = () => {}
export function PdfPages({ doc, page, onPage, onReady = ready, label = 'PDF preview' }: {
  doc: PDFDocumentProxy; page: number; onPage: (page: number) => void
  onReady?: (doc: PDFDocumentProxy | null) => void; label?: string
}) {
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} className="text-rose-600 disabled:text-zinc-400">Previous page</button>
      <label className="flex items-center gap-2">Page<select aria-label={`${label} page`} value={page} onChange={(e) => onPage(Number(e.target.value))} className={FIELD}>
        {Array.from({ length: doc.numPages }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
      </select>of {doc.numPages}</label>
      <button type="button" disabled={page >= doc.numPages} onClick={() => onPage(page + 1)} className="text-rose-600 disabled:text-zinc-400">Next page</button>
    </div>
    <DocumentPreview doc={doc} page={page} onReady={onReady} />
  </div>
}
export function PdfToolPreview({ result, from, page, onPage, onDismiss }: { result: PdfOutput; from: ToolId; page: number; onPage: (page: number) => void; onDismiss: () => void }) {
  const [rendered, setRendered] = useState<PDFDocumentProxy | null>(null)
  const onReady = useCallback((doc: PDFDocumentProxy | null) => setRendered(doc), [])
  return <section aria-label="Output preview" className="space-y-4 rounded-lg border border-zinc-200 bg-zinc-100/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/50">
    <h2 className="font-medium">Output preview</h2>
    <PdfPages doc={result.doc} page={Math.min(page, result.doc.numPages)} onPage={onPage} onReady={onReady} label="Output preview" />
    {rendered === result.doc && <ResultCard file={result.file} from={from} onDismiss={onDismiss} downloadLabel="Download PDF">This download matches the preview.</ResultCard>}
  </section>
}
