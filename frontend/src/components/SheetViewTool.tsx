import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { viewSpreadsheet } from '../lib/api'
import { FILE_KINDS, pickFiles } from '../lib/files'
import { useHandoff, useReceive } from '../lib/handoff'
import { formatSize } from '../lib/pdf'
import { cellDetails, cellKey, cellName, cellText, columnWidths, estimateWidth, findCells, type CellPosition, type SheetView } from '../lib/sheetView'
import { CSV_DELIMITERS, MAX_WORKBOOK_BYTES, separatorName, sheetSize, type CsvDelimiter } from '../lib/spreadsheets'
import { targetsFor } from '../lib/tools'
import { useWindowDrop } from '../lib/windowDrop'
import { Dropzone } from './Dropzone'
import { ChevronDownIcon, ChevronUpIcon } from './icons'
import { SheetGrid } from './SheetGrid'
import { DropOverlay, ErrorMessage, FIELD, IconButton } from './ui'

const MATCH_LIMIT = 10_000
type Separator = CsvDelimiter | 'auto'

/** Text widths in the grid's font, or an estimate where there is no canvas to measure with. */
function gridTextWidth(): (text: string) => number {
  const context = document.createElement('canvas').getContext?.('2d')
  if (!context) return estimateWidth
  context.font = `14px ${getComputedStyle(document.body).fontFamily || 'sans-serif'}`
  return (text) => context.measureText(text).width
}

/** Shows one sheet of a workbook, or a CSV file, as a read-only grid. */
export function SheetViewTool({ active = true }: { active?: boolean }) {
  const [file, setFile] = useState<File | null>(null)
  const [view, setView] = useState<SheetView | null>(null)
  // The sheet being opened while another is still shown.
  const [opening, setOpening] = useState<number | null>(null)
  const [delimiter, setDelimiter] = useState<Separator>('auto')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // The chosen cell and match, and the search they were chosen under.
  const [selection, setSelection] = useState<{ cell: CellPosition | null; search: string; index: number }>({ cell: null, search: '', index: 0 })
  const [query, setQuery] = useState('')
  const pending = useRef<AbortController | null>(null)
  // Sheets already read from the current file, by sheet and separator.
  const cache = useRef(new Map<string, SheetView>())
  const handoff = useHandoff()

  useEffect(() => () => pending.current?.abort(), [])

  function show(next: SheetView) {
    setView(next)
    setSelection({ cell: null, search: '', index: 0 })
  }

  async function load(target: File, sheet: number | null, separator: Separator) {
    pending.current?.abort()
    pending.current = null
    const key = `${sheet ?? 'first'}|${separator}`
    const known = cache.current.get(key)
    if (known) { setLoading(false); setOpening(null); show(known); return }
    const controller = new AbortController()
    pending.current = controller
    setLoading(true)
    setOpening(sheet)
    setError(null)
    try {
      const next = await viewSpreadsheet(target, { sheet, delimiter: separator }, controller.signal)
      if (controller.signal.aborted) return
      cache.current.set(key, next)
      cache.current.set(`${next.sheet}|${separator}`, next)
      show(next)
    } catch (err) {
      if (!controller.signal.aborted) setError((err as Error).message)
    } finally {
      if (pending.current === controller) { pending.current = null; setLoading(false); setOpening(null) }
    }
  }

  function open(next: File) {
    cache.current.clear()
    setFile(next)
    setView(null)
    setDelimiter('auto')
    setQuery('')
    setError(null)
    if (!next.size) { pending.current?.abort(); setError('This file is empty. Choose a file with content.'); return }
    if (next.size > MAX_WORKBOOK_BYTES) { pending.current?.abort(); setError('Choose a file of 64 MB or smaller.'); return }
    void load(next, null, 'auto')
  }

  function take(files: File[]) {
    const { wanted, skipped } = pickFiles(files, 'sheet')
    const hint = files.some((f) => /\.xls$/i.test(f.name))
      ? 'Old .xls workbooks can’t be read here. Open it in Excel or LibreOffice and save it as .xlsx first.'
      : skipped ? 'Only Excel workbooks (.xlsx, .xlsm) and CSV files (.csv, .tsv) can be viewed here.' : null
    setNotice(wanted.length > 1 ? 'One spreadsheet is shown at a time. Only the first one was opened.' : hint)
    if (wanted.length) open(wanted[0])
  }
  const dragging = useWindowDrop(take, active)
  useReceive('sheet-view', take)

  const widths = useMemo(() => (view ? columnWidths(view, gridTextWidth()) : []), [view])
  const details = useMemo(() => (view ? cellDetails(view) : null), [view])
  const search = useDeferredValue(query.trim())
  const matches = useMemo(() => (view && search ? findCells(view, search, MATCH_LIMIT) : []), [view, search])
  const matchKeys = useMemo(() => new Set(view ? matches.map((cell) => cellKey(view, cell)) : []), [view, matches])
  // A new search goes straight to its first match, as Find does in a spreadsheet app.
  const fresh = selection.search !== search
  const matchIndex = fresh ? 0 : Math.min(selection.index, Math.max(matches.length - 1, 0))
  const selected = fresh && matches.length ? matches[0] : selection.cell
  const current = matches.length ? matches[matchIndex] : null

  function select(cell: CellPosition) {
    setSelection({ cell, search, index: matchIndex })
  }

  function step(by: number) {
    if (!matches.length) return
    const next = (matchIndex + by + matches.length) % matches.length
    setSelection({ cell: matches[next], search, index: next })
  }

  const overlay = dragging && <DropOverlay label="Drop a spreadsheet to view" />
  if (!file) {
    return <div className="space-y-3">
      {overlay}
      <Dropzone kind="sheet" title="Choose a spreadsheet" onFiles={take} onSkipped={take} />
      {notice && <p role="status" className="text-sm text-zinc-500">{notice}</p>}
    </div>
  }

  const isCsv = FILE_KINDS.csv.is(file)
  const targets = handoff ? targetsFor(file, 'sheet-view') : []
  const shownSheet = opening ?? view?.sheet ?? 0
  const selectedKey = view && selected ? cellKey(view, selected) : null
  const formula = selectedKey === null ? undefined : details?.formulas.get(selectedKey)
  const stored = selectedKey === null ? undefined : details?.values.get(selectedKey)
  const shown = view && selected ? cellText(view.rows[selected.row]?.[selected.column]) : ''

  return <div className="space-y-4">
    {overlay}
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="min-w-0">
        <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">{file.name}</p>
        <p className="text-sm text-zinc-500">
          {view ? `${sheetSize({ name: '', rows: view.rows.length, columns: view.columns })} · ` : ''}{formatSize(file.size)}
        </p>
      </div>
      <button type="button" onClick={() => { pending.current?.abort(); setFile(null); setView(null); setError(null); setNotice(null); setLoading(false) }} className="shrink-0 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        Choose another file
      </button>
    </div>
    {targets.length > 0 && <div className="flex flex-wrap items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
      <span className="mr-0.5">Open in</span>
      {targets.map((t) => <button key={t.id} type="button" onClick={() => handoff?.send(t.id, file)} aria-label={`Open in ${t.label}`} className="rounded-md border border-zinc-300 px-2.5 py-1 font-medium text-zinc-800 hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:border-zinc-600 dark:hover:bg-zinc-800">{t.label}</button>)}
    </div>}
    {notice && <p role="status" className="text-sm text-zinc-500">{notice}</p>}
    {error && <ErrorMessage>{error}</ErrorMessage>}

    {view && view.sheets.length > 1 && <div role="tablist" aria-label="Sheets" className="flex gap-1 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
      {view.sheets.map((sheet, index) => <button
        key={index}
        type="button"
        role="tab"
        aria-selected={index === shownSheet}
        onClick={() => { if (index !== shownSheet) void load(file, index, delimiter) }}
        className={`-mb-px shrink-0 border-b-2 px-3 py-1.5 text-sm whitespace-nowrap ${index === shownSheet ? 'border-rose-600 font-medium text-zinc-900 dark:text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'} ${sheet.hidden ? 'italic' : ''}`}
      >{sheet.name}{sheet.hidden ? ' (hidden)' : ''}</button>)}
    </div>}

    {view && <div className="flex flex-wrap items-end gap-x-4 gap-y-2 text-sm text-zinc-600 dark:text-zinc-400">
      <label className="min-w-48 flex-1 space-y-1">
        <span className="block">Find</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1) } }}
          placeholder="Text or number as shown"
          className={`${FIELD} block w-full`}
        />
      </label>
      {search && <div className="flex items-center gap-1 pb-1">
        <span role="status" className="mr-1 tabular-nums">
          {!matches.length ? 'No matches' : `${(matchIndex + 1).toLocaleString('en-US')} of ${matches.length.toLocaleString('en-US')}${matches.length >= MATCH_LIMIT ? '+' : ''}`}
        </span>
        <IconButton label="Previous match" disabled={!matches.length} onClick={() => step(-1)}><ChevronUpIcon className="size-4" /></IconButton>
        <IconButton label="Next match" disabled={!matches.length} onClick={() => step(1)}><ChevronDownIcon className="size-4" /></IconButton>
      </div>}
      {isCsv && <label className="space-y-1">
        <span className="block">Separator</span>
        <select value={delimiter} onChange={(e) => { const next = e.target.value as Separator; setDelimiter(next); void load(file, null, next) }} className={`${FIELD} block`}>
          <option value="auto">{view.csv && delimiter === 'auto' ? `Detected: ${separatorName(view.csv.delimiter)}` : 'Detect automatically'}</option>
          {CSV_DELIMITERS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
      </label>}
    </div>}

    {loading && <p role="status" className="text-sm text-zinc-500">{view ? 'Opening sheet…' : 'Opening spreadsheet…'}</p>}
    {view?.csv && <p className="text-sm text-zinc-500">Read as {view.csv.encoding} text.</p>}
    {view?.truncated && <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
      This sheet is too large to show in full, so only its first {view.rows.length.toLocaleString('en-US')} rows are shown.
      {isCsv ? ' Search covers these rows only.' : ' Excel to CSV saves every row.'}
    </p>}

    {view && (view.rows.length === 0
      ? <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700">This sheet is empty.</p>
      : <>
        <div className="flex min-h-10 items-start gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900">
          <span className="w-14 shrink-0 font-mono text-xs leading-5 text-zinc-500">{selected ? cellName(selected) : ''}</span>
          <output aria-label="Selected cell" className="max-h-24 min-w-0 flex-1 overflow-auto break-words whitespace-pre-wrap select-text">
            {!selected ? <span className="text-zinc-500">Select a cell to see all of its content.</span>
              : formula ? <><span className="font-mono">{formula}</span>{shown && <span className="text-zinc-500"> = {shown}</span>}</>
                : <>{shown}{stored && <span className="text-zinc-500"> (stored as {stored})</span>}</>}
          </output>
        </div>
        <SheetGrid view={view} widths={widths} label={`${view.sheets[view.sheet]?.name ?? file.name} cells`} selected={selected} onSelect={select} matches={matchKeys} current={current} />
      </>)}
  </div>
}
