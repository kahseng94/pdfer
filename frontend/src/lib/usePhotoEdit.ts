// Running one edit over some photos, keeping the result while the inputs it was made from stay the same.

import { useEffect, useRef, useState } from 'react'
import { editPhotos } from './api'
import type { PhotoEdit, PhotoResult } from './photoEdits'
import { useResult } from './result'

/** The file to download (one photo, or a zip of them all) and what each photo came out as, by item id. */
export type PhotoOutcome = { file: File; results: Map<string, PhotoResult> }

export function usePhotoEdit(inputs: readonly unknown[]) {
  const result = useResult<PhotoOutcome>(inputs)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<AbortController | null>(null)

  useEffect(() => () => pending.current?.abort(), [])

  async function run(items: readonly { id: string; file: File }[], edit: PhotoEdit) {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setError(null)
    const finish = result.begin()
    try {
      const { file, results } = await editPhotos(items.map((it) => it.file), edit, controller.signal)
      if (controller.signal.aborted) return
      finish({ file, results: new Map(items.flatMap((it, i) => (results[i] ? [[it.id, results[i]] as const] : []))) })
    } catch (err) {
      if (!controller.signal.aborted) setError((err as Error).message)
    } finally {
      if (pending.current === controller) {
        pending.current = null
        setBusy(false)
      }
    }
  }

  function cancel() {
    pending.current?.abort()
    pending.current = null
    setBusy(false)
  }

  return { result, busy, error, run, cancel }
}
