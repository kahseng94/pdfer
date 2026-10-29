import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { stampPdf } from '../lib/api'
import { pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import { pdfPassword } from '../lib/passwords'
import { closePdf, formatSize, type PDFDocumentProxy } from '../lib/pdf'
import { pagesIn, parseSpec, toSpec } from '../lib/ranges'
import { useResult } from '../lib/result'
import { DEFAULT_NUMBERS, DEFAULT_WATERMARK, NUMBER_FORMATS, STAMP_POSITIONS, numberText, stampProblem, type NumberSettings, type StampSettings, type StampStyle, type WatermarkSettings } from '../lib/stamps'
import { usePdfLoader } from '../lib/usePdfLoader'
import { useWindowDrop } from '../lib/windowDrop'
import { DocumentPreview } from './DocumentPreview'
import { Dropzone } from './Dropzone'
import { CheckIcon } from './icons'
import { PageThumbnail } from './PageThumbnail'
import { ResultCard } from './ResultCard'
import { Button, DropOverlay, ErrorMessage, FIELD } from './ui'

type Preview = { file: File; doc: PDFDocumentProxy }

export function StampTool({ active = true }: { active?: boolean }) {
  const [file, setFile] = useState<File | null>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [spec, setSpec] = useState('')
  const [numbersOn, setNumbersOn] = useState(true)
  const [watermarkOn, setWatermarkOn] = useState(false)
  const [numbers, setNumbers] = useState<NumberSettings>({ ...DEFAULT_NUMBERS })
  const [watermark, setWatermark] = useState<WatermarkSettings>({ ...DEFAULT_WATERMARK })
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rendered, setRendered] = useState<PDFDocumentProxy | null>(null)
  const [hasPreview, setHasPreview] = useState(false)
  const documentRef = useRef<PDFDocumentProxy | null>(null)
  const previewDoc = useRef<PDFDocumentProxy | null>(null)
  const version = useRef(0)
  const pending = useRef<AbortController | null>(null)
  const loader = usePdfLoader()
  const settings: StampSettings = { pages: spec, numbers: numbersOn ? numbers : null, watermark: watermarkOn ? watermark : null }
  const result = useResult<Preview>([file, JSON.stringify(settings)])
  const total = doc?.numPages ?? 0
  const selection = useMemo(() => parseSpec(spec, total), [spec, total])
  const selected = useMemo(() => pagesIn(selection.ranges), [selection.ranges])
  const problem = stampProblem(settings, total)
  const onReady = useCallback((ready: PDFDocumentProxy | null) => setRendered(ready), [])

  useEffect(() => () => {
    version.current += 1
    pending.current?.abort()
    closePdf(documentRef.current)
    closePdf(previewDoc.current)
  }, [])

  function cancelPreview() {
    pending.current?.abort()
    pending.current = null
    loader.cancel('preview')
    setBusy(false)
  }

  function dismissPreview() {
    result.clear()
    setHasPreview(false)
    closePdf(previewDoc.current)
    previewDoc.current = null
  }

  function reset() {
    version.current += 1
    cancelPreview()
    loader.cancel()
    closePdf(documentRef.current)
    documentRef.current = null
    dismissPreview()
    setDoc(null)
    setFile(null)
    setSpec('')
    setPage(1)
    setError(null)
    setRendered(null)
  }

  async function open(next: File) {
    reset()
    const current = version.current
    setFile(next)
    try {
      const loaded = await loader.load(next)
      if (version.current !== current) { closePdf(loaded); return }
      documentRef.current = loaded
      setDoc(loaded)
      setSpec(loaded.numPages === 1 ? '1' : `1-${loaded.numPages}`)
    } catch (err) {
      if (version.current === current) setError((err as Error).message)
    }
  }

  async function preview() {
    if (!file || !doc || busy || problem) return
    const controller = new AbortController()
    pending.current = controller
    const finish = result.begin()
    closePdf(previewDoc.current)
    previewDoc.current = null
    setBusy(true)
    setHasPreview(false)
    setError(null)
    try {
      const output = await stampPdf(file, settings, controller.signal)
      if (controller.signal.aborted) return
      const renderedPdf = await loader.load(output, 'preview')
      if (controller.signal.aborted || pending.current !== controller) { closePdf(renderedPdf); return }
      previewDoc.current = renderedPdf
      setHasPreview(true)
      setPage((current) => selected.has(current) ? current : Math.min(...selected))
      finish({ file: output, doc: renderedPdf })
    } catch (err) {
      if (!controller.signal.aborted && pending.current === controller) setError((err as Error).message)
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false) }
    }
  }

  function toggle(number: number) {
    const next = new Set(selected)
    if (next.has(number)) next.delete(number)
    else next.add(number)
    setSpec(toSpec(next))
    setPage(number)
  }

  function take(files: File[]) {
    const [next] = pickFiles(files, 'pdf').wanted
    if (next) void open(next)
  }
  const dragging = useWindowDrop(take, active)
  useReceive('stamps', take)
  const overlay = dragging && <DropOverlay label="Drop a PDF to number or watermark" />
  if (!file) return <>{overlay}<Dropzone title="Choose a PDF to number or watermark" onFiles={take} /></>

  return (
    <div className="space-y-5">
      {overlay}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="min-w-0">
          <p className="truncate font-medium">{file.name}</p>
          <p className="text-sm text-zinc-500">{doc ? `${total} ${total === 1 ? 'page' : 'pages'} · ` : ''}{formatSize(file.size)}</p>
          {doc && pdfPassword(file) && <p className="text-sm text-zinc-500">The saved PDF will keep this file’s password.</p>}
        </div>
        <button type="button" onClick={reset} className="shrink-0 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Choose another file</button>
      </div>
      {!doc && !error && <p role="status" className="text-sm text-zinc-500">Opening PDF…</p>}

      {doc && <>
        <fieldset disabled={busy} className="space-y-5 disabled:opacity-60">
          <legend className="sr-only">Numbers and watermark settings</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <FeatureToggle label="Page numbers" hint="Headers or footers on selected pages" checked={numbersOn} onChange={setNumbersOn} />
            <FeatureToggle label="Text watermark" hint="A translucent label on selected pages" checked={watermarkOn} onChange={setWatermarkOn} />
          </div>
          {numbersOn && <div className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <h2 className="font-medium">Page numbers</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="space-y-1 text-sm">Number format<select aria-label="Number format" value={numbers.format} onChange={(e) => setNumbers({ ...numbers, format: e.target.value as NumberSettings['format'] })} className={`${FIELD} block w-full py-2`}>
                {NUMBER_FORMATS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select></label>
              <label className="space-y-1 text-sm">Number using<select aria-label="Number using" value={numbers.mode} onChange={(e) => setNumbers({ ...numbers, mode: e.target.value as NumberSettings['mode'] })} className={`${FIELD} block w-full py-2`}>
                <option value="document">Document page order</option><option value="selected">Selected pages in order</option>
              </select></label>
              <NumericField label="Start number" value={numbers.start} min={1} max={1_000_000} onChange={(start) => setNumbers({ ...numbers, start })} />
            </div>
            <StyleFields label="Number" value={numbers} onChange={(patch) => setNumbers({ ...numbers, ...patch })} />
            <p className="text-sm text-zinc-500">{numbers.mode === 'document' ? 'The start number belongs to the first document page; skipped pages still count.' : 'The start number belongs to the first selected page; skipped pages do not count.'}
              {!problem && selected.size > 0 && <> First selected page: {numberText(numbers, Math.min(...selected), 0, selected.size, total)}.</>}
            </p>
          </div>}
          {watermarkOn && <div className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <h2 className="font-medium">Text watermark</h2>
            <label className="block space-y-1 text-sm">Watermark text<input aria-label="Watermark text" value={watermark.text} onChange={(e) => setWatermark({ ...watermark, text: e.target.value })} placeholder="DRAFT" className={`${FIELD} block w-full px-3 py-2`} /></label>
            <StyleFields label="Watermark" value={watermark} onChange={(patch) => setWatermark({ ...watermark, ...patch })} />
            <div className="grid items-center gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm">Watermark opacity ({Math.round(watermark.opacity * 100)}%)<input aria-label="Watermark opacity" type="range" min={1} max={100} value={watermark.opacity * 100} onChange={(e) => setWatermark({ ...watermark, opacity: Number(e.target.value) / 100 })} className="block w-full accent-rose-600" /></label>
              <NumericField label="Watermark rotation (degrees)" value={watermark.rotation} min={-180} max={180} onChange={(rotation) => setWatermark({ ...watermark, rotation })} />
            </div>
            <p className="text-sm text-zinc-500">0° is horizontal; negative angles rise from left to right. Long text scales down to fit inside the margins.</p>
          </div>}

          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="stamp-pages" className="text-sm font-medium">Pages to mark</label>
              <div className="flex gap-3 text-sm">
                <button type="button" onClick={() => setSpec(total === 1 ? '1' : `1-${total}`)} className="text-rose-600 hover:underline dark:text-rose-400">Select all</button>
                <button type="button" onClick={() => setSpec('')} className="text-zinc-500 hover:underline">Clear selection</button>
              </div>
            </div>
            <input id="stamp-pages" value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="e.g. 2-5, 8-" autoComplete="off" spellCheck={false} aria-invalid={selection.invalid.length > 0} aria-describedby="stamp-pages-hint" className={`${FIELD} mt-1 w-full px-3 py-2 font-mono`} />
            <p id="stamp-pages-hint" className="mt-1 text-sm text-zinc-500">Type ranges or click thumbnails. Both enabled features apply to these pages, once each in document order.</p>
          </div>
          <p className="text-sm text-zinc-500">{selected.size} of {total} pages selected</p>
          <ol className="grid max-h-64 grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-3 overflow-y-auto p-1">
            {Array.from({ length: total }, (_, i) => i + 1).map((number) => <li key={number}>
              <button type="button" aria-label={`Page ${number}`} aria-pressed={selected.has(number)} onClick={() => toggle(number)} className={`relative flex w-full flex-col items-center gap-1.5 rounded-lg p-2 focus-visible:outline-2 focus-visible:outline-rose-600 ${selected.has(number) ? 'bg-rose-50 ring-2 ring-rose-500 dark:bg-rose-950/30' : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'}`}>
                <PageThumbnail doc={doc} pageNumber={number} width={96} /><span className="text-xs text-zinc-500">{number}</span>
                {selected.has(number) && <span className="absolute top-1 right-1 rounded-full bg-rose-600 p-0.5 text-white"><CheckIcon className="size-3.5" /></span>}
              </button>
            </li>)}
          </ol>
        </fieldset>

        {problem && <ErrorMessage>{problem}</ErrorMessage>}
        <Button onClick={preview} disabled={busy || !!problem}>{busy ? 'Building preview…' : hasPreview ? 'Update preview' : 'Preview changes'}</Button>
        {busy && <button type="button" onClick={cancelPreview} className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">Cancel preview</button>}
        <p className="text-sm text-zinc-500">{result.value ? 'This is the exact PDF that Download PDF will save.' : hasPreview ? 'Settings changed. Update the preview before downloading.' : 'Preview your changes before downloading. Text stays selectable and original page content is preserved.'}</p>
      </>}
      {error && <ErrorMessage>{error}</ErrorMessage>}

      {doc && <section aria-label="PDF preview" className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-100 p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">{result.value ? 'Preview with changes' : 'Original page'}</h2>
          <div className="flex items-center gap-2 text-sm">
            <button type="button" aria-label="Previous preview page" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border border-zinc-300 px-2 py-1 disabled:opacity-40 dark:border-zinc-700">Previous</button>
            <select aria-label="Preview page" value={page} onChange={(e) => setPage(Number(e.target.value))} className={FIELD}>{Array.from({ length: total }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} / {total}</option>)}</select>
            <button type="button" aria-label="Next preview page" disabled={page >= total} onClick={() => setPage(page + 1)} className="rounded border border-zinc-300 px-2 py-1 disabled:opacity-40 dark:border-zinc-700">Next</button>
          </div>
        </div>
        <p className="text-xs text-zinc-500">{selected.has(page) ? 'Selected for marking' : 'Not selected; this page stays unchanged'}</p>
        <DocumentPreview doc={result.value?.doc ?? doc} page={page} onReady={onReady} />
      </section>}
      {result.value && rendered === result.value.doc && <ResultCard file={result.value.file} from="stamps" onDismiss={dismissPreview} downloadLabel="Download PDF">
        {selected.size} {selected.size === 1 ? 'page' : 'pages'} marked · {numbersOn && watermarkOn ? 'Page numbers and watermark' : numbersOn ? 'Page numbers' : 'Watermark'}
      </ResultCard>}
    </div>
  )
}

function FeatureToggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${checked ? 'border-rose-500 bg-rose-50 dark:bg-rose-950/30' : 'border-zinc-200 dark:border-zinc-800'}`}>
    <input type="checkbox" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1 accent-rose-600" />
    <span><span className="block font-medium">{label}</span><span className="text-sm text-zinc-500">{hint}</span></span>
  </label>
}

function NumericField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return <label className="block space-y-1 text-sm">{label}<input aria-label={label} type="number" min={min} max={max} step={1} value={Number.isNaN(value) ? '' : value} onChange={(e) => onChange(e.target.valueAsNumber)} className={`${FIELD} block w-full px-2 py-2`} /></label>
}

function StyleFields({ label, value, onChange }: { label: 'Number' | 'Watermark'; value: StampStyle; onChange: (patch: Partial<StampStyle>) => void }) {
  const positions = label === 'Number' ? STAMP_POSITIONS.filter(([position]) => position.startsWith('top-') || position.startsWith('bottom-')) : STAMP_POSITIONS
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
    <label className="space-y-1 text-sm">{label} position<select aria-label={`${label} position`} value={value.position} onChange={(e) => onChange({ position: e.target.value as StampStyle['position'] })} className={`${FIELD} block w-full py-2`}>
      {positions.map(([position, text]) => <option key={position} value={position}>{text}</option>)}
    </select></label>
    <label className="space-y-1 text-sm">{label} font<select aria-label={`${label} font`} value={value.family} onChange={(e) => onChange({ family: e.target.value as StampStyle['family'] })} className={`${FIELD} block w-full py-2`}>
      <option value="sans">Sans</option><option value="serif">Serif</option><option value="mono">Mono</option>
    </select></label>
    <NumericField label={`${label} size (pt)`} value={value.size} min={6} max={label === 'Number' ? 72 : 200} onChange={(size) => onChange({ size })} />
    <NumericField label={`${label} margin (pt)`} value={value.margin} min={0} max={144} onChange={(margin) => onChange({ margin })} />
    <label className="space-y-1 text-sm">{label} color<input aria-label={`${label} color`} type="color" value={value.color} onChange={(e) => onChange({ color: e.target.value })} className={`${FIELD} block h-10 w-full`} /></label>
  </div>
}
