import { useCallback, useEffect, useRef } from 'react'
import { loadPdf } from './pdf'

/** Cancel password prompts and pending parsing when a tool replaces/removes a file. */
export function usePdfLoader() {
  const pending = useRef(new Map<unknown, AbortController>())
  const cancel = useCallback((key?: unknown) => {
    if (key === undefined) {
      for (const controller of pending.current.values()) controller.abort()
      pending.current.clear()
    } else {
      pending.current.get(key)?.abort()
      pending.current.delete(key)
    }
  }, [])
  useEffect(() => cancel, [cancel])

  const load = useCallback(async (file: File, key: unknown = file) => {
    cancel(key)
    const controller = new AbortController()
    pending.current.set(key, controller)
    try {
      return await loadPdf(file, controller.signal)
    } finally {
      if (pending.current.get(key) === controller) pending.current.delete(key)
    }
  }, [cancel])

  return { load, cancel }
}
