import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type MouseEvent, type ReactNode, type SVGProps } from 'react'
import { editPdf } from '../lib/api'
import {
  DEFAULT_STYLE,
  constrainBox,
  copyRegionToPage,
  FONT_SIZES,
  imagePlacement,
  moved,
  regionOnPage,
  REGION_ROTATIONS,
  rotateRegion,
  roundedBox,
  STROKE_WIDTHS,
  toPayload,
  type Element,
  type ImageElement,
  type RegionElement,
  type RegionRotation,
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
import { placeDraggedRegion, regionScrollDelta, type RegionPageSurface } from '../lib/regionDrag'
import { useWindowDrop } from '../lib/windowDrop'
import { checkProjectPages, type ProjectDraft, type ProjectStates } from '../lib/projects'
import { useProject } from '../lib/useProject'
import { ProjectControls } from './ProjectControls'
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
  RegionIcon,
  RotateIcon,
  SquareIcon,
  TrashIcon,
  TypeIcon,
  UndoIcon,
} from './icons'
import { ResultCard } from './ResultCard'
import { Button, DropOverlay, ErrorMessage, FIELD, IconButton } from './ui'

type Icon = ComponentType<SVGProps<SVGSVGElement>>

const TOOLS: { id: Tool; label: string; icon: Icon; hint: string }[] = [
  { id: 'select', label: 'Select', icon: CursorIcon, hint: 'Click an added element or region to move it. Use Move region to select original PDF content.' },
  { id: 'region', label: 'Move region', icon: RegionIcon, hint: 'Original page shown. Drag a rectangle around the content to move; shaded areas are already selected.' },
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
  const draft = useMemo<ProjectDraft<'edit'> | null>(() => file && doc ? { tool: 'edit', file, state: { elements, style, zoom: zoomLevel } } : null, [file, doc, elements, style, zoomLevel])
  const project = useProject('edit', draft, elements.length > 0, (saved) => open(saved.file, saved.state))
  // The embedded fonts, for text beyond the standard ones; previews re-measure once they are in.
  const [fontState, setFontState] = useState<'loading' | 'ready' | 'failed'>('loading')

  const container = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const pageRefs = useRef(new Map<number, HTMLElement>())
  const toolbarRef = useRef<HTMLDivElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  // Object URLs of the pictures added, released when the file is closed.
  const urls = useRef<string[]>([])
  const sourceDoc = useRef<PDFDocumentProxy | null>(null)
  useEffect(() => () => {
    opening.current += 1
    closePdf(sourceDoc.current)
    for (const url of urls.current) URL.revokeObjectURL(url)
    urls.current = []
  }, [])

  const regionViewport = useCallback(() => {
    const toolbar = toolbarRef.current?.getBoundingClientRect()
    const actions = actionsRef.current?.getBoundingClientRect()
    const top = toolbar?.height ? Math.max(0, Math.min(window.innerHeight, toolbar.bottom)) : 0
    const bottom = actions?.height ? Math.min(window.innerHeight, Math.max(top, actions.top)) : window.innerHeight
    return { top, bottom }
  }, [])
  const placeRegion: NonNullable<Editor['placeRegion']> = useCallback((original, client, grab, fallbackPage) => {
    const { top, bottom } = regionViewport()
    const view = container.current?.getBoundingClientRect()
    const surfaces: RegionPageSurface[] = []
    for (const [page, element] of pageRefs.current) {
      const svg = element.querySelector<SVGSVGElement>('[data-editor-page]')
      if (svg && pages[page - 1]) surfaces.push({ page, size: pages[page - 1], rect: svg.getBoundingClientRect() })
    }
    const x = view?.width ? Math.max(view.left, Math.min(client[0], view.right)) : client[0]
    return placeDraggedRegion(original, [x, Math.max(top, Math.min(client[1], bottom))], grab, surfaces, fallbackPage)
  }, [pages, regionViewport])
  const scrollRegionDrag: NonNullable<Editor['scrollRegionDrag']> = useCallback((client, elapsedMs) => {
    const { top, bottom } = regionViewport()
    const dy = regionScrollDelta(client[1], top, bottom, elapsedMs)
    if (!dy) return false
    const before = window.scrollY
    window.scrollBy({ top: dy, behavior: 'instant' })
    return window.scrollY !== before
  }, [regionViewport])

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
      placeRegion,
      scrollRegionDrag,
    }),
    [history.begin, history.change, history.end, history.commit, placeRegion, scrollRegionDrag],
  )

  function close() {
    loader.cancel()
    closePdf(sourceDoc.current)
    sourceDoc.current = null
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

  async function open(next: File, saved?: ProjectStates['edit']): Promise<boolean> {
    close()
    setFile(next)
    const version = opening.current
    let loaded: PDFDocumentProxy | null = null
    try {
      loaded = await loader.load(next)
      if (saved) checkProjectPages(saved, loaded.numPages)
      const sizes = await Promise.all(
        Array.from({ length: loaded.numPages }, (_, i) =>
          loaded!.getPage(i + 1).then((page) => {
            const { width, height } = page.getViewport({ scale: 1 })
            return { width, height }
          }),
        ),
      )
      if (opening.current !== version) {
        closePdf(loaded)
        return false
      }
      setDoc(loaded)
      sourceDoc.current = loaded
      setPages(sizes)
      if (saved) {
        history.reset(saved.elements)
        setStyle(saved.style); setZoomLevel(saved.zoom)
        urls.current = [...new Set(saved.elements.flatMap((element) => element.type === 'image' ? [element.url] : []))]
      }
      return true
    } catch (err) {
      closePdf(loaded)
      if (opening.current === version) setError((err as Error).message)
      return false
    }
  }

  function chooseAnother() {
    if (!project.canReplace()) return
    project.reset()
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

  const selected = useMemo(() => elements.find((el) => el.id === selectedId && !(el.type === 'region' && el.deleted)) ?? null, [elements, selectedId])
  const deletedRegions = useMemo(() => elements.filter((el): el is RegionElement => el.type === 'region' && el.deleted === true), [elements])
  const regionCount = useMemo(() => elements.filter((el) => el.type === 'region').length, [elements])
  const byPage = useMemo(() => {
    const map = new Map<number, Element[]>()
    for (const el of elements) {
      if (el.type !== 'region' || !el.deleted) map.set(el.page, [...(map.get(el.page) ?? []), el])
    }
    return map
  }, [elements])
  const sourcesByPage = useMemo(() => {
    const map = new Map<number, RegionElement[]>()
    for (const el of elements) {
      if (el.type === 'region' && !el.copy) map.set(el.sourcePage, [...(map.get(el.sourcePage) ?? []), el])
    }
    return map
  }, [elements])

  function showRegionPage(page: number) {
    const version = opening.current
    // Measure after the selected region's controls have wrapped/reflowed.
    requestAnimationFrame(() => {
      if (opening.current !== version) return
      const target = pageRefs.current.get(page)
      if (!target) return
      target.style.scrollMarginTop = `${(toolbarRef.current?.offsetHeight ?? 176) + 16}px`
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  function moveSelectedRegion(page: number) {
    if (selected?.type !== 'region' || selected.page === page || !pages[page - 1]) return
    const next = regionOnPage(selected, page, pages[page - 1])
    commit((els) => els.map((el) => el.id === selected.id ? next : el))
    setTool('select')
    showRegionPage(page)
  }

  function copySelectedRegion(page: number) {
    if (selected?.type !== 'region' || !pages[page - 1] || regionCount >= 200) return
    const copy = copyRegionToPage(selected, crypto.randomUUID(), page, pages[page - 1])
    commit((els) => [...els, copy])
    setSelectedId(copy.id)
    setTool('select')
    if (page !== selected.page) showRegionPage(page)
  }

  function rotateSelectedRegion(rotation: RegionRotation) {
    if (selected?.type !== 'region' || rotation === (selected.rotation ?? 0)) return
    const next = rotateRegion(selected, rotation, pages[selected.page - 1])
    commit((els) => els.map((el) => el.id === selected.id ? next : el))
    setTool('select')
  }

  const restoreSelected = useCallback(() => {
    if (!selectedId) return
    commit((els) => els.filter((el) => el.id !== selectedId))
    setSelectedId(null)
  }, [commit, selectedId])

  const deleteSelected = useCallback(() => {
    if (!selectedId) return
    commit((els) => els.flatMap((el) => el.id !== selectedId ? [el] : el.type === 'region' && !el.copy ? [{ ...el, deleted: true }] : []))
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
          deleteSelected()
        }
      } else if (!mod && selected?.type === 'region' && tool === 'select' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        commit((els) => els.map((el) => el.id === selected.id ? { ...el, ...constrainBox(moved(selected, dx, dy), pages[selected.page - 1]) } : el))
      } else if (e.key === 'Escape') {
        if (tool !== 'select') setTool('select')
        else setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, doc, selectedId, selected, pages, tool, undo, redo, deleteSelected, commit])

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
    const version = opening.current
    const page = currentPage()
    const size = pages[page - 1]
    if (!size) return
    const added: ImageElement[] = []
    for (const raw of files) {
      const picture = named(raw)
      const url = URL.createObjectURL(picture)
      try {
        const box = imagePlacement(await imageSize(url), size)
        if (opening.current !== version) { URL.revokeObjectURL(url); return }
        // Several at once are staggered so each can be seen.
        const offset = added.length * 16
        added.push({ id: crypto.randomUUID(), page, type: 'image', ...box, x: box.x + offset, y: box.y + offset, file: picture, url })
        urls.current.push(url)
      } catch {
        URL.revokeObjectURL(url)
        if (opening.current !== version) return
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
      if (project.canReplace()) { project.reset(); void open(pdf) }
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
        <Dropzone title="Choose a PDF to edit" onFiles={take} />
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
          <ProjectControls project={project} />
          <div ref={toolbarRef} className="sticky top-0 z-20 -mx-4 space-y-2 bg-zinc-50/95 px-4 py-2 backdrop-blur dark:bg-zinc-950/95">
            <div className="flex flex-wrap items-center gap-2">
              <div role="toolbar" aria-label="Tools" className="inline-flex flex-wrap rounded-lg bg-zinc-200/70 p-1 dark:bg-zinc-800/70">
                {TOOLS.map((t) => (
                  <ToolButton key={t.id} label={t.label} icon={t.icon} pressed={tool === t.id} onClick={() => { setTool(t.id); if (t.id === 'region') setSelectedId(null) }} />
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
                  value={selected && selected.type !== 'text' && selected.type !== 'image' && selected.type !== 'region' && selected.type !== 'highlight' ? selected : style}
                  withFill={subject === 'rect' || subject === 'ellipse'}
                  onChange={restyle}
                />
              )}
              {subject === 'image' && <span>Drag a corner to resize. Hold Shift to stretch.</span>}
              {selected?.type === 'region' && <RegionControls value={selected} pages={pages} onPageChange={moveSelectedRegion} onCopy={copySelectedRegion} onRotate={rotateSelectedRegion} copyDisabled={regionCount >= 200} onChange={(patch) => {
                const box = constrainBox({ ...selected, ...patch }, pages[selected.page - 1])
                commit((els) => els.map((el) => el.id === selected.id ? { ...el, ...box } : el))
              }} />}
              {!selected && <span>{TOOLS.find((t) => t.id === tool)?.hint}</span>}
              {selected && <div className="ml-auto flex items-center gap-2">
                {selected.type === 'region' && !selected.copy && <button type="button" onClick={restoreSelected}
                  className="rounded px-2 py-1 text-zinc-600 hover:bg-zinc-200/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
                  Restore original
                </button>}
                <button
                  type="button"
                  onClick={deleteSelected}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-rose-600 hover:bg-rose-100 dark:text-rose-400 dark:hover:bg-rose-950"
                >
                  <TrashIcon className="size-4" />
                  {selected.type === 'region' ? selected.copy ? 'Delete copy' : 'Delete region' : 'Delete'}
                </button>
              </div>}
            </div>
          </div>

          {(tool === 'region' || elements.some((el) => el.type === 'region')) && <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Drag a region directly onto another page; hold near the top or bottom edge to scroll. Move to page also changes pages. Copy region makes an independent copy. Regions shrink to fit the page when needed.
            {' '}Arrow keys move the selection; Shift moves it faster.
            {' '}Delete region leaves its source covered; Delete copy removes only that copy. Restore original cancels a move.
            {' '}Vacated areas become white. Original content remains in the file; use Redact to remove sensitive information.
            {' '}Links, annotations and form fields cannot be moved with a region.
          </p>}

          <div className="flex items-baseline justify-between gap-4">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {count === 0 ? 'No edits yet' : `${count} ${count === 1 ? 'edit' : 'edits'}`}
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

          {deletedRegions.length > 0 && <details className="rounded-lg border border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
            <summary className="cursor-pointer font-medium">Deleted regions ({deletedRegions.length})</summary>
            <ul className="mt-3 space-y-2">
              {deletedRegions.map((region, i) => <li key={region.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>Page {region.sourcePage} · {Math.round(region.source.width)} × {Math.round(region.source.height)} pt at {Math.round(region.source.x)}, {Math.round(region.source.y)}</span>
                <button type="button" aria-label={`Restore deleted region ${i + 1} on page ${region.sourcePage}`}
                  onClick={() => commit((els) => els.filter((el) => el.id !== region.id))} className="text-rose-600 hover:underline dark:text-rose-400">
                  Restore original
                </button>
              </li>)}
            </ul>
          </details>}

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
                    className="mx-auto w-fit scroll-mt-48"
                  >
                    <EditPage
                      doc={doc}
                      pageNumber={page}
                      size={size}
                      zoom={zoom}
                      elements={byPage.get(page) ?? []}
                      sourceRegions={sourcesByPage.get(page) ?? []}
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
        <div ref={actionsRef} className="tool-actions space-y-2">
          {result.value && <ResultCard file={result.value} from="edit" onDismiss={result.clear} />}
          <Button onClick={save} disabled={busy || count === 0 || unwritable.length > 0}>
            {busy ? 'Saving…' : count === 0 ? 'Make an edit first' : `Save with ${count} ${count === 1 ? 'edit' : 'edits'}`}
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

function RegionControls({ value, pages, onPageChange, onCopy, onRotate, copyDisabled, onChange }: {
  value: RegionElement
  pages: PageSize[]
  onPageChange: (page: number) => void
  onCopy: (page: number) => void
  onRotate: (rotation: RegionRotation) => void
  copyDisabled: boolean
  onChange: (patch: Partial<RegionElement>) => void
}) {
  const box = roundedBox(value)
  const rotation = value.rotation ?? 0
  const [preferredCopyPage, setPreferredCopyPage] = useState(0)
  const targets = pages.flatMap((size, i) => size.width >= 2 && size.height >= 2 ? [i + 1] : [])
  const copyPage = targets.includes(preferredCopyPage) ? preferredCopyPage : targets.find((page) => page > value.page) ?? targets[0] ?? 0
  return <>
    <label className="inline-flex items-center gap-1.5">
      Move to page
      <select aria-label="Move region to page" className={FIELD} value={value.page} onChange={(event) => onPageChange(Number(event.target.value))}>
        {pages.map((size, i) => <option key={i + 1} value={i + 1} disabled={size.width < 2 || size.height < 2}>Page {i + 1}</option>)}
      </select>
    </label>
    <span>{value.copy ? 'Copy of page' : 'From page'} {value.sourcePage}</span>
    <label className="inline-flex items-center gap-1.5">
      Copy to page
      <select aria-label="Region copy page" className={FIELD} value={copyPage || ''} disabled={!targets.length || copyDisabled} onChange={(event) => setPreferredCopyPage(Number(event.target.value))}>
        {!targets.length && <option value="">No available page</option>}
        {targets.map((page) => <option key={page} value={page}>Page {page}{page === value.page ? ' (current)' : ''}</option>)}
      </select>
    </label>
    <button type="button" onClick={() => onCopy(copyPage)} disabled={!copyPage || copyDisabled} className="rounded border border-zinc-300 px-2 py-1 text-zinc-800 hover:bg-zinc-200/70 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
      Copy region
    </button>
    <span className="inline-flex items-center gap-1.5">
      <label className="inline-flex items-center gap-1.5">Rotation
        <select aria-label="Region rotation" value={rotation} onChange={(event) => onRotate(Number(event.target.value) as RegionRotation)} className={FIELD}>
          {REGION_ROTATIONS.map((angle) => <option key={angle} value={angle}>{angle}°</option>)}
        </select>
      </label>
      <IconButton label="Rotate region left" onClick={() => onRotate(((rotation + 270) % 360) as RegionRotation)}><RotateIcon className="size-4 -scale-x-100" /></IconButton>
      <IconButton label="Rotate region right" onClick={() => onRotate(((rotation + 90) % 360) as RegionRotation)}><RotateIcon className="size-4" /></IconButton>
    </span>
    {(['x', 'y', 'width', 'height'] as const).map((key) => <label key={key} className="inline-flex items-center gap-1.5">
      {{ x: 'Left', y: 'Top', width: 'Width', height: 'Height' }[key]}
      <input aria-label={`Region ${key}`} type="number" min={key === 'x' || key === 'y' ? 0 : 2} step="1" value={box[key]}
        onChange={(event) => { if (event.target.value !== '' && Number.isFinite(event.target.valueAsNumber)) onChange({ [key]: event.target.valueAsNumber }) }}
        className={`${FIELD} w-20`} />
    </label>)}
    <span>pt · Hold Shift while resizing to stretch.</span>
  </>
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
