import { useEffect, useRef, useState } from 'react'
import { TextLayer } from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from '../lib/pdf'
import { matchKey, runHighlights, type PageText, type TextMatch } from '../lib/pdfText'
import { ErrorMessage } from './ui'

/** A selectable text layer aligned with the rendered PDF, including rotation and page scaling. */
export function TextPage({ doc, page, matches, current }: {
  doc: PDFDocumentProxy
  page: PageText
  matches: readonly TextMatch[]
  current: TextMatch | null
}) {
  const container = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const renderedLayer = useRef<{ page: PageText; layer: TextLayer } | null>(null)
  const [width, setWidth] = useState(0)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const [ready, setReady] = useState<{ page: PageText } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!container.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = canvas.current, textContainer = overlay.current
    if (!element || !textContainer || width <= 0) return
    let cancelled = false
    let task: RenderTask | undefined
    let layer: TextLayer | undefined
    renderedLayer.current = null
    setReady(null)
    setError(null)
    textContainer.replaceChildren()
    doc.getPage(page.page).then(async (source) => {
      if (cancelled) return
      const base = source.getViewport({ scale: 1 })
      const scale = Math.min(width / base.width, 750 / base.height)
      const viewport = source.getViewport({ scale })
      const pixels = source.getViewport({ scale: scale * Math.min(window.devicePixelRatio || 1, 2) })
      element.width = Math.ceil(pixels.width)
      element.height = Math.ceil(pixels.height)
      setDimensions({ width: viewport.width, height: viewport.height })
      textContainer.style.setProperty('--total-scale-factor', String(scale * source.userUnit))
      layer = new TextLayer({ textContentSource: page.content, container: textContainer, viewport })
      // Keep the layer's unrotated box exact, independent of CSS rounding support.
      textContainer.style.width = `${viewport.rotation % 180 ? viewport.height : viewport.width}px`
      textContainer.style.height = `${viewport.rotation % 180 ? viewport.width : viewport.height}px`
      task = source.render({ canvas: element, viewport: pixels, background: '#ffffff' })
      await Promise.all([task.promise, layer.render()])
      if (!cancelled) {
        renderedLayer.current = { page, layer }
        setReady({ page })
      }
    }).catch((err: Error) => {
      if (!cancelled) setError(`Could not preview page ${page.page}: ${err.message}`)
    })
    return () => { cancelled = true; task?.cancel(); layer?.cancel() }
  }, [doc, page, width])

  useEffect(() => {
    const rendered = renderedLayer.current
    if (!ready || ready.page !== page || rendered?.page !== page) return
    const currentKey = current ? matchKey(current) : null
    for (const run of page.runs) {
      const span = rendered.layer.textDivs[run.item]
      if (!span) continue
      const original = rendered.layer.textContentItemsStr[run.item]
      const hits = runHighlights(run, matches)
      if (!hits.length) {
        if (span.childElementCount) span.textContent = original
        continue
      }
      const nodes: Node[] = []
      let from = 0
      for (const hit of hits) {
        nodes.push(document.createTextNode(original.slice(from, hit.start)))
        const mark = document.createElement('mark')
        mark.textContent = original.slice(hit.start, hit.end)
        mark.className = matchKey(hit.match) === currentKey ? 'current-match' : ''
        nodes.push(mark)
        from = hit.end
      }
      nodes.push(document.createTextNode(original.slice(from)))
      span.replaceChildren(...nodes)
    }
  }, [ready, page, matches, current])

  const loaded = ready?.page === page
  return <div ref={container} className="min-w-0">
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {!loaded && !error && <p role="status" className="mb-2 text-sm text-zinc-500">Rendering page {page.page}…</p>}
    <div className={`relative mx-auto overflow-hidden bg-white shadow-sm ${!loaded ? 'invisible' : ''}`} style={{ width: dimensions.width || '100%', height: dimensions.height || 'auto' }}>
      <canvas ref={canvas} role="img" aria-label={`PDF text preview, page ${page.page}`} className="block h-full w-full" />
      <div ref={overlay} className="pdf-search-text-layer" aria-hidden="true" />
    </div>
  </div>
}
