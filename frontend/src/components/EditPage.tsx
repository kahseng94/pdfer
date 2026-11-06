import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  bounds,
  boxBetween,
  boxesOverlap,
  clampPoint,
  constrainBox,
  distance,
  HANDLES,
  lineWidth,
  MIN_SIZE,
  moved,
  normalizeText,
  resized,
  roundedBox,
  TEXT_ASCENT,
  TEXT_LINE_HEIGHT,
  textareaTop,
  textBox,
  textLines,
  withBox,
  type Box,
  type BoxElement,
  type Element,
  type Handle,
  type LineElement,
  type Point,
  type RegionElement,
  type Style,
  type TextElement,
  type Tool,
} from '../lib/edits'
import { familyCss } from '../lib/fonts'
import type { PDFDocumentProxy } from '../lib/pdf'
import { PageThumbnail } from './PageThumbnail'
import { RegionPreview } from './RegionPreview'

export type PageSize = { width: number; height: number }

/** What a page needs from the tool that owns the elements. */
export type Editor = {
  select: (id: string | null) => void
  /** Start editing a text element's words. */
  edit: (id: string) => void
  stopEditing: (id: string) => void
  /** Start a change that may take several updates, such as a drag. `end(false)` throws it away. */
  begin: () => void
  change: (update: (elements: Element[]) => Element[]) => void
  end: (changed: boolean) => void
  /** A change that is complete in one go. */
  commit: (update: (elements: Element[]) => Element[]) => void
  /** One-shot tools go back to Select after use. */
  toolDone: () => void
  /** Resolve a region drag against all displayed pages, using a fractional grab point. */
  placeRegion?: (original: RegionElement, client: Point, grab: Point, fallbackPage: number) => RegionElement
  /** Scroll the viewport during a held drag; return whether it actually moved. */
  scrollRegionDrag?: (client: Point, elapsedMs: number) => boolean
}

type Props = {
  doc: PDFDocumentProxy
  pageNumber: number
  /** The page's displayed size in points. */
  size: PageSize
  /** CSS pixels per point. */
  zoom: number
  /** This page's elements, in drawing order. */
  elements: Element[]
  /** Regions cut from this page, including ones now placed on other pages. */
  sourceRegions?: RegionElement[]
  selectedId: string | null
  editingId: string | null
  tool: Tool
  style: Style
  editor: Editor
  lockImageAspect?: boolean
}

type Drag =
  | { kind: 'region'; start: Point }
  | { kind: 'move'; id: string; orig: Element; start: Point; moved: boolean; client: Point; startClient: Point; grab: Point; currentPage: number; lastRegion?: RegionElement }
  | { kind: 'resize'; id: string; orig: BoxElement; handle: Handle; start: Point; moved: boolean }
  | { kind: 'endpoint'; id: string; handle: 'p1' | 'p2'; moved: boolean }
  | { kind: 'box'; id: string; start: Point }
  | { kind: 'line'; id: string; start: Point }
  | { kind: 'draw'; id: string; last: Point }

type Draft = { id: string; text: string }

const CURSORS: Record<Tool, string> = {
  select: 'default',
  region: 'crosshair',
  text: 'text',
  highlight: 'crosshair',
  rect: 'crosshair',
  ellipse: 'crosshair',
  line: 'crosshair',
  draw: 'crosshair',
}

/** One page with its elements drawn over it, where they can be added, moved and resized. */
export function EditPage({ doc, pageNumber, size, zoom, elements, sourceRegions, selectedId, editingId, tool, style, editor, lockImageAspect = false }: Props) {
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<Drag | null>(null)
  const scrollFrame = useRef<number | null>(null)
  useEffect(() => () => { if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current) }, [])
  const [regionDraft, setRegionDraft] = useState<Box | null>(null)
  const [regionError, setRegionError] = useState<string | null>(null)
  const regions = sourceRegions ?? elements.filter((el): el is RegionElement => el.type === 'region' && !el.copy && el.sourcePage === pageNumber)
  const choosingRegion = tool === 'region'
  useEffect(() => {
    // Tool changes must cancel an in-flight pointer selection, including its overlay.
    // oxlint-disable react/set-state-in-effect
    if (tool !== 'region' && drag.current?.kind === 'region') {
      drag.current = null
      setRegionDraft(null)
    }
    setRegionError(null)
    // oxlint-enable react/set-state-in-effect
  }, [tool])
  // A text element created by the Text tool is only kept once it has words in it.
  const newText = useRef<string | null>(null)
  // The last element clicked and when: a second click soon after opens text for editing.
  const lastTap = useRef<{ id: string; time: number } | null>(null)
  // What the textarea holds; a ref too, so a click can finish editing before React re-renders.
  const [draft, setDraftState] = useState<Draft | null>(null)
  const draftRef = useRef<Draft | null>(null)
  function setDraft(next: Draft | null) {
    draftRef.current = next
    setDraftState(next)
  }

  const selected = elements.find((el) => el.id === selectedId && !(el.type === 'region' && el.deleted)) ?? null
  const editingEl = elements.find((el) => el.id === editingId)
  const editing = editingEl?.type === 'text' ? editingEl : null

  function toPoint(e: { clientX: number; clientY: number }): Point {
    const r = svg.current!.getBoundingClientRect()
    return [((e.clientX - r.left) / r.width) * size.width, ((e.clientY - r.top) / r.height) * size.height]
  }

  function update(id: string, fn: (el: Element) => Element) {
    editor.change((els) => els.map((el) => (el.id === id ? fn(el) : el)))
  }

  function add(el: Element) {
    editor.change((els) => [...els, el])
  }

  function finishEditing() {
    if (!editing) return
    const text = normalizeText(draftRef.current?.id === editing.id ? draftRef.current.text : editing.text)
    setDraft(null)
    const isNew = newText.current === editing.id
    newText.current = null
    const id = editing.id
    if (isNew) {
      if (!text.trim()) editor.end(false)
      else {
        update(id, (el) => ({ ...el, text }))
        editor.end(true)
      }
    } else if (!text.trim()) {
      editor.commit((els) => els.filter((el) => el.id !== id))
    } else if (text !== editing.text) {
      editor.commit((els) => els.map((el) => (el.id === id ? { ...el, text } : el)))
    }
    editor.stopEditing(id)
  }

  function onPointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (e.button !== 0) return
    // Otherwise the browser moves focus on mousedown, which would blur a textarea the click is about to create.
    e.preventDefault()
    // Clicking the page while typing finishes the text first.
    if (editing) finishEditing()
    // Leave numeric/page controls so arrow keys nudge the canvas selection.
    // Text editing handles its own focus and blur lifecycle.
    if (!editing && tool !== 'text') e.currentTarget.focus({ preventScroll: true })
    const p = choosingRegion ? clampPoint(toPoint(e), size) : toPoint(e)
    const target = e.target as SVGElement
    const common = { id: crypto.randomUUID(), page: pageNumber }
    let next: Drag | null = null

    if (tool === 'region') {
      setRegionError(null)
      editor.select(null)
      setRegionDraft({ x: p[0], y: p[1], width: 0, height: 0 })
      next = { kind: 'region', start: p }
    } else if (tool === 'select') {
      const handle = target.closest('[data-handle]')?.getAttribute('data-handle')
      if (handle && selected) {
        editor.begin()
        next =
          selected.type === 'line'
            ? { kind: 'endpoint', id: selected.id, handle: handle as 'p1' | 'p2', moved: false }
            : { kind: 'resize', id: selected.id, orig: selected as BoxElement, handle: handle as Handle, start: p, moved: false }
      } else {
        const id = target.closest('[data-id]')?.getAttribute('data-id')
        const hit = id ? elements.find((el) => el.id === id) : undefined
        editor.select(hit?.id ?? null)
        if (hit) {
          // Double-click can't be used here: cancelling pointerdown above also cancels the mouse events it is made of.
          const now = performance.now()
          const again = lastTap.current?.id === hit.id && now - lastTap.current.time < 400
          lastTap.current = { id: hit.id, time: now }
          if (again && hit.type === 'text') {
            editor.edit(hit.id)
            return
          }
          editor.begin()
          next = { kind: 'move', id: hit.id, orig: hit, start: p, moved: false,
            client: [e.clientX, e.clientY], startClient: [e.clientX, e.clientY], currentPage: pageNumber,
            grab: hit.type === 'region' ? [(p[0] - hit.x) / hit.width, (p[1] - hit.y) / hit.height] : [0, 0] }
        }
      }
    } else if (tool === 'text') {
      const el: TextElement = {
        ...common,
        type: 'text',
        x: p[0],
        y: p[1] - (style.size * TEXT_LINE_HEIGHT) / 2,
        text: '',
        size: style.size,
        color: style.color,
        family: style.family,
        bold: style.bold,
        italic: style.italic,
      }
      editor.begin()
      add(el)
      newText.current = el.id
      editor.select(el.id)
      editor.edit(el.id)
      editor.toolDone()
      return
    } else if (tool === 'draw') {
      editor.begin()
      add({ ...common, type: 'draw', points: [p], stroke: style.stroke, strokeWidth: style.strokeWidth })
      next = { kind: 'draw', id: common.id, last: p }
    } else if (tool === 'line') {
      editor.begin()
      add({ ...common, type: 'line', x1: p[0], y1: p[1], x2: p[0], y2: p[1], stroke: style.stroke, strokeWidth: style.strokeWidth })
      next = { kind: 'line', id: common.id, start: p }
    } else {
      editor.begin()
      const box = { x: p[0], y: p[1], width: 0, height: 0 }
      if (tool === 'highlight') add({ ...common, type: 'highlight', ...box, color: style.highlight })
      else add({ ...common, type: tool, ...box, stroke: style.stroke, strokeWidth: style.strokeWidth, fill: style.fill })
      next = { kind: 'box', id: common.id, start: p }
    }

    if (next) {
      drag.current = next
      e.currentTarget.setPointerCapture(e.pointerId)
    }
  }

  function placeMovingRegion(d: Extract<Drag, { kind: 'move' }>) {
    if (d.orig.type !== 'region' || !editor.placeRegion) return
    const next = editor.placeRegion(d.orig, d.client, d.grab, d.currentPage)
    const last = d.lastRegion ?? d.orig
    d.currentPage = next.page
    d.lastRegion = next
    if (next.page !== last.page || next.x !== last.x || next.y !== last.y || next.width !== last.width || next.height !== last.height) {
      update(d.id, () => next)
    }
  }

  function stopAutoScroll() {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = null
  }

  function startAutoScroll() {
    if (scrollFrame.current !== null || !editor.scrollRegionDrag) return
    let previous: number | null = null
    const tick = (time: number) => {
      scrollFrame.current = null
      const d = drag.current
      if (d?.kind !== 'move' || d.orig.type !== 'region' || !d.moved) return
      const elapsed = previous === null ? 16 : time - previous
      previous = time
      if (editor.scrollRegionDrag?.(d.client, elapsed)) {
        placeMovingRegion(d)
        scrollFrame.current = requestAnimationFrame(tick)
      }
    }
    scrollFrame.current = requestAnimationFrame(tick)
  }

  function onPointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    const d = drag.current
    if (!d) return
    const p = toPoint(e)
    switch (d.kind) {
      case 'region':
        setRegionDraft(boxBetween(d.start, clampPoint(p, size)))
        break
      case 'move': {
        if (d.orig.type === 'region' && editor.placeRegion) {
          d.client = [e.clientX, e.clientY]
          if (!d.moved && distance(d.startClient, d.client) < 1) return
          d.moved = true
          placeMovingRegion(d)
          startAutoScroll()
          break
        }
        const dx = p[0] - d.start[0]
        const dy = p[1] - d.start[1]
        if (!d.moved && Math.hypot(dx, dy) < 1) return
        d.moved = true
        update(d.id, () => {
          const next = moved(d.orig, dx, dy)
          return next.type === 'region' ? withBox(next, constrainBox(next, size)) : next
        })
        break
      }
      case 'resize': {
        d.moved = true
        // Pictures keep their shape unless Shift is held; shapes are the other way round.
        const keepAspect = d.orig.type === 'region' ? !e.shiftKey : d.orig.type === 'image' ? lockImageAspect || !e.shiftKey : e.shiftKey
        const box = resized(bounds(d.orig), d.handle, p[0] - d.start[0], p[1] - d.start[1], keepAspect)
        update(d.id, (el) => withBox(el as BoxElement, d.orig.type === 'region' ? constrainBox(box, size, keepAspect) : box))
        break
      }
      case 'endpoint':
        d.moved = true
        update(d.id, (el) => {
          const line = el as LineElement
          return d.handle === 'p1' ? { ...line, x1: p[0], y1: p[1] } : { ...line, x2: p[0], y2: p[1] }
        })
        break
      case 'box':
        update(d.id, (el) => withBox(el as BoxElement, boxBetween(d.start, p)))
        break
      case 'line':
        update(d.id, (el) => ({ ...(el as LineElement), x2: p[0], y2: p[1] }))
        break
      case 'draw':
        if (distance(d.last, p) < 0.5) return
        d.last = p
        update(d.id, (el) => (el.type === 'draw' ? { ...el, points: [...el.points, p] } : el))
        break
    }
  }

  function onPointerUp(e: ReactPointerEvent<SVGSVGElement>) {
    stopAutoScroll()
    const d = drag.current
    if (!d) return
    drag.current = null
    const p = toPoint(e)
    switch (d.kind) {
      case 'region': {
        setRegionDraft(null)
        const box = roundedBox(boxBetween(d.start, clampPoint(p, size)))
        if (box.width < MIN_SIZE || box.height < MIN_SIZE) break
        if (regions.some((el) => boxesOverlap(el.source, box))) {
          setRegionError('That overlaps an existing source region. Select a separate area of the original page.')
          break
        }
        const id = crypto.randomUUID()
        editor.commit((els) => [...els, { id, page: pageNumber, sourcePage: pageNumber, type: 'region', source: box, ...box }])
        editor.select(id)
        editor.toolDone()
        break
      }
      case 'move':
        if (d.moved && d.orig.type === 'region' && editor.placeRegion) {
          d.client = [e.clientX, e.clientY]
          placeMovingRegion(d)
        }
        editor.end(d.moved)
        break
      case 'resize':
      case 'endpoint':
        editor.end(d.moved)
        break
      case 'box': {
        const box = boxBetween(d.start, p)
        if (box.width < MIN_SIZE || box.height < MIN_SIZE) {
          editor.end(false)
        } else {
          editor.end(true)
          editor.select(d.id)
          if (tool !== 'highlight') editor.toolDone()
        }
        break
      }
      case 'line':
        if (distance(d.start, p) < MIN_SIZE) {
          editor.end(false)
        } else {
          editor.end(true)
          editor.select(d.id)
          editor.toolDone()
        }
        break
      case 'draw':
        editor.end(true)
        break
    }
  }

  function cancelDrag() {
    stopAutoScroll()
    const d = drag.current
    if (!d) return
    drag.current = null
    if (d.kind === 'region') setRegionDraft(null)
    else editor.end(false)
  }

  const width = size.width * zoom
  const height = size.height * zoom
  const interactive = tool === 'select'

  return (
    <div className="relative" style={{ width, height }}>
      <PageThumbnail doc={doc} pageNumber={pageNumber} width={width} aspect={size.width / size.height} />
      <svg
        ref={svg}
        viewBox={`0 0 ${size.width} ${size.height}`}
        className="absolute inset-0 h-full w-full touch-none select-none"
        style={{ cursor: CURSORS[tool] }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={cancelDrag}
        onLostPointerCapture={cancelDrag}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && drag.current) {
            event.preventDefault()
            event.stopPropagation()
            cancelDrag()
          }
        }}
        aria-label={`Edit page ${pageNumber}`}
        data-editor-page={pageNumber}
        tabIndex={0}
      >
        {choosingRegion ? (
          <>
            {regions.map((el) => <rect key={el.id} {...el.source} fill="#e11d48" fillOpacity={0.15} stroke="#e11d48" strokeWidth={1 / zoom} pointerEvents="none" />)}
            {regionDraft && <rect {...regionDraft} fill="#e11d48" fillOpacity={0.1} stroke="#e11d48" strokeWidth={1 / zoom} strokeDasharray={`${4 / zoom} ${3 / zoom}`} pointerEvents="none" />}
          </>
        ) : (
          <>
            {regions.map((el) => <rect key={el.id} data-region-source={el.id} {...el.source} fill="white" pointerEvents="none" />)}
            {elements.map((el) => (el.id === editing?.id ? null : render(el, zoom, interactive, doc)))}
            {selected && selected.id !== editing?.id && <Selection el={selected} zoom={zoom} cornersOnly={selected.type === 'region' || (lockImageAspect && selected.type === 'image')} />}
          </>
        )}
      </svg>
      {regionError && <p role="alert" className="absolute inset-x-2 bottom-2 rounded bg-rose-50 p-3 text-sm text-rose-800 shadow">{regionError}</p>}
      {editing && (
        <TextEditor
          key={editing.id}
          el={editing}
          zoom={zoom}
          text={draft?.id === editing.id ? draft.text : editing.text}
          onChange={(text) => setDraft({ id: editing.id, text })}
          onDone={finishEditing}
        />
      )}
    </div>
  )
}

function render(el: Element, zoom: number, interactive: boolean, doc: PDFDocumentProxy): ReactNode {
  const className = interactive ? 'cursor-move' : undefined
  // Thin strokes are hard to hit, so an invisible wider twin takes the clicks.
  const hitWidth = (strokeWidth: number) => Math.max(strokeWidth, 10 / zoom)

  switch (el.type) {
    case 'region':
      if (el.deleted) return null
      return (
        <g key={el.id} data-id={el.id} className={className}>
          <RegionPreview region={el} doc={doc} zoom={zoom} />
          <rect x={el.x} y={el.y} width={el.width} height={el.height} fill="transparent" />
        </g>
      )
    case 'text': {
      const box = textBox(el)
      return (
        <g key={el.id} data-id={el.id} className={className}>
          <rect x={box.x} y={box.y} width={box.width} height={box.height} fill="transparent" />
          <text
            fill={el.color}
            fontSize={el.size}
            fontFamily={familyCss(el.family, el.text)}
            fontWeight={el.bold ? 'bold' : 'normal'}
            fontStyle={el.italic ? 'italic' : 'normal'}
            style={{ whiteSpace: 'pre' }}
            pointerEvents="none"
          >
            {textLines(el.text).map((line, i) => (
              <tspan key={i} x={el.x} y={el.y + el.size * TEXT_ASCENT + i * el.size * TEXT_LINE_HEIGHT}>
                {line}
              </tspan>
            ))}
          </text>
        </g>
      )
    }
    case 'image':
      return (
        <image
          key={el.id}
          data-id={el.id}
          href={el.url}
          x={el.x}
          y={el.y}
          width={el.width}
          height={el.height}
          preserveAspectRatio="none"
          className={className}
        />
      )
    case 'rect':
      return (
        <g key={el.id} data-id={el.id} className={className}>
          <rect x={el.x} y={el.y} width={el.width} height={el.height} stroke={el.stroke} strokeWidth={el.strokeWidth} fill={el.fill ?? 'none'} pointerEvents="none" />
          <rect x={el.x} y={el.y} width={el.width} height={el.height} stroke="transparent" strokeWidth={hitWidth(el.strokeWidth)} fill={el.fill ? 'transparent' : 'none'} />
        </g>
      )
    case 'ellipse': {
      const c = { cx: el.x + el.width / 2, cy: el.y + el.height / 2, rx: el.width / 2, ry: el.height / 2 }
      return (
        <g key={el.id} data-id={el.id} className={className}>
          <ellipse {...c} stroke={el.stroke} strokeWidth={el.strokeWidth} fill={el.fill ?? 'none'} pointerEvents="none" />
          <ellipse {...c} stroke="transparent" strokeWidth={hitWidth(el.strokeWidth)} fill={el.fill ? 'transparent' : 'none'} />
        </g>
      )
    }
    case 'highlight':
      return (
        <rect
          key={el.id}
          data-id={el.id}
          x={el.x}
          y={el.y}
          width={el.width}
          height={el.height}
          fill={el.color}
          style={{ mixBlendMode: 'multiply' }}
          className={className}
        />
      )
    case 'line':
      return (
        <g key={el.id} data-id={el.id} className={className}>
          <line x1={el.x1} y1={el.y1} x2={el.x2} y2={el.y2} stroke={el.stroke} strokeWidth={el.strokeWidth} strokeLinecap="round" pointerEvents="none" />
          <line x1={el.x1} y1={el.y1} x2={el.x2} y2={el.y2} stroke="transparent" strokeWidth={hitWidth(el.strokeWidth)} strokeLinecap="round" />
        </g>
      )
    case 'draw': {
      // A lone point still needs two of them to show up as a dot.
      const points = (el.points.length > 1 ? el.points : [...el.points, ...el.points]).map((p) => p.join(',')).join(' ')
      return (
        <g key={el.id} data-id={el.id} className={className}>
          <polyline points={points} fill="none" stroke={el.stroke} strokeWidth={el.strokeWidth} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
          <polyline points={points} fill="none" stroke="transparent" strokeWidth={hitWidth(el.strokeWidth)} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )
    }
  }
}

const HANDLE_CURSORS: Record<Handle, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
}

function handleCentre(b: Box, h: Handle): Point {
  const x = h.includes('w') ? b.x : h.includes('e') ? b.x + b.width : b.x + b.width / 2
  const y = h.includes('n') ? b.y : h.includes('s') ? b.y + b.height : b.y + b.height / 2
  return [x, y]
}

/** The dashed outline and handles around the selected element, kept the same size on screen at any zoom. */
function Selection({ el, zoom, cornersOnly = false }: { el: Element; zoom: number; cornersOnly?: boolean }) {
  const b = bounds(el)
  const s = 8 / zoom
  const stroke = 1 / zoom
  const handleProps = { fill: 'white', stroke: '#e11d48', strokeWidth: stroke }
  return (
    <g>
      <rect
        x={b.x}
        y={b.y}
        width={b.width}
        height={b.height}
        fill="none"
        stroke="#e11d48"
        strokeWidth={stroke}
        strokeDasharray={`${4 / zoom} ${3 / zoom}`}
        pointerEvents="none"
      />
      {el.type === 'line' &&
        (
          [
            ['p1', el.x1, el.y1],
            ['p2', el.x2, el.y2],
          ] as const
        ).map(([h, cx, cy]) => <circle key={h} data-handle={h} cx={cx} cy={cy} r={s / 2} className="cursor-move" {...handleProps} />)}
      {(el.type === 'region' || el.type === 'image' || el.type === 'rect' || el.type === 'ellipse' || el.type === 'highlight') &&
        HANDLES.filter((h) => !cornersOnly || h.length === 2).map((h) => {
          const [cx, cy] = handleCentre(b, h)
          return (
            <rect key={h} data-handle={h} x={cx - s / 2} y={cy - s / 2} width={s} height={s} style={{ cursor: HANDLE_CURSORS[h] }} {...handleProps} />
          )
        })}
    </g>
  )
}

/** A textarea laid exactly over where the text is drawn, in the same font. */
function TextEditor({
  el,
  zoom,
  text,
  onChange,
  onDone,
}: {
  el: TextElement
  zoom: number
  text: string
  onChange: (text: string) => void
  onDone: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])

  // Measured with the draft, not the saved text: typing a character beyond the standard fonts switches fonts.
  const draft = { ...el, text }
  const lines = textLines(text)
  const width = Math.max(el.size * 4, ...lines.map((l) => lineWidth(l, draft))) + el.size
  const height = lines.length * el.size * TEXT_LINE_HEIGHT

  return (
    <textarea
      ref={ref}
      value={text}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onDone}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault()
          ref.current?.blur()
        }
      }}
      wrap="off"
      spellCheck={false}
      aria-label="Text"
      className="absolute m-0 resize-none overflow-hidden whitespace-pre border-0 bg-transparent p-0 outline-1 outline-offset-2 outline-rose-500 outline-dashed"
      style={{
        left: el.x * zoom,
        top: textareaTop(el) * zoom,
        width: width * zoom,
        height: height * zoom + 2,
        fontStyle: el.italic ? 'italic' : 'normal',
        fontWeight: el.bold ? 'bold' : 'normal',
        fontSize: el.size * zoom,
        fontFamily: familyCss(el.family, text),
        lineHeight: TEXT_LINE_HEIGHT,
        color: el.color,
      }}
    />
  )
}
