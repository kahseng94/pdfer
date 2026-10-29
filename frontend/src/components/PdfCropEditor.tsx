import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { cropFromDrag, type CropMargins, type PageSize } from '../lib/organize'
import type { PDFDocumentProxy, RenderTask } from '../lib/pdf'

/** The source page after rotation, with a visual retained-area selector. */
export function PdfCropEditor({ doc, page, rotation, size, crop, disabled, onChange }: {
  doc: PDFDocumentProxy
  page: number
  rotation: number
  size: PageSize // millimetres
  crop: CropMargins
  disabled: boolean
  onChange: (crop: CropMargins) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const drag = useRef<{ id: number; start: PageSize; original: CropMargins } | null>(null)
  const displayWidth = Math.min(width, 420 * size.width / size.height)

  useEffect(() => {
    if (!container.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = canvas.current
    if (!element || displayWidth <= 0) return
    let cancelled = false
    let task: RenderTask | undefined
    setReady(false)
    setError(null)
    doc.getPage(page).then(async (source) => {
      if (cancelled) return
      const turned = (source.rotate + rotation) % 360
      const base = source.getViewport({ scale: 1, rotation: turned })
      const viewport = source.getViewport({ scale: displayWidth / base.width * Math.min(window.devicePixelRatio || 1, 2), rotation: turned })
      element.width = Math.ceil(viewport.width)
      element.height = Math.ceil(viewport.height)
      task = source.render({ canvas: element, viewport, background: '#ffffff' })
      await task.promise
      if (!cancelled) setReady(true)
    }).catch((err: Error) => { if (!cancelled) setError(`Could not show the crop page: ${err.message}`) })
    return () => { cancelled = true; task?.cancel(); drag.current = null }
  }, [doc, page, rotation, displayWidth])

  function point(event: PointerEvent<SVGSVGElement>): PageSize {
    const box = event.currentTarget.getBoundingClientRect()
    return { width: (event.clientX - box.left) / box.width * size.width, height: (event.clientY - box.top) / box.height * size.height }
  }

  function start(event: PointerEvent<SVGSVGElement>) {
    if (disabled || !ready || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { id: event.pointerId, start: point(event), original: crop }
  }

  function move(event: PointerEvent<SVGSVGElement>) {
    if (!drag.current || drag.current.id !== event.pointerId) return
    const next = cropFromDrag(drag.current.start, point(event), size)
    if (next) onChange(next)
  }

  function finish(event: PointerEvent<SVGSVGElement>, cancelled = false) {
    if (!drag.current || drag.current.id !== event.pointerId) return
    if (cancelled) onChange(drag.current.original)
    else move(event)
    drag.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const finite = (n: number) => Number.isFinite(n) ? n : 0
  const left = Math.min(size.width, Math.max(0, finite(crop.left)))
  const top = Math.min(size.height, Math.max(0, finite(crop.top)))
  const right = Math.max(left, Math.min(size.width, size.width - finite(crop.right)))
  const bottom = Math.max(top, Math.min(size.height, size.height - finite(crop.bottom)))

  return <div ref={container} className="space-y-2">
    {!ready && !error && <p role="status" className="text-sm text-zinc-500">Rendering crop page…</p>}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    <div className={`relative mx-auto bg-white shadow-sm ring-1 ring-zinc-300 ${!ready ? 'invisible' : ''}`} style={{ width: displayWidth, aspectRatio: size.width / size.height }}>
      <canvas ref={canvas} className="block h-full w-full" />
      <svg viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-label="Crop selection. Drag a rectangle to keep, or use the margin fields."
        onPointerDown={start} onPointerMove={move} onPointerUp={(e) => finish(e)} onPointerCancel={(e) => finish(e, true)}
        className={`absolute inset-0 h-full w-full touch-none ${disabled ? '' : 'cursor-crosshair'}`}>
        <path d={`M0 0H${size.width}V${size.height}H0Z M${left} ${top}V${bottom}H${right}V${top}Z`} fill="rgba(24,24,27,0.45)" fillRule="evenodd" />
        <rect x={left} y={top} width={right - left} height={bottom - top} fill="none" stroke="#e11d48" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
    <p className="text-xs text-zinc-500">Drag a rectangle to keep. The same margins apply to every checked page.</p>
  </div>
}
