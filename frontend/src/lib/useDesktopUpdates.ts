import { useEffect, useState } from 'react'
import type { UpdateState } from './desktop'

export type UpdateControls = {
  state: UpdateState | null
  error: string | null
  check: () => void
  download: () => void
  install: () => void
}

/** Update status for the desktop app, shared by the status panel and the check button. Null in the browser. */
export function useDesktopUpdates(): UpdateControls | null {
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
  return {
    state, error,
    check: () => void act(() => api.checkForUpdates()),
    download: () => void act(() => api.downloadUpdate()),
    install: () => void act(async () => {
      if (!await api.installUpdate()) setError('Finish any OCR installation before restarting to update.')
    }),
  }
}

/** One line describing the update status, as shown in the panel and the check button's tooltip. */
export function updateStatusText(state: UpdateState | null) {
  return !state ? 'Checking app status…' : state.status === 'disabled' ? 'Updates are not available for this build.'
    : state.status === 'checking' ? 'Checking for updates…'
    : state.status === 'available' ? `Version ${state.version} is available.`
    : state.status === 'downloading' ? `Downloading update · ${state.percent ?? 0}%`
    : state.status === 'downloaded' ? `Version ${state.version} is ready. Save your work before restarting.`
    : state.message ?? 'Updates are checked automatically.'
}
