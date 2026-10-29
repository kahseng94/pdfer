import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type MouseEvent, type ReactNode, type SVGProps } from 'react'
import { editPdf } from '../lib/api'
import {
  DEFAULT_STYLE,
  FONT_SIZES,
  imagePlacement,
  STROKE_WIDTHS,
  toPayload,
  type Element,
  type ImageElement,
  type Style,
  type Tool,
} from '../lib/edits'
import { pickFiles } from '../lib/files'
import { FONT_FAMILIES, loadFonts, unsupportedChars } from '../lib/fonts'
import { useReceive } from '../lib/handoff'
import { imageSize, named } from '../lib/images'
import { closePdf, formatSize, type PDFDocumentProxy } from '../lib/pdf'
import { usePdfLoader } from '../lib/usePdfLoader'
import { useEditHistory } from '../lib/useEditHistory'
import { useResult } from '../lib/result'
import { useWindowDrop } from '../lib/windowDrop'
import { Dropzone } from './Dropzone'
import { EditPage, type Editor, type PageSize } from './EditPage'
import {
  CircleIcon,
  CursorIcon,
  HighlighterIcon,
  ImageIcon,
  LineIcon,
  PencilIcon,
  RedoIcon,
  SquareIcon,
  TrashIcon,
  TypeIcon,
  UndoIcon,
} from './icons'
import { ResultCard } from './ResultCard'
import { Button, DropOverlay, ErrorMessage, FIELD, IconButton } from './ui'

type Icon = ComponentType<SVGProps<SVGSVGElement>>

const TOOLS: { id: Tool; label: string; icon: Icon; hint: string }[] = [
  { id: 'select', label: 'Select', icon: CursorIcon, hint: 'Click something you added to move it. Double-click text to change it.' },
  { id: 'text', label: 'Text', icon: TypeIcon, hint: 'Click where the text should start.' },
  { id: 'highlight', label: 'Highlight', icon: HighlighterIcon, hint: 'Drag across what you want to mark.' },
  { id: 'rect', label: 'Rectangle', icon: SquareIcon, hint: 'Drag out a box.' },
  { id: 'ellipse', label: 'Ellipse', icon: CircleIcon, hint: 'Drag out an oval.' },
  { id: 'line', label: 'Line', icon: LineIcon, hint: 'Drag from one end to the other.' },
  { id: 'draw', label: 'Draw', icon: PencilIcon, hint: 'Draw with the mouse, a pen or a finger.' },
]

export function EditTool({ active = true }: { active?: boolean }) {
  const [file, setFile] = useState<File | null>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [pages, setPages] = useState<PageSize[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The file whose preview is loading; an older load that finishes late is dropped.
  const opening = useRef(0)
  const loader = usePdfLoader()

  const history = useEditHistory()
  const { elements, commit, undo, redo } = history
  const result = useResult<File>([file, elements])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [style, setStyle] = useState<Style>(DEFAULT_STYLE)
  const [zoomLevel, setZoomLevel] = useState(1)
  // The embedded fonts, for text beyond the standard ones; previews re-measure once they are in.
  const [fontState, setFontState] = useState<'loading' | 'ready' | 'failed'>('loading')

  const container = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const pageRefs = useRef(new Map<number, HTMLElement>())
  const imageInput = useRef<HTMLInputElement>(null)
  // Object URLs of the pictures added, released when the file is closed.
  const urls = useRef<string[]>([])

  const editor = useMemo<Editor>(
    () => ({
      select: setSelectedId,
      edit: setEditingId,
      stopEditing: (id) => setEditingId((cur) => (cur === id ? null : cur)),
      begin: history.begin,
      change: history.change,
      end: history.end,
      commit: history.commit,
      toolDone: () => setTool('select'),
    }),
    [history.begin, history.change, history.end, history.commit],
  )

  function close() {
    loader.cancel()
    closePdf(doc)
    opening.current += 1
    for (const url of urls.current) URL.revokeObjectURL(url)
    urls.current = []
    setDoc(null)
    setPages([])
    history.reset()
    setSelectedId(null)
    setEditingId(null)
    setTool('select')
    setError(null)
  }

  async function open(next: File) {
    close()
    setFile(next)
    const version = opening.current
    try {
      const loaded = await loader.load(next)
      const sizes = await Promise.all(
        Array.from({ length: loaded.numPages }, (_, i) =>
          loaded.getPage(i + 1).then((page) => {
            const { width, height } = page.getViewport({ scale: 1 })
            return { width, height }
          }),
        ),
      )
      if (opening.current !== version) {
        closePdf(loaded)
        return
      }
      setDoc(loaded)
      setPages(sizes)
    } catch (err) {
      if (opening.current === version) setError((err as Error).message)
    }
  }

  function chooseAnother() {
    close()
    setFile(null)
  }

  useEffect(() => {
    if (!doc || fontState === 'ready') return
    let cancelled = false
    loadFonts().then((loaded) => {
      if (!cancelled) setFontState(loaded ? 'ready' : 'failed')
    })
    return () => {
      cancelled = true
    }
  }, [doc, fontState])

  // Pages fill the column; zooming scales from there.
  useEffect(() => {
    const el = container.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [doc])
  const widest = Math.max(1, ...pages.map((p) => p.width))
  const zoom = (containerWidth > 0 ? containerWidth / widest : 1) * zoomLevel

  const selected = useMemo(() => elements.find((el) => el.id === selectedId) ?? null, [elements, selectedId])
  const byPage = useMemo(() => {
    const map = new Map<number, Element[]>()
    for (const el of elements) map.set(el.page, [...(map.get(el.page) ?? []), el])
    return map
  }, [elements])

  const removeSelected = useCallback(() => {
    if (!selectedId) return
    commit((els) => els.filter((el) => el.id !== selectedId))
    setSelectedId(null)
  }, [commit, selectedId])

  useEffect(() => {
    if (!active || !doc) return
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]')) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redo()
      } else if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (selectedId) {
          e.preventDefault()
          removeSelected()
        }
      } else if (e.key === 'Escape') {
        if (tool !== 'select') setTool('select')
        else setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, doc, selectedId, tool, undo, redo, removeSelected])

  /** The page nearest the middle of the window, where new pictures go. */
  function currentPage(): number {
    const middle = window.innerHeight / 2
    let best = 1
    let bestDistance = Infinity
    for (const [page, el] of pageRefs.current) {
      const r = el.getBoundingClientRect()
      const d = r.top > middle ? r.top - middle : r.bottom < middle ? middle - r.bottom : 0
      if (d < bestDistance) {
        bestDistance = d
        best = page
      }
    }
    return best
  }

  async function addImages(files: File[]) {
    const page = currentPage()
    const size = pages[page - 1]
    if (!size) return
    const added: ImageElement[] = []
    for (const raw of files) {
      const picture = named(raw)
      const url = URL.createObjectURL(picture)
      try {
        const box = imagePlacement(await imageSize(url), size)
        // Several at once are staggered so each can be seen.
        const offset = added.length * 16
        added.push({ id: crypto.randomUUID(), page, type: 'image', ...box, x: box.x + offset, y: box.y + offset, file: picture, url })
        urls.current.push(url)
      } catch {
        URL.revokeObjectURL(url)
        setError(`Can’t read ${picture.name}.`)
      }
    }
    if (added.length) {
      commit((els) => [...els, ...added])
      setSelectedId(added[added.length - 1].id)
      setTool('select')
    }
  }

  const addImagesLatest = useRef(addImages)
  useEffect(() => {
    addImagesLatest.current = addImages
  })

  // Paste adds pictures while this tab is showing, unless the paste is meant for a text field.
  useEffect(() => {
    if (!active || !doc) return
    function onPaste(e: ClipboardEvent) {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, [contenteditable]')) return
      const { wanted } = pickFiles(e.clipboardData?.files ?? [], 'image')
      if (!wanted.length) return
      e.preventDefault()
      addImagesLatest.current(wanted)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [active, doc])

  /** Change how the selected element looks, and how new ones will. */
  function restyle(patch: Partial<Style>) {
    setStyle((s) => ({ ...s, ...patch }))
    if (selected) commit((els) => els.map((el) => (el.id === selected.id ? restyled(el, patch) : el)))
  }

  async function save() {
    if (!file) return
    setBusy(true)
    setError(null)
    const finish = result.begin()
    try {
      const { edits, images } = toPayload(elements)
      finish(await editPdf(file, edits, images))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function take(files: File[]) {
    const [pdf] = pickFiles(files, 'pdf').wanted
    if (pdf) {
      open(pdf)
      return
    }
    const { wanted } = pickFiles(files, 'image')
    if (wanted.length && doc) addImages(wanted)
  }

  const dragging = useWindowDrop(take, active)
  useReceive('edit', take)
  const overlay = dragging && <DropOverlay label={doc ? 'Drop a PDF to edit, or pictures to add' : 'Drop a PDF to edit'} />

  if (!file) {
    return (
      <>
        {overlay}
        <Dropzone title="Choose a PDF to edit" onFiles={([f]) => open(f)} />
      </>
    )
  }

  const total = doc?.numPages ?? 0
  const count = elements.length
  const unwritable = [...new Set(elements.flatMap((el) => (el.type === 'text' ? unsupportedChars(el.text) : [])))]
  const subject = selected?.type ?? tool

  return (
    <div className="space-y-5">
      {overlay}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="min-w-0">
          <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">{file.name}</p>
          <p className="text-sm text-zinc-500">
            {doc ? `${total} ${total === 1 ? 'page' : 'pages'} · ` : ''}
            {formatSize(file.size)}
          </p>
        </div>
        <button
          type="button"
          onClick={chooseAnother}
          className="shrink-0 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          Choose another file
        </button>
      </div>

      {doc && (
        <>
          <div className="sticky top-0 z-20 -mx-4 space-y-2 bg-zinc-50/95 px-4 py-2 backdrop-blur dark:bg-zinc-950/95">
            <div className="flex flex-wrap items-center gap-2">
              <div role="toolbar" aria-label="Tools" className="inline-flex flex-wrap rounded-lg bg-zinc-200/70 p-1 dark:bg-zinc-800/70">
                {TOOLS.map((t) => (
                  <ToolButton key={t.id} label={t.label} icon={t.icon} pressed={tool === t.id} onClick={() => setTool(t.id)} />
                ))}
                <ToolButton label="Image" icon={ImageIcon} pressed={false} onClick={() => imageInput.current?.click()} />
              </div>
              <div className="ml-auto flex items-center gap-0.5">
                <IconButton label="Undo" disabled={!history.canUndo} onClick={undo}>
                  <UndoIcon className="size-4" />
                </IconButton>
                <IconButton label="Redo" disabled={!history.canRedo} onClick={redo}>
                  <RedoIcon className="size-4" />
                </IconButton>
                <span className="mx-1 h-5 w-px bg-zinc-300 dark:bg-zinc-700" />
                <IconButton label="Zoom out" disabled={zoomLevel <= 0.5} onClick={() => setZoomLevel((z) => Math.max(0.5, z / 1.25))}>
                  <span className="text-base leading-none">−</span>
                </IconButton>
                <button
                  type="button"
                  onClick={() => setZoomLevel(1)}
                  title="Fit to width"
                  className="w-11 rounded py-1 text-center text-xs tabular-nums text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  {Math.round(zoom * 100)}%
                </button>
                <IconButton label="Zoom in" disabled={zoomLevel >= 4} onClick={() => setZoomLevel((z) => Math.min(4, z * 1.25))}>
                  <span className="text-base leading-none">+</span>
                </IconButton>
              </div>
            </div>

            <div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-2 text-sm text-zinc-600 dark:text-zinc-400">
              {(subject === 'text' || (selected?.type === 'text')) && (
                <TextControls
                  value={selected?.type === 'text' ? selected : style}
                  onChange={restyle}
                />
              )}
              {subject === 'highlight' && (
                <ColorInput label="Colour" value={selected?.type === 'highlight' ? selected.color : style.highlight} onChange={(highlight) => restyle({ highlight })} />
              )}
              {(subject === 'rect' || subject === 'ellipse' || subject === 'line' || subject === 'draw') && (
                <StrokeControls
                  value={selected && selected.type !== 'text' && selected.type !== 'image' && selected.type !== 'highlight' ? selected : style}
                  withFill={subject === 'rect' || subject === 'ellipse'}
                  onChange={restyle}
                />
              )}
              {subject === 'image' && <span>Drag a corner to resize. Hold Shift to stretch.</span>}
              {!selected && <span>{TOOLS.find((t) => t.id === tool)?.hint}</span>}
              {selected && (
                <button
                  type="button"
                  onClick={removeSelected}
                  className="ml-auto inline-flex items-center gap-1 rounded px-2 py-1 text-zinc-600 hover:bg-zinc-200/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                >
                  <TrashIcon className="size-4" />
                  Delete
                </button>
              )}
            </div>
          </div>

          <div className="flex items-baseline justify-between gap-4">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {count === 0 ? 'Nothing added yet' : `${count} ${count === 1 ? 'edit' : 'edits'}`}
            </p>
            {count > 0 && (
              <button
                type="button"
                onClick={() => {
                  commit(() => [])
                  setSelectedId(null)
                }}
                className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              >
                Clear all
              </button>
            )}
          </div>

          <div ref={container} className="overflow-x-auto">
            <ol className="space-y-6 py-1">
              {pages.map((size, i) => {
                const page = i + 1
                return (
                  <li
                    key={page}
                    ref={(el) => {
                      if (el) pageRefs.current.set(page, el)
                      else pageRefs.current.delete(page)
                    }}
                    className="mx-auto w-fit"
                  >
                    <EditPage
                      doc={doc}
                      pageNumber={page}
                      size={size}
                      zoom={zoom}
                      elements={byPage.get(page) ?? []}
                      selectedId={selectedId}
                      editingId={editingId}
                      tool={tool}
                      style={style}
                      editor={editor}
                    />
                    <p className="mt-1 text-center text-xs tabular-nums text-zinc-500">{page}</p>
                  </li>
                )
              })}
            </ol>
          </div>
        </>
      )}

      {unwritable.length > 0 &&
        (fontState === 'loading' ? (
          <p role="status" className="text-sm text-zinc-500">
            Loading fonts…
          </p>
        ) : (
          <ErrorMessage>
            {fontState === 'failed' ? 'The fonts couldn’t be loaded, so ' : 'None of pdfer’s fonts can write '}
            {unwritable.map((c) => `“${c}”`).join(', ')}
            {fontState === 'failed' ? ' can’t be checked.' : '.'}
          </ErrorMessage>
        ))}
      {error && <ErrorMessage>{error}</ErrorMessage>}

      {doc && (
        <div className="sticky bottom-4 space-y-2">
          {result.value && <ResultCard file={result.value} from="edit" onDismiss={result.clear} />}
          <Button onClick={save} disabled={busy || count === 0 || unwritable.length > 0}>
            {busy ? 'Saving…' : count === 0 ? 'Add something first' : `Save with ${count} ${count === 1 ? 'edit' : 'edits'}`}
          </Button>
        </div>
      )}

      <input
        ref={imageInput}
        type="file"
        accept="image/jpeg,image/png,.jpg,.jpeg,.png"
        multiple
        hidden
        onChange={(e) => {
          addImages(pickFiles(e.target.files ?? [], 'image').wanted)
          e.target.value = ''
        }}
      />
    </div>
  )
}

/** The element with the parts of the style that apply to it. */
function restyled(el: Element, patch: Partial<Style>): Element {
  const pick = <K extends keyof Style>(...keys: K[]) =>
    Object.fromEntries(keys.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]]))
  switch (el.type) {
    case 'text':
      return { ...el, ...pick('color', 'size', 'family', 'bold', 'italic') }
    case 'highlight':
      return patch.highlight === undefined ? el : { ...el, color: patch.highlight }
    case 'rect':
    case 'ellipse':
      return { ...el, ...pick('stroke', 'strokeWidth', 'fill') }
    case 'line':
    case 'draw':
      return { ...el, ...pick('stroke', 'strokeWidth') }
    default:
      return el
  }
}

/** On a toolbar button, so a text box being typed in keeps the focus while its look changes. */
function keepFocus(e: MouseEvent<HTMLButtonElement>) {
  e.preventDefault()
}

function ToolButton({ label, icon: Icon, pressed, onClick }: { label: string; icon: Icon; pressed: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={label}
      onMouseDown={keepFocus}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors ${
        pressed
          ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100'
          : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
      }`}
    >
      <Icon className="size-4" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}

function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="inline-flex items-center gap-1.5">
      {label}
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-9 cursor-pointer rounded border border-zinc-300 bg-white p-0.5 dark:border-zinc-700 dark:bg-zinc-900"
      />
    </label>
  )
}

function TextControls({
  value,
  onChange,
}: {
  value: Pick<Style, 'color' | 'size' | 'family' | 'bold' | 'italic'>
  onChange: (patch: Partial<Style>) => void
}) {
  return (
    <>
      <label className="inline-flex items-center gap-1.5">
        Font
        <select value={value.family} onChange={(e) => onChange({ family: e.target.value as Style['family'] })} className={FIELD}>
          {FONT_FAMILIES.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <label className="inline-flex items-center gap-1.5">
        Size
        <select value={value.size} onChange={(e) => onChange({ size: Number(e.target.value) })} className={FIELD}>
          {(FONT_SIZES.includes(value.size) ? FONT_SIZES : [...FONT_SIZES, value.size].sort((a, b) => a - b)).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <span className="inline-flex gap-0.5">
        <Toggle label="Bold" pressed={value.bold} onClick={() => onChange({ bold: !value.bold })}>
          <span className="font-bold">B</span>
        </Toggle>
        <Toggle label="Italic" pressed={value.italic} onClick={() => onChange({ italic: !value.italic })}>
          <span className="font-serif italic">I</span>
        </Toggle>
      </span>
      <ColorInput label="Colour" value={value.color} onChange={(color) => onChange({ color })} />
    </>
  )
}

function StrokeControls({
  value,
  withFill,
  onChange,
}: {
  value: Pick<Style, 'stroke' | 'strokeWidth'> & { fill?: string | null }
  withFill: boolean
  onChange: (patch: Partial<Style>) => void
}) {
  const fill = value.fill ?? null
  return (
    <>
      <ColorInput label={withFill ? 'Outline' : 'Colour'} value={value.stroke} onChange={(stroke) => onChange({ stroke })} />
      <label className="inline-flex items-center gap-1.5">
        Width
        <select value={value.strokeWidth} onChange={(e) => onChange({ strokeWidth: Number(e.target.value) })} className={FIELD}>
          {(STROKE_WIDTHS.includes(value.strokeWidth) ? STROKE_WIDTHS : [...STROKE_WIDTHS, value.strokeWidth].sort((a, b) => a - b)).map((w) => (
            <option key={w} value={w}>
              {w} pt
            </option>
          ))}
        </select>
      </label>
      {withFill && (
        <span className="inline-flex items-center gap-1.5">
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={fill !== null} onChange={(e) => onChange({ fill: e.target.checked ? '#fecdd3' : null })} className="accent-rose-600" />
            Fill
          </label>
          {fill !== null && <ColorInput label="" value={fill} onChange={(f) => onChange({ fill: f })} />}
        </span>
      )}
    </>
  )
}

function Toggle({ label, pressed, onClick, children }: { label: string; pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onMouseDown={keepFocus}
      onClick={onClick}
      className={`inline-flex size-7 items-center justify-center rounded border text-sm ${
        pressed
          ? 'border-rose-500 bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300'
          : 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800'
      }`}
    >
      {children}
    </button>
  )
}
