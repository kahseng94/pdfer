import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from '../lib/pdf'
import { ErrorMessage } from './ui'

/** Render an actual PDF page, reporting readiness so its download can follow review. */
export function DocumentPreview({ doc, page, onReady }: {
  doc: PDFDocumentProxy
  page: number
  onReady: (doc: PDFDocumentProxy | null) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const [displayWidth, setDisplayWidth] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!container.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = canvas.current
    if (!element || width <= 0) return
    let cancelled = false
    let task: RenderTask | undefined
    setLoading(true)
    setError(null)
    onReady(null)
    doc.getPage(page).then(async (source) => {
      if (cancelled) return
      const base = source.getViewport({ scale: 1 })
      const scale = Math.min(width / base.width, 900 / base.height)
      const viewport = source.getViewport({ scale: scale * Math.min(window.devicePixelRatio || 1, 2) })
      element.width = Math.max(1, Math.ceil(viewport.width))
      element.height = Math.max(1, Math.ceil(viewport.height))
      setDisplayWidth(base.width * scale)
      task = source.render({ canvas: element, viewport, background: '#ffffff' })
      await task.promise
      if (!cancelled) {
        setLoading(false)
        onReady(doc)
      }
    }).catch((err: Error) => {
      if (!cancelled) { setLoading(false); setError(`Could not preview page ${page}: ${err.message}`) }
    })
    return () => { cancelled = true; task?.cancel() }
  }, [doc, page, width, onReady])

  return (
    <div ref={container} className="min-w-0">
      {loading && <p role="status" className="mb-2 text-sm text-zinc-500">Rendering page {page}…</p>}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <canvas ref={canvas} role="img" aria-label={`PDF preview, page ${page}`} style={{ width: displayWidth || '100%', maxWidth: '100%', height: 'auto' }} className={`mx-auto block bg-white shadow-sm ${loading || error ? 'invisible' : ''}`} />
    </div>
  )
}
