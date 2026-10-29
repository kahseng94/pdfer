import { useEffect, useRef, useState } from 'react'
import { closePdf } from './pdf'
import { usePdfLoader } from './usePdfLoader'

export type WorkflowItem = { id: string; file: File; pageCount: number | null; error: string | null }

/** Validate inputs/passwords once and release their preview resources before processing. */
export function useWorkflowInputs(onChange: () => void) {
  const [items, setItems] = useState<WorkflowItem[]>([])
  const opening = useRef(new Map<string, symbol>())
  const loader = usePdfLoader()
  useEffect(() => () => opening.current.clear(), [])

  function open(item: WorkflowItem) {
    const token = Symbol()
    opening.current.set(item.id, token)
    loader.load(item.file, item.id).then((doc) => {
      const pageCount = doc.numPages
      closePdf(doc)
      if (opening.current.get(item.id) !== token) return
      opening.current.delete(item.id)
      setItems((previous) => previous.map((current) => current.id === item.id ? { ...current, pageCount, error: null } : current))
    }, (error: Error) => {
      if (opening.current.get(item.id) !== token) return
      opening.current.delete(item.id)
      setItems((previous) => previous.map((current) => current.id === item.id ? { ...current, error: error.message } : current))
    })
  }
  function add(files: readonly File[]) {
    if (!files.length) return
    onChange()
    const added = files.map((file): WorkflowItem => ({ id: crypto.randomUUID(), file, pageCount: null, error: null }))
    setItems((previous) => [...previous, ...added])
    added.forEach(open)
  }
  function remove(id: string) {
    onChange()
    opening.current.delete(id)
    loader.cancel(id)
    setItems((previous) => previous.filter((item) => item.id !== id))
  }
  function retry(item: WorkflowItem) {
    onChange()
    setItems((previous) => previous.map((current) => current.id === item.id ? { ...current, pageCount: null, error: null } : current))
    open(item)
  }
  function clear() {
    onChange()
    opening.current.clear()
    loader.cancel()
    setItems([])
  }
  return { items, add, remove, retry, clear }
}
