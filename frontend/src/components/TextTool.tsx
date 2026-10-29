import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { saveFile } from '../lib/api'
import { pickFiles } from '../lib/files'
import { useHandoff, useReceive } from '../lib/handoff'
import { pdfPassword } from '../lib/passwords'
import { closePdf, formatSize, type PDFDocumentProxy } from '../lib/pdf'
import { exportText, extractPdfText, matchKey, MAX_MATCHES, runHighlights, searchText, textFile, textPages, type PageText, type SearchOptions, type TextMatch, type TextProgress, type TextScope } from '../lib/pdfText'
import { useResult } from '../lib/result'
import { usePdfLoader } from '../lib/usePdfLoader'
import { useWindowDrop } from '../lib/windowDrop'
import { Dropzone } from './Dropzone'
import { TextPage } from './TextPage'
import { Button, DropOverlay, ErrorMessage, FIELD } from './ui'

const SEARCH_DEFAULTS: SearchOptions = { matchCase: false, wholeWord: false }
const RESULT_WINDOW = 40

export function TextTool({ active = true }: { active?: boolean }) {
  const handoff = useHandoff()
  const [file, setFile] = useState<File | null>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [pages, setPages] = useState<PageText[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [progress, setProgress] = useState<TextProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<SearchOptions>(SEARCH_DEFAULTS)
  const [matchIndex, setMatchIndex] = useState<number | null>(0)
  const [page, setPage] = useState(1)
  const [view, setView] = useState<'pdf' | 'text'>('pdf')
  const [scope, setScope] = useState<TextScope>('all')
  const [spec, setSpec] = useState('')
  const [headings, setHeadings] = useState(true)
  const source = useRef<PDFDocumentProxy | null>(null)
  const version = useRef(0)
  const pending = useRef<AbortController | null>(null)
  const loader = usePdfLoader()
  const found = useMemo(() => searchText(pages ?? [], query, options), [pages, query, options])
  const selectedIndex = matchIndex === null || !found.matches.length ? null : Math.min(matchIndex, found.matches.length - 1)
  const current = selectedIndex === null ? null : found.matches[selectedIndex]
  const pageNumber = current?.page ?? page
  const currentPage = pages?.[pageNumber - 1]
  const pageMatches = useMemo(() => found.matches.filter((match) => match.page === pageNumber), [found, pageNumber])
  const pagesWithText = useMemo(() => pages?.filter((entry) => entry.text.trim()).length ?? 0, [pages])
  const exportPage = scope === 'page' ? pageNumber : 0
  const output = useMemo(() => {
    if (!pages) return { text: '', count: 0, hasText: false, error: null }
    try {
      const selected = textPages(scope, exportPage, spec, pages.length)
      return { text: exportText(pages, selected, headings), count: selected.length, hasText: selected.some((number) => pages[number - 1].text.trim()), error: null }
    } catch (err) {
      return { text: '', count: 0, hasText: false, error: (err as Error).message }
    }
  }, [pages, scope, exportPage, spec, headings])
  const copyResult = useResult<{ success: boolean; message: string }>([file, output.text])

  useEffect(() => () => {
    version.current += 1
    pending.current?.abort()
    closePdf(source.current)
  }, [])

  function reset() {
    version.current += 1
    pending.current?.abort()
    pending.current = null
    loader.cancel()
    closePdf(source.current)
    source.current = null
    setFile(null)
    setDoc(null)
    setPages(null)
    setBusy(false)
    setProgress(null)
    setCancelled(false)
    setError(null)
    setQuery('')
    setOptions(SEARCH_DEFAULTS)
    setMatchIndex(0)
    setPage(1)
    setScope('all')
    setSpec('')
    setHeadings(true)
    copyResult.clear()
  }

  async function extract(loaded: PDFDocumentProxy) {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setPages(null)
    setBusy(true)
    setCancelled(false)
    setError(null)
    setProgress({ completed: 0, total: loaded.numPages })
    copyResult.clear()
    try {
      const text = await extractPdfText(loaded, {
        signal: controller.signal,
        onProgress: (next) => { if (pending.current === controller) setProgress(next) },
      })
      if (pending.current === controller && !controller.signal.aborted) setPages(text)
    } catch (err) {
      if (pending.current === controller && !controller.signal.aborted) setError((err as Error).message)
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false); setProgress(null) }
    }
  }

  async function open(next: File) {
    reset()
    const currentVersion = version.current
    setFile(next)
    try {
      const loaded = await loader.load(next)
      if (version.current !== currentVersion) { closePdf(loaded); return }
      source.current = loaded
      setDoc(loaded)
      setSpec(loaded.numPages === 1 ? '1' : `1-${loaded.numPages}`)
      await extract(loaded)
    } catch (err) {
      if (version.current === currentVersion) setError((err as Error).message)
    }
  }

  function cancel() {
    pending.current?.abort()
    pending.current = null
    setBusy(false)
    setProgress(null)
    setCancelled(true)
  }

  function changeQuery(value: string) { setPage(pageNumber); setMatchIndex(0); setQuery(value) }
  function changeOptions(value: SearchOptions) { setPage(pageNumber); setMatchIndex(0); setOptions(value) }
  function chooseMatch(index: number) { setMatchIndex(index); setPage(found.matches[index].page) }
  function moveMatch(direction: number) {
    const count = found.matches.length
    if (!count) return
    if (selectedIndex !== null) chooseMatch((selectedIndex + direction + count) % count)
    else if (direction > 0) {
      const index = found.matches.findIndex((match) => match.page >= pageNumber)
      chooseMatch(index === -1 ? 0 : index)
    } else {
      const index = found.matches.findLastIndex((match) => match.page <= pageNumber)
      chooseMatch(index === -1 ? count - 1 : index)
    }
  }
  function choosePage(number: number) { setMatchIndex(null); setPage(number) }

  async function copy() {
    if (!output.hasText || output.error) return
    const finish = copyResult.begin()
    try {
      await navigator.clipboard.writeText(output.text)
      finish({ success: true, message: `Copied text from ${output.count} ${output.count === 1 ? 'page' : 'pages'}.` })
    } catch {
      finish({ success: false, message: 'Clipboard access was blocked. Select text in the Extracted text view, or download the TXT file.' })
    }
  }

  function take(files: File[]) {
    const [next] = pickFiles(files, 'pdf').wanted
    if (next) void open(next)
  }
  const dragging = useWindowDrop(take, active)
  useReceive('text', take)
  const overlay = dragging && <DropOverlay label="Drop a PDF to search and extract text" />
  if (!file) return <>{overlay}<Dropzone title="Choose a PDF to search or extract text" onFiles={take} /><p className="mt-3 text-sm text-zinc-500">Find existing PDF text, copy it, or save a TXT file. Use the OCR tab to recognize scanned pages first.</p></>
  const resultStart = Math.floor((selectedIndex ?? 0) / RESULT_WINDOW) * RESULT_WINDOW

  return <div className="space-y-5">
    {overlay}
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="min-w-0"><p className="truncate font-medium">{file.name}</p><p className="text-sm text-zinc-500">{doc ? `${doc.numPages} pages · ` : ''}{formatSize(file.size)}{pages && ` · ${pagesWithText} with text`}</p></div>
      <button type="button" onClick={reset} className="shrink-0 text-sm text-zinc-500 hover:underline">Choose another file</button>
    </div>
    {!doc && !error && <p role="status" className="text-sm text-zinc-500">Opening PDF…</p>}
    {busy && progress && <div className="space-y-2 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <p role="status" className="text-sm">Extracting text… {progress.completed} of {progress.total} pages</p>
      <progress aria-label="Text extraction progress" value={progress.completed} max={progress.total} className="h-2 w-full accent-rose-600" />
      <button type="button" onClick={cancel} className="text-sm text-rose-600 hover:underline">Cancel extraction</button>
    </div>}
    {cancelled && <p role="status" className="text-sm text-zinc-500">Extraction cancelled. Retry to search and export the complete document.</p>}
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {doc && !pages && !busy && <Button onClick={() => void extract(doc)}>Retry extraction</Button>}

    {pages && doc && <>
      {pagesWithText === 0 && <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">No extractable text was found. This PDF may contain scanned images or outlined letters. OCR is needed before its text can be searched or exported.</p>}
      {pagesWithText < pages.length && handoff && <div className="flex flex-wrap items-center gap-3 text-sm"><p className="text-zinc-500">Pages without extractable text may need OCR.</p><button type="button" onClick={() => handoff.send('ocr', file)} className="text-rose-600 hover:underline">Recognize scanned pages</button></div>}
      <div className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <label htmlFor="pdf-text-search" className="block text-sm font-medium">Find in document</label>
        <input id="pdf-text-search" type="search" value={query} onChange={(e) => changeQuery(e.target.value)} maxLength={256} disabled={!pagesWithText} placeholder="Search for a word or phrase" autoComplete="off" spellCheck={false}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); moveMatch(e.shiftKey ? -1 : 1) } }}
          aria-describedby="pdf-text-search-hint" className={`${FIELD} w-full px-3 py-2`} />
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={options.matchCase} onChange={(e) => changeOptions({ ...options, matchCase: e.target.checked })} className="accent-rose-600" />Match case</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={options.wholeWord} onChange={(e) => changeOptions({ ...options, wholeWord: e.target.checked })} className="accent-rose-600" />Whole words</label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <p role="status">{query.trim() ? found.matches.length ? `${selectedIndex === null ? '' : `${selectedIndex + 1} of `}${found.matches.length.toLocaleString()} matches${found.limited ? '+' : ''}` : 'No matches found.' : `Search across all ${pages.length} pages.`}</p>
          <div className="flex gap-3"><button type="button" onClick={() => moveMatch(-1)} disabled={!found.matches.length} className="text-rose-600 disabled:text-zinc-400">Previous match</button><button type="button" onClick={() => moveMatch(1)} disabled={!found.matches.length} className="text-rose-600 disabled:text-zinc-400">Next match</button></div>
        </div>
        <p id="pdf-text-search-hint" className="text-xs text-zinc-500">Enter finds the next match; Shift+Enter finds the previous one. Search includes phrases across line breaks.</p>
        {found.limited && <p className="text-sm text-amber-700 dark:text-amber-400">Showing the first {MAX_MATCHES.toLocaleString()} matches. Use a longer search to narrow the results.</p>}
      </div>

      {found.matches.length > 0 && <div className="space-y-2">
        <ol aria-label="Search results" start={resultStart + 1} className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
          {found.matches.slice(resultStart, resultStart + RESULT_WINDOW).map((match, index) => <li key={matchKey(match)}>
            <button type="button" onClick={() => chooseMatch(resultStart + index)} aria-current={selectedIndex === resultStart + index ? 'true' : undefined}
              className={`w-full rounded px-3 py-2 text-left text-sm break-words ${selectedIndex === resultStart + index ? 'bg-rose-50 ring-1 ring-rose-300 dark:bg-rose-950/30' : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'}`}>
              <span className="mr-2 font-medium">Page {match.page}</span><Snippet text={pages[match.page - 1].text} match={match} />
            </button>
          </li>)}
        </ol>
        {found.matches.length > RESULT_WINDOW && <div className="flex items-center justify-between gap-3 text-xs text-zinc-500">
          <button type="button" disabled={!resultStart} onClick={() => chooseMatch(Math.max(0, resultStart - RESULT_WINDOW))} className="text-rose-600 disabled:text-zinc-400">Earlier results</button>
          <span>Results {resultStart + 1}–{Math.min(resultStart + RESULT_WINDOW, found.matches.length)}</span>
          <button type="button" disabled={resultStart + RESULT_WINDOW >= found.matches.length} onClick={() => chooseMatch(resultStart + RESULT_WINDOW)} className="text-rose-600 disabled:text-zinc-400">More results</button>
        </div>}
      </div>}

      {currentPage && <div className="space-y-4 rounded-lg border border-zinc-200 bg-zinc-100/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/50">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <div className="flex gap-1 rounded bg-zinc-200/70 p-1 dark:bg-zinc-800">
            {(['pdf', 'text'] as const).map((value) => <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)} className={`rounded px-3 py-1 ${view === value ? 'bg-white shadow-sm dark:bg-zinc-950' : 'text-zinc-500'}`}>{value === 'pdf' ? 'PDF preview' : 'Extracted text'}</button>)}
          </div>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => choosePage(pageNumber - 1)} disabled={pageNumber <= 1} className="text-rose-600 disabled:text-zinc-400">Previous page</button>
            <label className="flex items-center gap-2">Page<select aria-label="Text preview page" value={pageNumber} onChange={(e) => choosePage(Number(e.target.value))} className={FIELD}>{pages.map((entry) => <option key={entry.page} value={entry.page}>{entry.page}</option>)}</select>of {pages.length}</label>
            <button type="button" onClick={() => choosePage(pageNumber + 1)} disabled={pageNumber >= pages.length} className="text-rose-600 disabled:text-zinc-400">Next page</button>
          </div>
        </div>
        {view === 'pdf' ? <TextPage doc={doc} page={currentPage} matches={pageMatches} current={current} /> : <PlainText page={currentPage} matches={pageMatches} current={current} />}
        {!currentPage.text.trim() && <p className="text-sm text-zinc-500">Page {pageNumber} has no extractable text. It may be blank or need OCR.</p>}
      </div>}

      <div className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="font-medium">Copy or export text</h2>
        <label className="block space-y-1 text-sm">Pages to export<select aria-label="Pages to export" value={scope} onChange={(e) => setScope(e.target.value as TextScope)} className={`${FIELD} block w-full py-2`}>
          <option value="all">All pages</option><option value="page">Current page ({pageNumber})</option><option value="ranges">Page ranges</option>
        </select></label>
        {scope === 'ranges' && <label className="block space-y-1 text-sm">Page ranges<input aria-label="Text export page ranges" value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="e.g. 1-3, 5, 8-" aria-invalid={!!output.error} autoComplete="off" spellCheck={false} className={`${FIELD} block w-full px-3 py-2 font-mono`} /></label>}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={headings} onChange={(e) => setHeadings(e.target.checked)} className="accent-rose-600" />Include page headings</label>
        <p className="text-sm text-zinc-500">Export keeps document page order. Reading order and spacing may vary in columns or tables.</p>
        {pdfPassword(file) && <p className="text-sm text-zinc-500">Copied and exported text has no password protection.</p>}
        {output.error && <ErrorMessage>{output.error}</ErrorMessage>}
        {!output.hasText && !output.error && <p className="text-sm text-zinc-500">The selected pages have no text to export.</p>}
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => void copy()} disabled={!output.hasText || !!output.error} className="flex-1 rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-medium disabled:text-zinc-400 dark:border-zinc-700">Copy text</button>
          <Button onClick={() => saveFile(textFile(file.name, output.text))} disabled={!output.hasText || !!output.error} className="flex-1">Download TXT</Button>
        </div>
        {copyResult.value && <p role="status" className={`text-sm ${copyResult.value.success ? 'text-zinc-500' : 'text-amber-700 dark:text-amber-400'}`}>{copyResult.value.message}</p>}
      </div>
    </>}
  </div>
}

function Snippet({ text, match }: { text: string; match: TextMatch }) {
  const start = Math.max(0, match.start - 45), end = Math.min(text.length, match.end + 65)
  return <span className="text-zinc-600 dark:text-zinc-400">{start > 0 && '…'}{text.slice(start, match.start).replace(/\s+/g, ' ')}<mark className="rounded bg-yellow-200 px-0.5 text-zinc-900">{text.slice(match.start, match.end).replace(/\s+/g, ' ')}</mark>{text.slice(match.end, end).replace(/\s+/g, ' ')}{end < text.length && '…'}</span>
}

function PlainText({ page, matches, current }: { page: PageText; matches: readonly TextMatch[]; current: TextMatch | null }) {
  const container = useRef<HTMLDivElement>(null)
  const activeMark = useRef<HTMLElement | null>(null)
  const nodes: ReactNode[] = []
  let from = 0
  const currentKey = current ? matchKey(current) : null
  for (const hit of runHighlights({ start: 0, end: page.text.length, item: 0 }, matches)) {
    nodes.push(page.text.slice(from, hit.start))
    const selected = matchKey(hit.match) === currentKey
    nodes.push(<mark key={matchKey(hit.match)} ref={selected ? activeMark : undefined} className={`rounded text-zinc-900 ${selected ? 'bg-orange-300 outline outline-orange-600' : 'bg-yellow-200'}`}>{page.text.slice(hit.start, hit.end)}</mark>)
    from = hit.end
  }
  nodes.push(page.text.slice(from))
  useEffect(() => {
    if (container.current && activeMark.current && currentKey) container.current.scrollTop = activeMark.current.offsetTop - container.current.clientHeight / 2
  }, [page, currentKey])
  return <div ref={container} role="region" aria-label={`Extracted text, page ${page.page}`} tabIndex={0} dir="auto" className="relative max-h-96 min-h-32 overflow-auto rounded border border-zinc-200 bg-white p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap break-words dark:border-zinc-700 dark:bg-zinc-950">{nodes}</div>
}
