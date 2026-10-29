import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { signPdf } from '../lib/api'
import { DEFAULT_STYLE, type Element } from '../lib/edits'
import { pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import { pdfPassword } from '../lib/passwords'
import { closePdf, formatSize, type PDFDocumentProxy } from '../lib/pdf'
import { useResult } from '../lib/result'
import { deleteSignature, listSignatures, signatureImage, signatureImageUrl, type SavedSignature } from '../lib/signatureApi'
import { fitSignature, initialSignatureBox, signaturePayload, type SignaturePage, type SignaturePlacement } from '../lib/signatures'
import { useEditHistory } from '../lib/useEditHistory'
import { usePdfLoader } from '../lib/usePdfLoader'
import { useWindowDrop } from '../lib/windowDrop'
import { DocumentPreview } from './DocumentPreview'
import { Dropzone } from './Dropzone'
import { EditPage, type Editor } from './EditPage'
import { ResultCard } from './ResultCard'
import { SignatureCreator } from './SignatureCreator'
import { Button, DropOverlay, ErrorMessage, FIELD } from './ui'

export function SignatureTool({ active = true }: { active?: boolean }) {
  const [library, setLibrary] = useState<SavedSignature[]>([])
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [assetId, setAssetId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const libraryRequest = useRef<AbortController | null>(null)
  const refreshLibrary = useCallback(async () => {
    libraryRequest.current?.abort()
    const controller = new AbortController()
    libraryRequest.current = controller
    setLibraryLoading(true); setLibraryError(null)
    try {
      const saved = await listSignatures(controller.signal)
      if (!controller.signal.aborted) setLibrary(saved)
    } catch (error) { if (!controller.signal.aborted) setLibraryError((error as Error).message) }
    finally { if (!controller.signal.aborted) setLibraryLoading(false) }
  }, [])
  useEffect(() => {
    if (!active) return
    const timer = setTimeout(() => void refreshLibrary(), 0)
    return () => { clearTimeout(timer); libraryRequest.current?.abort() }
  }, [active, refreshLibrary])

  function saved(signature: SavedSignature) {
    libraryRequest.current?.abort()
    setLibraryLoading(false); setLibraryError(null)
    setLibrary((previous) => [signature, ...previous])
    setAssetId(signature.id); setCreating(false)
  }
  async function removeSaved(id: string) {
    setDeleting(true); setLibraryError(null)
    try {
      await deleteSignature(id)
      libraryRequest.current?.abort(); setLibraryLoading(false)
      setLibrary((previous) => previous.filter((signature) => signature.id !== id))
      setAssetId((current) => current === id ? null : current)
      setConfirmDelete(null)
    } catch (error) { setLibraryError((error as Error).message) }
    finally { setDeleting(false) }
  }

  const [file, setFile] = useState<File | null>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [pages, setPages] = useState<SignaturePage[]>([])
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [placing, setPlacing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rendered, setRendered] = useState<PDFDocumentProxy | null>(null)
  const [hasPreview, setHasPreview] = useState(false)
  const sourceDoc = useRef<PDFDocumentProxy | null>(null)
  const previewDoc = useRef<PDFDocumentProxy | null>(null)
  const previewRequest = useRef<AbortController | null>(null)
  const placementRequest = useRef<AbortController | null>(null)
  const version = useRef(0)
  const pictures = useRef(new Map<string, { file: File; url: string }>())
  const loader = usePdfLoader()
  const history = useEditHistory<SignaturePlacement>()
  const { elements } = history
  const { begin, change, end, commit } = history
  const result = useResult<{ file: File; doc: PDFDocumentProxy }>([file, elements])
  const selected = elements.find((element) => element.id === selectedId && element.page === page) ?? null
  const chosen = library.find((signature) => signature.id === assetId) ?? null
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const ready = useCallback((rendered: PDFDocumentProxy | null) => setRendered(rendered), [])

  useEffect(() => {
    if (!doc || !container.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [doc])
  useEffect(() => () => {
    version.current += 1
    previewRequest.current?.abort(); placementRequest.current?.abort()
    closePdf(sourceDoc.current); closePdf(previewDoc.current)
    for (const picture of pictures.current.values()) URL.revokeObjectURL(picture.url)
    pictures.current.clear()
  }, [])

  function cancelPreview() { previewRequest.current?.abort(); previewRequest.current = null; loader.cancel('preview'); setBusy(false) }
  function editPlacements() { result.clear(); setHasPreview(false); closePdf(previewDoc.current); previewDoc.current = null; setRendered(null) }
  function reset() {
    version.current += 1
    cancelPreview(); placementRequest.current?.abort(); placementRequest.current = null
    loader.cancel(); closePdf(sourceDoc.current); sourceDoc.current = null
    editPlacements()
    for (const picture of pictures.current.values()) URL.revokeObjectURL(picture.url)
    pictures.current.clear()
    setFile(null); setDoc(null); setPages([]); setPage(1); setSelectedId(null); setPlacing(false); setError(null)
    history.reset()
  }
  async function open(next: File) {
    reset()
    const current = version.current
    setFile(next)
    let loaded: PDFDocumentProxy | null = null
    try {
      loaded = await loader.load(next)
      const sizes = await Promise.all(Array.from({ length: loaded.numPages }, async (_, index) => {
        const source = await loaded!.getPage(index + 1)
        const viewport = source.getViewport({ scale: 1 })
        return { width: viewport.width, height: viewport.height, unit: source.userUnit }
      }))
      if (version.current !== current) { closePdf(loaded); return }
      sourceDoc.current = loaded
      setDoc(loaded); setPages(sizes)
    } catch (error) { closePdf(loaded); if (version.current === current) setError((error as Error).message) }
  }
  function take(files: File[]) { const [next] = pickFiles(files, 'pdf').wanted; if (next) void open(next) }
  const dragging = useWindowDrop(take, active)
  useReceive('signatures', take)

  async function place() {
    if (!chosen || !doc || busy || placing) return
    const current = version.current
    const target = page
    const controller = new AbortController()
    placementRequest.current = controller
    setPlacing(true); setError(null)
    try {
      let picture = pictures.current.get(chosen.id)
      if (!picture) {
        const image = await signatureImage(chosen, controller.signal)
        if (controller.signal.aborted || version.current !== current) return
        picture = { file: image, url: URL.createObjectURL(image) }
        pictures.current.set(chosen.id, picture)
      }
      const id = crypto.randomUUID()
      const aspect = chosen.width / chosen.height
      const placement: SignaturePlacement = { id, type: 'image', page: target, ...initialSignatureBox(aspect, pages[target - 1]), ...picture, signatureId: chosen.id, label: chosen.name, aspect }
      history.commit((previous) => [...previous, placement])
      setSelectedId(id)
    } catch (error) { if (!controller.signal.aborted && version.current === current) setError((error as Error).message) }
    finally { if (placementRequest.current === controller) { placementRequest.current = null; setPlacing(false) } }
  }

  const normalize = useCallback((next: Element[]) => next.map((element) => fitSignature(element as SignaturePlacement, pages[element.page - 1])), [pages])
  const editor = useMemo<Editor>(() => ({
    select: setSelectedId, edit: () => {}, stopEditing: () => {}, toolDone: () => {},
    begin, end,
    change: (update) => change((previous) => normalize(update(previous))),
    commit: (update) => commit((previous) => normalize(update(previous))),
  }), [begin, end, change, commit, normalize, setSelectedId])

  function changeSelected(patch: Partial<Pick<SignaturePlacement, 'x' | 'y' | 'width'>>) {
    if (!selected || Object.values(patch).some((value) => !Number.isFinite(value))) return
    history.commit((previous) => previous.map((element) => element.id === selected.id ? fitSignature({ ...element, ...patch }, pages[page - 1]) : element))
  }
  function removeSelected() { if (selected) { history.commit((previous) => previous.filter((element) => element.id !== selected.id)); setSelectedId(null) } }

  async function preview() {
    if (!file || !doc || !elements.length || busy || placing) return
    editPlacements()
    const controller = new AbortController()
    previewRequest.current = controller
    const finish = result.begin()
    setBusy(true); setError(null)
    try {
      const payload = signaturePayload(elements, pages)
      const output = await signPdf(file, payload.edits, payload.images, controller.signal)
      if (controller.signal.aborted) return
      const preview = await loader.load(output, 'preview')
      if (controller.signal.aborted || previewRequest.current !== controller) { closePdf(preview); return }
      previewDoc.current = preview
      setHasPreview(true)
      finish({ file: output, doc: preview })
    } catch (error) { if (!controller.signal.aborted && previewRequest.current === controller) setError((error as Error).message) }
    finally { if (previewRequest.current === controller) { previewRequest.current = null; setBusy(false) } }
  }

  const size = pages[page - 1]
  const zoom = size ? Math.min(width / size.width, 850 / size.height) : 0
  return <div className="space-y-5">
    {dragging && <DropOverlay label="Drop a PDF to add signatures" />}
    <section aria-label="Saved signatures" className="space-y-3">
      <div className="flex items-center justify-between gap-3"><h2 className="font-medium">Saved signatures</h2><button type="button" onClick={() => setCreating(true)} className="text-sm font-medium text-rose-600 dark:text-rose-400">New signature</button></div>
      <p className="text-sm text-zinc-500">Save signature images on this computer and reuse them on future PDFs.</p>
      {libraryLoading && <p role="status" className="text-sm text-zinc-500">Loading signatures…</p>}
      {libraryError && <><ErrorMessage>{libraryError}</ErrorMessage><button type="button" onClick={() => void refreshLibrary()} className="text-sm text-rose-600">Retry library</button></>}
      {!libraryLoading && !libraryError && !library.length && <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">No saved signatures yet. Create one by drawing or importing an image.</p>}
      <div className="grid max-h-80 gap-3 overflow-y-auto p-0.5 sm:grid-cols-2">
        {library.map((signature) => <div key={signature.id} className={`rounded-lg border p-3 ${assetId === signature.id ? 'border-rose-500 bg-rose-50 dark:bg-rose-950/30' : 'border-zinc-200 dark:border-zinc-800'}`}>
          <button type="button" aria-label={`Use signature ${signature.name}`} aria-pressed={assetId === signature.id} onClick={() => setAssetId(signature.id)} className="block w-full text-left">
            <div className="signature-checker flex h-20 items-center justify-center rounded p-2"><img src={signatureImageUrl(signature.id)} alt="" loading="lazy" className="max-h-full max-w-full object-contain" /></div>
            <span className="mt-2 block truncate text-sm font-medium">{signature.name}</span>
          </button>
          {confirmDelete === signature.id ? <div className="mt-2 space-y-2 text-sm"><p>Delete this saved signature? Placed copies stay in your current PDF.</p><div className="flex gap-3"><button type="button" disabled={deleting} onClick={() => void removeSaved(signature.id)} className="text-red-600">Confirm delete</button><button type="button" disabled={deleting} onClick={() => setConfirmDelete(null)}>Cancel delete</button></div></div> : <button type="button" aria-label={`Delete signature ${signature.name}`} onClick={() => setConfirmDelete(signature.id)} className="mt-2 text-xs text-zinc-500 hover:text-red-600">Delete</button>}
        </div>)}
      </div>
    </section>
    {creating && <SignatureCreator onSaved={saved} onCancel={() => setCreating(false)} />}

    {!file ? <Dropzone title="Choose a PDF to add signatures" onFiles={take} /> : <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="min-w-0"><p className="truncate font-medium">{file.name}</p><p className="text-sm text-zinc-500">{doc && `${doc.numPages} ${doc.numPages === 1 ? 'page' : 'pages'} · `}{formatSize(file.size)}</p>{doc && pdfPassword(file) && <p className="text-sm text-zinc-500">The saved PDF will keep this file’s password.</p>}</div>
      <button type="button" onClick={reset} className="shrink-0 text-sm text-zinc-500">Choose another file</button>
    </div>}
    {file && !doc && !error && <p role="status" className="text-sm text-zinc-500">Opening PDF…</p>}
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {doc && <>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">PDF page<select aria-label="Signature page" value={page} disabled={placing} onChange={(e) => { setPage(Number(e.target.value)); setSelectedId(null) }} className={FIELD}>{pages.map((_, i) => <option key={i + 1} value={i + 1}>{i + 1} / {pages.length}</option>)}</select></label>
        <span className="text-zinc-500">{chosen ? `Selected: ${chosen.name}` : 'Choose a saved signature above'}</span>
      </div>
      <Button onClick={place} disabled={!chosen || placing || busy}>{placing ? 'Loading signature…' : 'Place signature on this page'}</Button>
      <div className="flex flex-wrap gap-3 text-sm">
        <button type="button" disabled={busy || !history.canUndo} onClick={history.undo} className="text-rose-600 disabled:text-zinc-400">Undo placement</button>
        <button type="button" disabled={busy || !history.canRedo} onClick={history.redo} className="text-rose-600 disabled:text-zinc-400">Redo placement</button>
        <button type="button" disabled={busy || !selected} onClick={removeSelected} className="text-red-600 disabled:text-zinc-400">Remove selected signature</button>
        {result.value && <button type="button" onClick={editPlacements} className="text-rose-600">Edit placements</button>}
      </div>
      {elements.some((element) => element.page === page) && <label className="block space-y-1 text-sm">Placed signature<select aria-label="Placed signature" value={selected?.id ?? ''} disabled={busy} onChange={(e) => setSelectedId(e.target.value || null)} className={`${FIELD} block w-full py-2`}>
        <option value="">Choose a placement to adjust</option>{elements.filter((element) => element.page === page).map((element, index) => <option key={element.id} value={element.id}>{element.label} · {index + 1}</option>)}
      </select></label>}
      {selected && <fieldset disabled={busy} className="grid grid-cols-3 gap-3">
        <legend className="sr-only">Selected signature position</legend>
        {(['x', 'y', 'width'] as const).map((key) => <label key={key} className="space-y-1 text-sm">{key === 'x' ? 'Left (pt)' : key === 'y' ? 'Top (pt)' : 'Width (pt)'}<input aria-label={key === 'x' ? 'Signature left' : key === 'y' ? 'Signature top' : 'Signature width'} type="number" min={key === 'width' ? 1 : 0} step={1} value={Math.round(selected[key] * 100) / 100} onChange={(e) => changeSelected({ [key]: e.target.valueAsNumber })} className={`${FIELD} block w-full px-2 py-2`} /></label>)}
      </fieldset>}
      <p className="text-sm text-zinc-500">{result.value ? 'Preview of the exact PDF that will be downloaded.' : 'Drag a signature to move it; drag a corner to resize. Proportions are kept and signatures stay inside the page.'}</p>
      <div ref={container} className="rounded-lg border border-zinc-200 bg-zinc-100 p-3 dark:border-zinc-800 dark:bg-zinc-900">
        {result.value ? <DocumentPreview doc={result.value.doc} page={page} onReady={ready} /> : width > 0 && size && <div className={`mx-auto w-fit ${busy ? 'pointer-events-none opacity-60' : ''}`} aria-label="Signature placement page">
          <EditPage doc={doc} pageNumber={page} size={size} zoom={zoom} elements={elements.filter((element) => element.page === page)} selectedId={selectedId} editingId={null} tool="select" style={DEFAULT_STYLE} editor={editor} lockImageAspect />
        </div>}
      </div>
      <p className="text-sm text-zinc-500">{elements.length} {elements.length === 1 ? 'signature placement' : 'signature placements'} across {new Set(elements.map((element) => element.page)).size} {new Set(elements.map((element) => element.page)).size === 1 ? 'page' : 'pages'}.</p>
      <Button onClick={preview} disabled={busy || placing || !elements.length}>{busy ? 'Building preview…' : hasPreview ? 'Update PDF preview' : 'Preview signed PDF'}</Button>
      {busy && <button type="button" onClick={cancelPreview} className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">Cancel preview</button>}
      {result.value && rendered === result.value.doc && <ResultCard file={result.value.file} from="signatures" onDismiss={editPlacements} downloadLabel="Download PDF">Signature images applied. The original PDF is kept.</ResultCard>}
    </>}
  </div>
}
