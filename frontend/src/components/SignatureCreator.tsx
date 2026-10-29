import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { Point } from '../lib/edits'
import { prepareSignature, saveSignature, type PreparedSignature, type SavedSignature } from '../lib/signatureApi'
import { drawSignature, PAD_HEIGHT, PAD_WIDTH, type InkStroke } from '../lib/signatures'
import { Dropzone } from './Dropzone'
import { Button, ErrorMessage, FIELD } from './ui'

export function SignatureCreator({ onSaved, onCancel }: { onSaved: (signature: SavedSignature) => void; onCancel: () => void }) {
  const [mode, setMode] = useState<'draw' | 'import'>('draw')
  const [name, setName] = useState('')
  const [strokes, setStrokes] = useState<InkStroke[]>([])
  const [drawing, setDrawing] = useState(false)
  const [imported, setImported] = useState<File | null>(null)
  const [removeWhite, setRemoveWhite] = useState(false)
  const [prepared, setPrepared] = useState<PreparedSignature | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const preparation = useRef<AbortController | null>(null)

  function resetImport() {
    preparation.current?.abort()
    setPrepared(null); setUrl(null); setPreparing(false); setError(null)
  }

  useEffect(() => {
    if (mode !== 'import' || !imported) return
    const controller = new AbortController()
    preparation.current = controller
    let objectUrl: string | null = null
    prepareSignature(imported, removeWhite, controller.signal).then((ready) => {
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(ready.file)
      setPrepared(ready); setUrl(objectUrl)
    }).catch((error: Error) => { if (!controller.signal.aborted) setError(error.message) })
      .finally(() => { if (!controller.signal.aborted) setPreparing(false) })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [imported, removeWhite, mode])

  async function save() {
    if (saving || drawing || !name.trim() || (mode === 'draw' ? !strokes.length : !prepared || preparing)) return
    setSaving(true); setError(null)
    try {
      const file = mode === 'draw' ? await drawSignature(strokes) : prepared!.file
      onSaved(await saveSignature(file, name.trim()))
    } catch (error) { setError((error as Error).message); setSaving(false) }
  }

  return <section aria-label="Create a reusable signature" className="space-y-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
    <div className="flex items-center justify-between gap-3"><h3 className="font-medium">Create a reusable signature</h3><button type="button" disabled={saving} onClick={onCancel} className="text-sm text-zinc-500 disabled:opacity-50">Cancel</button></div>
    <fieldset disabled={saving} className="space-y-4 disabled:pointer-events-none disabled:opacity-60">
      <legend className="sr-only">Signature details</legend>
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="radio" name="signature-source" checked={mode === 'draw'} onChange={() => { resetImport(); setMode('draw') }} className="accent-rose-600" />Draw signature</label>
        <label className="flex items-center gap-2"><input type="radio" name="signature-source" checked={mode === 'import'} onChange={() => { resetImport(); setMode('import'); setPreparing(!!imported) }} className="accent-rose-600" />Import image</label>
      </div>
      {mode === 'draw' ? <SignaturePad strokes={strokes} onChange={setStrokes} onDrawing={setDrawing} /> : <>
        <Dropzone kind="image" compact title="Choose a PNG or JPEG signature" onFiles={([file]) => { resetImport(); setImported(file); setRemoveWhite(false); setPreparing(true) }} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={removeWhite} onChange={(e) => { resetImport(); setRemoveWhite(e.target.checked); setPreparing(!!imported) }} className="accent-rose-600" />Remove white background</label>
        <p className="text-sm text-zinc-500">Use this for ink on white paper. Transparent edges are trimmed automatically.</p>
        {preparing && <p role="status" className="text-sm text-zinc-500">Preparing signature…</p>}
        {url && <div className="signature-checker rounded-lg border border-zinc-200 p-3"><img src={url} alt="Prepared signature preview" className="mx-auto max-h-40 max-w-full object-contain" /></div>}
      </>}
      <label className="block space-y-1 text-sm">Signature name<input aria-label="Signature name" value={name} maxLength={80} onChange={(e) => { setName(e.target.value); setError(null) }} placeholder="e.g. My signature or Initials" className={`${FIELD} block w-full px-3 py-2`} /></label>
    </fieldset>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    <Button onClick={save} disabled={saving || drawing || !name.trim() || (mode === 'draw' ? !strokes.length : !prepared || preparing)}>{saving ? 'Saving signature…' : 'Save signature locally'}</Button>
  </section>
}

function SignaturePad({ strokes, onChange, onDrawing }: { strokes: InkStroke[]; onChange: (strokes: InkStroke[]) => void; onDrawing: (drawing: boolean) => void }) {
  const [color, setColor] = useState('#111827')
  const [width, setWidth] = useState(3)
  const [drawing, setDrawing] = useState(false)
  const pointer = useRef<number | null>(null)
  const current = useRef(strokes)
  useEffect(() => { current.current = strokes }, [strokes])
  function point(event: { clientX: number; clientY: number }, svg: SVGSVGElement): Point {
    const rect = svg.getBoundingClientRect()
    return [Math.max(0, Math.min(PAD_WIDTH, (event.clientX - rect.left) / rect.width * PAD_WIDTH)), Math.max(0, Math.min(PAD_HEIGHT, (event.clientY - rect.top) / rect.height * PAD_HEIGHT))]
  }
  function publish(next: InkStroke[]) { current.current = next; onChange(next) }
  function down(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || pointer.current !== null || !event.isPrimary) return
    event.preventDefault(); pointer.current = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrawing(true); onDrawing(true)
    publish([...current.current, { points: [point(event, event.currentTarget)], color, width }])
  }
  function move(event: PointerEvent<SVGSVGElement>) {
    if (pointer.current !== event.pointerId) return
    const last = current.current[current.current.length - 1]
    if (!last) return
    const next = point(event, event.currentTarget)
    const previous = last.points[last.points.length - 1]
    if (Math.hypot(next[0] - previous[0], next[1] - previous[1]) < 0.6) return
    publish([...current.current.slice(0, -1), { ...last, points: [...last.points, next] }])
  }
  function up(event: PointerEvent<SVGSVGElement>) {
    if (pointer.current !== event.pointerId) return
    move(event); pointer.current = null; setDrawing(false); onDrawing(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <label className="flex items-center gap-2">Ink color<select aria-label="Ink color" value={color} onChange={(e) => setColor(e.target.value)} className={FIELD}><option value="#111827">Black</option><option value="#1d4ed8">Blue</option></select></label>
      <label className="flex items-center gap-2">Pen width<select aria-label="Pen width" value={width} onChange={(e) => setWidth(Number(e.target.value))} className={FIELD}><option value={2}>Fine</option><option value={3}>Medium</option><option value={5}>Bold</option></select></label>
      <button type="button" disabled={drawing || !strokes.length} onClick={() => publish(current.current.slice(0, -1))} className="text-rose-600 disabled:text-zinc-400">Undo stroke</button>
      <button type="button" disabled={drawing || !strokes.length} onClick={() => publish([])} className="text-zinc-500 disabled:opacity-40">Clear drawing</button>
    </div>
    <svg role="img" aria-label="Draw signature" viewBox={`0 0 ${PAD_WIDTH} ${PAD_HEIGHT}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} className="block aspect-[10/3] w-full touch-none select-none rounded-lg border border-zinc-300 bg-white">
      <line x1={24} x2={PAD_WIDTH - 24} y1={180} y2={180} stroke="#d4d4d8" strokeDasharray="6 6" />
      {strokes.map((stroke, index) => <polyline key={index} points={(stroke.points.length === 1 ? [...stroke.points, ...stroke.points] : stroke.points).map((point) => point.join(',')).join(' ')} fill="none" stroke={stroke.color} strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round" />)}
    </svg>
    <p className="text-sm text-zinc-500">Draw with a mouse, pen or finger. The guide line is not saved.</p>
  </div>
}
