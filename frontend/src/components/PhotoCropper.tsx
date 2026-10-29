import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { frameSize, headGuide, panCrop, zoomCrop, type Crop, type Size } from '../lib/photo'

type Props = {
  url: string
  /** The picture's size in pixels as the browser shows it. */
  image: Size
  /** The photo's printed size in millimetres, with its head range when known. */
  photo: Size & { head?: [number, number] }
  crop: Crop
  onChange: (crop: Crop) => void
}

/** Space between the frame and the edge of the stage, where the rest of the picture shows dimmed. */
const MARGIN = 24

/** How wide a head is compared to its height, for the outline. */
const HEAD_ASPECT = 0.72

/**
 * The picture behind a fixed frame of the photo's shape, with guides for the
 * head. Dragging moves the picture under the frame; the wheel, keyboard and
 * the owner's sliders zoom and turn it.
 */
export function PhotoCropper({ url, image, photo, crop, onChange }: Props) {
  const stage = useRef<HTMLDivElement>(null)
  const [stageSize, setStageSize] = useState<Size>({ width: 0, height: 0 })
  const maskId = useId()
  const drag = useRef<{ x: number; y: number; crop: Crop } | null>(null)

  useEffect(() => {
    const el = stage.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setStageSize({ width, height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // The wheel listener must not be passive, so the page doesn't scroll while zooming;
  // React's onWheel is, so it is attached by hand and reads the latest props from a ref.
  const latest = useRef({ crop, image, onChange })
  useEffect(() => {
    latest.current = { crop, image, onChange }
  })
  useEffect(() => {
    const el = stage.current
    if (!el) return
    function onWheel(e: WheelEvent) {
      e.preventDefault()
      const { crop, image, onChange } = latest.current
      onChange(zoomCrop(crop, Math.exp(-e.deltaY * 0.002), image))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const frame = frameSize(stageSize, photo.width / photo.height, MARGIN)
  /** CSS pixels per picture pixel. */
  const scale = frame.width / crop.width
  const fx = (stageSize.width - frame.width) / 2
  const fy = (stageSize.height - frame.height) / 2
  const centerX = fx + frame.width / 2
  const centerY = fy + frame.height / 2

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, crop }
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d) return
    onChange(panCrop(d.crop, e.clientX - d.x, e.clientY - d.y, scale, image))
  }

  function onPointerEnd() {
    drag.current = null
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = frame.width * 0.02
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }
    if (e.key in moves) {
      e.preventDefault()
      onChange(panCrop(crop, ...moves[e.key], scale, image))
    } else if (e.key === '+' || e.key === '=' || e.code === 'Equal' || e.code === 'NumpadAdd') {
      e.preventDefault()
      onChange(zoomCrop(crop, 1.1, image))
    } else if (e.key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract') {
      e.preventDefault()
      onChange(zoomCrop(crop, 1 / 1.1, image))
    }
  }

  // Guides, in CSS pixels: the top of the head, and the band the chin may land in.
  const guide = headGuide(photo)
  const perMm = frame.height / photo.height
  const crownY = fy + guide.crown * perMm
  const chinMin = crownY + guide.min * perMm
  const chinMax = crownY + guide.max * perMm
  const headHeight = ((guide.min + guide.max) / 2) * perMm
  const headWidth = headHeight * HEAD_ASPECT

  return (
    <div
      ref={stage}
      role="application"
      aria-label="Photo crop. Drag to move the photo; scroll or press plus and minus to zoom; arrow keys nudge it."
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onKeyDown={onKeyDown}
      className="relative aspect-4/3 w-full cursor-grab touch-none overflow-hidden rounded-xl bg-zinc-900 select-none active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600"
    >
      {stageSize.width > 0 && (
        <>
          <img
            src={url}
            alt=""
            draggable={false}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: image.width,
              height: image.height,
              maxWidth: 'none',
              transformOrigin: '0 0',
              transform: `translate(${centerX}px, ${centerY}px) rotate(${crop.angle}deg) scale(${scale}) translate(${-crop.cx}px, ${-crop.cy}px)`,
            }}
          />
          <svg className="pointer-events-none absolute inset-0" width={stageSize.width} height={stageSize.height} aria-hidden="true">
            <defs>
              <mask id={maskId}>
                <rect width="100%" height="100%" fill="white" />
                <rect x={fx} y={fy} width={frame.width} height={frame.height} fill="black" />
              </mask>
            </defs>
            <rect width="100%" height="100%" fill="black" fillOpacity={0.6} mask={`url(#${maskId})`} />
            <g fill="none" stroke="white">
              <rect x={fx} y={fy} width={frame.width} height={frame.height} strokeWidth={2} />
              <ellipse
                cx={centerX}
                cy={crownY + headHeight / 2}
                rx={headWidth / 2}
                ry={headHeight / 2}
                strokeDasharray="4 4"
                strokeOpacity={0.6}
              />
              <line x1={fx} x2={fx + frame.width} y1={crownY} y2={crownY} strokeDasharray="6 4" />
              <rect x={fx} y={chinMin} width={frame.width} height={chinMax - chinMin} fill="white" fillOpacity={0.15} stroke="none" />
              <line x1={fx} x2={fx + frame.width} y1={chinMin} y2={chinMin} strokeDasharray="6 4" strokeOpacity={0.5} />
              <line x1={fx} x2={fx + frame.width} y1={chinMax} y2={chinMax} strokeDasharray="6 4" strokeOpacity={0.5} />
            </g>
            <g
              fill="white"
              fontSize={11}
              fontFamily="ui-sans-serif, system-ui, sans-serif"
              stroke="rgba(0, 0, 0, 0.7)"
              strokeWidth={3}
              style={{ paintOrder: 'stroke' }}
            >
              <text x={fx + 6} y={crownY - 5}>
                Top of head
              </text>
              <text x={fx + 6} y={chinMin + 14}>
                Chin
              </text>
            </g>
          </svg>
        </>
      )}
    </div>
  )
}
