import { useRef, useState, type DragEvent } from 'react'
import { FILE_KINDS, pickFiles, type FileKind } from '../lib/files'
import { UploadIcon } from './icons'

type Props = {
  kind?: FileKind
  multiple?: boolean
  compact?: boolean
  title: string
  onFiles: (files: File[]) => void
}

export function Dropzone({ kind = 'pdf', multiple = false, compact = false, title, onFiles }: Props) {
  const { accept: acceptTypes, one, many } = FILE_KINDS[kind]
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [skipped, setSkipped] = useState(0)

  function accept(list: FileList | null) {
    const { wanted, skipped } = pickFiles(list ?? [], kind)
    setSkipped(skipped)
    if (wanted.length) onFiles(multiple ? wanted : wanted.slice(0, 1))
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
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed text-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600 ${
          compact ? 'px-4 py-5' : 'px-6 py-14'
        } ${
          dragging
            ? 'border-rose-500 bg-rose-50 dark:bg-rose-950/30'
            : 'border-zinc-300 hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:border-zinc-600 dark:hover:bg-zinc-900'
        }`}
      >
        <UploadIcon className={`text-zinc-400 ${compact ? 'size-5' : 'size-8'}`} />
        <span className="font-medium text-zinc-800 dark:text-zinc-200">{title}</span>
        {!compact && <span className="text-sm text-zinc-500">Drop {multiple ? many : one} here, or click to browse</span>}
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
