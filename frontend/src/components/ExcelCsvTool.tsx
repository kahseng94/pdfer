import { useEffect, useRef, useState } from 'react'
import { excelToCsv, readWorkbookSheets } from '../lib/api'
import { pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import { formatSize } from '../lib/pdf'
import { useResult } from '../lib/result'
import { CSV_DELIMITERS, csvRows, MAX_WORKBOOK_BYTES, sheetSize, type CsvDelimiter, type CsvSummary, type WorkbookSheets } from '../lib/spreadsheets'
import { useWindowDrop } from '../lib/windowDrop'
import { Dropzone } from './Dropzone'
import { ResultCard } from './ResultCard'
import { Button, DropOverlay, ErrorMessage, FIELD } from './ui'

const PREVIEW_ROWS = 10

type Made = { file: File; summary: CsvSummary | null; preview: string[][] | null }

/** Saves one worksheet, or all of them in a ZIP, as CSV. */
export function ExcelCsvTool({ active = true }: { active?: boolean }) {
  const [file, setFile] = useState<File | null>(null)
  const [workbook, setWorkbook] = useState<WorkbookSheets | null>(null)
  const [reading, setReading] = useState(false)
  const [sheet, setSheet] = useState<number | 'all'>(0)
  const [delimiter, setDelimiter] = useState<CsvDelimiter>('comma')
  const [bom, setBom] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const result = useResult<Made>([file, sheet, delimiter, bom])
  const pending = useRef<AbortController | null>(null)

  useEffect(() => () => pending.current?.abort(), [])

  function stop() {
    pending.current?.abort()
    pending.current = null
    setBusy(false)
    setReading(false)
  }

  async function open(next: File) {
    stop()
    result.clear()
    setFile(next)
    setWorkbook(null)
    setSheet(0)
    setError(null)
    if (!next.size) { setError('This workbook is empty. Choose a file with content.'); return }
    if (next.size > MAX_WORKBOOK_BYTES) { setError('Choose a workbook of 64 MB or smaller.'); return }
    const controller = new AbortController()
    pending.current = controller
    setReading(true)
    try {
      const sheets = await readWorkbookSheets(next, controller.signal)
      if (controller.signal.aborted) return
      setWorkbook(sheets)
      setSheet(sheets.active)
    } catch (err) {
      if (!controller.signal.aborted) setError((err as Error).message)
    } finally {
      if (pending.current === controller) { pending.current = null; setReading(false) }
    }
  }

  function take(files: File[]) {
    const { wanted, skipped } = pickFiles(files, 'xlsx')
    const hint = files.some((f) => /\.xls$/i.test(f.name))
      ? 'Old .xls workbooks can’t be read here. Open it in Excel or LibreOffice and save it as .xlsx first.'
      : skipped ? 'Only Excel workbooks (.xlsx or .xlsm) can be converted here.' : null
    setNotice(wanted.length > 1 ? 'One workbook is converted at a time. Only the first one was opened.' : hint)
    if (wanted.length) void open(wanted[0])
  }
  const dragging = useWindowDrop(take, active)
  useReceive('excel-csv', take)

  async function convert() {
    if (!file || !workbook || busy) return
    stop()
    setError(null)
    setNotice(null)
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    const finish = result.begin()
    try {
      const made = await excelToCsv(file, { sheet, delimiter, bom }, controller.signal)
      if (controller.signal.aborted) return
      const separator = CSV_DELIMITERS.find((d) => d.value === delimiter)!.char
      const preview = /\.csv$/i.test(made.file.name)
        ? csvRows(await made.file.slice(0, 256 * 1024).text(), separator, PREVIEW_ROWS)
        : null
      if (controller.signal.aborted) return
      finish({ ...made, preview })
    } catch (err) {
      if (!controller.signal.aborted) setError((err as Error).message)
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false) }
    }
  }

  const overlay = dragging && <DropOverlay label="Drop an Excel workbook to convert" />
  if (!file) {
    return <div className="space-y-3">
      {overlay}
      <Dropzone kind="xlsx" title="Choose an Excel workbook" onFiles={take} onSkipped={take} />
      {notice && <p role="status" className="text-sm text-zinc-500">{notice}</p>}
    </div>
  }

  const sheets = workbook?.sheets ?? []
  const made = result.value
  return <div className="space-y-5">
    {overlay}
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="min-w-0">
        <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">{file.name}</p>
        <p className="text-sm text-zinc-500">
          {workbook ? `${sheets.length} ${sheets.length === 1 ? 'sheet' : 'sheets'} · ` : ''}{formatSize(file.size)}
        </p>
      </div>
      <button type="button" onClick={() => { stop(); result.clear(); setFile(null); setWorkbook(null); setError(null); setNotice(null) }} className="shrink-0 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        Choose another file
      </button>
    </div>
    {notice && <p role="status" className="text-sm text-zinc-500">{notice}</p>}
    {reading && <p role="status" className="text-sm text-zinc-500">Reading sheets…</p>}

    {workbook && <>
      <div className="flex flex-wrap items-end gap-x-5 gap-y-3 text-sm text-zinc-600 dark:text-zinc-400">
        {sheets.length > 1 && <label className="space-y-1">
          <span className="block">Sheet</span>
          <select value={String(sheet)} onChange={(e) => setSheet(e.target.value === 'all' ? 'all' : Number(e.target.value))} className={`${FIELD} block max-w-72`}>
            {sheets.map((s, index) => <option key={index} value={index}>{s.name}{s.hidden ? ' (hidden)' : ''}</option>)}
            <option value="all">All sheets (a ZIP with one CSV each)</option>
          </select>
        </label>}
        <label className="space-y-1">
          <span className="block">Separator</span>
          <select value={delimiter} onChange={(e) => setDelimiter(e.target.value as CsvDelimiter)} className={`${FIELD} block`}>
            {CSV_DELIMITERS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </label>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={bom} onChange={(e) => setBom(e.target.checked)} className="mt-0.5" />
        <span>
          <span className="font-medium">Mark the file as UTF-8 for Excel</span>
          <span className="block text-zinc-500">Excel then shows accents and other non-English letters correctly. Turn it off for tools that expect plain UTF-8 text.</span>
        </span>
      </label>
      <p className="text-sm text-zinc-500">
        Cells are saved as their values, not their formatting: 15% becomes 0.15 and dates are written like 2026-11-07.
        Formulas give the result last saved with the workbook.
      </p>
    </>}

    {error && <ErrorMessage>{error}</ErrorMessage>}
    {made && <ResultCard file={made.file} from="excel-csv" onDismiss={result.clear}>
      {made.summary && (made.summary.sheets.length === 1
        ? sheetSize(made.summary.sheets[0])
        : `${made.summary.sheets.length} sheets: ${made.summary.sheets.map((s) => s.name).join(', ')}`)}
    </ResultCard>}
    {made?.summary && made.summary.uncalculated > 0 && <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
      {made.summary.uncalculated === 1 ? '1 formula was' : `${made.summary.uncalculated.toLocaleString('en-US')} formulas were`} saved
      without a result, so {made.summary.uncalculated === 1 ? 'its cell is' : 'their cells are'} empty in the CSV.
      Open the workbook in Excel or LibreOffice, save it, and convert it again.
    </p>}
    {made?.preview && made.preview.length > 0 && <CsvPreview rows={made.preview} total={made.summary?.sheets[0]?.rows ?? null} />}

    <div className="tool-actions">
      <Button onClick={() => void convert()} disabled={!workbook || busy}>{busy ? 'Converting…' : sheet === 'all' ? 'Convert every sheet to CSV' : 'Convert to CSV'}</Button>
      {busy && <button type="button" onClick={() => { stop(); setNotice('Conversion cancelled.') }} className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">Cancel conversion</button>}
    </div>
  </div>
}

/** The first rows of the CSV just made, so the separator and values can be checked before downloading. */
function CsvPreview({ rows, total }: { rows: string[][]; total: number | null }) {
  const width = Math.max(...rows.map((row) => row.length))
  return <figure className="space-y-1">
    <figcaption className="text-sm text-zinc-500">
      {total !== null && total > rows.length ? `First ${rows.length} of ${total.toLocaleString('en-US')} rows` : 'Preview'}
    </figcaption>
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table aria-label="CSV preview" className="min-w-full text-left text-sm">
        <tbody>
          {rows.map((row, r) => <tr key={r} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
            {Array.from({ length: width }, (_, c) => <td key={c} title={row[c]} className="max-w-48 truncate px-2 py-1 font-mono text-xs text-zinc-700 dark:text-zinc-300">{row[c] ?? ''}</td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
  </figure>
}
