import { useEffect, useRef, useState } from 'react'
import { protectPdf, unlockPdf } from '../lib/api'
import { pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import { passwordProblem, pdfPassword } from '../lib/passwords'
import { closePdf, formatSize, type PDFDocumentProxy } from '../lib/pdf'
import { usePdfLoader } from '../lib/usePdfLoader'
import { useResult } from '../lib/result'
import { useWindowDrop } from '../lib/windowDrop'
import { Dropzone } from './Dropzone'
import { PageThumbnail } from './PageThumbnail'
import { ResultCard } from './ResultCard'
import { Button, DropOverlay, ErrorMessage, FIELD } from './ui'

type Mode = 'protect' | 'unlock'
const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: 'protect', label: 'Add password protection', hint: 'Require a password to open the copy' },
  { value: 'unlock', label: 'Save an unlocked copy', hint: 'Open the copy without a password' },
]

export function PasswordTool({ active = true }: { active?: boolean }) {
  const [file, setFile] = useState<File | null>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [mode, setMode] = useState<Mode>('protect')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const documentRef = useRef<PDFDocumentProxy | null>(null)
  const version = useRef(0)
  const loader = usePdfLoader()
  const result = useResult<File>([file, mode, password, confirmation])

  useEffect(() => () => {
    version.current += 1
    closePdf(documentRef.current)
  }, [])

  function reset() {
    version.current += 1
    loader.cancel()
    closePdf(documentRef.current)
    documentRef.current = null
    setFile(null)
    setDoc(null)
    setPassword('')
    setConfirmation('')
    setVisible(false)
    setBusy(false)
    setError(null)
    result.clear()
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
    } catch (err) {
      if (version.current === current) setError((err as Error).message)
    }
  }

  function take(files: File[]) {
    const [next] = pickFiles(files, 'pdf').wanted
    if (next) void open(next)
  }
  const dragging = useWindowDrop(take, active)
  useReceive('passwords', take)
  const problem = passwordProblem(password)
  const mismatch = confirmation !== password

  async function run() {
    if (!file || !doc || busy || (mode === 'protect' && (problem || mismatch))) return
    const current = version.current
    const finish = result.begin()
    setBusy(true)
    setError(null)
    try {
      const output = mode === 'protect' ? await protectPdf(file, password) : await unlockPdf(file)
      if (version.current === current) finish(output)
    } catch (err) {
      if (version.current === current) setError((err as Error).message)
    } finally {
      if (version.current === current) setBusy(false)
    }
  }

  const overlay = dragging && <DropOverlay label="Drop a PDF to protect or unlock" />
  if (!file) return <>{overlay}<Dropzone title="Choose a PDF to protect or unlock" onFiles={take} /></>

  return (
    <div className="space-y-5">
      {overlay}
      <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        {doc && <div className="shrink-0"><PageThumbnail doc={doc} pageNumber={1} width={40} /></div>}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{file.name}</p>
          <p className="text-sm text-zinc-500">{doc ? `${doc.numPages} ${doc.numPages === 1 ? 'page' : 'pages'} · ` : ''}{formatSize(file.size)}</p>
          {doc && pdfPassword(file) && <p className="text-sm text-zinc-500">Opened with a password</p>}
        </div>
        <button type="button" onClick={reset} className="shrink-0 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Choose another file</button>
      </div>
      {!doc && !error && <p role="status" className="text-sm text-zinc-500">Opening PDF…</p>}
      {doc && <>
        <fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
          <legend className="sr-only">Password action</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {MODES.map((option) => <label key={option.value} className={`cursor-pointer rounded-lg border px-3 py-2.5 has-focus-visible:outline-2 has-focus-visible:outline-rose-600 ${
              mode === option.value ? 'border-rose-500 bg-rose-50 dark:bg-rose-950/30' : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'
            }`}>
              <input type="radio" name="password-action" checked={mode === option.value} onChange={() => { setMode(option.value); setError(null) }} className="sr-only" />
              <span className="block font-medium">{option.label}</span>
              <span className="block text-sm text-zinc-500">{option.hint}</span>
            </label>)}
          </div>
          {mode === 'protect' && <div className="space-y-3">
            <div>
              <label htmlFor="new-pdf-password" className="mb-1 block text-sm font-medium">New password</label>
              <input id="new-pdf-password" type={visible ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" aria-describedby="new-pdf-password-hint" className={`${FIELD} w-full px-3 py-2`} />
            </div>
            <div>
              <label htmlFor="confirm-pdf-password" className="mb-1 block text-sm font-medium">Confirm password</label>
              <input id="confirm-pdf-password" type={visible ? 'text' : 'password'} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" aria-invalid={!!confirmation && mismatch} className={`${FIELD} w-full px-3 py-2`} />
            </div>
            <label className="flex items-center gap-2 text-sm text-zinc-500"><input type="checkbox" checked={visible} onChange={(event) => setVisible(event.target.checked)} className="accent-rose-600" />Show passwords</label>
            <p id="new-pdf-password-hint" className="text-sm text-zinc-500">The copy uses AES-256 encryption. Keep the password somewhere you can find it.</p>
            {!!password && problem && <ErrorMessage>{problem}</ErrorMessage>}
            {!!confirmation && mismatch && <ErrorMessage>The passwords don’t match.</ErrorMessage>}
          </div>}
          {mode === 'unlock' && <p className="text-sm text-zinc-500">The new copy will open without a password. Your original file stays as it is.</p>}
        </fieldset>
        <p className="text-sm text-zinc-500">Passwords stay in memory for this session. Processing happens on this computer.</p>
      </>}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      {result.value && <ResultCard file={result.value} from="passwords" onDismiss={result.clear}>
        {mode === 'unlock' ? 'Opens without a password.' : 'Requires the new password to open.'}
      </ResultCard>}
      {doc && <Button onClick={run} disabled={busy || (mode === 'protect' && (!!problem || mismatch))}>
        {busy ? 'Working…' : mode === 'protect' ? 'Create protected PDF' : 'Create unlocked copy'}
      </Button>}
    </div>
  )
}
