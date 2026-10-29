import { useMemo, useRef, useState } from 'react'
import { splitPdf, type SplitMode } from '../lib/api'
import { pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import { closePdf, formatSize, type PDFDocumentProxy } from '../lib/pdf'
import { usePdfLoader } from '../lib/usePdfLoader'
import { useResult } from '../lib/result'
import { useWindowDrop } from '../lib/windowDrop'
import { pagesIn, parseSpec, toSpec } from '../lib/ranges'
import { Dropzone } from './Dropzone'
import { CheckIcon } from './icons'
import { PageThumbnail } from './PageThumbnail'
import { ResultCard } from './ResultCard'
import { Button, DropOverlay, ErrorMessage } from './ui'

const MODES: { value: SplitMode; label: string; hint: string }[] = [
  { value: 'ranges', label: 'Split by ranges', hint: 'One PDF per range' },
  { value: 'each', label: 'Every page', hint: 'One PDF per page' },
  { value: 'extract', label: 'Extract pages', hint: 'Chosen pages in one PDF' },
]

export function SplitTool({ active = true }: { active?: boolean }) {
  const [file, setFile] = useState<File | null>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [mode, setMode] = useState<SplitMode>('ranges')
  const [spec, setSpec] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const result = useResult<File>([file, mode, spec])
  const loader = usePdfLoader()
  const opening = useRef(0)

  async function open(next: File) {
    const version = ++opening.current
    loader.cancel()
    closePdf(doc)
    setDoc(null)
    setFile(next)
    setSpec('')
    setError(null)
    try {
      const loaded = await loader.load(next)
      if (version === opening.current) setDoc(loaded)
      else closePdf(loaded)
    } catch (err) {
      if (version === opening.current) setError((err as Error).message)
    }
  }

  function reset() {
    opening.current += 1
    loader.cancel()
    closePdf(doc)
    setDoc(null)
    setFile(null)
    setError(null)
  }

  const total = doc?.numPages ?? 0
  const { ranges, invalid } = useMemo(() => parseSpec(spec, total), [spec, total])
  const selected = useMemo(() => pagesIn(ranges), [ranges])

  function toggle(page: number) {
    setSpec((prev) => {
      const next = pagesIn(parseSpec(prev, total).ranges)
      if (next.has(page)) next.delete(page)
      else next.add(page)
      return toSpec(next)
    })
  }

  async function run() {
    if (!file) return
    setBusy(true)
    setError(null)
    const finish = result.begin()
    try {
      finish(await splitPdf(file, mode, spec))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function take(files: File[]) {
    const [first] = pickFiles(files, 'pdf').wanted
    if (first) open(first)
  }

  const dragging = useWindowDrop(take, active)
  useReceive('split', take)
  const overlay = dragging && <DropOverlay label="Drop a PDF to split" />

  if (!file) {
    return (
      <>
        {overlay}
        <Dropzone title="Choose a PDF to split" onFiles={([f]) => open(f)} />
      </>
    )
  }

  const picking = mode !== 'each'
  const extractCount = ranges.reduce((n, [start, end]) => n + end - start + 1, 0)
  let action: string
  if (mode === 'each') action = `Split into ${total} ${total === 1 ? 'file' : 'files'}`
  else if (ranges.length === 0) action = 'Choose pages first'
  else if (mode === 'ranges') action = `Split into ${ranges.length} ${ranges.length === 1 ? 'file' : 'files'}`
  else action = `Extract ${extractCount} ${extractCount === 1 ? 'page' : 'pages'}`

  return (
    <div className="space-y-5">
      {overlay}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="min-w-0">
          <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">{file.name}</p>
          <p className="text-sm text-zinc-500">
            {doc ? `${total} ${total === 1 ? 'page' : 'pages'} · ` : ''}
            {formatSize(file.size)}
          </p>
        </div>
        <button
          type="button"
          onClick={reset}
          className="shrink-0 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          Choose another file
        </button>
      </div>

      {doc && (
        <>
          <fieldset>
            <legend className="sr-only">How to split</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {MODES.map((m) => (
                <label
                  key={m.value}
                  className={`cursor-pointer rounded-lg border px-3 py-2.5 has-focus-visible:outline-2 has-focus-visible:outline-rose-600 ${
                    mode === m.value
                      ? 'border-rose-500 bg-rose-50 dark:bg-rose-950/30'
                      : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'
                  }`}
                >
                  <input
                    type="radio"
                    name="split-mode"
                    value={m.value}
                    checked={mode === m.value}
                    onChange={() => setMode(m.value)}
                    className="sr-only"
                  />
                  <span className="block font-medium text-zinc-900 dark:text-zinc-100">{m.label}</span>
                  <span className="block text-sm text-zinc-500">{m.hint}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {picking && (
            <div>
              <label htmlFor="pages" className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
                Pages
              </label>
              <input
                id="pages"
                value={spec}
                onChange={(e) => setSpec(e.target.value)}
                placeholder="e.g. 1-3, 5, 8-"
                autoComplete="off"
                spellCheck={false}
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-rose-500 focus:outline-none focus:ring-2 focus:ring-rose-500/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
              <p className="mt-1 text-sm text-zinc-500">
                {invalid.length > 0 ? (
                  <span className="text-amber-700 dark:text-amber-400">
                    Not valid for this {total}-page file: {invalid.join(', ')}
                  </span>
                ) : mode === 'ranges' ? (
                  'Type ranges, or click pages below. Each range becomes its own PDF.'
                ) : (
                  'Type ranges, or click pages below. Pages are kept in the order you list them.'
                )}
              </p>
            </div>
          )}

          <ol className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-3">
            {Array.from({ length: total }, (_, i) => i + 1).map((page) => {
              const on = picking && selected.has(page)
              return (
                <li key={page}>
                  <button
                    type="button"
                    disabled={!picking}
                    onClick={() => toggle(page)}
                    aria-pressed={picking ? on : undefined}
                    aria-label={`Page ${page}`}
                    className={`group relative flex w-full flex-col items-center gap-1.5 rounded-lg p-2 focus-visible:outline-2 focus-visible:outline-rose-600 ${
                      on ? 'bg-rose-50 ring-2 ring-rose-500 dark:bg-rose-950/30' : picking ? 'hover:bg-zinc-100 dark:hover:bg-zinc-900' : ''
                    }`}
                  >
                    <PageThumbnail doc={doc} pageNumber={page} width={96} />
                    <span className="text-xs tabular-nums text-zinc-500">{page}</span>
                    {on && (
                      <span className="absolute top-1 right-1 rounded-full bg-rose-600 p-0.5 text-white">
                        <CheckIcon className="size-3.5" />
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ol>
        </>
      )}

      {error && <ErrorMessage>{error}</ErrorMessage>}

      {doc && (
        <div className="sticky bottom-4 space-y-2">
          {result.value && <ResultCard file={result.value} from="split" onDismiss={result.clear} />}
          <Button onClick={run} disabled={busy || (picking && (ranges.length === 0 || invalid.length > 0))}>
            {busy ? 'Working…' : action}
          </Button>
        </div>
      )}
    </div>
  )
}
