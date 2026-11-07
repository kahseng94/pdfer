import { useId, useRef, useState, type DragEvent } from 'react'
import { FILE_KINDS, pickFiles, type FileKind } from '../lib/files'
import { FileUploadIcon, UploadIcon } from './icons'

type Props = {
  kind?: FileKind
  multiple?: boolean
  compact?: boolean
  title: string
  onFiles: (files: File[]) => void
  /** Given the files of other kinds, so the tool can say why; the zone then says nothing itself. */
  onSkipped?: (files: File[]) => void
}

export function Dropzone({ kind = 'pdf', multiple = false, compact = false, title, onFiles, onSkipped }: Props) {
  const { accept: acceptTypes, one, many, formatHint } = FILE_KINDS[kind]
  const input = useRef<HTMLInputElement>(null)
  const hintId = useId()
  const [dragging, setDragging] = useState(false)
  const [skipped, setSkipped] = useState(0)

  function accept(list: FileList | null) {
    const all = [...(list ?? [])]
    const { wanted, skipped } = pickFiles(all, kind)
    setSkipped(onSkipped ? 0 : skipped)
    if (wanted.length) onFiles(multiple ? wanted : wanted.slice(0, 1))
    if (onSkipped && skipped) onSkipped(all.filter((f) => !FILE_KINDS[kind].is(f)))
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragging(false)
    accept(e.dataTransfer.files)
  }

  return (
    <div>
      {/* data-dropzone tells the window-wide drop handler to leave drops here alone. */}
      <button
        type="button"
        data-dropzone=""
        aria-label={title}
        aria-describedby={compact ? undefined : `${hintId} ${hintId}-formats`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`file-dropzone ${compact ? 'file-dropzone-compact' : ''} ${dragging ? 'is-dragging' : ''}`}
      >
        {compact ? <UploadIcon className="dropzone-small-icon" /> : <FileUploadIcon className="dropzone-document" />}
        <span className="dropzone-title">{title}</span>
        {!compact && <>
          <span id={hintId} className="dropzone-hint">Drag and drop {multiple ? many : one} here</span>
          <span className="dropzone-browse" aria-hidden="true">Browse files</span>
          <span id={`${hintId}-formats`} className="dropzone-formats">{formatHint}</span>
        </>}
      </button>
      {skipped > 0 && (
        <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
          Skipped {skipped} {skipped === 1 ? `file that isn’t ${one}` : `files that aren’t ${one}`}.
        </p>
      )}
      <input
        ref={input}
        type="file"
        accept={acceptTypes}
        multiple={multiple}
        hidden
        onChange={(e) => {
          accept(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}
