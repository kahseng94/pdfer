import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from './pdf'

/** Renders one page into a canvas at the width it is shown, sharp on high-density screens. */
export function usePageCanvas(doc: PDFDocumentProxy, page: number, displayWidth: number) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const element = canvas.current
    if (!element || displayWidth <= 0) return
    let cancelled = false
    let task: RenderTask | undefined
    setReady(false); setError(null)
    doc.getPage(page).then(async (source) => {
      if (cancelled) return
      const base = source.getViewport({ scale: 1 })
      const viewport = source.getViewport({ scale: displayWidth / base.width * Math.min(window.devicePixelRatio || 1, 2) })
      element.width = Math.ceil(viewport.width); element.height = Math.ceil(viewport.height)
      task = source.render({ canvas: element, viewport, background: '#ffffff' })
      await task.promise
      if (!cancelled) setReady(true)
    }).catch((reason: Error) => { if (!cancelled) setError(reason.message) })
    return () => { cancelled = true; task?.cancel() }
  }, [doc, page, displayWidth])
  return { canvas, ready, error }
}

/** The width of an element, kept up to date as it resizes. */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!ref.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}
