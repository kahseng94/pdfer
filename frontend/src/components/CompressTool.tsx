import { useEffect, useRef, useState } from 'react'
import { compressImages, type CompressLevel, type ImageFormat, type ImageResult } from '../lib/api'
import { FILE_KINDS, pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import { imageSize, named } from '../lib/images'
import { formatSize } from '../lib/pdf'
import { pdfPassword } from '../lib/passwords'
import type { PdfCompressionResult } from '../lib/pdfCompression'
import { usePdfCompression, type PdfCompressionItem } from '../lib/usePdfCompression'
import type { PdfTargetUnit } from '../lib/pdfTarget'
import { PdfCompressionPreview, PdfTargetStatus } from './PdfCompressionPreview'
import { useResult } from '../lib/result'
import { useWindowDrop } from '../lib/windowDrop'
import { Dropzone } from './Dropzone'
import { XIcon } from './icons'
import { ResultCard } from './ResultCard'
import { PageThumbnail } from './PageThumbnail'
import { Button, DropOverlay, ErrorMessage, FIELD } from './ui'

type Level = { value: CompressLevel; label: string; hint: string }

const PDF_LEVELS: Level[] = [
  { value: 'light', label: 'Light', hint: 'Keep images as they are' },
  { value: 'balanced', label: 'Balanced', hint: 'Images up to 1600 px, good for reading' },
  { value: 'strong', label: 'Strong', hint: 'Images up to 1000 px, smallest file' },
]

const IMAGE_LEVELS: Level[] = [
  { value: 'light', label: 'Light', hint: 'Keep the size, re-encode' },
  { value: 'balanced', label: 'Balanced', hint: 'Longest side up to 1600 px' },
  { value: 'strong', label: 'Strong', hint: 'Longest side up to 1000 px, smallest file' },
]

const FORMATS: { value: ImageFormat; label: string }[] = [
  { value: 'keep', label: 'Same format' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'png', label: 'PNG' },
  { value: 'webp', label: 'WebP' },
]

type Result = { before: number; after: number }

type ImageItem = {
  id: string
  file: File
  /** Object URL for the preview, revoked when the item goes away. */
  url: string
  size: { width: number; height: number } | null
  error: string | null
}

/** Shrinks a batch of PDFs or pictures, according to the type added last. */
export function CompressTool({ active = true }: { active?: boolean }) {
  const pdfs = usePdfCompression()
  const [images, setImages] = useState<ImageItem[]>([])
  const [notice, setNotice] = useState<string | null>(null)

  function take(files: File[]) {
    const { wanted, skipped } = pickFiles(files, 'compressible')
    const documents = wanted.filter(FILE_KINDS.pdf.is)
    const pictures = wanted.filter((f) => !FILE_KINDS.pdf.is(f))
    const notices: string[] = []
    if (skipped) notices.push(`Skipped ${skipped} unsupported ${skipped === 1 ? 'file' : 'files'}.`)
    if (documents.length && pictures.length) notices.push(`Skipped ${pictures.length} ${pictures.length === 1 ? 'image' : 'images'}. Add images separately to compress them.`)
    setNotice(notices.length ? notices.join(' ') : null)
    if (documents.length) {
      clearImages()
      pdfs.add(documents)
      return
    }
    if (!pictures.length) return
    pdfs.clear()
    addImages(pictures)
  }

  function addImages(files: File[]) {
    const added = files.map(
      (file): ImageItem => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file), size: null, error: null }),
    )
    setImages((prev) => [...prev, ...added])
    for (const item of added) {
      // An item removed meanwhile is simply not found by update().
      imageSize(item.url).then(
        (size) => update(item.id, { size }),
        () => update(item.id, { error: 'Can’t read this image.' }),
      )
    }
  }

  function update(id: string, patch: Partial<ImageItem>) {
    setImages((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)))
  }

  function removeImage(item: ImageItem) {
    URL.revokeObjectURL(item.url)
    setImages((prev) => prev.filter((it) => it.id !== item.id))
  }

  function clearImages() {
    setImages((prev) => {
      for (const it of prev) URL.revokeObjectURL(it.url)
      return []
    })
  }

  const dragging = useWindowDrop(take, active)
  useReceive('compress', take)
  const overlay = dragging && <DropOverlay label="Drop PDFs or images to compress" />
  const skippedNotice = notice && <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">{notice}</p>

  // Paste adds pictures while this tab is showing, unless the paste is meant for a text field.
  const takeLatest = useRef(take)
  useEffect(() => {
    takeLatest.current = take
  })
  useEffect(() => {
    if (!active) return
    function onPaste(e: ClipboardEvent) {
      if ((e.target as Element | null)?.closest?.('input, textarea, [contenteditable]')) return
      const { wanted } = pickFiles(e.clipboardData?.files ?? [], 'compressible')
      if (!wanted.length) return
      e.preventDefault()
      takeLatest.current(wanted.map(named))
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [active])

  if (pdfs.items.length) {
    return (
      <div className="space-y-4">
        {overlay}
        {skippedNotice}
        <PdfCompress batch={pdfs} onAdd={take} onClear={() => { pdfs.clear(); setNotice(null) }} />
      </div>
    )
  }

  if (images.length) {
    return (
      <div className="space-y-4">
        {overlay}
        {skippedNotice}
        <ImagesCompress items={images} onAdd={take} onRemove={removeImage} onClear={clearImages} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {overlay}
      {skippedNotice}
      <Dropzone kind="compressible" multiple title="Choose PDFs or images to compress" onFiles={take} />
      <p className="text-center text-sm text-zinc-500">You can also paste an image.</p>
    </div>
  )
}

function PdfCompress({ batch, onAdd, onClear }: {
  batch: ReturnType<typeof usePdfCompression>
  onAdd: (files: File[]) => void
  onClear: () => void
}) {
  const { items, busy, progress, result } = batch
  const count = items.length
  const unreadable = items.filter((item) => item.error).length
  const opening = items.some((item) => !item.doc && !item.error)
  const sizes = result?.results ?? progress?.results ?? []
  const totals = result?.results.reduce((total, entry) => ({ before: total.before + entry.before, after: total.after + entry.after }), { before: 0, after: 0 })

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm text-zinc-500">{count} {count === 1 ? 'PDF' : 'PDFs'} · {formatSize(items.reduce((total, item) => total + item.file.size, 0))} total</p>
          <button type="button" onClick={onClear} className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Clear all</button>
        </div>
        <ul className="space-y-2" aria-label="PDFs to compress">
          {items.map((item, index) => <PdfRow key={item.id} item={item} result={sizes[index] ?? null}
            working={busy && progress?.completed === index} queued={busy && index > (progress?.completed ?? 0)} failed={batch.failedId === item.id}
            onRemove={() => batch.remove(item.id)} onRetry={() => batch.retry(item)} />)}
        </ul>
        <Dropzone kind="pdf" multiple compact title="Add more PDFs" onFiles={onAdd} />
      </div>
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={batch.targetEnabled} onChange={(event) => batch.changeTarget(event.target.checked)} />Fit each PDF to a target size</label>
        {batch.targetEnabled && <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1 text-sm">Target size (at most)<input aria-label="PDF target size" type="text" inputMode="decimal" value={batch.targetValue} onChange={(event) => batch.changeTarget(true, event.target.value)} className={`${FIELD} block w-36`} /></label>
            <label className="space-y-1 text-sm">Unit<select aria-label="PDF target unit" value={batch.targetUnit} onChange={(event) => batch.changeTarget(true, batch.targetValue, event.target.value as PdfTargetUnit)} className={`${FIELD} block`}><option>KB</option><option>MB</option></select></label>
          </div>
          <p className="text-sm text-zinc-500">1 KB = 1,000 bytes; 1 MB = 1,000,000 bytes. Range: 1 KB–500 MB per PDF. We try progressively smaller images while preserving text and vectors. Some targets cannot be reached without going below the quality floor.</p>
          {batch.targetError && <ErrorMessage>{batch.targetError}</ErrorMessage>}
        </>}
      </div>
      {!batch.targetEnabled && <LevelPicker name="compress-level" levels={PDF_LEVELS} value={batch.level} onChange={batch.changeLevel}>
        Text and vector graphics stay exactly as they are at every level. PDFs that cannot shrink are kept unchanged.
      </LevelPicker>}
      <p className="text-sm text-zinc-500">{count > 1 ? 'One compressed PDF per input, bundled into a ZIP. Files with the same name are kept separately.' : 'Add more PDFs to compress them together and download a ZIP.'}</p>
      {items.some((item) => item.doc && pdfPassword(item.file)) && <p className="text-sm text-zinc-500">Each protected PDF keeps its own password.</p>}
      {opening && <p role="status" className="text-sm text-zinc-500">Opening PDFs…</p>}
      {unreadable > 0 && <ErrorMessage>Remove or retry the {unreadable === 1 ? 'PDF that could not be opened' : `${unreadable} PDFs that could not be opened`} before compressing.</ErrorMessage>}
      {batch.error && <ErrorMessage>{batch.error}</ErrorMessage>}
      {busy && progress && <div className="rounded-lg border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
        <p role="status" className="break-words">{progress.completed === count ? (count > 1 ? 'Preparing ZIP…' : 'Finishing…') : `Compressing ${progress.current}…`} {progress.completed} of {count} complete</p>
        <progress aria-label="PDF compression progress" value={progress.completed} max={count} className="mt-2 h-2 w-full accent-rose-600" />
      </div>}
      {result && <>
        {totals && <p className="text-sm">{count > 1 && 'Combined PDF size: '}<PdfSavings {...totals} /></p>}
        <PdfCompressionPreview result={result} items={items} onDismiss={batch.dismiss} />
      </>}
      <div className="sticky bottom-4 space-y-2">
        <Button onClick={batch.run} disabled={busy || opening || unreadable > 0 || !!batch.targetError}>
          {busy ? 'Compressing…' : batch.targetEnabled ? 'Compress and preview' : count === 1 ? 'Compress' : `Compress ${count} PDFs`}
        </Button>
        {busy && <button type="button" onClick={batch.cancel} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">Cancel compression</button>}
      </div>
    </div>
  )
}

function PdfRow({ item, result, working, queued, failed, onRemove, onRetry }: {
  item: PdfCompressionItem
  result: PdfCompressionResult | null
  working: boolean
  queued: boolean
  failed: boolean
  onRemove: () => void
  onRetry: () => void
}) {
  return <li className={`flex items-center gap-3 rounded-lg border bg-white p-3 dark:bg-zinc-900 ${item.error || failed ? 'border-red-300 dark:border-red-900' : 'border-zinc-200 dark:border-zinc-800'}`}>
    <div className="flex h-14 w-10 shrink-0 items-center justify-center">{item.doc && <PageThumbnail doc={item.doc} pageNumber={1} width={40} />}</div>
    <div className="min-w-0 flex-1">
      <p title={item.file.name} className="truncate font-medium">{item.file.name}</p>
      {item.error ? <p className="text-sm text-red-600 dark:text-red-400">{item.error}</p> : <>
        <p className="text-sm text-zinc-500">{item.doc ? `${item.doc.numPages} ${item.doc.numPages === 1 ? 'page' : 'pages'}` : 'Opening…'} · {formatSize(item.file.size)}{item.doc && pdfPassword(item.file) && ' · Password protected'}</p>
        {result && <>
          <p className="text-sm text-zinc-600 dark:text-zinc-400"><PdfSavings {...result} /></p>
          <PdfTargetStatus {...result} />
          <p className="truncate text-xs text-zinc-500" title={result.name}>Output: {result.name}</p>
        </>}
        {working && <p className="text-sm text-rose-600 dark:text-rose-400">Compressing…</p>}
        {queued && <p className="text-sm text-zinc-500">Waiting…</p>}
        {failed && <p className="text-sm text-red-600 dark:text-red-400">Compression failed. Try again or remove this file.</p>}
      </>}
      {item.error && <button type="button" onClick={onRetry} aria-label={`Retry ${item.file.name}`} className="mt-1 text-sm font-medium text-rose-600 hover:underline dark:text-rose-400">Try again</button>}
    </div>
    <button type="button" onClick={onRemove} aria-label={`Remove ${item.file.name}`} className="shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"><XIcon className="size-4" /></button>
  </li>
}

function PdfSavings({ before, after }: Result) {
  const saved = Math.max(0, before - after)
  return <>
    <span className="font-medium text-zinc-900 dark:text-zinc-100">{formatSize(before)} → {formatSize(after)}</span>
    {saved > 0 ? ` · ${formatSize(saved)} saved (${percentSmaller(before, after)})` : after === before ? ' · No reduction; original kept' : ' · No reduction'}
  </>
}

function ImagesCompress({
  items,
  onAdd,
  onRemove,
  onClear,
}: {
  items: ImageItem[]
  onAdd: (files: File[]) => void
  onRemove: (item: ImageItem) => void
  onClear: () => void
}) {
  const [level, setLevel] = useState<CompressLevel>('balanced')
  const [format, setFormat] = useState<ImageFormat>('keep')
  // What the user typed; empty means no limit.
  const [maxKb, setMaxKb] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The one picture or a zip of them all, and the sizes of each picture by item id.
  const result = useResult<{ file: File; sizes: Map<string, ImageResult> }>([level, format, maxKb, ...items.map((it) => it.file)])

  const limit = Number(maxKb)
  const limitOk = maxKb === '' || (Number.isInteger(limit) && limit > 0)

  async function run() {
    const ready = items.filter((it) => !it.error)
    setBusy(true)
    setError(null)
    const finish = result.begin()
    try {
      const { file, results } = await compressImages(
        ready.map((it) => it.file),
        level,
        format,
        maxKb ? limit : undefined,
      )
      finish({ file, sizes: new Map(ready.map((it, i) => [it.id, results[i]])) })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const unreadable = items.filter((it) => it.error).length
  const count = items.length
  const done = [...(result.value?.sizes.values() ?? [])]
  const totals =
    done.length > 0
      ? done.reduce((t, r) => ({ before: t.before + r.before, after: t.after + r.after }), { before: 0, after: 0 })
      : null

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {count} {count === 1 ? 'image' : 'images'}
          </p>
          <button
            type="button"
            onClick={onClear}
            className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            Clear all
          </button>
        </div>
        <ul className="space-y-2">
          {items.map((item) => (
            <ImageRow key={item.id} item={item} result={result.value?.sizes.get(item.id) ?? null} onRemove={() => onRemove(item)} />
          ))}
        </ul>
        <Dropzone kind="compressible" multiple compact title="Add more images" onFiles={onAdd} />
      </div>

      <LevelPicker name="image-level" levels={IMAGE_LEVELS} value={level} onChange={setLevel}>
        Smaller pictures are never enlarged. Metadata such as EXIF is dropped; the colour profile is kept.
      </LevelPicker>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-sm text-zinc-600 dark:text-zinc-400">
        <label className="flex items-center gap-2">
          Save as
          <select value={format} onChange={(e) => setFormat(e.target.value as ImageFormat)} className={FIELD}>
            {FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Keep each under
          <input
            type="number"
            min={1}
            step={1}
            placeholder="no limit"
            value={maxKb}
            onChange={(e) => setMaxKb(e.target.value)}
            aria-invalid={!limitOk}
            className={`${FIELD} w-24 ${limitOk ? '' : 'border-red-400 dark:border-red-700'}`}
          />
          KB
        </label>
      </div>
      <p className="text-sm text-zinc-500">
        With the same format, a picture that doesn’t get smaller comes back as it is. A size limit lowers the quality,
        then the size, until each picture fits.
      </p>

      {unreadable > 0 && (
        <ErrorMessage>Remove the {unreadable === 1 ? 'image' : `${unreadable} images`} that can’t be read first.</ErrorMessage>
      )}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      {result.value && (
        <ResultCard file={result.value.file} from="compress" onDismiss={result.clear}>
          {totals && <Shrunk {...totals} />}
        </ResultCard>
      )}

      <div className="sticky bottom-4">
        <Button onClick={run} disabled={busy || unreadable > 0 || !limitOk}>
          {busy ? 'Compressing…' : `Compress ${count} ${count === 1 ? 'image' : 'images'}`}
        </Button>
      </div>
    </div>
  )
}

function ImageRow({ item, result, onRemove }: { item: ImageItem; result: ImageResult | null; onRemove: () => void }) {
  const details = [item.size && `${item.size.width} × ${item.size.height}`, formatSize(item.file.size)]
    .filter(Boolean)
    .join(' · ')
  return (
    <li
      className={`flex items-center gap-3 rounded-lg border bg-white p-2 pr-3 dark:bg-zinc-900 ${
        item.error ? 'border-red-300 dark:border-red-900' : 'border-zinc-200 dark:border-zinc-800'
      }`}
    >
      <div className="flex h-14 w-10 shrink-0 items-center justify-center">
        {!item.error && <img src={item.url} alt="" className="max-h-14 max-w-10 shadow-sm ring-1 ring-zinc-900/10" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">{item.file.name}</p>
        <p className={`text-sm ${item.error ? 'text-red-600 dark:text-red-400' : 'text-zinc-500'}`}>
          {item.error ?? details}
          {result && <Saved {...result} />}
        </p>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${item.file.name}`}
        className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
      >
        <XIcon className="size-4" />
      </button>
    </li>
  )
}

/** "→ 300 KB, 75% smaller" after a picture's details, or that it is unchanged. */
function Saved({ before, after }: Result) {
  if (after >= before) return <span> · unchanged</span>
  return (
    <span>
      {' → '}
      <span className="font-medium text-zinc-900 dark:text-zinc-100">{formatSize(after)}</span>,{' '}
      {percentSmaller(before, after)} smaller
    </span>
  )
}

function percentSmaller(before: number, after: number): string {
  const percent = Math.floor((1 - after / before) * 100)
  return percent < 1 ? 'under 1%' : `${percent}%`
}

function LevelPicker({
  name,
  levels,
  value,
  onChange,
  children,
}: {
  name: string
  levels: Level[]
  value: CompressLevel
  onChange: (level: CompressLevel) => void
  children: string
}) {
  return (
    <fieldset>
      <legend className="sr-only">How much to compress</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {levels.map((l) => (
          <label
            key={l.value}
            className={`cursor-pointer rounded-lg border px-3 py-2.5 has-focus-visible:outline-2 has-focus-visible:outline-rose-600 ${
              value === l.value
                ? 'border-rose-500 bg-rose-50 dark:bg-rose-950/30'
                : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'
            }`}
          >
            <input
              type="radio"
              name={name}
              value={l.value}
              checked={value === l.value}
              onChange={() => onChange(l.value)}
              className="sr-only"
            />
            <span className="block font-medium text-zinc-900 dark:text-zinc-100">{l.label}</span>
            <span className="block text-sm text-zinc-500">{l.hint}</span>
          </label>
        ))}
      </div>
      <p className="mt-2 text-sm text-zinc-500">{children}</p>
    </fieldset>
  )
}

/** How much smaller the result came out, for the line under its name. */
function Shrunk({ before, after }: Result) {
  if (after >= before) return <>Already as small as pdfer can make it.</>
  return (
    <>
      <span className="font-medium text-zinc-900 dark:text-zinc-100">
        {formatSize(before)} → {formatSize(after)}
      </span>
      , {percentSmaller(before, after)} smaller
    </>
  )
}
