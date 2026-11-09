import { useEffect, useRef, useState } from 'react'
import type { OcrSetupState, UpdateState } from '../lib/desktop'
import { updateStatusText, type UpdateControls } from '../lib/useDesktopUpdates'
import { ReloadIcon } from './icons'
import { IconButton } from './ui'

const BUTTON = 'rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800'

const NEEDS_ATTENTION: UpdateState['status'][] = ['available', 'downloading', 'downloaded', 'error']

/** Shown above the tool only when there is an update to download or install, or a problem to report.
 * Routine status lives in the sidebar's check button. */
export function DesktopUpdates({ updates }: { updates: UpdateControls | null }) {
  if (!updates) return null
  const { state, error } = updates
  if (!error && !(state && NEEDS_ATTENTION.includes(state.status))) return null
  return <div className="mb-4 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="font-medium">pdfer{state ? ` ${state.currentVersion}` : ''} · Desktop</p>{state && <p className="text-zinc-500">{updateStatusText(state)}</p>}</div>
      <div className="flex flex-wrap gap-2">
        {state?.status === 'available' && <button className={BUTTON} onClick={updates.download}>Download update</button>}
        {state?.status === 'downloaded' && <button className={BUTTON} onClick={updates.install}>Restart to update</button>}
      </div>
    </div>
    {state?.status === 'downloading' && <progress aria-label="Update download" className="mt-2 w-full" max={100} value={state.percent ?? 0} />}
    {(error || (state?.message && state.status === 'available')) && <p role="alert" className="mt-2 text-red-600 dark:text-red-400">{error || state?.message}</p>}
  </div>
}

/** The reload icon in the sidebar footer. A new check can start only when none is running or waiting.
 * It spins while checking, its tooltip carries the version and latest result, and screen readers hear each change. */
export function CheckForUpdatesButton({ updates }: { updates: UpdateControls }) {
  const { state } = updates
  const ready = !!state && ['idle', 'error'].includes(state.status)
  const status = updateStatusText(state)
  const version = state ? `pdfer ${state.currentVersion} · ` : ''
  return <>
    <IconButton label="Check for updates" title={`Check for updates\n${version}${status}`} disabled={!ready} onClick={updates.check}>
      {/* The arrow's circle is centred a little below the middle of the icon, so it spins about that point. */}
      <ReloadIcon className={`size-4 ${state?.status === 'checking' ? 'origin-[50%_54%] motion-safe:animate-spin' : ''}`} />
    </IconButton>
    <span role="status" className="sr-only">{status}</span>
  </>
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
