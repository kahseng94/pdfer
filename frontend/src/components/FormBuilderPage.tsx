import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { PdfSize } from '../lib/documentTools'
import { HANDLES, type Box, type Handle } from '../lib/edits'
import { boxFromDrag, movedBox, resizedBox, TYPE_LABELS, type BuilderTool, type DraftField } from '../lib/formBuilder'
import type { PDFDocumentProxy } from '../lib/pdf'
import { useElementWidth, usePageCanvas } from '../lib/usePageCanvas'

type Drag =
  | { kind: 'draw'; id: number; x: number; y: number; moved: boolean }
  | { kind: 'move' | 'resize'; id: number; x: number; y: number; field: string; origin: Box; handle?: Handle; moved: boolean }

/** What the page asks of the tool; a move or resize is one undo step from begin to end. */
export type FieldEditor = {
  create: (box: Box) => void
  select: (id: string | null) => void
  /** Pick one of the PDF's own fields, so it can be deleted. */
  selectExisting: (id: string) => void
  begin: () => void
  change: (id: string, box: Box) => void
  end: (changed: boolean) => void
}

/** Where one widget of one of the PDF's own fields sits, and how the tool is treating that field. */
export type ExistingBox = Box & { id: string; name: string; removed: boolean; selected: boolean }

const handlePoint = (box: Box, handle: Handle): [number, number] => [
  box.x + (handle.includes('w') ? 0 : handle.includes('e') ? box.width : box.width / 2),
  box.y + (handle.includes('n') ? 0 : handle.includes('s') ? box.height : box.height / 2),
]
const CURSORS: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' }

export function FormBuilderPage({ doc, page, size, fields, existing, tool, selectedId, disabled, editor }: {
  doc: PDFDocumentProxy; page: number; size: PdfSize; fields: readonly DraftField[]; existing: readonly ExistingBox[]
  tool: BuilderTool; selectedId: string | null; disabled: boolean; editor: FieldEditor
}) {
  const [container, width] = useElementWidth<HTMLDivElement>()
  const drag = useRef<Drag | null>(null)
  const [drafted, setDraft] = useState<(Box & { page: number }) | null>(null)
  const draft = drafted?.page === page ? drafted : null
  const displayWidth = Math.min(width, 900 * size.width / size.height)
  const { canvas, ready, error } = usePageCanvas(doc, page, displayWidth)
  /** Points per screen pixel, so handles and labels keep their size at any zoom. */
  const px = displayWidth > 0 ? size.width / displayWidth : 1
  // Turning to another page abandons any drag that was under way.
  useEffect(() => { drag.current = null }, [doc, page])

  function point(event: PointerEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    return { x: (event.clientX - box.left) / box.width * size.width, y: (event.clientY - box.top) / box.height * size.height }
  }
  function start(event: PointerEvent<SVGSVGElement>) {
    if (disabled || !ready || event.button !== 0) return
    // The page can be taller than the window; focusing must not scroll it out from under the pointer.
    event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId)
    const at = point(event)
    const target = event.target as Element
    const handle = target.closest('[data-handle]')?.getAttribute('data-handle') as Handle | undefined
    const id = target.closest('[data-id]')?.getAttribute('data-id')
    const existingId = target.closest('[data-existing]')?.getAttribute('data-existing')
    const selected = fields.find((field) => field.id === selectedId)
    if (handle && selected) {
      editor.begin()
      drag.current = { kind: 'resize', id: event.pointerId, ...at, field: selected.id, origin: selected, handle, moved: false }
    } else if (id) {
      const field = fields.find((item) => item.id === id)!
      editor.select(id); editor.begin()
      drag.current = { kind: 'move', id: event.pointerId, ...at, field: id, origin: field, moved: false }
    } else if (existingId && tool === 'select') {
      editor.selectExisting(existingId)
    } else if (tool === 'select') {
      editor.select(null)
    } else {
      drag.current = { kind: 'draw', id: event.pointerId, ...at, moved: false }
    }
  }
  function move(event: PointerEvent<SVGSVGElement>) {
    const current = drag.current
    if (current?.id !== event.pointerId) return
    const at = point(event)
    const dx = at.x - current.x, dy = at.y - current.y
    if (!current.moved && Math.hypot(dx, dy) < 2) return
    current.moved = true
    if (current.kind === 'draw') setDraft({ ...boxFromDrag(tool as DraftField['type'], current, at, size), page })
    else if (current.kind === 'move') editor.change(current.field, movedBox(current.origin, dx, dy, size))
    else editor.change(current.field, resizedBox(current.origin, current.handle!, dx, dy, size))
  }
  function finish(event: PointerEvent<SVGSVGElement>, cancelled = false) {
    const current = drag.current
    if (current?.id !== event.pointerId) return
    drag.current = null; setDraft(null)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (current.kind === 'draw') {
      if (!cancelled && tool !== 'select') editor.create(boxFromDrag(tool, current, point(event), size))
    } else {
      if (cancelled && current.moved) editor.change(current.field, current.origin)
      editor.end(current.moved && !cancelled)
    }
  }
  const selected = fields.find((field) => field.id === selectedId)
  const label = tool === 'select' ? 'Click a field to select it, drag to move it, or drag a handle to resize it. Click one of the PDF’s own fields to delete it.' : `Click or drag to add a ${TYPE_LABELS[tool].toLowerCase()}.`
  return <div ref={container} className="space-y-2">
    {error && <p role="alert" className="text-sm text-red-600">Could not render this page: {error}</p>}
    {!ready && !error && <p role="status" className="text-sm text-zinc-500">Rendering page…</p>}
    <div className={`relative mx-auto bg-white shadow-sm ${!ready ? 'invisible' : ''}`} style={{ width: displayWidth, aspectRatio: size.width / size.height }}>
      <canvas ref={canvas} className="block h-full w-full" />
      <svg viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-label={`Form page ${page}. ${label}`} data-form-page={page} tabIndex={0}
        onPointerDown={start} onPointerMove={move} onPointerUp={(event) => finish(event)} onPointerCancel={(event) => finish(event, true)}
        onKeyDown={(event) => { if (event.key === 'Escape' && drag.current?.kind === 'draw') { drag.current = null; setDraft(null) } }}
        className={`absolute inset-0 h-full w-full touch-none focus:outline-2 focus:outline-rose-500 ${tool === 'select' ? 'cursor-default' : 'cursor-crosshair'}`}>
        {/* The PDF's own fields: grey until selected, crossed out in red once marked for removal. Only the Select tool can pick them. */}
        {existing.map((box, index) => <g key={index} data-existing={box.id} pointerEvents={tool === 'select' ? 'auto' : 'none'} className={tool === 'select' ? 'cursor-pointer' : undefined}>
          <rect x={box.x} y={box.y} width={box.width} height={box.height}
            fill={box.removed ? '#e11d48' : box.selected ? '#3f3f46' : '#71717a'} fillOpacity={box.selected ? 0.18 : box.removed ? 0.1 : 0.08}
            stroke={box.removed ? '#e11d48' : box.selected ? '#18181b' : '#71717a'} strokeWidth={box.selected ? 2 : 1} strokeDasharray={box.selected && !box.removed ? undefined : '4 3'} vectorEffect="non-scaling-stroke" />
          {box.removed && <line x1={box.x} y1={box.y} x2={box.x + box.width} y2={box.y + box.height} stroke="#e11d48" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
          <title>{box.removed ? 'Deleted field' : 'Existing field'}: {box.name}</title>
        </g>)}
        {fields.map((field) => {
          const active = field.id === selectedId
          const round = field.type === 'radio' ? Math.min(field.width, field.height) / 2 : 0
          return <g key={field.id} data-id={field.id} className="cursor-move">
            <rect x={field.x} y={field.y} width={field.width} height={field.height} rx={round} fill="#f43f5e" fillOpacity={active ? 0.16 : 0.08} stroke="#e11d48" strokeWidth={active ? 2 : 1.25} vectorEffect="non-scaling-stroke" />
            <text x={field.x} y={field.y - 3 * px} fontSize={10 * px} fill="#be123c" pointerEvents="none" style={{ userSelect: 'none' }}>{field.type === 'radio' ? `${field.name}: ${field.option}` : field.name}</text>
            <title>{TYPE_LABELS[field.type]}: {field.name}</title>
          </g>
        })}
        {selected && HANDLES.map((handle) => {
          const [cx, cy] = handlePoint(selected, handle)
          return <rect key={handle} data-handle={handle} x={cx - 4 * px} y={cy - 4 * px} width={8 * px} height={8 * px} fill="white" stroke="#e11d48" strokeWidth={1} vectorEffect="non-scaling-stroke" style={{ cursor: CURSORS[handle] }} />
        })}
        {draft && <rect x={draft.x} y={draft.y} width={draft.width} height={draft.height} fill="#f43f5e" fillOpacity={0.12} stroke="#e11d48" strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />}
      </svg>
    </div>
  </div>
}
