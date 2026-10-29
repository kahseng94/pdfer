import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cropPhoto, photoSheet } from '../lib/api'
import { pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import { imageSize, named } from '../lib/images'
import { formatSize } from '../lib/pdf'
import { useResult } from '../lib/result'
import {
  CUSTOM_ID,
  fitCrop,
  limitZoom,
  MAX_ZOOM,
  PAPERS,
  pixelsAt,
  PRESETS,
  reshapeCrop,
  sheetLayout,
  sizeLabel,
  zoomCrop,
  type Crop,
  type Paper,
  type Size,
} from '../lib/photo'
import { useWindowDrop } from '../lib/windowDrop'
import { Dropzone } from './Dropzone'
import { RotateIcon } from './icons'
import { PhotoCropper } from './PhotoCropper'
import { ResultCard } from './ResultCard'
import { Button, DropOverlay, ErrorMessage, FIELD, IconButton } from './ui'

/** Resolution of the photo meant for printing. */
const PRINT_DPI = 600

/** Resolution of the photo meant for uploading, when the service doesn't ask for a pixel size. */
const DIGITAL_DPI = 300

type Output = 'print' | 'digital'

type Photo = {
  file: File
  /** Object URL for the picture, revoked when it is replaced. */
  url: string
  size: Size | null
  error: string | null
}

export function PhotoTool({ active = true }: { active?: boolean }) {
  const [photo, setPhoto] = useState<Photo | null>(null)
  const [presetId, setPresetId] = useState(PRESETS[0].id)
  const [custom, setCustom] = useState<Size>({ width: 35, height: 45 })
  // Where the user has put the frame; null means the largest crop that fits.
  const [placed, setPlaced] = useState<Crop | null>(null)
  const [turns, setTurns] = useState(0)
  const [tilt, setTilt] = useState(0)
  const [output, setOutput] = useState<Output>('print')
  const [paper, setPaper] = useState<Paper>('4x6')
  const [busy, setBusy] = useState<'photo' | 'sheet' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The file whose size is loading; an older load that finishes late is dropped.
  const opening = useRef<File | null>(null)

  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0]
  const size: Size & { head?: [number, number] } =
    presetId === CUSTOM_ID ? { width: between(custom.width, 15, 150), height: between(custom.height, 15, 150) } : preset
  const aspect = size.width / size.height
  const angle = turns * 90 + tilt

  const picture = photo?.size ?? null
  const crop = picture ? reshapeCrop(placed ?? fitCrop(picture, aspect), aspect, angle, picture) : null
  const fitWidth = picture ? fitCrop(picture, aspect, angle).width : 1
  const zoom = crop ? between(fitWidth / crop.width, 1, MAX_ZOOM) : 1

  const printPx = pixelsAt(size, PRINT_DPI)
  const digitalPx = preset.digital ?? pixelsAt(size, DIGITAL_DPI)
  const target =
    output === 'print'
      ? { ...printPx, dpi: PRINT_DPI, maxKb: undefined }
      : { ...digitalPx, dpi: Math.round(digitalPx.width / (size.width / 25.4)), maxKb: preset.digital?.maxKb }
  const upscaled = crop ? Math.round(crop.width) < target.width : false
  const layout = sheetLayout(PAPERS[paper], size)
  // The photo or sheet made last, and a line about it. Its inputs are everything either of them depends on.
  const result = useResult<{ file: File; note: string }>([
    photo?.file,
    presetId,
    size.width,
    size.height,
    output,
    paper,
    crop?.cx,
    crop?.cy,
    crop?.width,
    crop?.height,
    crop?.angle,
  ])

  async function open(next: File) {
    if (photo) URL.revokeObjectURL(photo.url)
    const url = URL.createObjectURL(next)
    setPhoto({ file: next, url, size: null, error: null })
    setPlaced(null)
    setTurns(0)
    setTilt(0)
    setError(null)
    opening.current = next
    try {
      const size = await imageSize(url)
      if (opening.current === next) setPhoto((p) => (p?.file === next ? { ...p, size } : p))
    } catch {
      if (opening.current === next) setPhoto((p) => (p?.file === next ? { ...p, error: 'Can’t read this photo.' } : p))
    }
  }

  function reset() {
    if (photo) URL.revokeObjectURL(photo.url)
    opening.current = null
    setPhoto(null)
    setPlaced(null)
    setError(null)
  }

  function setZoom(value: number) {
    if (!crop || !picture) return
    setPlaced(zoomCrop(crop, crop.width / (fitWidth / value), picture))
  }

  async function savePhoto() {
    if (!photo || !crop) return
    setBusy('photo')
    setError(null)
    const finish = result.begin()
    try {
      const file = await cropPhoto(photo.file, crop, target, target.dpi, target.maxKb)
      finish({ file, note: `A ${target.width} × ${target.height} px JPEG at ${target.dpi} dpi.` })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function saveSheet() {
    if (!photo || !crop) return
    setBusy('sheet')
    setError(null)
    const finish = result.begin()
    try {
      const { file, copies } = await photoSheet(photo.file, crop, size, paper)
      finish({ file, note: `A print sheet with ${copies} ${copies === 1 ? 'photo' : 'photos'} on ${PAPERS[paper].label}.` })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  function take(files: File[]) {
    const [first] = pickFiles(files, 'image').wanted
    if (first) open(first)
  }

  const dragging = useWindowDrop(take, active)
  useReceive('photo', take)
  const overlay = dragging && <DropOverlay label="Drop a photo to crop" />

  // Paste opens a photo while this tab is showing, unless the paste is meant for a text field.
  const openLatest = useRef(open)
  useEffect(() => {
    openLatest.current = open
  })
  useEffect(() => {
    if (!active) return
    function onPaste(e: ClipboardEvent) {
      if ((e.target as Element | null)?.closest?.('input, textarea, [contenteditable]')) return
      const [first] = pickFiles(e.clipboardData?.files ?? [], 'image').wanted
      if (!first) return
      e.preventDefault()
      openLatest.current(named(first))
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [active])

  if (!photo) {
    return (
      <div className="space-y-4">
        {overlay}
        <Dropzone kind="image" title="Choose a photo to crop for a passport or visa" onFiles={([f]) => open(f)} />
        <p className="text-center text-sm text-zinc-500">You can also paste a photo.</p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {overlay}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex min-w-0 items-center gap-3">
          {!photo.error && <img src={photo.url} alt="" className="size-12 shrink-0 rounded object-cover ring-1 ring-zinc-900/10" />}
          <div className="min-w-0">
            <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">{photo.file.name}</p>
            <p className={`text-sm ${photo.error ? 'text-red-600 dark:text-red-400' : 'text-zinc-500'}`}>
              {photo.error ??
                [picture && `${picture.width} × ${picture.height} px`, formatSize(photo.file.size)].filter(Boolean).join(' · ')}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={reset}
          className="shrink-0 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          Choose another photo
        </button>
      </div>

      {picture && crop && (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-64 flex-1 text-sm text-zinc-600 dark:text-zinc-400">
              <span className="mb-1 block">Photo for</span>
              <select value={presetId} onChange={(e) => setPresetId(e.target.value)} className={`${FIELD} w-full py-1.5`}>
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id === CUSTOM_ID ? p.label : `${p.label} · ${sizeLabel(p)}`}
                  </option>
                ))}
              </select>
            </label>
            {presetId === CUSTOM_ID && (
              <div className="flex items-end gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                <label>
                  <span className="mb-1 block">Width (mm)</span>
                  <input
                    type="number"
                    min={15}
                    max={150}
                    step={0.5}
                    value={custom.width}
                    onChange={(e) => setCustom((c) => ({ ...c, width: Number(e.target.value) }))}
                    className={`${FIELD} w-20 py-1.5`}
                  />
                </label>
                <label>
                  <span className="mb-1 block">Height (mm)</span>
                  <input
                    type="number"
                    min={15}
                    max={150}
                    step={0.5}
                    value={custom.height}
                    onChange={(e) => setCustom((c) => ({ ...c, height: Number(e.target.value) }))}
                    className={`${FIELD} w-20 py-1.5`}
                  />
                </label>
              </div>
            )}
          </div>

          <PhotoCropper url={photo.url} image={picture} photo={size} crop={crop} onChange={(c) => setPlaced(limitZoom(c, picture))} />

          <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-sm text-zinc-600 dark:text-zinc-400">
            <div className="flex items-center gap-0.5">
              <IconButton label="Rotate left" onClick={() => setTurns((t) => (t + 3) % 4)}>
                <RotateIcon className="size-4 -scale-x-100" />
              </IconButton>
              <IconButton label="Rotate right" onClick={() => setTurns((t) => (t + 1) % 4)}>
                <RotateIcon className="size-4" />
              </IconButton>
            </div>
            <label className="flex items-center gap-2">
              Straighten
              <input
                type="range"
                min={-15}
                max={15}
                step={0.5}
                value={tilt}
                onChange={(e) => setTilt(Number(e.target.value))}
                onDoubleClick={() => setTilt(0)}
                className="w-32 accent-rose-600"
              />
              <span className="w-10 tabular-nums">{tilt}°</span>
            </label>
            <label className="flex items-center gap-2">
              Zoom
              <input
                type="range"
                min={1}
                max={MAX_ZOOM}
                step={0.01}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="w-32 accent-rose-600"
              />
              <span className="w-10 tabular-nums">{zoom.toFixed(1)}×</span>
            </label>
          </div>
          <p className="text-sm text-zinc-500">
            Drag the photo so the top of the head meets the upper line and the chin lands in the band. Scroll to zoom.
          </p>

          <fieldset>
            <legend className="mb-1 text-sm text-zinc-600 dark:text-zinc-400">Save as</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Choice name="photo-output" checked={output === 'print'} onChange={() => setOutput('print')} title="For printing">
                {printPx.width} × {printPx.height} px · {PRINT_DPI} dpi · {sizeLabel(size)}
              </Choice>
              <Choice
                name="photo-output"
                checked={output === 'digital'}
                onChange={() => setOutput('digital')}
                title="For an online application"
              >
                {digitalPx.width} × {digitalPx.height} px
                {preset.digital?.maxKb ? ` · under ${preset.digital.maxKb} KB` : ''}
              </Choice>
            </div>
          </fieldset>

          {upscaled && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Only {Math.round(crop.width)} px of the photo are in the frame, so it will be enlarged to {target.width} px.
              Zoom out or start from a bigger photo for a sharper result.
            </p>
          )}

          {error && <ErrorMessage>{error}</ErrorMessage>}
          {result.value && (
            <ResultCard file={result.value.file} from="photo" onDismiss={result.clear}>
              {result.value.note}
            </ResultCard>
          )}

          <div className="flex flex-wrap gap-2">
            <div className="min-w-56 flex-1">
              <Button onClick={savePhoto} disabled={busy !== null}>
                {busy === 'photo' ? 'Cropping…' : 'Crop photo'}
              </Button>
            </div>
            <div className="flex flex-1 gap-2">
              <select
                value={paper}
                onChange={(e) => setPaper(e.target.value as Paper)}
                aria-label="Paper for the print sheet"
                className={`${FIELD} py-2`}
              >
                {(Object.keys(PAPERS) as Paper[]).map((p) => (
                  <option key={p} value={p}>
                    {PAPERS[p].label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={saveSheet}
                disabled={busy !== null || layout.copies === 0}
                className="flex-1 rounded-lg border border-zinc-300 bg-white px-4 py-2.5 font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600 disabled:cursor-not-allowed disabled:text-zinc-400 disabled:hover:bg-white dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:disabled:text-zinc-600 dark:disabled:hover:bg-zinc-900"
              >
                {busy === 'sheet'
                  ? 'Making the sheet…'
                  : layout.copies === 0
                    ? 'Too big for this paper'
                    : `Print sheet with ${layout.copies} ${layout.copies === 1 ? 'photo' : 'photos'}`}
              </button>
            </div>
          </div>

          <p className="text-xs text-zinc-500">
            Sizes and head guides follow each country’s published requirements, but check the official rules for your
            application: background, expression and lighting matter too.
          </p>
        </>
      )}
    </div>
  )
}

function between(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo
}

function Choice({
  name,
  checked,
  onChange,
  title,
  children,
}: {
  name: string
  checked: boolean
  onChange: () => void
  title: string
  children: ReactNode
}) {
  return (
    <label
      className={`cursor-pointer rounded-lg border px-3 py-2.5 has-focus-visible:outline-2 has-focus-visible:outline-rose-600 ${
        checked
          ? 'border-rose-500 bg-rose-50 dark:bg-rose-950/30'
          : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'
      }`}
    >
      <input type="radio" name={name} checked={checked} onChange={onChange} className="sr-only" />
      <span className="block font-medium text-zinc-900 dark:text-zinc-100">{title}</span>
      <span className="block text-sm text-zinc-500">{children}</span>
    </label>
  )
}
