import { useEffect, useRef, useState } from 'react'
import type { CompressLevel } from './api'
import { closePdf, type PDFDocumentProxy } from './pdf'
import { compressPdfBatch, PdfCompressionError, type PdfCompressionBatch, type PdfCompressionProgress } from './pdfCompression'
import { usePdfLoader } from './usePdfLoader'
import { useResult } from './result'

export type PdfCompressionItem = { id: string; file: File; doc: PDFDocumentProxy | null; error: string | null }

export function usePdfCompression() {
  const [items, setItems] = useState<PdfCompressionItem[]>([])
  const [level, setLevel] = useState<CompressLevel>('balanced')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<PdfCompressionProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [failedId, setFailedId] = useState<string | null>(null)
  const pending = useRef<AbortController | null>(null)
  const documents = useRef(new Map<string, PDFDocumentProxy>())
  const opening = useRef(new Map<string, symbol>())
  const loader = usePdfLoader()
  const result = useResult<PdfCompressionBatch>([level, ...items.map((item) => item.id)])

  useEffect(() => () => {
    opening.current.clear()
    pending.current?.abort()
    pending.current = null
    for (const doc of documents.current.values()) closePdf(doc)
    documents.current.clear()
  }, [])

  function cancel() {
    pending.current?.abort()
    pending.current = null
    setBusy(false)
    setProgress(null)
  }

  function invalidate() {
    cancel()
    result.clear()
    setError(null)
    setFailedId(null)
  }

  function open(item: PdfCompressionItem) {
    const token = Symbol()
    opening.current.set(item.id, token)
    loader.load(item.file, item.id).then((doc) => {
      if (opening.current.get(item.id) !== token) { closePdf(doc); return }
      opening.current.delete(item.id)
      documents.current.set(item.id, doc)
      setItems((previous) => previous.map((current) => current.id === item.id ? { ...current, doc, error: null } : current))
    }, (error: Error) => {
      if (opening.current.get(item.id) !== token) return
      opening.current.delete(item.id)
      setItems((previous) => previous.map((current) => current.id === item.id ? { ...current, error: error.message } : current))
    })
  }

  function add(files: readonly File[]) {
    if (!files.length) return
    invalidate()
    const added = files.map((file): PdfCompressionItem => ({ id: crypto.randomUUID(), file, doc: null, error: null }))
    setItems((previous) => [...previous, ...added])
    added.forEach(open)
  }

  function remove(id: string) {
    invalidate()
    opening.current.delete(id)
    loader.cancel(id)
    closePdf(documents.current.get(id))
    documents.current.delete(id)
    setItems((previous) => previous.filter((item) => item.id !== id))
  }

  function retry(item: PdfCompressionItem) {
    invalidate()
    closePdf(documents.current.get(item.id))
    documents.current.delete(item.id)
    setItems((previous) => previous.map((current) => current.id === item.id ? { ...current, doc: null, error: null } : current))
    open(item)
  }

  function clear() {
    invalidate()
    opening.current.clear()
    loader.cancel()
    for (const doc of documents.current.values()) closePdf(doc)
    documents.current.clear()
    setItems([])
  }

  function changeLevel(next: CompressLevel) {
    if (next === level) return
    invalidate()
    setLevel(next)
  }

  async function run() {
    if (pending.current || !items.length || items.some((item) => !item.doc || item.error)) return
    invalidate()
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    const finish = result.begin()
    try {
      const output = await compressPdfBatch(items.map((item) => item.file), level, controller.signal, (next) => {
        if (pending.current === controller && !controller.signal.aborted) setProgress(next)
      })
      if (pending.current === controller && !controller.signal.aborted) finish(output)
    } catch (error) {
      if (pending.current === controller && !controller.signal.aborted) {
        if (error instanceof PdfCompressionError) setFailedId(items[error.index].id)
        setError(`${(error as Error).message}${items.length > 1 ? ' No ZIP was created.' : ''}`)
      }
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false); setProgress(null) }
    }
  }

  return { items, level, busy, progress, error, failedId, result: result.value, dismiss: result.clear, add, remove, retry, clear, changeLevel, run, cancel }
}
