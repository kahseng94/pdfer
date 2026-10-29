import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from '../lib/pdf'

type Props = {
  doc: PDFDocumentProxy
  pageNumber: number
  /** CSS width in pixels. */
  width: number
  /** Extra clockwise rotation in degrees, on top of the page's own. */
  rotation?: number
  /** Width / height when already known, so the canvas has the right shape before it renders. */
  aspect?: number
}

/** Renders one page, but only once it scrolls into view. */
export function PageThumbnail({ doc, pageNumber, width, rotation = 0, aspect: knownAspect }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  const [aspect, setAspect] = useState(knownAspect ?? 1 / Math.SQRT2)

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '200px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const el = canvas.current
    if (!visible || !el) return
    let cancelled = false
    let task: RenderTask | undefined

    doc.getPage(pageNumber).then((page) => {
      if (cancelled) return
      const turned = (page.rotate + rotation) % 360
      const base = page.getViewport({ scale: 1, rotation: turned })
      setAspect(base.width / base.height)
      const viewport = page.getViewport({ scale: (width / base.width) * window.devicePixelRatio, rotation: turned })
      el.width = Math.floor(viewport.width)
      el.height = Math.floor(viewport.height)
      task = page.render({ canvas: el, viewport })
      task.promise.catch(() => {}) // Rejects on cancel; nothing to do.
    }).catch(() => {}) // A document may be closed while its page is loading.

    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [doc, pageNumber, width, rotation, visible])

  return (
    <canvas
      ref={canvas}
      style={{ width, aspectRatio: aspect }}
      className="block bg-white shadow-sm ring-1 ring-zinc-900/10"
    />
  )
}
