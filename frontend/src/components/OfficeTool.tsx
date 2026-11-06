import { useEffect, useRef, useState } from 'react'
import { officeToPdf, readOfficeStatus } from '../lib/api'
import { pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import { MAX_OFFICE_BYTES, OFFICE_FORMATS, type OfficeKind, type OfficeStatus } from '../lib/office'
import { closePdf, formatSize, type PDFDocumentProxy } from '../lib/pdf'
import { usePdfLoader } from '../lib/usePdfLoader'
import type { PdfOutput } from '../lib/usePdfTask'
import { useWindowDrop } from '../lib/windowDrop'
import { Dropzone } from './Dropzone'
import { PdfToolPreview } from './PdfToolPreview'
import { Button, DropOverlay, ErrorMessage } from './ui'

export function OfficeTool({ kind, active = true }: { kind: OfficeKind; active?: boolean }) {
  const format = OFFICE_FORMATS[kind]
  const article = kind === 'excel' ? 'an' : 'a'
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState<OfficeStatus | null>(null)
  const [check, setCheck] = useState(0)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [output, setOutput] = useState<PdfOutput | null>(null)
  const [page, setPage] = useState(1)
  const pending = useRef<AbortController | null>(null)
  const preview = useRef<PDFDocumentProxy | null>(null)
  const loader = usePdfLoader()

  const checking = !status && !statusError

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    void readOfficeStatus(controller.signal).then((next) => {
      if (!controller.signal.aborted) { setStatus(next); setStatusError(null) }
    }).catch((err: Error) => {
      if (!controller.signal.aborted) { setStatus(null); setStatusError((err as Error).message) }
    })
    return () => controller.abort()
  }, [active, check])
  useEffect(() => () => { pending.current?.abort(); closePdf(preview.current) }, [])

  function invalidate() {
    pending.current?.abort(); pending.current = null
    loader.cancel(); setBusy(false)
    closePdf(preview.current); preview.current = null
    setOutput(null); setError(null); setNotice(null); setPage(1)
  }

  function take(files: File[]) {
    const { wanted, skipped } = pickFiles(files, kind)
    if (!wanted.length) { setNotice(`Choose ${article} ${format.label} file (${format.extensions}).`); return }
    invalidate()
    setFile(wanted[0])
    if (skipped || wanted.length > 1) setNotice('One document is converted at a time. Only the first matching file was selected.')
  }
  const dragging = useWindowDrop(take, active)
  useReceive(kind, take)
  const problem = file && (file.size === 0 ? 'This file is empty. Choose a file with content.' : file.size > MAX_OFFICE_BYTES ? 'Choose an Office file of 128 MB or smaller.' : null)

  async function convert() {
    if (!file || busy || checking || problem || !status?.available) return
    invalidate()
    const controller = new AbortController()
    pending.current = controller; setBusy(true)
    try {
      const pdf = await officeToPdf(file, kind, controller.signal)
      if (controller.signal.aborted) return
      const doc = await loader.load(pdf)
      if (controller.signal.aborted || pending.current !== controller) { closePdf(doc); return }
      preview.current = doc
      setOutput({ file: pdf, doc })
    } catch (err) {
      if (!controller.signal.aborted && pending.current === controller) setError((err as Error).message)
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false) }
    }
  }

  return <div className="space-y-4">
    {dragging && <DropOverlay label={`Drop ${article} ${format.label} file to convert`} />}
    <p className="text-sm text-zinc-600 dark:text-zinc-400">Convert {format.label} files ({format.extensions}) to PDF on this computer. One document at a time, up to 128 MB.</p>
    <div className="space-y-2 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
      <p role="status">{checking ? 'Checking LibreOffice…' : statusError ?? (status?.available ? 'LibreOffice is ready. Conversion runs locally.' : status?.message ?? 'LibreOffice is needed for Office conversion.')}</p>
      {!checking && !status?.available && <>
        <p>Install LibreOffice with Writer, Calc and Impress. {window.pdferDesktop ? 'Visit libreoffice.org in your browser to download it.' : <a href="https://www.libreoffice.org/download/download-libreoffice/" target="_blank" rel="noreferrer" className="text-rose-600 underline">Download from libreoffice.org</a>}</p>
        <button type="button" onClick={() => { setStatus(null); setStatusError(null); setCheck((value) => value + 1) }} className="font-medium text-rose-600">Check again</button>
      </>}
    </div>
    {file && <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="min-w-0"><p className="truncate font-medium">{file.name}</p><p className="text-sm text-zinc-500">{formatSize(file.size)}</p></div>
      <button type="button" onClick={() => { invalidate(); setFile(null) }} className="text-sm text-zinc-500">Remove</button>
    </div>}
    <Dropzone kind={kind} compact={!!file} title={file ? `Choose another ${format.label} file` : `Choose ${article} ${format.label} file to convert`} onFiles={take} />
    <p className="text-sm text-zinc-500">{format.hint} Review the preview before downloading.</p>
    {notice && <p role="status" className="text-sm text-zinc-500">{notice}</p>}
    {problem && <ErrorMessage>{problem}</ErrorMessage>}
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {file && <Button onClick={() => void convert()} disabled={busy || checking || !!problem || !status?.available}>{busy ? 'Converting to PDF…' : 'Convert to PDF'}</Button>}
    {busy && <button type="button" onClick={() => { invalidate(); setNotice('Conversion cancelled.') }} className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">Cancel conversion</button>}
    {output && <PdfToolPreview result={output} from={kind} page={page} onPage={setPage} onDismiss={invalidate} />}
  </div>
}
