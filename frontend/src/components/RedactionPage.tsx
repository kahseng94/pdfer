import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { redactionFromDrag, type PdfSize, type Redaction } from '../lib/documentTools'
import type { PDFDocumentProxy, RenderTask } from '../lib/pdf'

export function RedactionPage({ doc, page, size, areas, disabled, onAdd }: { doc: PDFDocumentProxy; page: number; size: PdfSize; areas: readonly Redaction[]; disabled: boolean; onAdd: (area: Redaction) => void }) {
  const container = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ id: number; x: number; y: number } | null>(null)
  const [width, setWidth] = useState(0)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Redaction | null>(null)
  const displayWidth = Math.min(width, 650 * size.width / size.height)
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
    setReady(false); setError(null); setDraft(null)
    doc.getPage(page).then(async (source) => {
      if (cancelled) return
      const base = source.getViewport({ scale: 1 })
      const viewport = source.getViewport({ scale: displayWidth / base.width * Math.min(window.devicePixelRatio || 1, 2) })
      element.width = Math.ceil(viewport.width); element.height = Math.ceil(viewport.height)
      task = source.render({ canvas: element, viewport, background: '#ffffff' })
      await task.promise
      if (!cancelled) setReady(true)
    }).catch((reason: Error) => { if (!cancelled) setError(reason.message) })
    return () => { cancelled = true; task?.cancel(); drag.current = null }
  }, [doc, page, displayWidth])
  function point(event: PointerEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    return { x: (event.clientX - box.left) / box.width * size.width, y: (event.clientY - box.top) / box.height * size.height }
  }
  function start(event: PointerEvent<SVGSVGElement>) {
    if (disabled || !ready || event.button !== 0) return
    event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { id: event.pointerId, ...point(event) }
  }
  function move(event: PointerEvent<SVGSVGElement>) {
    if (drag.current?.id === event.pointerId) setDraft(redactionFromDrag(page, drag.current, point(event), size))
  }
  function finish(event: PointerEvent<SVGSVGElement>, cancelled = false) {
    if (drag.current?.id !== event.pointerId) return
    const area = redactionFromDrag(page, drag.current, point(event), size)
    if (!cancelled && area) onAdd(area)
    drag.current = null; setDraft(null); event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return <div ref={container} className="space-y-2">
    {error && <p role="alert" className="text-sm text-red-600">Could not render this page: {error}</p>}
    {!ready && !error && <p role="status" className="text-sm text-zinc-500">Rendering page…</p>}
    <div className={`relative mx-auto bg-white shadow-sm ${!ready ? 'invisible' : ''}`} style={{ width: displayWidth, aspectRatio: size.width / size.height }}>
      <canvas ref={canvas} className="block h-full w-full" />
      <svg viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-label="Redaction areas. Drag a rectangle to mark content for removal." tabIndex={0} onPointerDown={start} onPointerMove={move} onPointerUp={(event) => finish(event)} onPointerCancel={(event) => finish(event, true)} onKeyDown={(event) => { if (event.key === 'Escape') { drag.current = null; setDraft(null) } }} className="absolute inset-0 h-full w-full cursor-crosshair touch-none focus:outline-2 focus:outline-rose-500">
        {areas.filter((area) => [area.x, area.y, area.width, area.height].every(Number.isFinite)).map((area) => <rect key={area.id} x={area.x} y={area.y} width={area.width} height={area.height} fill="black" stroke="#f43f5e" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />)}
        {draft && <rect x={draft.x} y={draft.y} width={draft.width} height={draft.height} fill="black" fillOpacity={0.7} stroke="#f43f5e" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
      </svg>
    </div>
  </div>
}
