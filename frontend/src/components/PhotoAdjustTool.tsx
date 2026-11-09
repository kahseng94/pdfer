import { useEffect, useRef, useState } from 'react'
import { ADJUST_KEYS, ADJUST_RANGES, adjustPixels, DEFAULT_ADJUST, isIdentity, toAdjust, type AdjustSettings } from '../lib/photoAdjust'
import { usePhotoEdit } from '../lib/usePhotoEdit'
import { onlyItem, usePhotoItems, type PhotoItem } from '../lib/usePhotoItems'
import { PhotoEmpty, PhotoHeader } from './PhotoItems'
import { ResultCard } from './ResultCard'
import { Button, DropOverlay, ErrorMessage } from './ui'

/** The preview's longest side; enough to judge by, quick enough to redraw as a slider moves. */
const PREVIEW_SIDE = 1200

const LABELS: Record<(typeof ADJUST_KEYS)[number], string> = { brightness: 'Brightness', contrast: 'Contrast', saturation: 'Saturation', sharpness: 'Sharpness' }

/** "+20%" for a factor of 1.2. */
function percent(factor: number): string {
  const value = Math.round((factor - 1) * 100)
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value)}%`
}

/** Brightens, sharpens or greys one photo, showing the change as it is made. */
export function PhotoAdjustTool({ active = true }: { active?: boolean }) {
  const photos = usePhotoItems('photo-adjust', active, { single: true })
  const item = onlyItem(photos.items)

  if (!item) {
    return <PhotoEmpty title="Choose a photo to adjust" multiple={false} onFiles={photos.add} onSkipped={photos.noteSkipped} dragging={photos.dragging} skipped={photos.skipped} />
  }

  return (
    <div className="space-y-5">
      {photos.dragging && <DropOverlay label="Drop a photo to open" />}
      <PhotoHeader item={item} onReset={photos.clear} />
      {item.preview === 'error' ? <ErrorMessage>This photo can’t be read.</ErrorMessage> : <AdjustEditor key={item.id} item={item} />}
    </div>
  )
}

/** The sliders and the live preview for one photo. A new photo gets a new editor, so the sliders start level. */
function AdjustEditor({ item }: { item: PhotoItem }) {
  const [settings, setSettings] = useState<AdjustSettings>(DEFAULT_ADJUST)
  const [comparing, setComparing] = useState(false)
  // The photo's pixels, scaled down, read once so each slider move only has to recolour them.
  const [base, setBase] = useState<ImageData | 'failed' | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const edit = usePhotoEdit([JSON.stringify(settings)])
  const identity = isIdentity(settings)
  const preview = item.preview === 'none' || base === 'failed' ? 'unavailable' : base ? 'ready' : 'loading'

  useEffect(() => {
    if (item.preview !== 'ready') return
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      const scale = Math.min(1, PREVIEW_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
      const width = Math.max(1, Math.round(img.naturalWidth * scale))
      const height = Math.max(1, Math.round(img.naturalHeight * scale))
      const scratch = document.createElement('canvas')
      scratch.width = width
      scratch.height = height
      const context = scratch.getContext('2d')
      if (!context) {
        setBase('failed')
        return
      }
      context.drawImage(img, 0, 0, width, height)
      setBase(context.getImageData(0, 0, width, height))
    }
    img.onerror = () => {
      if (!cancelled) setBase('failed')
    }
    img.src = item.url
    return () => {
      cancelled = true
    }
  }, [item.preview, item.url])

  // Redraw on the next frame, so a slider dragged quickly isn't recoloured for every pixel it passes.
  useEffect(() => {
    if (!base || base === 'failed') return
    const frame = requestAnimationFrame(() => {
      const target = canvas.current
      const context = target?.getContext('2d')
      if (!target || !context) return
      target.width = base.width
      target.height = base.height
      const pixels = comparing || identity ? base.data : adjustPixels(base.data, base.width, base.height, settings)
      context.putImageData(new ImageData(new Uint8ClampedArray(pixels), base.width, base.height), 0, 0)
    })
    return () => cancelAnimationFrame(frame)
  }, [base, settings, comparing, identity])

  return (
    <>
      <div className="relative flex min-h-60 items-center justify-center overflow-hidden rounded-xl bg-zinc-900" style={{ maxHeight: '60vh' }}>
        {preview === 'ready' ? (
          <canvas ref={canvas} aria-label={comparing ? 'The photo as it is' : 'The photo as it will be saved'} className="max-h-[60vh] max-w-full object-contain" />
        ) : (
          <p className="p-6 text-center text-sm text-zinc-400">
            {preview === 'loading' ? 'Preparing the preview…' : 'No preview for this format here; the adjustments are still applied when you save.'}
          </p>
        )}
        {preview === 'ready' && !identity && (
          <button
            type="button"
            onPointerDown={() => setComparing(true)}
            onPointerUp={() => setComparing(false)}
            onPointerLeave={() => setComparing(false)}
            onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setComparing(true) } }}
            onKeyUp={() => setComparing(false)}
            aria-pressed={comparing}
            className="absolute right-3 bottom-3 rounded-md bg-white/90 px-3 py-1.5 text-sm font-medium text-zinc-900 shadow hover:bg-white"
          >
            {comparing ? 'Original' : 'Hold to compare'}
          </button>
        )}
      </div>

      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
        {ADJUST_KEYS.map((key) => (
          <label key={key} className="block text-sm text-zinc-600 dark:text-zinc-400">
            <span className="flex items-baseline justify-between">
              <span>{LABELS[key]}</span>
              <span className="tabular-nums text-zinc-900 dark:text-zinc-100">{percent(settings[key])}</span>
            </span>
            <input
              type="range"
              min={ADJUST_RANGES[key].min}
              max={ADJUST_RANGES[key].max}
              step={ADJUST_RANGES[key].step}
              value={settings[key]}
              onChange={(e) => setSettings((s) => ({ ...s, [key]: Number(e.target.value) }))}
              onDoubleClick={() => setSettings((s) => ({ ...s, [key]: 1 }))}
              aria-label={LABELS[key]}
              title="Double-click to reset"
              className="mt-1 w-full accent-rose-600"
            />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <label className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
          <input type="checkbox" checked={settings.grayscale} onChange={(e) => setSettings((s) => ({ ...s, grayscale: e.target.checked }))} />
          Black and white
        </label>
        <button type="button" onClick={() => setSettings(DEFAULT_ADJUST)} disabled={identity} className="text-zinc-500 hover:text-zinc-800 disabled:text-zinc-300 dark:hover:text-zinc-200 dark:disabled:text-zinc-700">
          Reset all
        </button>
      </div>
      <p className="text-sm text-zinc-500">
        0% leaves the photo as it is. The photo keeps its format; a JPEG is re-encoded at high quality with its camera data.
      </p>

      {edit.error && <ErrorMessage>{edit.error}</ErrorMessage>}
      {edit.result.value && (
        <ResultCard file={edit.result.value.file} from="photo-adjust" onDismiss={edit.result.clear}>
          {[...edit.result.value.results.values()].map((r) => `${r.width} × ${r.height} px`).join('')}
        </ResultCard>
      )}

      <div className="tool-actions">
        <Button onClick={() => edit.run([item], { adjust: toAdjust(settings), suffix: 'adjusted' })} disabled={edit.busy || identity}>
          {edit.busy ? 'Saving…' : identity ? 'Move a slider to begin' : 'Save adjusted photo'}
        </Button>
      </div>
    </>
  )
}
