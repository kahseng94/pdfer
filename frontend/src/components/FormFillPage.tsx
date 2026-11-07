import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import type { FieldBox, FormField, FormValue, PdfSize } from '../lib/documentTools'
import type { PDFDocumentProxy } from '../lib/pdf'
import { useElementWidth, usePageCanvas } from '../lib/usePageCanvas'

/** A request to put the keyboard in a field on this page; a new key repeats it. */
export type FieldFocus = { id: string; key: number }

const BASE = 'absolute m-0 box-border text-zinc-900 outline-none'
const BOX = 'border bg-sky-50/95 px-[0.2em] focus:border-rose-500 focus:ring-1 focus:ring-rose-500'

/**
 * One page of the form with inputs laid over its fields, so they can be filled where they are.
 * The page still draws read-only and unsupported fields itself; editable ones are covered by
 * their inputs, which share their values with the list beside the page.
 */
export function FormFillPage({ doc, page, size, fields, values, activeId, focus, onChange, onFocusField }: {
  doc: PDFDocumentProxy; page: number; size: PdfSize; fields: readonly FormField[]; values: Record<string, FormValue>
  activeId: string | null; focus: FieldFocus | null
  onChange: (field: FormField, value: FormValue) => void; onFocusField: (id: string) => void
}) {
  const [container, width] = useElementWidth<HTMLDivElement>()
  const displayWidth = Math.min(width, 900 * size.width / size.height)
  const { canvas, ready, error } = usePageCanvas(doc, page, displayWidth)
  /** Screen pixels per point. */
  const scale = displayWidth > 0 ? displayWidth / size.width : 1

  const handled = useRef(0)
  useEffect(() => {
    if (!focus || !ready || handled.current === focus.key) return
    const target = container.current?.querySelector<HTMLElement>(`[data-field="${CSS.escape(focus.id)}"]`)
    if (!target) return
    handled.current = focus.key
    target.focus({ preventScroll: true })
    target.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  }, [focus, ready, page, container])

  const controls: ReactNode[] = []
  for (const field of fields) {
    if (field.readOnly || field.type === 'unsupported') continue
    const value = values[field.id] ?? field.value
    const active = field.id === activeId
    ;(field.boxes ?? []).forEach((box, index) => {
      if (box.page !== page) return
      const control = fieldControl(field, box, `${field.id}-${index}`, value, active, scale, size, onChange, () => onFocusField(field.id))
      if (control) controls.push(control)
    })
  }
  const editable = controls.length
  return <div ref={container} className="space-y-2">
    {error && <p role="alert" className="text-sm text-red-600">Could not render this page: {error}</p>}
    {!ready && !error && <p role="status" className="text-sm text-zinc-500">Rendering page…</p>}
    {ready && !editable && <p className="text-sm text-zinc-500">No fields to fill on this page.</p>}
    <div className={`relative mx-auto bg-white shadow-sm ${!ready ? 'invisible' : ''}`} style={{ width: displayWidth, aspectRatio: size.width / size.height }}>
      <canvas ref={canvas} aria-hidden="true" className="block h-full w-full" />
      <div role="group" aria-label={`Form fields on page ${page}`} className="absolute inset-0">{controls}</div>
    </div>
  </div>
}

function fieldControl(field: FormField, box: FieldBox, key: string, value: FormValue, active: boolean, scale: number, size: PdfSize,
  onChange: (field: FormField, value: FormValue) => void, onFocus: () => void): ReactNode {
  const place: CSSProperties = {
    left: `${box.x / size.width * 100}%`, top: `${box.y / size.height * 100}%`,
    width: `${box.width / size.width * 100}%`, height: `${box.height / size.height * 100}%`,
  }
  const common = { 'data-field': field.id, onFocus, title: field.reason ?? field.label }
  const border = active ? 'border-rose-500' : 'border-sky-400/80'
  // Text about the size the saved PDF will use: up to 12 points, smaller in a short box.
  const fontSize = Math.max(5, Math.min(field.multiline ? 10 : 12, (box.height - 2) / 1.25)) * scale
  const text = { ...place, fontSize, lineHeight: 1.2 }
  if (field.type === 'checkbox') {
    return <input key={key} {...common} type="checkbox" aria-label={field.label} checked={Boolean(value)} onChange={(e) => onChange(field, e.target.checked)} className={`${BASE} accent-rose-600`} style={place} />
  }
  if (field.type === 'radio') {
    if (!box.option) return null
    const option = box.option
    return <input key={key} {...common} type="radio" name={`page-${field.id}`} aria-label={`${field.label}: ${option}`} checked={value === option} onChange={() => onChange(field, option)} className={`${BASE} accent-rose-600`} style={place} />
  }
  if (field.type === 'choice' && !field.editable) {
    return <select key={key} {...common} aria-label={field.label} value={String(value)} onChange={(e) => onChange(field, e.target.value)} className={`${BASE} ${BOX} ${border} appearance-auto py-0`} style={text}>
      <option value="" />
      {!!value && !field.options.some((option) => option.value === value) && <option value={String(value)}>{String(value)}</option>}
      {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  }
  if (field.type === 'text' && field.multiline) {
    return <textarea key={key} {...common} aria-label={field.label} maxLength={field.maxLength ?? 5000} value={String(value)} onChange={(e) => onChange(field, e.target.value)} className={`${BASE} ${BOX} ${border} resize-none overflow-auto py-[0.1em]`} style={text} />
  }
  const list = field.type === 'choice' ? `page-options-${key}` : undefined
  return <span key={key}>
    <input {...common} type="text" aria-label={field.label} list={list} maxLength={field.maxLength ?? 5000} value={String(value)} onChange={(e) => onChange(field, e.target.value)} className={`${BASE} ${BOX} ${border} py-0`} style={text} />
    {list && <datalist id={list}>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</datalist>}
  </span>
}
