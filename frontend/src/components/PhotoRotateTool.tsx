import { useState } from 'react'
import { describeOrientation, mirrored, turned, turnStyle, UPRIGHT, type Orientation, type Turn } from '../lib/photoEdits'
import { usePhotoEdit } from '../lib/usePhotoEdit'
import { RotateIcon } from './icons'
import { batchProblem, readyItems, totalLine, usePhotoItems, type PhotoItem } from '../lib/usePhotoItems'
import { Outcome, PhotoEmpty, PhotoList, SkippedNotice } from './PhotoItems'
import { ResultCard } from './ResultCard'
import { Button, DropOverlay, ErrorMessage } from './ui'

const OUTLINE =
  'inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 aria-pressed:border-rose-500 aria-pressed:bg-rose-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:aria-pressed:bg-rose-950/30'

/** What the user did to the picture on screen. */
export type OrientationAction = { kind: 'turn'; clockwise: boolean } | { kind: 'flip'; flip: 'horizontal' | 'vertical' }

/** The buttons that turn and mirror a picture on screen, shared with the crop tool. */
export function OrientationControls({ value, onChange }: { value: Orientation; onChange: (o: Orientation, action: OrientationAction) => void }) {
  const turn = (clockwise: boolean) => onChange(turned(value, clockwise), { kind: 'turn', clockwise })
  const flip = (flip: 'horizontal' | 'vertical') => onChange(mirrored(value, flip), { kind: 'flip', flip })
  return (
    <>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => turn(false)} className={OUTLINE}>
          <RotateIcon className="size-4 -scale-x-100" /> Rotate left
        </button>
        <button type="button" onClick={() => turn(true)} className={OUTLINE}>
          <RotateIcon className="size-4" /> Rotate right
        </button>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" aria-pressed={value.flip === 'horizontal'} onClick={() => flip('horizontal')} className={OUTLINE}>
          Flip horizontally
        </button>
        <button type="button" aria-pressed={value.flip === 'vertical'} onClick={() => flip('vertical')} className={OUTLINE}>
          Flip vertically
        </button>
      </div>
    </>
  )
}

/** Turns and mirrors a batch of photos the same way. */
export function PhotoRotateTool({ active = true }: { active?: boolean }) {
  const photos = usePhotoItems('photo-rotate', active)
  const [orientation, setOrientation] = useState<Orientation>(UPRIGHT)
  const edit = usePhotoEdit([orientation.turns, orientation.flip, ...photos.items.map((it) => it.file)])
  const ready = readyItems(photos.items)
  const blocked = batchProblem(photos.items)
  const count = photos.items.length
  const nothing = orientation.turns === 0 && orientation.flip === 'none'

  if (!count) {
    return <PhotoEmpty title="Choose photos to rotate or flip" multiple onFiles={photos.add} onSkipped={photos.noteSkipped} dragging={photos.dragging} skipped={photos.skipped} />
  }

  function outcome(item: PhotoItem) {
    const made = edit.result.value?.results.get(item.id)
    if (made) return <Outcome result={made} />
    if (!item.size || orientation.turns % 2 === 0) return null
    return <span>→ {item.size.height} × {item.size.width} px</span>
  }

  return (
    <div className="space-y-5">
      {photos.dragging && <DropOverlay label="Drop photos to add" />}
      <SkippedNotice count={photos.skipped} />
      <PhotoList
        items={photos.items}
        onAdd={photos.add}
        onSkipped={photos.noteSkipped}
        onRemove={photos.remove}
        onClear={photos.clear}
        detail={outcome}
        thumbStyle={{ transform: turnStyle(orientation) }}
      />

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <OrientationControls value={orientation} onChange={setOrientation} />
        <p role="status" className="text-sm text-zinc-600 dark:text-zinc-400">{describeOrientation(orientation)}</p>
        {!nothing && (
          <button type="button" onClick={() => setOrientation(UPRIGHT)} className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
            Reset
          </button>
        )}
      </div>
      <p className="text-sm text-zinc-500">
        The previews show how each photo will come out. Photos keep their format; JPEGs are re-encoded at high quality with their camera data, PNGs stay lossless.
      </p>

      {blocked && <ErrorMessage>{blocked}</ErrorMessage>}
      {edit.error && <ErrorMessage>{edit.error}</ErrorMessage>}
      {edit.result.value && (
        <ResultCard file={edit.result.value.file} from="photo-rotate" onDismiss={edit.result.clear}>
          {totalLine(edit.result.value.results.values(), orientation.turns ? 'rotated' : 'flipped')}
        </ResultCard>
      )}

      <div className="tool-actions space-y-2">
        <Button
          onClick={() => edit.run(ready, { rotate: (orientation.turns * 90) as Turn, flip: orientation.flip, suffix: orientation.turns ? 'rotated' : 'flipped' })}
          disabled={edit.busy || nothing || !!blocked || !ready.length}
        >
          {edit.busy ? 'Saving…' : nothing ? 'Choose a turn or a flip' : `Apply to ${count} ${count === 1 ? 'photo' : 'photos'}`}
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
