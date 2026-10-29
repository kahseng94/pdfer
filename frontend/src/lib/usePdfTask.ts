import { useEffect, useRef, useState } from 'react'
import { closePdf, type PDFDocumentProxy } from './pdf'
import { usePdfLoader } from './usePdfLoader'
import { useResult } from './result'

export type PdfOutput = { file: File; doc: PDFDocumentProxy }

/** Common source/preview lifecycle. Call invalidate before changing editing settings. */
export function usePdfTask<T>(read: (file: File, doc: PDFDocumentProxy, signal: AbortSignal) => Promise<T>, settingsKey: string) {
  const [file, setFile] = useState<File | null>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [data, setData] = useState<T | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const source = useRef<PDFDocumentProxy | null>(null)
  const output = useRef<PDFDocumentProxy | null>(null)
  const opening = useRef<AbortController | null>(null)
  const running = useRef<AbortController | null>(null)
  const loader = usePdfLoader()
  const result = useResult<PdfOutput>([file, settingsKey])
  useEffect(() => () => {
    opening.current?.abort(); running.current?.abort()
    closePdf(source.current); closePdf(output.current)
  }, [])
  function cancel() {
    running.current?.abort(); running.current = null
    loader.cancel('output'); setBusy(false)
  }
  function invalidate() {
    cancel(); result.clear(); closePdf(output.current); output.current = null
    setError(null); setCancelled(false)
  }
  function clear() {
    invalidate(); opening.current?.abort(); opening.current = null; loader.cancel()
    closePdf(source.current); source.current = null
    setFile(null); setDoc(null); setData(null)
  }
  async function open(next: File): Promise<T | null> {
    clear()
    const controller = new AbortController()
    opening.current = controller; setFile(next)
    try {
      const loaded = await loader.load(next, 'source')
      if (controller.signal.aborted) { closePdf(loaded); return null }
      source.current = loaded
      const metadata = await read(next, loaded, controller.signal)
      if (controller.signal.aborted) return null
      setDoc(loaded); setData(metadata)
      return metadata
    } catch (reason) {
      if (!controller.signal.aborted) setError((reason as Error).message)
      return null
    }
  }
  async function preview(make: (file: File, signal: AbortSignal) => Promise<File>) {
    if (!file || !doc || busy) return
    invalidate()
    const controller = new AbortController()
    running.current = controller; setBusy(true)
    const finish = result.begin()
    try {
      const made = await make(file, controller.signal)
      controller.signal.throwIfAborted()
      const loaded = await loader.load(made, 'output')
      if (controller.signal.aborted || running.current !== controller) { closePdf(loaded); return }
      output.current = loaded; finish({ file: made, doc: loaded })
    } catch (reason) {
      if (!controller.signal.aborted && running.current === controller) setError((reason as Error).message)
    } finally {
      if (running.current === controller) { running.current = null; setBusy(false) }
    }
  }
  return { file, doc, data, busy, error, cancelled, result: result.value, open, clear, preview, invalidate,
    cancel: () => { cancel(); setCancelled(true) }, dismiss: invalidate }
}
