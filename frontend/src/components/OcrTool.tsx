import { useEffect, useState } from 'react'
import { readOcrStatus, type OcrEngine, type OcrStatus } from '../lib/api'
import { pickFiles } from '../lib/files'
import { useHandoff, useReceive } from '../lib/handoff'
import { OCR_DPI, ocrPages, recognizePdf, type OcrProgress } from '../lib/ocr'
import { pdfPassword } from '../lib/passwords'
import { formatSize, type PDFDocumentProxy } from '../lib/pdf'
import { usePdfTask } from '../lib/usePdfTask'
import { useWindowDrop } from '../lib/windowDrop'
import { Dropzone } from './Dropzone'
import { PdfPages, PdfToolPreview } from './PdfToolPreview'
import { Button, DropOverlay, ErrorMessage, FIELD } from './ui'

const LANGUAGE_NAMES: Record<string, string> = { eng: 'English', fra: 'French', deu: 'German', spa: 'Spanish', ita: 'Italian', por: 'Portuguese', chi_sim: 'Chinese (simplified)', chi_tra: 'Chinese (traditional)', jpn: 'Japanese', kor: 'Korean', ara: 'Arabic', hin: 'Hindi', rus: 'Russian', nld: 'Dutch' }

async function inspect(file: File, doc: PDFDocumentProxy) {
  if (file.size > 128 * 1024 * 1024) throw new Error('Choose a PDF under 128 MB, or split it first.')
  ocrPages('', doc.numPages)
  return doc.numPages
}

export function OcrTool({ active = true }: { active?: boolean }) {
  const [engine, setEngine] = useState<OcrEngine>('tesseract')
  const [status, setStatus] = useState<OcrStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [check, setCheck] = useState(0)
  const [languages, setLanguages] = useState<string[]>([])
  const [spec, setSpec] = useState('')
  const [dpi, setDpi] = useState(300)
  const [page, setPage] = useState(1)
  const [progress, setProgress] = useState<OcrProgress | null>(null)
  const task = usePdfTask(inspect, JSON.stringify({ engine, languages, spec, dpi }))
  const handoff = useHandoff()

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    void readOcrStatus(controller.signal, engine).then((value) => {
      if (controller.signal.aborted) return
      setStatusError(null)
      setStatus(value)
      setLanguages((current) => {
        const kept = current.filter((language) => value.languages.includes(language))
        return kept.length ? kept : value.languages.includes('eng') ? ['eng'] : value.languages.slice(0, 1)
      })
    }).catch((error: Error) => { if (!controller.signal.aborted) setStatusError(error.message) })
    return () => controller.abort()
  }, [active, check, engine])

  function changeEngine(next: OcrEngine) {
    task.invalidate()
    setEngine(next); setStatus(null); setStatusError(null); setLanguages([]); setProgress(null)
  }

  async function open(file: File) { setSpec(''); setPage(1); setProgress(null); await task.open(file) }
  function take(files: File[]) { const [file] = pickFiles(files, 'pdf').wanted; if (file) void open(file) }
  const dragging = useWindowDrop(take, active)
  useReceive('ocr', take)
  let count = 0, problem: string | null = null
  if (task.doc) {
    try { count = ocrPages(spec, task.doc.numPages).length }
    catch (error) { problem = (error as Error).message }
  }
  return <div className="space-y-5">
    {dragging && <DropOverlay label="Drop a PDF to recognize text locally" />}
    <p className="text-sm text-zinc-500">Make scanned pages searchable and selectable. Recognition runs on this computer. Pages that already contain text are skipped; all original pages remain in the output.</p>
    <label className="block space-y-1 text-sm">OCR engine<select aria-label="OCR engine" value={engine} onChange={(event) => changeEngine(event.target.value as OcrEngine)} className={`${FIELD} block w-full py-2`}>
      <option value="tesseract">Tesseract</option>
      <option value="paddleocr">PaddleOCR PP-OCRv6 · medium</option>
    </select></label>
    <p className="text-xs text-zinc-500">{engine === 'paddleocr' ? 'Optional multilingual model. Uses more memory and loads its models for each page. Documents are processed locally.' : 'Lightweight local OCR with a choice of installed language packs.'}</p>
    {(!status || !status.available || statusError) && <div className="space-y-3 rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
      <p role="status">{statusError ?? status?.message ?? 'Checking the local OCR engine…'}</p>
      {status && !status.available && (engine === 'paddleocr'
        ? <p className="text-zinc-500">Setup downloads the optional runtime and official model weights. Recognition uses the installed local files. Tesseract remains available independently.</p>
        : <p className="text-zinc-500">Linux: install <code>tesseract-ocr</code> and the language packs you need. Windows: install Tesseract and add it to PATH. See the README for setup.</p>)}
      <button type="button" onClick={() => { task.invalidate(); setStatus(null); setStatusError(null); setCheck((value) => value + 1) }} className="text-rose-600 hover:underline">Check again</button>
    </div>}
    {!task.file ? <Dropzone title="Choose a PDF to recognize text" onFiles={take} /> : <>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="min-w-0"><p className="truncate font-medium">{task.file.name}</p><p className="text-sm text-zinc-500">{formatSize(task.file.size)}{task.doc && ` · ${task.doc.numPages} pages`}</p></div>
        <button type="button" onClick={task.clear} className="shrink-0 text-sm text-zinc-500">Choose another file</button>
      </div>
      {!task.doc && !task.error && <p role="status" className="text-sm text-zinc-500">Opening PDF…</p>}
      {!task.doc && task.error && <Button onClick={() => void open(task.file!)}>Retry opening</Button>}
    </>}
    {task.error && <ErrorMessage>{task.error}</ErrorMessage>}
    {task.doc && <>
      <fieldset disabled={task.busy} className="space-y-4 disabled:opacity-60">
        <legend className="sr-only">OCR settings</legend>
        {engine === 'paddleocr' ? <div className="space-y-1 text-sm"><p className="font-medium">Automatic multilingual recognition</p><p className="text-zinc-500">The unified model recognizes Chinese, English, Japanese, and supported Latin-script languages. Use Tesseract’s language packs for other scripts.</p></div> : <div className="space-y-2"><p className="text-sm font-medium">Document languages</p>
          <div className="flex max-h-48 flex-wrap gap-x-5 gap-y-2 overflow-auto">{status?.languages.map((language) => <label key={language} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={languages.includes(language)} disabled={!languages.includes(language) && languages.length >= 8} onChange={(event) => { task.invalidate(); setLanguages((current) => event.target.checked ? [...current, language] : current.filter((value) => value !== language)) }} />{LANGUAGE_NAMES[language] ?? language} <span className="text-xs text-zinc-500">({language})</span></label>)}</div>
          <p className="text-xs text-zinc-500">Choose the languages printed on the page. Only installed language packs are listed.</p>
        </div>}
        <label className="block space-y-1 text-sm">Pages<input aria-label="Pages to recognize" placeholder="All pages, or 1-3, 5, 8-" value={spec} onChange={(event) => { task.invalidate(); setSpec(event.target.value) }} className={`${FIELD} block w-full px-3 py-2`} /></label>
        {problem ? <ErrorMessage>{problem}</ErrorMessage> : <p className="text-xs text-zinc-500">{count} pages selected. Leave blank for all pages.</p>}
        <label className="block space-y-1 text-sm">Recognition resolution<select value={dpi} onChange={(event) => { task.invalidate(); setDpi(Number(event.target.value)) }} className={`${FIELD} block w-full py-2`}>{OCR_DPI.map((value) => <option key={value} value={value}>{value} DPI · {value === 300 ? 'recommended for accuracy' : 'faster, less memory'}</option>)}</select></label>
      </fieldset>
      <p className="text-sm text-zinc-500">Best for upright printed text. Recognition can make mistakes; review the extracted text before using it. The PDF’s appearance is preserved.</p>
      {pdfPassword(task.file!) && <p className="text-sm text-zinc-500">The searchable copy keeps this PDF’s opening password.</p>}
      {task.busy && progress && <div className="space-y-2 text-sm"><p role="status">{progress.phase === 'assemble' ? 'Building the searchable PDF…' : `${progress.phase === 'inspect' ? 'Checking' : progress.phase === 'render' ? 'Rendering' : 'Recognizing text on'} page ${progress.page}…`} {progress.completed} of {progress.total} selected pages checked{progress.skipped ? ` · ${progress.skipped} already have text` : ''}</p><progress aria-label="OCR progress" value={progress.completed} max={progress.total} className="h-2 w-full accent-rose-600" /></div>}
      <div className="flex flex-wrap items-center gap-4">
        <Button disabled={task.busy || !status?.available || !!statusError || !languages.length || !!problem} onClick={() => { setProgress(null); void task.preview((file, signal) => recognizePdf(task.doc!, file, spec, languages, dpi, signal, setProgress, engine)) }}>{task.busy ? 'Recognizing text…' : 'Recognize text'}</Button>
        {task.busy && <button type="button" onClick={task.cancel} className="text-sm text-zinc-500">Cancel OCR</button>}
        {handoff && !task.busy && <button type="button" onClick={() => handoff.send('text', task.result?.file ?? task.file!)} className="text-sm text-rose-600 hover:underline">Open {task.result ? 'result' : 'original'} in Search & text</button>}
      </div>
      {task.cancelled && <p role="status" className="text-sm text-zinc-500">OCR cancelled. No partial result was created.</p>}
      {task.result ? <>
        <p role="status" className="text-sm text-zinc-500">OCR completed for {progress?.recognized} {progress?.recognized === 1 ? 'page' : 'pages'}; {progress?.skipped} {progress?.skipped === 1 ? 'page with existing text was' : 'pages with existing text were'} skipped. Use Search & text to review, copy, or export the recognized text.</p>
        <PdfToolPreview result={task.result} from="ocr" page={page} onPage={setPage} onDismiss={task.dismiss} />
      </> : <PdfPages doc={task.doc} page={page} onPage={setPage} label="Original PDF" />}
    </>}
  </div>
}
