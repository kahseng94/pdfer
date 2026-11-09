import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { HANDLES, moveBox, resizeBox, type Box, type Handle } from '../lib/cropBox'
import type { Size } from '../lib/photo'
import { turnStyle, type Orientation } from '../lib/photoEdits'

type Props = {
  url: string
  /** The picture's size in pixels as shown, after the orientation is applied. */
  image: Size
  orientation: Orientation
  box: Box
  /** Width / height the box must keep, or null for any shape. */
  aspect: number | null
  onChange: (box: Box) => void
}

const CURSORS: Record<Handle, string> = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
}

/** The square handles' size in CSS pixels. */
const HANDLE = 12

/**
 * The picture with a box over the part to keep. Dragging the box moves it,
 * dragging its sides and corners resizes it, and the arrow keys nudge it.
 */
export function CropBox({ url, image, orientation, box, aspect, onChange }: Props) {
  const stage = useRef<HTMLDivElement>(null)
  const [stageSize, setStageSize] = useState<Size>({ width: 0, height: 0 })
  const maskId = useId()
  const drag = useRef<{ x: number; y: number; box: Box; handle: Handle | null } | null>(null)

  useEffect(() => {
    const el = stage.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setStageSize({ width, height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // CSS pixels per picture pixel, with the picture fitted inside the stage.
  const scale = stageSize.width && stageSize.height ? Math.min(stageSize.width / image.width, stageSize.height / image.height) : 0
  const drawn = { width: image.width * scale, height: image.height * scale }
  const ox = (stageSize.width - drawn.width) / 2
  const oy = (stageSize.height - drawn.height) / 2
  // The <img> holds the pixels before the turn, so a quarter turn swaps its sides.
  const odd = orientation.turns % 2 === 1
  const imgWidth = odd ? drawn.height : drawn.width
  const imgHeight = odd ? drawn.width : drawn.height

  const bx = ox + box.x * scale
  const by = oy + box.y * scale
  const bw = box.width * scale
  const bh = box.height * scale

  function start(e: ReactPointerEvent, handle: Handle | null) {
    if (e.button !== 0) return
    e.preventDefault()
    stage.current?.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, box, handle }
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d || !scale) return
    const dx = (e.clientX - d.x) / scale
    const dy = (e.clientY - d.y) / scale
    onChange(d.handle ? resizeBox(d.box, d.handle, dx, dy, image, aspect) : moveBox(d.box, dx, dy, image))
  }

  function end() {
    drag.current = null
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 10 : 1
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    if (!(e.key in moves)) return
    e.preventDefault()
    const [dx, dy] = moves[e.key]
    onChange(e.altKey ? resizeBox(box, 'se', dx, dy, image, aspect) : moveBox(box, dx, dy, image))
  }

  function handleAt(handle: Handle): { x: number; y: number } {
    const x = handle.includes('w') ? bx : handle.includes('e') ? bx + bw : bx + bw / 2
    const y = handle.includes('n') ? by : handle.includes('s') ? by + bh : by + bh / 2
    return { x, y }
  }

  return (
    <div
      ref={stage}
      role="application"
      aria-label="Crop frame. Drag it to move it, drag its edges to resize it. Arrow keys nudge it, Shift for bigger steps, Alt to resize."
      tabIndex={0}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      style={{ height: 'clamp(240px, 60vh, 640px)' }}
      className="relative w-full touch-none overflow-hidden rounded-xl bg-zinc-900 select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600"
    >
      {scale > 0 && (
        <>
          <img
            src={url}
            alt=""
            draggable={false}
            style={{
              position: 'absolute',
              left: ox + (drawn.width - imgWidth) / 2,
              top: oy + (drawn.height - imgHeight) / 2,
              width: imgWidth,
              height: imgHeight,
              maxWidth: 'none',
              transform: turnStyle(orientation),
            }}
          />
          <svg className="absolute inset-0" width={stageSize.width} height={stageSize.height} aria-hidden="true">
            <defs>
              <mask id={maskId}>
                <rect width="100%" height="100%" fill="white" />
                <rect x={bx} y={by} width={bw} height={bh} fill="black" />
              </mask>
            </defs>
            <rect width="100%" height="100%" fill="black" fillOpacity={0.55} mask={`url(#${maskId})`} style={{ pointerEvents: 'none' }} />
            <g fill="none" stroke="white" style={{ pointerEvents: 'none' }}>
              <rect x={bx} y={by} width={bw} height={bh} strokeWidth={2} />
              <g strokeOpacity={0.4}>
                <line x1={bx + bw / 3} x2={bx + bw / 3} y1={by} y2={by + bh} />
                <line x1={bx + (2 * bw) / 3} x2={bx + (2 * bw) / 3} y1={by} y2={by + bh} />
                <line x1={bx} x2={bx + bw} y1={by + bh / 3} y2={by + bh / 3} />
                <line x1={bx} x2={bx + bw} y1={by + (2 * bh) / 3} y2={by + (2 * bh) / 3} />
              </g>
            </g>
            <rect
              data-crop-body=""
              x={bx}
              y={by}
              width={bw}
              height={bh}
              fill="transparent"
              style={{ cursor: 'move' }}
              onPointerDown={(e) => start(e, null)}
            />
            {HANDLES.map((handle) => {
              const { x, y } = handleAt(handle)
              return (
                <rect
                  key={handle}
                  data-handle={handle}
                  x={x - HANDLE / 2}
                  y={y - HANDLE / 2}
                  width={HANDLE}
                  height={HANDLE}
                  rx={2}
                  fill="white"
                  stroke="rgba(0, 0, 0, 0.6)"
                  style={{ cursor: CURSORS[handle] }}
                  onPointerDown={(e) => start(e, handle)}
                />
              )
            })}
          </svg>
        </>
      )}
    </div>
  )
}
