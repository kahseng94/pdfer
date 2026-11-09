import { useState } from 'react'
import { convertSuffix, outputName, PHOTO_FORMATS, type PhotoFormat } from '../lib/photoEdits'
import { usePhotoEdit } from '../lib/usePhotoEdit'
import { batchProblem, readyItems, totalLine, usePhotoItems, type PhotoItem } from '../lib/usePhotoItems'
import { Outcome, PhotoEmpty, PhotoList, SkippedNotice } from './PhotoItems'
import { ResultCard } from './ResultCard'
import { Button, DropOverlay, ErrorMessage, FIELD } from './ui'

type Target = Exclude<PhotoFormat, 'keep'>

/** Saves a batch of photos in another format. */
export function PhotoConvertTool({ active = true }: { active?: boolean }) {
  const photos = usePhotoItems('photo-convert', active)
  const [format, setFormat] = useState<Target>('jpeg')
  const [quality, setQuality] = useState(90)
  const [background, setBackground] = useState('#ffffff')
  const [strip, setStrip] = useState(false)
  const lossy = format !== 'png'
  const suffix = convertSuffix(photos.items.map((it) => it.file), format)
  const edit = usePhotoEdit([format, lossy ? quality : null, format === 'jpeg' ? background : null, strip, ...photos.items.map((it) => it.file)])
  const ready = readyItems(photos.items)
  const blocked = batchProblem(photos.items)
  const count = photos.items.length

  if (!count) {
    return <PhotoEmpty title="Choose images to convert" multiple onFiles={photos.add} onSkipped={photos.noteSkipped} dragging={photos.dragging} skipped={photos.skipped} />
  }

  function outcome(item: PhotoItem) {
    const made = edit.result.value?.results.get(item.id)
    if (made) return <Outcome result={made} />
    return <span>→ {outputName(item.file.name, format, suffix)}</span>
  }

  return (
    <div className="space-y-5">
      {photos.dragging && <DropOverlay label="Drop images to add" />}
      <SkippedNotice count={photos.skipped} />
      <PhotoList items={photos.items} onAdd={photos.add} onSkipped={photos.noteSkipped} onRemove={photos.remove} onClear={photos.clear} detail={outcome} />

      <fieldset>
        <legend className="mb-2 text-sm font-medium">Save as</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {PHOTO_FORMATS.map((f) => (
            <label
              key={f.value}
              className={`cursor-pointer rounded-lg border px-3 py-2.5 has-focus-visible:outline-2 has-focus-visible:outline-rose-600 ${
                format === f.value ? 'border-rose-500 bg-rose-50 dark:bg-rose-950/30' : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'
              }`}
            >
              <input type="radio" name="photo-convert-format" aria-label={f.label} checked={format === f.value} onChange={() => setFormat(f.value)} className="sr-only" />
              <span className="block font-medium text-zinc-900 dark:text-zinc-100">{f.label}</span>
              <span className="block text-sm text-zinc-500">{f.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-zinc-600 dark:text-zinc-400">
        {lossy && (
          <label className="flex items-center gap-2">
            Quality
            <input type="range" min={1} max={100} step={1} value={quality} onChange={(e) => setQuality(Number(e.target.value))} aria-label="Quality" className="w-40 accent-rose-600" />
            <span className="w-8 tabular-nums">{quality}</span>
          </label>
        )}
        {format === 'jpeg' && (
          <label className="flex items-center gap-2">
            Behind transparency
            <input type="color" value={background} onChange={(e) => setBackground(e.target.value)} aria-label="Colour behind transparency" className={`${FIELD} h-8 w-12 p-0.5`} />
          </label>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={strip} onChange={(e) => setStrip(e.target.checked)} />
          Remove camera and location data
        </label>
      </div>
      <p className="text-sm text-zinc-500">
        {format === 'jpeg' && 'JPEG is the smallest for photos. Quality 90 is hard to tell from the original; 75 is fine for sharing. Transparent areas get the colour chosen above.'}
        {format === 'png' && 'PNG keeps every pixel and transparency, so photos come out large. Best for screenshots, graphics and anything with transparent areas.'}
        {format === 'webp' && 'WebP is smaller than JPEG at the same quality and keeps transparency. Browsers and recent apps open it; some older ones do not.'}{' '}
        Animated pictures keep their first frame.{strip ? '' : ' Camera data and the colour profile come along.'}
      </p>

      {blocked && <ErrorMessage>{blocked}</ErrorMessage>}
      {edit.error && <ErrorMessage>{edit.error}</ErrorMessage>}
      {edit.result.value && (
        <ResultCard file={edit.result.value.file} from="photo-convert" onDismiss={edit.result.clear}>
          {totalLine(edit.result.value.results.values(), 'converted')}
        </ResultCard>
      )}

      <div className="tool-actions space-y-2">
        <Button
          onClick={() => edit.run(ready, { format, quality: lossy ? quality : undefined, background: format === 'jpeg' ? background : undefined, metadata: strip ? 'none' : 'keep', suffix })}
          disabled={edit.busy || !!blocked || !ready.length}
        >
          {edit.busy ? 'Converting…' : `Convert ${count} ${count === 1 ? 'image' : 'images'} to ${PHOTO_FORMATS.find((f) => f.value === format)?.label}`}
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
