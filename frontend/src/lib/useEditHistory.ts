import { useCallback, useState } from 'react'
import type { Element } from './edits'

type History<T> = { past: T[][]; present: T[]; future: T[][] }

/** A drag is one undo step: begin, any number of changes, end. */
export function useEditHistory<T extends Element = Element>() {
  const [history, setHistory] = useState<History<T>>({ past: [], present: [], future: [] })
  const push = (state: History<T>) => [...state.past.slice(-99), state.present]
  const begin = useCallback(() => setHistory((state) => ({ past: push(state), present: state.present, future: [] })), [])
  const change = useCallback((update: (elements: T[]) => T[]) => setHistory((state) => ({ ...state, present: update(state.present) })), [])
  const end = useCallback((changed: boolean) => {
    if (!changed) setHistory((state) => state.past.length ? { past: state.past.slice(0, -1), present: state.past[state.past.length - 1], future: state.future } : state)
  }, [])
  const commit = useCallback((update: (elements: T[]) => T[]) => setHistory((state) => ({ past: push(state), present: update(state.present), future: [] })), [])
  const undo = useCallback(() => setHistory((state) => state.past.length ? { past: state.past.slice(0, -1), present: state.past[state.past.length - 1], future: [state.present, ...state.future] } : state), [])
  const redo = useCallback(() => setHistory((state) => state.future.length ? { past: [...state.past, state.present], present: state.future[0], future: state.future.slice(1) } : state), [])
  const reset = useCallback(() => setHistory({ past: [], present: [], future: [] }), [])
  return { elements: history.present, canUndo: history.past.length > 0, canRedo: history.future.length > 0, begin, change, end, commit, undo, redo, reset }
}
