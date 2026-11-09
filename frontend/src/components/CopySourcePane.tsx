import { useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { boxBetween, clampPoint, MIN_SIZE, roundedBox, type Box, type Point } from '../lib/edits'
import { pickFiles } from '../lib/files'
import { formatSize, type PDFDocumentProxy } from '../lib/pdf'
import { useElementWidth } from '../lib/usePageCanvas'
import { isFileDrag } from '../lib/windowDrop'
import { Dropzone } from './Dropzone'
import type { PageSize } from './EditPage'
import { CopyIcon } from './icons'
import { PageThumbnail } from './PageThumbnail'
import { ErrorMessage, FIELD, IconButton } from './ui'

/** The rectangle chosen on a page of the other PDF, in points. */
export type SourceSelection = { page: number; box: Box }

/** A selection being dragged out of the pane; the Edit tool places it on whichever of its pages is under the pointer. */
export type SourceDrag = {
  start: (selection: SourceSelection, grab: Point) => void
  move: (client: Point) => void
  end: (cancelled: boolean) => void
}

type Props = {
  file: File | null
  doc: PDFDocumentProxy | null
  pages: PageSize[]
  loading: boolean
  error: string | null
  selection: SourceSelection | null
  onSelect: (selection: SourceSelection | null) => void
  /** Open another PDF to copy from. */
  onFile: (file: File) => void
  /** The name of the PDF to paste into, once one is open, and its pages a copy can be pasted onto. */
  editing: string | null
  targets: PageSize[]
  onPaste: (page: number) => void
  onCopy: () => void
  pasteDisabled: boolean
  drag: SourceDrag
  /** How the keyboard shortcuts are written on this computer: ⌘ or Ctrl+. */
  modifier: string
}

/** The PDF to copy from in the Copy between PDFs tab, where a rectangle can be chosen and copied across. */
export function CopySourcePane({ file, doc, pages, loading, error, selection, onSelect, onFile, editing, targets, onPaste, onCopy, pasteDisabled, drag, modifier }: Props) {
  const [container, containerWidth] = useElementWidth<HTMLDivElement>()
  const [zoomLevel, setZoomLevel] = useState(1)
  const [preferredPage, setPreferredPage] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const widest = Math.max(1, ...pages.map((p) => p.width))
  const zoom = (containerWidth > 0 ? containerWidth / widest : 1) * zoomLevel
  const pasteTargets = targets.flatMap((size, i) => size.width >= 2 && size.height >= 2 ? [i + 1] : [])
  const pastePage = pasteTargets.includes(preferredPage) ? preferredPage : pasteTargets[0] ?? 0
  const box = selection && roundedBox(selection.box)

  function drop(event: DragEvent) {
    event.preventDefault()
    const [pdf] = pickFiles([...event.dataTransfer.files], 'pdf').wanted
    if (pdf) onFile(pdf)
  }

  return (
    // data-dropzone keeps the window-wide drop handler from opening a PDF dropped here as the one to edit.
    <section aria-label="PDF to copy from" className="copy-source-pane min-w-0 space-y-3" data-dropzone="" onDragOver={(event) => { if (isFileDrag(event.dataTransfer.types)) event.preventDefault() }} onDrop={drop}>
      {/* Sticks to the top of the pane's own scroll area, not the window's. */}
      <div className="sticky top-0 z-20 space-y-2 bg-zinc-50/95 py-2 backdrop-blur dark:bg-zinc-950/95">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Copy from</p>
            {file ? <>
              <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">{file.name}</p>
              <p className="text-sm text-zinc-500">{doc ? `${pages.length} ${pages.length === 1 ? 'page' : 'pages'} · ` : loading ? 'Opening… · ' : ''}{formatSize(file.size)}</p>
            </> : <p className="text-sm text-zinc-500">Choose the PDF to copy content from.</p>}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {doc && <>
              <IconButton label="Zoom out other PDF" disabled={zoomLevel <= 0.5} onClick={() => setZoomLevel((z) => Math.max(0.5, z / 1.25))}>
                <span className="text-base leading-none">−</span>
              </IconButton>
              <button type="button" onClick={() => setZoomLevel(1)} title="Fit other PDF to width"
                className="w-11 rounded py-1 text-center text-xs tabular-nums text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">
                {Math.round(zoom * 100)}%
              </button>
              <IconButton label="Zoom in other PDF" disabled={zoomLevel >= 4} onClick={() => setZoomLevel((z) => Math.min(4, z * 1.25))}>
                <span className="text-base leading-none">+</span>
              </IconButton>
              <span className="mx-1 h-5 w-px bg-zinc-300 dark:bg-zinc-700" />
            </>}
            {file && <button type="button" onClick={() => input.current?.click()} className="rounded px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
              Change PDF
            </button>}
          </div>
        </div>
        {doc && <div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-2 text-sm text-zinc-600 dark:text-zinc-400">
          {box ? <>
            <span>Page {selection!.page} · {box.width} × {box.height} pt</span>
            <label className="inline-flex items-center gap-1.5">
              Paste onto page
              <select aria-label="Paste onto page" className={FIELD} value={pastePage || ''} disabled={!pasteTargets.length || pasteDisabled} onChange={(event) => setPreferredPage(Number(event.target.value))}>
                {!pasteTargets.length && <option value="">No available page</option>}
                {pasteTargets.map((page) => <option key={page} value={page}>Page {page}</option>)}
              </select>
            </label>
            <button type="button" onClick={() => onPaste(pastePage)} disabled={!pastePage || pasteDisabled}
              className="rounded border border-zinc-300 px-2 py-1 text-zinc-800 hover:bg-zinc-200/70 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
              Paste
            </button>
            <button type="button" onClick={onCopy} title={`Copy (${modifier}C)`} aria-label="Copy selection"
              className="inline-flex items-center gap-1 rounded border border-zinc-300 px-2 py-1 text-zinc-800 hover:bg-zinc-200/70 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
              <CopyIcon className="size-4" />Copy
            </button>
            <span>{!editing ? 'Choose the PDF to paste into, then paste or drag the selection onto it.' : pasteDisabled ? `${editing} already has 200 regions.` : `Or drag the selection onto a page of ${editing}. ${modifier}V pastes it onto the page in view.`}</span>
          </> : <span>Drag a rectangle around the content to copy. It stays sharp: text and drawings come across as PDF content, not a picture.</span>}
        </div>}
      </div>

      {!file && <Dropzone title="Choose a PDF to copy from" onFiles={([pdf]) => onFile(pdf)} />}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      {doc && <div ref={container} className="overflow-x-auto">
        {/* Room at the end so the last page can scroll clear of the Save bar floating over the window. */}
        <ol className="space-y-6 py-1 pb-24">
          {pages.map((size, i) => {
            const page = i + 1
            return <li key={page} className="mx-auto w-fit">
              <SourcePage doc={doc} pageNumber={page} size={size} zoom={zoom} selection={selection?.page === page ? selection.box : null}
                onSelect={(box) => onSelect(box ? { page, box } : null)} drag={drag} />
              <p className="mt-1 text-center text-xs tabular-nums text-zinc-500">{page}</p>
            </li>
          })}
        </ol>
      </div>}
      <input ref={input} type="file" accept="application/pdf,.pdf" hidden aria-label="Choose another PDF to copy from"
        onChange={(event) => { const [pdf] = pickFiles(event.target.files ?? [], 'pdf').wanted; if (pdf) onFile(pdf); event.target.value = '' }} />
    </section>
  )
}

type Gesture = { kind: 'draw'; start: Point } | { kind: 'drag' }

/** One page of the other PDF: drag out a rectangle, then drag the rectangle itself onto the PDF being edited. */
function SourcePage({ doc, pageNumber, size, zoom, selection, onSelect, drag }: {
  doc: PDFDocumentProxy
  pageNumber: number
  size: PageSize
  zoom: number
  selection: Box | null
  onSelect: (box: Box | null) => void
  drag: SourceDrag
}) {
  const svg = useRef<SVGSVGElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const [draft, setDraft] = useState<Box | null>(null)
  const [dragging, setDragging] = useState(false)
  useEffect(() => () => { if (gesture.current?.kind === 'drag') drag.end(true) }, [drag])

  function toPoint(e: { clientX: number; clientY: number }): Point {
    const r = svg.current!.getBoundingClientRect()
    return clampPoint([((e.clientX - r.left) / r.width) * size.width, ((e.clientY - r.top) / r.height) * size.height], size)
  }

  function inside(p: Point, box: Box) {
    return p[0] >= box.x && p[0] <= box.x + box.width && p[1] >= box.y && p[1] <= box.y + box.height
  }

  function onPointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.focus({ preventScroll: true })
    const p = toPoint(e)
    if (selection && inside(p, selection)) {
      gesture.current = { kind: 'drag' }
      setDragging(true)
      drag.start({ page: pageNumber, box: selection }, [(p[0] - selection.x) / selection.width, (p[1] - selection.y) / selection.height])
    } else {
      gesture.current = { kind: 'draw', start: p }
      setDraft({ x: p[0], y: p[1], width: 0, height: 0 })
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    const g = gesture.current
    if (!g) return
    if (g.kind === 'draw') setDraft(boxBetween(g.start, toPoint(e)))
    else drag.move([e.clientX, e.clientY])
  }

  function onPointerUp(e: ReactPointerEvent<SVGSVGElement>) {
    const g = gesture.current
    if (!g) return
    gesture.current = null
    if (g.kind === 'draw') {
      setDraft(null)
      const box = roundedBox(boxBetween(g.start, toPoint(e)))
      // A click clears the selection; a drag that is too small to copy does too.
      onSelect(box.width >= MIN_SIZE && box.height >= MIN_SIZE ? box : null)
    } else {
      setDragging(false)
      drag.move([e.clientX, e.clientY])
      drag.end(false)
    }
  }

  function cancel() {
    const g = gesture.current
    if (!g) return
    gesture.current = null
    if (g.kind === 'draw') setDraft(null)
    else { setDragging(false); drag.end(true) }
  }

  const width = size.width * zoom
  const height = size.height * zoom
  const stroke = 1 / zoom
  return (
    <div className="relative" style={{ width, height }}>
      <PageThumbnail doc={doc} pageNumber={pageNumber} width={width} aspect={size.width / size.height} />
      <svg ref={svg} viewBox={`0 0 ${size.width} ${size.height}`} className="absolute inset-0 h-full w-full touch-none select-none"
        style={{ cursor: dragging ? 'grabbing' : 'crosshair' }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={cancel} onLostPointerCapture={cancel}
        onKeyDown={(event) => { if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); cancel() } }}
        aria-label={`Copy from page ${pageNumber}`} data-source-page={pageNumber} tabIndex={0}>
        {selection && !draft && <g data-source-selection="">
          <rect {...selection} fill="#e11d48" fillOpacity={0.12} stroke="#e11d48" strokeWidth={stroke} strokeDasharray={`${4 / zoom} ${3 / zoom}`} style={{ cursor: dragging ? 'grabbing' : 'grab' }} />
        </g>}
        {draft && <rect {...draft} fill="#e11d48" fillOpacity={0.1} stroke="#e11d48" strokeWidth={stroke} strokeDasharray={`${4 / zoom} ${3 / zoom}`} pointerEvents="none" />}
      </svg>
    </div>
  )
}
