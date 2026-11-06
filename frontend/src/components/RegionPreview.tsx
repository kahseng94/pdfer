import { useEffect, useRef, useState } from 'react'
import type { RegionElement } from '../lib/edits'
import type { PDFDocumentProxy, RenderTask } from '../lib/pdf'

/** Render just the original cutout, even when its source page is offscreen. */
export function RegionPreview({ region, doc, zoom }: { region: RegionElement; doc: PDFDocumentProxy; zoom: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  const [status, setStatus] = useState('loading')
  const { x, y, width, height } = region.source
  const sourcePage = region.sourcePage
  const rotation = region.rotation ?? 0
  const turned = rotation === 90 || rotation === 270
  const previewWidth = turned ? region.height : region.width
  const previewHeight = turned ? region.width : region.height
  const desiredScale = zoom * (window.devicePixelRatio || 1) * Math.max(previewWidth / width, previewHeight / height)
  // The browser preview is bounded; export still uses the original PDF objects.
  const scale = Math.min(desiredScale, 4, Math.sqrt(4_000_000 / (width * height)), 8192 / Math.max(width, height))

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '200px' })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let task: RenderTask | undefined
    // An independent canvas keeps cancelled renders from touching the current preview.
    const buffer = document.createElement('canvas')
    doc.getPage(sourcePage).then(async (page) => {
      if (cancelled) return
      buffer.width = Math.max(1, Math.ceil(width * scale))
      buffer.height = Math.max(1, Math.ceil(height * scale))
      task = page.render({ canvas: buffer, viewport: page.getViewport({ scale }), transform: [1, 0, 0, 1, -x * scale, -y * scale] })
      await task.promise
      const canvas = ref.current
      if (cancelled || !canvas) return
      canvas.width = buffer.width; canvas.height = buffer.height
      canvas.getContext('2d')?.drawImage(buffer, 0, 0)
      setStatus('ready')
    }).catch(() => { if (!cancelled) setStatus('error') })
    return () => { cancelled = true; task?.cancel() }
  }, [doc, sourcePage, visible, x, y, width, height, scale])

  return <foreignObject x={region.x + (region.width - previewWidth) / 2} y={region.y + (region.height - previewHeight) / 2}
    width={previewWidth} height={previewHeight} transform={rotation ? `rotate(${rotation} ${region.x + region.width / 2} ${region.y + region.height / 2})` : undefined} pointerEvents="none">
    <div className="relative h-full w-full bg-white">
      <canvas ref={ref} className="block h-full w-full" />
      {status !== 'ready' && <span className="absolute inset-0 flex items-center justify-center text-center text-xs text-zinc-500" role="status">
        {status === 'error' ? 'Region preview unavailable' : 'Loading region…'}
      </span>}
    </div>
  </foreignObject>
}
