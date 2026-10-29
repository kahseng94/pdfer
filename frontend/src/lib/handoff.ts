// Sending the file one tool made to another tool, which takes it as if it had been dropped there.

import { createContext, useContext, useEffect, useRef } from 'react'
import type { ToolId } from './tools'

/** A file on its way to a tool. `id` tells one sending from the next, even of the same file. */
export type Delivery = { to: ToolId; file: File; id: number }

type Handoff = {
  delivery: Delivery | null
  /** Give `file` to the tool `to` and switch to its tab. */
  send: (to: ToolId, file: File) => void
}

export const HandoffContext = createContext<Handoff | null>(null)

/** The way to send files on, or null outside the app (and then there is nowhere to send them). */
export function useHandoff(): Handoff | null {
  return useContext(HandoffContext)
}

/** Call `onFiles` once for each file sent to `tool`. */
export function useReceive(tool: ToolId, onFiles: (files: File[]) => void) {
  const delivery = useHandoff()?.delivery ?? null
  // Always call the latest handler without re-running for every render.
  const latest = useRef(onFiles)
  useEffect(() => {
    latest.current = onFiles
  })
  const taken = useRef(0)

  useEffect(() => {
    if (!delivery || delivery.to !== tool || delivery.id === taken.current) return
    taken.current = delivery.id
    latest.current([delivery.file])
  }, [delivery, tool])
}
