import { useEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from '../lib/pdf'
import { cleanupComparisonDocuments, comparisonPage, createComparisonScheduler, pageGeometry, pairSize, renderComparisonPage, type ComparisonPage, type ComparisonScheduler, type Difference, type Geometry } from '../lib/pdfCompare'
import { ErrorMessage } from './ui'

/** Re-render only the visible pair; no document-wide image cache. */
export function ComparePreview({ original, revised, page, result, selected, dpi, schedule: sharedSchedule }: {
  original: PDFDocumentProxy | null; revised: PDFDocumentProxy | null; page: number
  result?: ComparisonPage; selected?: Difference; dpi: number; schedule?: ComparisonScheduler
}) {
  const leftHost = useRef<HTMLDivElement>(null), rightHost = useRef<HTMLDivElement>(null)
  const [ownSchedule] = useState(createComparisonScheduler)
  const schedule = sharedSchedule ?? ownSchedule
  const request = useMemo(() => ({ original, revised, page, dpi }), [original, revised, page, dpi])
  type View = { size: ReturnType<typeof pairSize>; geometry: (Geometry | null)[] }
  const [display, setDisplay] = useState<{ request: typeof request; view?: View; error?: string } | null>(null)
  const view = display?.request === request ? display.view : undefined
  const error = display?.request === request ? display.error : undefined
  useEffect(() => {
    const controller = new AbortController(), { signal } = controller
    const canvases = [document.createElement('canvas'), document.createElement('canvas')]
    let a: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | null = null
    let b: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | null = null
    let settled = false
    const release = () => { for (const c of canvases) { c.remove(); c.width = 0; c.height = 0 } }
    async function render() {
      try {
        await schedule(signal, async () => {
          let published = false
          try {
            a = await comparisonPage(original, page, signal)
            b = await comparisonPage(revised, page, signal)
            signal.throwIfAborted()
            const geometry = [a && pageGeometry(a), b && pageGeometry(b)]
            const size = pairSize(geometry[0], geometry[1], dpi)
            if (a) await renderComparisonPage(a, canvases[0], size, signal)
            if (b) await renderComparisonPage(b, canvases[1], size, signal)
            signal.throwIfAborted()
            a?.cleanup(); b?.cleanup()
            await cleanupComparisonDocuments(original, revised, signal)
            for (const [index, host] of [leftHost, rightHost].entries()) {
              canvases[index].style.width = '100%'
              canvases[index].style.display = 'block'
              canvases[index].setAttribute('role', 'img')
              canvases[index].setAttribute('aria-label', `${index === 0 ? 'Original' : 'Revised'} PDF preview, page ${page}`)
              host.current?.replaceChildren(canvases[index])
            }
            setDisplay({ request, view: { size, geometry } }); published = true
          } finally {
            a?.cleanup(); b?.cleanup()
            if (!published) release()
            settled = true
          }
        })
      } catch (reason) {
        settled = true; release()
        if (!signal.aborted) setDisplay({ request, error: `Could not preview page ${page}: ${(reason as Error).message}` })
      }
    }
    void render()
    // Never resize a canvas while PDF.js still owns its graphics state.
    return () => { controller.abort(); for (const c of canvases) c.remove(); if (settled) release() }
  }, [request, original, revised, page, dpi, schedule])

  return <div className="space-y-3">
    {!view && !error && <p role="status" className="text-sm text-zinc-500">Rendering side-by-side previews…</p>}
    {error && <ErrorMessage>{error}</ErrorMessage>}
    <div className="overflow-x-auto pb-2">
      <div className="grid min-w-[540px] grid-cols-2 items-start gap-4">
        {['Original', 'Revised'].map((label, i) => {
          const geometry = view?.geometry[i]
          const fullPage = result?.status === 'added' || result?.status === 'removed'
          return <section key={label} aria-label={`${label} page ${page}`} className="min-w-0 space-y-2">
            <h3 className="text-sm font-medium">{label} · page {page}</h3>
            <p className="text-xs text-zinc-500">{geometry ? `${geometry.width.toFixed(1)} × ${geometry.height.toFixed(1)} pt` : view ? 'No page in this document' : 'Loading…'}</p>
            <div className={`relative overflow-hidden rounded border border-zinc-300 bg-white ${view ? '' : 'hidden'}`} style={{ aspectRatio: view ? `${view.size.width} / ${view.size.height}` : undefined }}>
              <div ref={i === 0 ? leftHost : rightHost} className={geometry ? '' : 'hidden'} />
              {view && !geometry && <p className="absolute inset-0 flex items-center justify-center bg-zinc-100 p-4 text-center text-sm text-zinc-500">No {label.toLowerCase()} page</p>}
              {view && geometry && <svg aria-label={`${label} change highlights`} role="img" viewBox={`0 0 ${view.size.width / view.size.scale} ${view.size.height / view.size.scale}`} className="pointer-events-none absolute inset-0 h-full w-full">
                <title>Highlighted regions differ between the page pair. Orange indicates the selected difference.</title>
                <rect x="0" y="0" width={geometry.width} height={geometry.height} fill="none" stroke={fullPage || result?.geometryChanged ? '#ea580c' : '#a1a1aa'} strokeWidth="2" vectorEffect="non-scaling-stroke" />
                {fullPage && <rect x="0" y="0" width={geometry.width} height={geometry.height} fill="#fb923c" fillOpacity="0.18" />}
                {result?.regions.map((region, index) => <rect key={index} {...region} fill={selected?.region === index ? '#f97316' : '#e11d48'} fillOpacity={selected?.region === index ? '0.28' : '0.15'} stroke={selected?.region === index ? '#c2410c' : '#e11d48'} strokeWidth={selected?.region === index ? '3' : '1.5'} vectorEffect="non-scaling-stroke" />)}
              </svg>}
            </div>
          </section>
        })}
      </div>
    </div>
  </div>
}
