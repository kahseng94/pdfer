import { useEffect, useState, type ReactNode } from 'react'
import { readPhotoInfo } from '../lib/api'
import { formatSize } from '../lib/pdf'
import { formatCamera, formatLocation, summarizeMetadata, type PhotoInfo, type PhotoMetadata } from '../lib/photoEdits'
import { usePhotoEdit } from '../lib/usePhotoEdit'
import { onlyItem, usePhotoItems } from '../lib/usePhotoItems'
import { PhotoEmpty, PhotoHeader } from './PhotoItems'
import { ResultCard } from './ResultCard'
import { Button, DropOverlay, ErrorMessage } from './ui'

type Removal = Exclude<PhotoMetadata, 'keep'>

/** What a photo records, and copies of it without the location or without any of it. */
export function PhotoInfoTool({ active = true }: { active?: boolean }) {
  const photos = usePhotoItems('photo-info', active, { single: true })
  const item = onlyItem(photos.items)
  const id = item?.id
  const file = item?.file
  // What the backend read, for the photo it was read from.
  const [read, setRead] = useState<{ id: string; value?: PhotoInfo; error?: string } | null>(null)
  const [removal, setRemoval] = useState<Removal>('no-location')
  const edit = usePhotoEdit([file])
  const made = edit.result.value?.file ?? null
  const [after, setAfter] = useState<{ file: File; value: PhotoInfo } | null>(null)

  useEffect(() => {
    if (!file || !id) return
    const controller = new AbortController()
    readPhotoInfo(file, controller.signal).then(
      (value) => setRead({ id, value }),
      (err: Error) => {
        if (!controller.signal.aborted) setRead({ id, error: err.message })
      },
    )
    return () => controller.abort()
  }, [file, id])

  // Check the copy, so the card can say what it carries now.
  useEffect(() => {
    if (!made) return
    const controller = new AbortController()
    readPhotoInfo(made, controller.signal).then(
      (value) => setAfter({ file: made, value }),
      () => {},
    )
    return () => controller.abort()
  }, [made])

  if (!item) {
    return <PhotoEmpty title="Choose a photo to look into" multiple={false} onFiles={photos.add} onSkipped={photos.noteSkipped} dragging={photos.dragging} skipped={photos.skipped} />
  }

  const current = read?.id === item.id ? read : null
  const info = current?.value ?? null
  const hasLocation = !!info?.gps
  const hasMetadata = !!info && (info.metadata.exif_tags > 0 || info.metadata.xmp || info.metadata.iptc)

  function remove(mode: Removal) {
    if (!item) return
    setRemoval(mode)
    void edit.run([item], { metadata: mode, suffix: mode === 'none' ? 'clean' : 'no-location' })
  }

  return (
    <div className="space-y-5">
      {photos.dragging && <DropOverlay label="Drop a photo to open" />}
      <PhotoHeader item={item} onReset={photos.clear} />
      {!current && <p role="status" className="text-sm text-zinc-500">Reading the photo…</p>}
      {current?.error && <ErrorMessage>{current.error}</ErrorMessage>}

      {info && (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Section title="Picture">
              <Row label="Format" value={info.format} />
              <Row label="Size" value={`${info.width} × ${info.height} px`} />
              <Row label="Resolution" value={info.dpi ? (info.dpi[0] === info.dpi[1] ? `${info.dpi[0]} dpi` : `${info.dpi[0]} × ${info.dpi[1]} dpi`) : null} />
              <Row label="Colour" value={info.mode} />
              <Row label="Frames" value={info.frames > 1 ? `${info.frames} (animated; tools keep the first)` : null} />
              <Row label="File" value={formatSize(info.bytes)} />
              <Row label="Stored" value={info.orientation && info.orientation !== 1 ? `Turned; shown upright by its orientation tag (${info.orientation})` : null} />
            </Section>
            <Section title="Camera" empty="No camera data.">
              <Row label="Camera" value={formatCamera(info.camera)} />
              <Row label="Lens" value={info.camera.lens} />
              <Row label="Taken" value={info.taken} />
              <Row label="Shutter" value={info.exposure.time} />
              <Row label="Aperture" value={info.exposure.aperture} />
              <Row label="ISO" value={info.exposure.iso === null ? null : String(info.exposure.iso)} />
              <Row
                label="Focal length"
                value={info.exposure.focal_length ? `${info.exposure.focal_length}${info.exposure.focal_length_35mm ? ` (${info.exposure.focal_length_35mm} equivalent)` : ''}` : null}
              />
              <Row label="Software" value={info.camera.software} />
            </Section>
            <Section title="Location" empty="No location data.">
              <Row label="Coordinates" value={formatLocation(info.gps)} />
              <Row label="Altitude" value={info.gps && info.gps.altitude !== null ? `${info.gps.altitude} m ${info.gps.altitude < 0 ? 'below' : 'above'} sea level` : null} />
            </Section>
            <Section title="Author" empty="No author or description.">
              <Row label="Artist" value={info.author.artist} />
              <Row label="Copyright" value={info.author.copyright} />
              <Row label="Description" value={info.author.description} />
            </Section>
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            <span className="font-medium text-zinc-900 dark:text-zinc-100">Metadata in the file:</span> {summarizeMetadata(info)}
          </p>
          <p className="text-sm text-zinc-500">
            A copy without the location keeps the camera data. A clean copy keeps only the colour profile and which way is up. JPEG, PNG and WebP
            files are rewritten without touching the picture itself; other formats are re-saved as JPEG or PNG.
          </p>

          {edit.error && <ErrorMessage>{edit.error}</ErrorMessage>}
          {edit.result.value && (
            <ResultCard file={edit.result.value.file} from="photo-info" onDismiss={edit.result.clear}>
              {after?.file === edit.result.value.file ? `Now: ${summarizeMetadata(after.value)}` : 'Checking the copy…'}
            </ResultCard>
          )}

          <div className="tool-actions flex flex-wrap gap-2">
            <div className="min-w-56 flex-1">
              <Button onClick={() => remove('no-location')} disabled={edit.busy || !hasLocation}>
                {edit.busy && removal === 'no-location' ? 'Removing…' : hasLocation ? 'Copy without location' : 'No location to remove'}
              </Button>
            </div>
            <button
              type="button"
              onClick={() => remove('none')}
              disabled={edit.busy || !hasMetadata}
              className="min-w-56 flex-1 rounded-lg border border-zinc-300 bg-white px-4 py-2.5 font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600 disabled:cursor-not-allowed disabled:text-zinc-400 disabled:hover:bg-white dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:disabled:text-zinc-600 dark:disabled:hover:bg-zinc-900"
            >
              {edit.busy && removal === 'none' ? 'Removing…' : hasMetadata ? 'Copy without any metadata' : 'No metadata to remove'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function Section({ title, empty, children }: { title: string; empty?: string; children: ReactNode }) {
  const rows = (Array.isArray(children) ? children : [children]).filter((child) => child && (child as { props?: { value?: unknown } }).props?.value)
  return (
    <section aria-label={title} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="mb-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</h2>
      {rows.length ? <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">{rows}</dl> : <p className="text-sm text-zinc-500">{empty}</p>}
    </section>
  )
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="break-words text-zinc-900 dark:text-zinc-100">{value}</dd>
    </>
  )
}
