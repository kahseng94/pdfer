import { useState } from 'react'
import { MAX_PERCENT, MAX_PHOTO_SIDE, resizePlan, resizeProblem, type Fit, type Resize } from '../lib/photoEdits'
import { usePhotoEdit } from '../lib/usePhotoEdit'
import { batchProblem, readyItems, totalLine, usePhotoItems, type PhotoItem } from '../lib/usePhotoItems'
import { Outcome, PhotoEmpty, PhotoList, SkippedNotice } from './PhotoItems'
import { ResultCard } from './ResultCard'
import { Button, DropOverlay, ErrorMessage, FIELD } from './ui'

type Mode = 'longest' | 'width' | 'height' | 'box' | 'percent'

const MODES: { value: Mode; label: string }[] = [
  { value: 'longest', label: 'Longest side' },
  { value: 'width', label: 'Width' },
  { value: 'height', label: 'Height' },
  { value: 'box', label: 'Width and height' },
  { value: 'percent', label: 'Percentage' },
]

const FITS: { value: Fit; label: string; hint: string }[] = [
  { value: 'contain', label: 'Fit inside', hint: 'Keeps the proportions; may be smaller one way' },
  { value: 'cover', label: 'Fill and crop', hint: 'Keeps the proportions; trims the overhang from the middle' },
  { value: 'stretch', label: 'Stretch', hint: 'Exactly this size; changes the proportions' },
]

const QUICK_SIDES = [640, 1024, 1280, 1600, 1920, 2560]

/** Resizes a batch of photos to one size rule, keeping each one's format. */
export function PhotoResizeTool({ active = true }: { active?: boolean }) {
  const photos = usePhotoItems('photo-resize', active)
  const [mode, setMode] = useState<Mode>('longest')
  const [longest, setLongest] = useState('1600')
  const [width, setWidth] = useState('1200')
  const [height, setHeight] = useState('800')
  const [percent, setPercent] = useState('50')
  const [fit, setFit] = useState<Fit>('contain')
  const [enlarge, setEnlarge] = useState(false)

  const resize = buildResize(mode, { longest, width, height, percent, fit, enlarge })
  const problem = resizeProblem(resize)
  const edit = usePhotoEdit([JSON.stringify(resize), ...photos.items.map((it) => it.file)])
  const ready = readyItems(photos.items)
  const blocked = batchProblem(photos.items)
  const count = photos.items.length

  if (!count) {
    return <PhotoEmpty title="Choose photos to resize" multiple onFiles={photos.add} onSkipped={photos.noteSkipped} dragging={photos.dragging} skipped={photos.skipped} />
  }

  function planned(item: PhotoItem) {
    const made = edit.result.value?.results.get(item.id)
    if (made) return <Outcome result={made} />
    if (!item.size || problem) return null
    const { final } = resizePlan(item.size, resize)
    if (final.width === item.size.width && final.height === item.size.height) return <span>· stays this size</span>
    return <span>→ {final.width} × {final.height} px</span>
  }

  const number = (value: string, set: (v: string) => void, label: string, max = MAX_PHOTO_SIDE) => (
    <label className="space-y-1 text-sm">
      {label}
      <input
        type="number"
        inputMode="numeric"
        min={1}
        max={max}
        step={1}
        value={value}
        onChange={(e) => set(e.target.value)}
        aria-label={label}
        className={`${FIELD} block w-32`}
      />
    </label>
  )

  return (
    <div className="space-y-5">
      {photos.dragging && <DropOverlay label="Drop photos to add" />}
      <SkippedNotice count={photos.skipped} />
      <PhotoList items={photos.items} onAdd={photos.add} onSkipped={photos.noteSkipped} onRemove={photos.remove} onClear={photos.clear} detail={planned} />

      <fieldset className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <legend className="px-1 font-medium">New size</legend>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-sm">
            Set the
            <select aria-label="Resize by" value={mode} onChange={(e) => setMode(e.target.value as Mode)} className={`${FIELD} block`}>
              {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </label>
          {mode === 'longest' && number(longest, setLongest, 'Longest side (px)')}
          {(mode === 'width' || mode === 'box') && number(width, setWidth, 'Width (px)')}
          {(mode === 'height' || mode === 'box') && number(height, setHeight, 'Height (px)')}
          {mode === 'percent' && number(percent, setPercent, 'Percentage', MAX_PERCENT)}
        </div>
        {mode === 'longest' && (
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="mr-1 text-zinc-500">Common:</span>
            {QUICK_SIDES.map((side) => (
              <button
                key={side}
                type="button"
                onClick={() => setLongest(String(side))}
                aria-pressed={longest === String(side)}
                className="rounded-md border border-zinc-300 px-2 py-0.5 text-zinc-700 hover:bg-zinc-50 aria-pressed:border-rose-500 aria-pressed:bg-rose-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800 dark:aria-pressed:bg-rose-950/30"
              >
                {side}
              </button>
            ))}
          </div>
        )}
        {mode === 'box' && (
          <div className="grid gap-2 sm:grid-cols-3">
            {FITS.map((f) => (
              <label
                key={f.value}
                className={`cursor-pointer rounded-lg border px-3 py-2.5 has-focus-visible:outline-2 has-focus-visible:outline-rose-600 ${
                  fit === f.value ? 'border-rose-500 bg-rose-50 dark:bg-rose-950/30' : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'
                }`}
              >
                <input type="radio" name="photo-resize-fit" aria-label={f.label} checked={fit === f.value} onChange={() => setFit(f.value)} className="sr-only" />
                <span className="block font-medium text-zinc-900 dark:text-zinc-100">{f.label}</span>
                <span className="block text-sm text-zinc-500">{f.hint}</span>
              </label>
            ))}
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enlarge} onChange={(e) => setEnlarge(e.target.checked)} />
          Enlarge photos that are smaller than this
        </label>
        <p className="text-sm text-zinc-500">
          {mode === 'percent'
            ? 'Both sides are scaled by the same percentage.'
            : mode === 'box'
              ? 'Photos are scaled to the box; how depends on the fitting above.'
              : 'The other side follows, keeping the proportions.'}{' '}
          Each photo keeps its format; JPEGs are saved at high quality, with camera data kept. Smaller photos stay as they are unless you enlarge them.
        </p>
      </fieldset>

      {problem && <ErrorMessage>{problem}</ErrorMessage>}
      {blocked && <ErrorMessage>{blocked}</ErrorMessage>}
      {edit.error && <ErrorMessage>{edit.error}</ErrorMessage>}
      {edit.result.value && (
        <ResultCard file={edit.result.value.file} from="photo-resize" onDismiss={edit.result.clear}>
          {totalLine(edit.result.value.results.values(), 'resized')}
        </ResultCard>
      )}

      <div className="tool-actions space-y-2">
        <Button onClick={() => edit.run(ready, { resize, suffix: 'resized' })} disabled={edit.busy || !!problem || !!blocked || !ready.length}>
          {edit.busy ? 'Resizing…' : `Resize ${count} ${count === 1 ? 'photo' : 'photos'}`}
        </Button>
        {edit.busy && (
          <button type="button" onClick={edit.cancel} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}

function buildResize(mode: Mode, values: { longest: string; width: string; height: string; percent: string; fit: Fit; enlarge: boolean }): Resize {
  const num = (s: string) => (s.trim() === '' ? NaN : Number(s))
  const base = values.enlarge ? { enlarge: true } : {}
  switch (mode) {
    case 'longest':
      return { ...base, longest: num(values.longest) }
    case 'width':
      return { ...base, width: num(values.width) }
    case 'height':
      return { ...base, height: num(values.height) }
    case 'box':
      return { ...base, width: num(values.width), height: num(values.height), fit: values.fit }
    case 'percent':
      return { ...base, percent: num(values.percent) }
  }
}
