import { useEffect, useMemo, useRef, useState } from 'react'
import { pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import { closePdf, formatSize, type PDFDocumentProxy } from '../lib/pdf'
import { pdfPassword } from '../lib/passwords'
import { usePdfLoader } from '../lib/usePdfLoader'
import { IMAGE_RESOLUTIONS, pdfToImages, type ExportProgress, type ImageResolution, type PdfImageFormat } from '../lib/pdfImages'
import { pagesIn, parseSpec, toSpec } from '../lib/ranges'
import { useResult } from '../lib/result'
import { useWindowDrop } from '../lib/windowDrop'
import { Dropzone } from './Dropzone'
import { CheckIcon } from './icons'
import { PageThumbnail } from './PageThumbnail'
import { ResultCard } from './ResultCard'
import { Button, DropOverlay, ErrorMessage, FIELD } from './ui'

const FORMATS: { value: PdfImageFormat; label: string; hint: string }[] = [
  { value: 'png', label: 'PNG', hint: 'Lossless, crisp text' },
  { value: 'jpeg', label: 'JPEG', hint: 'Smaller files, good for photos' },
]
const RESOLUTION_HINTS = { 72: 'Screen', 150: 'Balanced', 300: 'Print' }

export function PdfImagesTool({ active = true }: { active?: boolean }) {
  const [file, setFile] = useState<File | null>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [spec, setSpec] = useState('')
  const [format, setFormat] = useState<PdfImageFormat>('png')
  const [dpi, setDpi] = useState<ImageResolution>(150)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const documentRef = useRef<PDFDocumentProxy | null>(null)
  const loadVersion = useRef(0)
  const exporting = useRef<AbortController | null>(null)
  const result = useResult<File>([file, spec, format, dpi])
  const loader = usePdfLoader()

  useEffect(() => () => {
    loadVersion.current += 1
    exporting.current?.abort()
    closePdf(documentRef.current)
  }, [])

  function reset() {
    loader.cancel()
    loadVersion.current += 1
    exporting.current?.abort()
    exporting.current = null
    closePdf(documentRef.current)
    documentRef.current = null
    setDoc(null)
    setFile(null)
    setSpec('')
    setError(null)
    setBusy(false)
    setProgress(null)
    result.clear()
  }

  async function open(next: File) {
    reset()
    const version = loadVersion.current
    setFile(next)
    try {
      const loaded = await loader.load(next)
      if (version !== loadVersion.current) {
        closePdf(loaded)
        return
      }
      documentRef.current = loaded
      setDoc(loaded)
      setSpec(loaded.numPages === 1 ? '1' : `1-${loaded.numPages}`)
    } catch (err) {
      if (version === loadVersion.current) setError((err as Error).message)
    }
  }

  const total = doc?.numPages ?? 0
  const { ranges, invalid } = useMemo(() => parseSpec(spec, total), [spec, total])
  const selected = useMemo(() => pagesIn(ranges), [ranges])

  function toggle(page: number) {
    const next = new Set(selected)
    if (next.has(page)) next.delete(page)
    else next.add(page)
    setSpec(toSpec(next))
  }

  async function run() {
    if (!file || !doc || busy || invalid.length || selected.size === 0) return
    const controller = new AbortController()
    exporting.current = controller
    setBusy(true)
    setError(null)
    const finish = result.begin()
    try {
      const zip = await pdfToImages(doc, {
        name: file.name, spec, format, dpi, signal: controller.signal,
        onProgress: (next) => {
          if (exporting.current === controller) setProgress(next)
        },
      })
      if (exporting.current === controller && !controller.signal.aborted) finish(zip)
    } catch (err) {
      if (exporting.current === controller && !controller.signal.aborted) setError((err as Error).message)
    } finally {
      if (exporting.current === controller) {
        exporting.current = null
        setBusy(false)
        setProgress(null)
      }
    }
  }

  function take(files: File[]) {
    const [first] = pickFiles(files, 'pdf').wanted
    if (first) void open(first)
  }

  const dragging = useWindowDrop(take, active)
  useReceive('pdf-images', take)
  const overlay = dragging && <DropOverlay label="Drop a PDF to export as images" />

  if (!file) {
    return <>{overlay}<Dropzone title="Choose a PDF to turn into images" onFiles={take} /></>
  }

  return (
    <div className="space-y-5">
      {overlay}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="min-w-0">
          <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">{file.name}</p>
          <p className="text-sm text-zinc-500">
            {doc ? `${total} ${total === 1 ? 'page' : 'pages'} · ` : ''}{formatSize(file.size)}
          </p>
        </div>
        <button type="button" onClick={reset} className="shrink-0 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
          Choose another file
        </button>
      </div>

      {!doc && !error && <p role="status" className="text-sm text-zinc-500">Loading pages…</p>}

      {doc && (
        <>
          <fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
            <legend className="sr-only">Image export settings</legend>
            <fieldset>
              <legend className="mb-2 text-sm font-medium">Image format</legend>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {FORMATS.map((option) => (
                  <label key={option.value} className={`cursor-pointer rounded-lg border px-3 py-2.5 has-focus-visible:outline-2 has-focus-visible:outline-rose-600 ${
                    format === option.value ? 'border-rose-500 bg-rose-50 dark:bg-rose-950/30' : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'
                  }`}>
                    <input type="radio" name="pdf-images-format" value={option.value} checked={format === option.value} onChange={() => setFormat(option.value)} className="sr-only" />
                    <span className="block font-medium">{option.label}</span>
                    <span className="block text-sm text-zinc-500">{option.hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div>
              <label htmlFor="pdf-images-dpi" className="mb-1 block text-sm font-medium">Resolution</label>
              <select id="pdf-images-dpi" value={dpi} onChange={(e) => setDpi(Number(e.target.value) as ImageResolution)} className={`${FIELD} w-full px-3 py-2`} aria-describedby="pdf-images-dpi-hint">
                {IMAGE_RESOLUTIONS.map((value) => <option key={value} value={value}>{value} DPI · {RESOLUTION_HINTS[value]}</option>)}
              </select>
              <p id="pdf-images-dpi-hint" className="mt-1 text-sm text-zinc-500">Higher resolution gives larger, sharper images and larger files.</p>
            </div>

            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="pdf-images-pages" className="text-sm font-medium">Pages</label>
                <div className="flex gap-3 text-sm">
                  <button type="button" onClick={() => setSpec(total === 1 ? '1' : `1-${total}`)} className="text-rose-600 hover:underline dark:text-rose-400">Select all</button>
                  <button type="button" onClick={() => setSpec('')} className="text-zinc-500 hover:underline">Clear selection</button>
                </div>
              </div>
              <input
                id="pdf-images-pages" value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="e.g. 1-3, 5, 8-"
                autoComplete="off" spellCheck={false} aria-invalid={invalid.length > 0} aria-describedby="pdf-images-pages-hint"
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-rose-500 focus:outline-none focus:ring-2 focus:ring-rose-500/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
              <p id="pdf-images-pages-hint" className="mt-1 text-sm text-zinc-500">
                {invalid.length > 0 ? <span className="text-amber-700 dark:text-amber-400">Not valid for this {total}-page file: {invalid.join(', ')}</span>
                  : 'Type ranges or click pages below. Each selected page is exported once, in document order.'}
              </p>
            </div>

            <p className="text-sm text-zinc-500">{selected.size} of {total} pages selected</p>
            <ol className="grid max-h-[32rem] grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-3 overflow-y-auto p-1">
              {Array.from({ length: total }, (_, i) => i + 1).map((page) => (
                <li key={page}>
                  <button type="button" onClick={() => toggle(page)} aria-pressed={selected.has(page)} aria-label={`Page ${page}`} className={`relative flex w-full flex-col items-center gap-1.5 rounded-lg p-2 focus-visible:outline-2 focus-visible:outline-rose-600 ${
                    selected.has(page) ? 'bg-rose-50 ring-2 ring-rose-500 dark:bg-rose-950/30' : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'
                  }`}>
                    <PageThumbnail doc={doc} pageNumber={page} width={96} />
                    <span className="text-xs tabular-nums text-zinc-500">{page}</span>
                    {selected.has(page) && <span className="absolute top-1 right-1 rounded-full bg-rose-600 p-0.5 text-white"><CheckIcon className="size-3.5" /></span>}
                  </button>
                </li>
              ))}
            </ol>
          </fieldset>

          <p className="text-sm text-zinc-500">One {format.toUpperCase()} image per page, bundled into a ZIP. Page sizes and rotation are preserved.</p>
          {pdfPassword(file) && <p className="text-sm text-zinc-500">The exported images and ZIP will open without a password.</p>}
        </>
      )}

      {error && <ErrorMessage>{error}</ErrorMessage>}

      {doc && (
        <div className="sticky bottom-4 space-y-2">
          {result.value && <ResultCard file={result.value} from="pdf-images" onDismiss={result.clear} downloadLabel="Download ZIP">
            {selected.size} {format.toUpperCase()} {selected.size === 1 ? 'image' : 'images'} · {dpi} DPI
          </ResultCard>}
          {busy && progress && <div className="rounded-lg border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
            <p role="status">{progress.completed === progress.total ? 'Finishing ZIP…' : `Rendering page ${progress.page}…`} {progress.completed} of {progress.total} complete</p>
            <progress aria-label="Export progress" value={progress.completed} max={progress.total} className="mt-2 h-2 w-full accent-rose-600" />
          </div>}
          <Button onClick={run} disabled={busy || selected.size === 0 || invalid.length > 0}>
            {busy ? 'Exporting…' : selected.size === 0 ? 'Choose pages first' : `Export ${selected.size} ${selected.size === 1 ? 'page' : 'pages'} as ${format.toUpperCase()}`}
          </Button>
          {busy && <button type="button" onClick={() => exporting.current?.abort()} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">Cancel export</button>}
        </div>
      )}
    </div>
  )
}
