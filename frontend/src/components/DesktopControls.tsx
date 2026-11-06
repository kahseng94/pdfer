import { useEffect, useRef, useState } from 'react'
import type { OcrSetupState, UpdateState } from '../lib/desktop'

const BUTTON = 'rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800'

export function DesktopUpdates() {
  const api = window.pdferDesktop
  const [state, setState] = useState<UpdateState | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!api) return
    let live = true, changed = false
    const unsubscribe = api.onUpdateState((value) => { changed = true; if (live) { setState(value); setError(null) } })
    void api.getUpdateState().then((value) => { if (live && !changed) setState(value) })
      .catch(() => { if (live) setError('Could not read update status.') })
    return () => { live = false; unsubscribe() }
  }, [api])
  if (!api) return null
  async function act(action: () => Promise<unknown>) {
    setError(null)
    try { await action() } catch { setError('Could not update the app. Please try again.') }
  }
  const label = !state ? 'Checking app status…' : state.status === 'disabled' ? 'Updates are not available for this build.'
    : state.status === 'checking' ? 'Checking for updates…'
    : state.status === 'available' ? `Version ${state.version} is available.`
    : state.status === 'downloading' ? `Downloading update · ${state.percent ?? 0}%`
    : state.status === 'downloaded' ? `Version ${state.version} is ready. Save your work before restarting.`
    : state.message ?? 'Updates are checked automatically.'
  return <div className="mb-4 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="font-medium">pdfer{state ? ` ${state.currentVersion}` : ''} · Desktop</p><p role="status" className="text-zinc-500">{label}</p></div>
      <div className="flex flex-wrap gap-2">
        {state && ['idle', 'error'].includes(state.status) && <button className={BUTTON} onClick={() => void act(() => api.checkForUpdates())}>Check for updates</button>}
        {state?.status === 'available' && <button className={BUTTON} onClick={() => void act(() => api.downloadUpdate())}>Download update</button>}
        {state?.status === 'downloaded' && <button className={BUTTON} onClick={() => void act(async () => {
          if (!await api.installUpdate()) setError('Finish any OCR installation before restarting to update.')
        })}>Restart to update</button>}
      </div>
    </div>
    {state?.status === 'downloading' && <progress aria-label="Update download" className="mt-2 w-full" max={100} value={state.percent ?? 0} />}
    {(error || (state?.message && state.status === 'available')) && <p role="alert" className="mt-2 text-red-600 dark:text-red-400">{error || state?.message}</p>}
  </div>
}

export function DesktopOcrSetup({ onReady }: { onReady: () => void }) {
  const api = window.pdferDesktop
  const [state, setState] = useState<OcrSetupState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ready = useRef(onReady)
  useEffect(() => { ready.current = onReady }, [onReady])
  useEffect(() => {
    if (!api) return
    let live = true, changed = false
    const unsubscribe = api.onOcrSetupState((value) => {
      changed = true
      if (live) { setState(value); setError(null); if (value.status === 'ready') ready.current() }
    })
    void api.getOcrSetupState().then((value) => { if (live && !changed) setState(value) })
      .catch(() => { if (live) setError('Could not read OCR setup status.') })
    return () => { live = false; unsubscribe() }
  }, [api])
  if (!api) return null
  return <div className="space-y-2">
    <p className="text-zinc-500">{state?.status === 'unsupported'
      ? 'PaddleOCR is not available on this architecture. Use the included Tesseract engine.'
      : state?.message ?? 'Optional download: PaddleOCR installs its own runtime and models. Allow several GB of disk space. After setup, recognition works offline.'}</p>
    {state && !['installing', 'unsupported'].includes(state.status) && <button className={BUTTON} onClick={() => {
      setError(null)
      void api.installOcr().then(setState).catch(() => setError('Could not start OCR setup. Please try again.'))
    }}>{state.status === 'ready' ? 'Repair PaddleOCR' : state.status === 'error' ? 'Retry PaddleOCR setup' : 'Install PaddleOCR'}</button>}
    {state?.status === 'installing' && <p role="status">Setup is running. Keep pdfer open until it finishes.</p>}
    {error && <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>}
  </div>
}
