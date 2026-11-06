import { useEffect, useMemo, useRef, useState } from 'react'
import { saveFile } from '../lib/api'
import { pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import { pdfPassword } from '../lib/passwords'
import { closePdf, formatSize, type PDFDocumentProxy } from '../lib/pdf'
import { COMPARE_LIMITS, COMPARE_RESOLUTIONS, DEFAULT_COMPARE, comparePdfs, comparisonReport, differences, type CompareProgress, type CompareSettings, type ComparisonPage } from '../lib/pdfCompare'
import { textFile } from '../lib/pdfText'
import { usePdfLoader } from '../lib/usePdfLoader'
import { useWindowDrop } from '../lib/windowDrop'
import { ComparePreview } from './ComparePreview'
import { Dropzone } from './Dropzone'
import { Button, DropOverlay, ErrorMessage, FIELD } from './ui'

type Side = 'original' | 'revised'
type Input = { file: File | null; doc: PDFDocumentProxy | null; loading: boolean; error: string | null }
const empty = (): Input => ({ file: null, doc: null, loading: false, error: null })
const SIDES: Side[] = ['original', 'revised']
const LABELS = { original: 'Original', revised: 'Revised' }
const LINK = 'text-sm text-rose-600 hover:underline disabled:text-zinc-400'

export function CompareTool({ active = true }: { active?: boolean }) {
  const [inputs, setInputs] = useState<Record<Side, Input>>({ original: empty(), revised: empty() })
  const sources = useRef(inputs)
  const versions = useRef({ original: 0, revised: 0 })
  const loader = usePdfLoader()
  const [settings, setSettings] = useState<CompareSettings>(DEFAULT_COMPARE)
  const [pages, setPages] = useState<ComparisonPage[] | null>(null)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<number | null>(null)
  const [progress, setProgress] = useState<CompareProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const pending = useRef<AbortController | null>(null)
  const settled = useRef<Promise<void>>(Promise.resolve())
  const [revision, setRevision] = useState(0)
  const found = useMemo(() => differences(pages ?? []), [pages])
  const current = selected === null ? undefined : found[selected]
  const total = Math.max(inputs.original.doc?.numPages ?? 0, inputs.revised.doc?.numPages ?? 0)
  const currentPage = pages?.[page - 1]
  const ready = !!inputs.original.doc && !!inputs.revised.doc

  useEffect(() => () => {
    versions.current.original++; versions.current.revised++
    pending.current?.abort()
    for (const side of SIDES) closePdf(sources.current[side].doc)
  }, [])

  function update(side: Side, input: Input) {
    sources.current = { ...sources.current, [side]: input }
    setInputs(sources.current)
  }
  function invalidate() {
    pending.current?.abort(); pending.current = null
    setPages(null); setProgress(null); setBusy(false); setCancelled(false); setError(null)
    setSelected(null); setRevision((v) => v + 1)
  }
  function clear(side: Side) {
    invalidate(); versions.current[side]++; loader.cancel(side)
    closePdf(sources.current[side].doc)
    update(side, empty()); setPage(1)
  }
  async function open(side: Side, file: File) {
    clear(side)
    const version = versions.current[side]
    update(side, { file, doc: null, loading: true, error: null })
    try {
      if (file.size > COMPARE_LIMITS.fileBytes) throw new Error('Choose a PDF smaller than 100 MB. Split or compress larger files first.')
      const doc = await loader.load(file, side)
      if (versions.current[side] !== version) { closePdf(doc); return }
      if (doc.numPages > COMPARE_LIMITS.pages) {
        closePdf(doc); throw new Error(`Compare up to ${COMPARE_LIMITS.pages} pages per input. Split larger PDFs first.`)
      }
      update(side, { file, doc, loading: false, error: null })
    } catch (reason) {
      if (versions.current[side] === version) update(side, { file, doc: null, loading: false, error: (reason as Error).message })
    }
  }
  function take(files: File[]) {
    const { wanted, skipped } = pickFiles(files, 'pdf')
    setNotice(skipped || wanted.length > 2 ? 'Only the first two PDFs are accepted; other files were skipped.' : null)
    if (wanted.length >= 2) { void open('original', wanted[0]); void open('revised', wanted[1]) }
    else if (wanted.length) void open(sources.current.original.file ? 'revised' : 'original', wanted[0])
  }
  const dragging = useWindowDrop(take, active)
  useReceive('compare', take)

  function run() {
    const { original, revised } = sources.current
    if (!original.doc || !revised.doc || busy) return
    invalidate()
    const controller = new AbortController(), { signal } = controller
    pending.current = controller; setBusy(true); setPage(1)
    // A quick cancel/retry cannot overlap old raster allocations or page cleanup.
    const previous = settled.current
    settled.current = (async () => {
      try {
        await previous
        signal.throwIfAborted()
        const result = await comparePdfs(original.doc!, revised.doc!, settings, {
          signal, onProgress: (value) => { if (pending.current === controller && !signal.aborted) setProgress(value) },
        })
        if (pending.current !== controller || signal.aborted) return
        setPages(result)
        const first = differences(result)[0]
        if (first) { setSelected(0); setPage(first.page) }
      } catch (reason) {
        if (pending.current === controller && !signal.aborted) setError((reason as Error).message)
      } finally {
        if (pending.current === controller) { pending.current = null; setBusy(false); setProgress(null) }
      }
    })()
  }
  function changeSettings(next: CompareSettings) { invalidate(); setSettings(next) }
  function choosePage(next: number) { setPage(next); setSelected(null) }
  function moveDifference(direction: number) {
    if (!found.length) return
    let index: number
    if (selected !== null) index = (selected + direction + found.length) % found.length
    else if (direction > 0) { index = found.findIndex((d) => d.page >= page); if (index < 0) index = 0 }
    else { index = found.findLastIndex((d) => d.page <= page); if (index < 0) index = found.length - 1 }
    setSelected(index); setPage(found[index].page)
  }

  return <div className="space-y-5">
    {dragging && <DropOverlay label="Drop two PDFs, or one PDF into the next input" />}
    <div className="space-y-2">
      <h2 className="text-lg font-semibold">Compare PDFs</h2>
      <p className="text-sm text-zinc-500">Compare visible content and extractable text locally. Page 1 pairs with page 1, and so on. Pages are not automatically aligned: an insertion in the middle may change every later pair.</p>
      <p className="text-xs text-zinc-500">A single drop or “Open in Compare PDFs” fills Original first, then fills or replaces Revised. Drop two files to replace both, in file order.</p>
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      {SIDES.map((side) => {
        const input = inputs[side]
        return <section key={side} aria-label={`${LABELS[side]} input`} className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <h3 className="font-medium">{LABELS[side]}</h3>
          {input.file && <div className="text-sm"><p className="break-all font-medium">{input.file.name}</p><p className="text-zinc-500">{formatSize(input.file.size)}{input.doc && ` · ${input.doc.numPages} pages`}{pdfPassword(input.file) && ' · Protected'}</p></div>}
          <Dropzone compact title={`${input.file ? 'Replace' : 'Choose'} ${side} PDF`} onFiles={(files) => { if (files[0]) void open(side, files[0]) }} />
          {input.loading && <p role="status" className="text-sm text-zinc-500">Opening {side} PDF…</p>}
          {input.error && <><ErrorMessage>{input.error}</ErrorMessage><button type="button" onClick={() => void open(side, input.file!)} className={LINK}>Retry {side}</button></>}
          {input.file && <button type="button" onClick={() => clear(side)} className={LINK}>{input.loading ? `Cancel opening ${side}` : `Remove ${side}`}</button>}
        </section>
      })}
    </div>
    {notice && <p role="status" className="text-sm text-zinc-500">{notice}</p>}
    <div className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm">Resolution<select aria-label="Comparison resolution" className={FIELD} value={settings.dpi} onChange={(e) => changeSettings({ ...settings, dpi: Number(e.target.value) as CompareSettings['dpi'] })}>
          {COMPARE_RESOLUTIONS.map((dpi) => <option key={dpi} value={dpi}>{dpi} DPI{dpi === 96 ? ' (default)' : ''}</option>)}
        </select></label>
        <label className="flex items-center gap-2 text-sm">Noise tolerance<select aria-label="Comparison noise tolerance" className={FIELD} value={settings.tolerance} onChange={(e) => changeSettings({ ...settings, tolerance: e.target.value as CompareSettings['tolerance'] })}>
          <option value="precise">Precise</option><option value="balanced">Balanced</option><option value="relaxed">Relaxed</option>
        </select></label>
      </div>
      <p className="text-xs text-zinc-500">Balanced ignores small color differences and isolated changes under 4 pixels. Precise detects finer changes; Relaxed reduces scan noise. Pages are capped at 2 million pixels / 2400 pixels per side; large pages use a lower effective DPI. Up to 1000 pages and 100 MB per PDF.</p>
      <Button onClick={run} disabled={!ready || busy}>{pages ? 'Compare again' : 'Compare PDFs'}</Button>
    </div>
    {busy && <div className="space-y-2">
      <p role="status" className="text-sm">{progress ? `${progress.phase} · ${progress.completed} of ${progress.total} pairs complete` : 'Preparing comparison…'}</p>
      <progress aria-label="Comparison progress" value={progress?.completed ?? 0} max={total || 1} className="h-2 w-full accent-rose-600" />
      <button type="button" className={LINK} onClick={() => { invalidate(); setCancelled(true) }}>Cancel comparison</button>
    </div>}
    {cancelled && <p role="status" className="text-sm text-zinc-500">Comparison cancelled. Run again to compare the complete documents.</p>}
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {pages && <section aria-label="Comparison results" className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h3 className="font-medium">Comparison complete</h3>
      <p role="status" className="text-sm">{(['unchanged', 'changed', 'added', 'removed'] as const).map((status) => `${pages.filter((p) => p.status === status).length} ${status}`).join(' · ')}</p>
      <p className="text-xs text-zinc-500">Unchanged means no detected differences at this resolution and tolerance. Added/removed means the other document has no page with that number. Metadata and whitespace-only text changes are ignored.</p>
      {pages.some((p) => p.warnings.length) && <p className="text-sm text-amber-700 dark:text-amber-400">Some pages could only be compared visually. Their page details describe missing text results.</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={() => moveDifference(-1)} disabled={!found.length} className={LINK}>Previous difference</button>
        <span role="status" className="text-sm">{selected === null ? `${found.length} differences` : `Difference ${selected + 1} of ${found.length} · ${current?.kind === 'region' ? 'visual region' : current?.kind}`}</span>
        <button type="button" onClick={() => moveDifference(1)} disabled={!found.length} className={LINK}>Next difference</button>
      </div>
    </section>}
    {total > 0 && !busy && <section aria-label="Comparison preview" className="space-y-4 rounded-lg bg-zinc-100 p-4 dark:bg-zinc-900">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={() => choosePage(page - 1)} disabled={page <= 1} className={LINK}>Previous page</button>
        <label className="flex items-center gap-2 text-sm">Page pair<select aria-label="Comparison page pair" value={page} onChange={(e) => choosePage(Number(e.target.value))} className={FIELD}>
          {Array.from({ length: total }, (_, i) => <option key={i} value={i + 1}>{i + 1}{pages && ` · ${pages[i].status}${pages[i].warnings.length ? ' (text incomplete)' : ''}`}</option>)}
        </select>of {total}</label>
        <button type="button" onClick={() => choosePage(page + 1)} disabled={page >= total} className={LINK}>Next page</button>
      </div>
      {currentPage && <div className="space-y-1 text-sm">
        <p className="font-medium">Page {page}: {currentPage.status}{currentPage.geometryChanged && ' · Visible page dimensions changed'}</p>
        <p className="text-xs text-zinc-500">{currentPage.regions.length} highlighted regions · {currentPage.dpi.toFixed(1)} effective DPI. Pink marks visual changes on both sides; orange marks the selected region or changed page boundary.</p>
        {currentPage.groupedRegions && <p>Many visual regions were grouped into one bounding area.</p>}
      </div>}
      {active && <ComparePreview key={`${revision}:${page}:${!!inputs.original.doc}:${!!inputs.revised.doc}`} original={inputs.original.doc} revised={inputs.revised.doc} page={page} result={currentPage} selected={current} dpi={settings.dpi} />}
      {currentPage && <section aria-label="Text differences" className={`space-y-3 rounded-lg border p-3 ${current?.kind === 'text' ? 'border-orange-500' : 'border-zinc-300 dark:border-zinc-700'}`}>
        <h3 className="font-medium">Text additions and removals</h3>
        <p className="text-xs text-zinc-500">Literal words in extracted reading order; spacing and line breaks are ignored. Columns, tables and OCR layers can have unusual reading order. No OCR or semantic interpretation is performed.</p>
        {currentPage.warnings.map((warning) => <p key={warning} className="text-sm text-amber-700 dark:text-amber-400">{warning}</p>)}
        {!currentPage.originalHasText && !currentPage.revisedHasText && !currentPage.warnings.length && <p className="text-sm">No extractable text in this pair. Blank and scanned pages are compared visually.</p>}
        {(currentPage.originalHasText || currentPage.revisedHasText) && !currentPage.textChanges.length && !currentPage.warnings.length && <p className="text-sm">No extracted-text changes.</p>}
        {currentPage.coarseText && <p className="text-sm text-zinc-500">Long text replacement grouped into one block.</p>}
        <div className="max-h-80 space-y-3 overflow-auto text-sm break-words">
          {currentPage.textChanges.map((change, index) => <div key={index} className="space-y-1">
            {change.removed && <p className="rounded bg-red-50 p-2 text-red-900 dark:bg-red-950/40 dark:text-red-200"><strong>Removed: </strong><del>{change.removed}</del></p>}
            {change.added && <p className="rounded bg-emerald-50 p-2 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"><strong>Added: </strong><ins>{change.added}</ins></p>}
          </div>)}
        </div>
      </section>}
    </section>}
    {pages && <div className="space-y-2">
      <Button onClick={() => saveFile(textFile('comparison.pdf', comparisonReport(inputs.original.file!.name, inputs.revised.file!.name, settings, pages)))}>Download comparison TXT</Button>
      {(pdfPassword(inputs.original.file!) || pdfPassword(inputs.revised.file!)) && <p className="text-xs text-zinc-500">The downloaded text report has no password protection.</p>}
    </div>}
  </div>
}
