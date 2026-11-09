import { useState } from 'react'
import { ASPECTS, aspectFor, clampBox, fitBox, flipBox, rotateBox, toCrop, turnedSize, type Box } from '../lib/cropBox'
import type { Size } from '../lib/photo'
import { UPRIGHT, type Orientation, type Turn } from '../lib/photoEdits'
import { usePhotoEdit } from '../lib/usePhotoEdit'
import { onlyItem, usePhotoItems, type PhotoItem } from '../lib/usePhotoItems'
import { CropBox } from './CropBox'
import { PhotoEmpty, PhotoHeader } from './PhotoItems'
import { OrientationControls, type OrientationAction } from './PhotoRotateTool'
import { ResultCard } from './ResultCard'
import { Button, DropOverlay, ErrorMessage, FIELD } from './ui'

/** Cuts one part out of a photo, turned and mirrored first if wanted. */
export function PhotoCropTool({ active = true }: { active?: boolean }) {
  const photos = usePhotoItems('photo-crop', active, { single: true })
  const item = onlyItem(photos.items)

  if (!item) {
    return <PhotoEmpty title="Choose a photo to crop" multiple={false} onFiles={photos.add} onSkipped={photos.noteSkipped} dragging={photos.dragging} skipped={photos.skipped} />
  }

  return (
    <div className="space-y-5">
      {photos.dragging && <DropOverlay label="Drop a photo to open" />}
      <PhotoHeader item={item} onReset={photos.clear} />
      {item.preview === 'error' && <ErrorMessage>This photo can’t be read.</ErrorMessage>}
      {item.preview === 'none' && <ErrorMessage>This format can’t be shown here, so it can’t be cropped by eye. Convert it to JPEG or PNG first.</ErrorMessage>}
      {item.preview === 'loading' && <p role="status" className="text-sm text-zinc-500">Opening the photo…</p>}
      {item.size && item.preview === 'ready' && <CropEditor key={item.id} item={item} source={item.size} />}
    </div>
  )
}

/** The frame over one photo. A new photo gets a new editor, so everything starts afresh. */
function CropEditor({ item, source }: { item: PhotoItem; source: Size }) {
  const [orientation, setOrientation] = useState<Orientation>(UPRIGHT)
  const [choice, setChoice] = useState('free')
  const [custom, setCustom] = useState<Size>({ width: 4, height: 3 })
  // Where the user has put the box; null means the largest that fits.
  const [placed, setPlaced] = useState<Box | null>(null)

  const image = turnedSize(source, orientation.turns)
  const aspect = aspectFor(choice, image, custom)
  const box = placed ? clampBox(placed, image, aspect) : fitBox(image, aspect)
  const edit = usePhotoEdit([orientation.turns, orientation.flip, box.x, box.y, box.width, box.height])

  function reorient(next: Orientation, action: OrientationAction) {
    // Keep the same part of the picture selected as it turns or mirrors on screen.
    setPlaced(action.kind === 'turn' ? rotateBox(box, image, action.clockwise) : flipBox(box, image, action.flip))
    setOrientation(next)
  }

  function place(field: keyof Box, value: number) {
    if (!Number.isFinite(value)) return
    const next = { ...box, [field]: value }
    if (aspect !== null && field === 'width') next.height = value / aspect
    if (aspect !== null && field === 'height') next.width = value * aspect
    setPlaced(clampBox(next, image, aspect))
  }

  const field = (label: string, key: keyof Box, max: number) => (
    <label className="text-sm text-zinc-600 dark:text-zinc-400">
      <span className="mb-1 block">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        max={max}
        step={1}
        value={box[key]}
        onChange={(e) => place(key, e.target.valueAsNumber)}
        aria-label={label}
        className={`${FIELD} w-24 py-1.5`}
      />
    </label>
  )

  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-zinc-600 dark:text-zinc-400">
          <span className="mb-1 block">Shape</span>
          <select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Shape" className={`${FIELD} py-1.5`}>
            {ASPECTS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </label>
        {choice === 'custom' && (
          <div className="flex items-end gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <label>
              <span className="mb-1 block">Width</span>
              <input type="number" min={1} step={1} value={custom.width} onChange={(e) => setCustom((c) => ({ ...c, width: e.target.valueAsNumber }))} aria-label="Shape width" className={`${FIELD} w-20 py-1.5`} />
            </label>
            <span className="pb-2">:</span>
            <label>
              <span className="mb-1 block">Height</span>
              <input type="number" min={1} step={1} value={custom.height} onChange={(e) => setCustom((c) => ({ ...c, height: e.target.valueAsNumber }))} aria-label="Shape height" className={`${FIELD} w-20 py-1.5`} />
            </label>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <OrientationControls value={orientation} onChange={reorient} />
        </div>
      </div>

      <CropBox url={item.url} image={image} orientation={orientation} box={box} aspect={aspect} onChange={setPlaced} />

      <div className="flex flex-wrap items-end gap-3">
        {field('Left', 'x', image.width)}
        {field('Top', 'y', image.height)}
        {field('Width', 'width', image.width)}
        {field('Height', 'height', image.height)}
        <button type="button" onClick={() => setPlaced(null)} className="pb-2 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
          Reset frame
        </button>
        <p role="status" className="ml-auto pb-2 text-sm text-zinc-600 dark:text-zinc-400">
          Output: <span className="font-medium text-zinc-900 dark:text-zinc-100">{box.width} × {box.height} px</span>
        </p>
      </div>
      <p className="text-sm text-zinc-500">
        Drag the frame to move it and its edges or corners to resize it. The photo keeps its format; a JPEG is re-encoded at high quality with its camera data.
      </p>

      {edit.error && <ErrorMessage>{edit.error}</ErrorMessage>}
      {edit.result.value && (
        <ResultCard file={edit.result.value.file} from="photo-crop" onDismiss={edit.result.clear}>
          {[...edit.result.value.results.values()].map((r) => `${r.width} × ${r.height} px`).join('')}
        </ResultCard>
      )}

      <div className="tool-actions">
        <Button
          onClick={() => edit.run([item], { rotate: (orientation.turns * 90) as Turn, flip: orientation.flip, crop: toCrop(box), suffix: 'cropped' })}
          disabled={edit.busy}
        >
          {edit.busy ? 'Cropping…' : 'Crop photo'}
        </Button>
      </div>
    </>
  )
}
