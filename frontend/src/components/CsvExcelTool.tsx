import { useEffect, useRef, useState } from 'react'
import { csvToExcel } from '../lib/api'
import { FILE_KINDS, pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import { formatSize } from '../lib/pdf'
import { useResult } from '../lib/result'
import { CSV_DELIMITERS, MAX_CSV_BYTES, MAX_CSV_FILES, separatorName, sheetSize, type CsvDelimiter, type WorkbookSummary } from '../lib/spreadsheets'
import { useWindowDrop } from '../lib/windowDrop'
import { Dropzone } from './Dropzone'
import { ChevronDownIcon, ChevronUpIcon, XIcon } from './icons'
import { ResultCard } from './ResultCard'
import { Button, DropOverlay, ErrorMessage, FIELD, IconButton } from './ui'

type Item = { id: number; file: File }
type Made = { file: File; summary: WorkbookSummary | null }

/** Puts each CSV file on its own sheet of a new workbook. */
export function CsvExcelTool({ active = true }: { active?: boolean }) {
  const [items, setItems] = useState<Item[]>([])
  const [delimiter, setDelimiter] = useState<CsvDelimiter | 'auto'>('auto')
  const [detectTypes, setDetectTypes] = useState(true)
  const [header, setHeader] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const result = useResult<Made>([delimiter, detectTypes, header, ...items.map((item) => item.file)])
  const pending = useRef<AbortController | null>(null)
  const nextId = useRef(0)

  useEffect(() => () => pending.current?.abort(), [])

  function stop() {
    pending.current?.abort()
    pending.current = null
    setBusy(false)
  }

  function take(files: File[]) {
    const { wanted, skipped } = pickFiles(files, 'csv')
    let message = !skipped ? null
      : files.some(FILE_KINDS.xlsx.is) ? 'Excel workbooks were not added. Use Excel to CSV to convert workbooks.'
        : `Skipped ${skipped} ${skipped === 1 ? 'file that isn’t' : 'files that aren’t'} CSV (.csv or .tsv).`
    if (wanted.length) {
      stop()
      const room = MAX_CSV_FILES - items.length
      const added = wanted.slice(0, Math.max(room, 0)).map((file) => ({ id: nextId.current++, file }))
      setItems((prev) => [...prev, ...added])
      setError(null)
      if (added.length < wanted.length) message = `A workbook can be made from up to ${MAX_CSV_FILES} CSV files. The rest were not added.`
    }
    setNotice(message)
  }
  const dragging = useWindowDrop(take, active)
  useReceive('csv-excel', take)

  function move(index: number, by: number) {
    setItems((prev) => {
      const next = [...prev]
      const [item] = next.splice(index, 1)
      next.splice(index + by, 0, item)
      return next
    })
  }

  const total = items.reduce((sum, item) => sum + item.file.size, 0)
  const empty = items.find((item) => !item.file.size)
  const problem = empty ? `${empty.file.name} is empty. Remove it or choose a file with content.`
    : total > MAX_CSV_BYTES ? 'CSV files must be 64 MB or smaller in total. Remove some files.' : null

  async function convert() {
    if (!items.length || busy || problem) return
    stop()
    setError(null)
    setNotice(null)
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    const finish = result.begin()
    try {
      const made = await csvToExcel(items.map((item) => item.file), { delimiter, detectTypes, header }, controller.signal)
      if (!controller.signal.aborted) finish(made)
    } catch (err) {
      if (!controller.signal.aborted) setError((err as Error).message)
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false) }
    }
  }

  const overlay = dragging && <DropOverlay label="Drop CSV files to convert" />
  if (!items.length) {
    return <div className="space-y-3">
      {overlay}
      <Dropzone kind="csv" multiple title="Choose CSV files" onFiles={take} onSkipped={take} />
      {notice && <p role="status" className="text-sm text-zinc-500">{notice}</p>}
    </div>
  }

  const count = items.length
  const made = result.value
  return <div className="space-y-5">
    {overlay}
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {count === 1 ? '1 file becomes one sheet' : `${count} files become ${count} sheets, in this order`} · {formatSize(total)}
        </p>
        <button type="button" onClick={() => { stop(); setItems([]); setError(null); setNotice(null) }} className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Clear all</button>
      </div>
      <ul className="space-y-2">
        {items.map((item, index) => <li key={item.id} className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white py-2 pr-2 pl-3 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">{item.file.name}</p>
            <p className="text-sm text-zinc-500">{formatSize(item.file.size)}</p>
          </div>
          {count > 1 && <>
            <IconButton label={`Move ${item.file.name} up`} disabled={index === 0} onClick={() => move(index, -1)}><ChevronUpIcon className="size-4" /></IconButton>
            <IconButton label={`Move ${item.file.name} down`} disabled={index === count - 1} onClick={() => move(index, 1)}><ChevronDownIcon className="size-4" /></IconButton>
          </>}
          <IconButton label={`Remove ${item.file.name}`} onClick={() => setItems((prev) => prev.filter((other) => other.id !== item.id))}><XIcon className="size-4" /></IconButton>
        </li>)}
      </ul>
      {count < MAX_CSV_FILES && <Dropzone kind="csv" multiple compact title="Add more CSV files" onFiles={take} onSkipped={take} />}
    </div>
    {notice && <p role="status" className="text-sm text-zinc-500">{notice}</p>}

    <label className="block space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
      <span className="block">Separator</span>
      <select value={delimiter} onChange={(e) => setDelimiter(e.target.value as CsvDelimiter | 'auto')} className={`${FIELD} block`}>
        <option value="auto">Detect automatically</option>
        {CSV_DELIMITERS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
      </select>
    </label>
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" checked={detectTypes} onChange={(e) => setDetectTypes(e.target.checked)} className="mt-0.5" />
      <span>
        <span className="font-medium">Turn numbers, dates and TRUE/FALSE into Excel values</span>
        <span className="block text-zinc-500">Numbers with leading zeros or more than 15 digits stay as text, so codes and IDs never change. Dates must be written like 2026-11-07.</span>
      </span>
    </label>
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} className="mt-0.5" />
      <span>
        <span className="font-medium">The first row holds column names</span>
        <span className="block text-zinc-500">It is made bold, stays in view while scrolling, and gets filter buttons.</span>
      </span>
    </label>
    <p className="text-sm text-zinc-500">Text that starts with = is kept as text, so nothing in a CSV file can run as a formula.</p>

    {problem && <ErrorMessage>{problem}</ErrorMessage>}
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {made && <ResultCard file={made.file} from="csv-excel" onDismiss={result.clear}>
      {made.summary && made.summary.sheets.length === 1 && sheetSize(made.summary.sheets[0])}
      {made.summary && made.summary.sheets.length > 1 && `${made.summary.sheets.length} sheets`}
    </ResultCard>}
    {made?.summary && <ul aria-label="Sheets made" className="space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
      {made.summary.sheets.map((s) => <li key={s.name}>
        <span className="font-medium text-zinc-900 dark:text-zinc-100">{s.name}</span>
        {` · ${sheetSize(s)} · read as ${separatorName(s.delimiter)} ${s.encoding} text`}
        {s.source.replace(/\.[^.]+$/, '') !== s.name && ` from ${s.source}`}
      </li>)}
    </ul>}
    {made?.summary && made.summary.removed > 0 && <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
      Removed {made.summary.removed === 1 ? '1 control character' : `${made.summary.removed.toLocaleString('en-US')} control characters`} that Excel can’t store.
    </p>}

    <div className="tool-actions">
      <Button onClick={() => void convert()} disabled={busy || !!problem}>{busy ? 'Converting…' : `Convert ${count === 1 ? '1 file' : `${count} files`} to Excel`}</Button>
      {busy && <button type="button" onClick={() => { stop(); setNotice('Conversion cancelled.') }} className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">Cancel conversion</button>}
    </div>
  </div>
}
