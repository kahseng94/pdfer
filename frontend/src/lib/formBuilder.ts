// The fields the Create form tool adds, and how they turn into the backend's spec.
//
// Boxes are in points on the page as pdf.js shows it, like lib/edits.ts: the
// origin is the top-left corner and y runs down. The backend turns them into
// widget rectangles, so nothing here needs to know about page rotation.

import type { FormField, PdfSize } from './documentTools'
import { clampPoint, constrainBox, resized, roundedBox, type Box, type Handle } from './edits'

export type FieldType = 'text' | 'checkbox' | 'choice' | 'radio'
export type BuilderTool = FieldType | 'select'

export type DraftField = Box & {
  id: string
  page: number
  type: FieldType
  /** For a radio button, the name of its group. */
  name: string
  label: string
  required: boolean
  multiline: boolean
  maxLength: number | null
  /** Dropdown options, one per line as typed; blank lines are dropped when saving. */
  options: string[]
  editable: boolean
  /** A radio button's own value within its group. */
  option: string
}

export type FieldSpec = Box & {
  type: FieldType; name: string; page: number; label?: string; required?: boolean
  multiline?: boolean; maxLength?: number; options?: string[]; editable?: boolean; option?: string
}

/** One of the PDF's own fields marked for removal. It shares the undo history with the new fields. */
export type RemovedField = { id: string; kind: 'removed'; fieldId: string; name: string }
export type BuilderItem = DraftField | RemovedField
export const isRemoved = (item: BuilderItem): item is RemovedField => 'kind' in item && item.kind === 'removed'
export const isDraft = (item: BuilderItem): item is DraftField => !isRemoved(item)
export function removal(field: Pick<FormField, 'id' | 'name'>): RemovedField {
  return { id: `removed:${field.id}`, kind: 'removed', fieldId: field.id, name: field.name }
}
/** How the PDF's own fields are described; radio buttons are always a group. */
export const EXISTING_LABELS: Record<FormField['type'], string> = { text: 'Text box', checkbox: 'Checkbox', choice: 'Dropdown', radio: 'Radio group', unsupported: 'Field' }

export const FIELD_TYPES: { type: FieldType; label: string }[] = [
  { type: 'text', label: 'Text box' },
  { type: 'checkbox', label: 'Checkbox' },
  { type: 'choice', label: 'Dropdown' },
  { type: 'radio', label: 'Radio button' },
]
export const TYPE_LABELS: Record<FieldType, string> = { text: 'Text box', checkbox: 'Checkbox', choice: 'Dropdown', radio: 'Radio button' }

/** Same limits as the backend. */
export const MIN_FIELD = 8
export const MAX_FIELDS = 500
const BASE_NAMES: Record<FieldType, string> = { text: 'Text', checkbox: 'Checkbox', choice: 'Dropdown', radio: 'Radio group' }
/** What a click without dragging places. */
const DEFAULT_SIZE: Record<FieldType, [number, number]> = { text: [160, 22], checkbox: [14, 14], choice: [140, 22], radio: [14, 14] }
const hasControl = (text: string) => [...text].some((ch) => { const code = ch.charCodeAt(0); return code < 32 || (code >= 0x7f && code < 0xa0) })

export function nextName(type: FieldType, taken: Iterable<string>): string {
  const used = new Set(taken)
  for (let n = 1; ; n++) if (!used.has(`${BASE_NAMES[type]} ${n}`)) return `${BASE_NAMES[type]} ${n}`
}

export function nextOption(group: readonly DraftField[]): string {
  const used = new Set(group.map((field) => field.option))
  for (let n = 1; ; n++) if (!used.has(`Option ${n}`)) return `Option ${n}`
}

/** The box a drag draws, kept on the page. A click places a field of the usual size for its type. */
export function boxFromDrag(type: FieldType, start: { x: number; y: number }, end: { x: number; y: number }, size: PdfSize): Box {
  const [x0, y0] = clampPoint([start.x, start.y], size)
  const [x1, y1] = clampPoint([end.x, end.y], size)
  const dragged = Math.abs(x1 - x0) >= 4 || Math.abs(y1 - y0) >= 4
  const box = dragged
    ? { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.max(MIN_FIELD, Math.abs(x1 - x0)), height: Math.max(MIN_FIELD, Math.abs(y1 - y0)) }
    : { x: x0, y: y0, width: DEFAULT_SIZE[type][0], height: DEFAULT_SIZE[type][1] }
  return constrainBox(box, size)
}

export function movedBox(box: Box, dx: number, dy: number, size: PdfSize): Box {
  return constrainBox({ ...box, x: box.x + dx, y: box.y + dy }, size)
}

/** The box after a handle is dragged, never smaller than a field may be or past the page edges. */
export function resizedBox(box: Box, handle: Handle, dx: number, dy: number, size: PdfSize): Box {
  const next = resized(box, handle, dx, dy)
  const right = box.x + box.width
  const bottom = box.y + box.height
  if (handle.includes('w')) { next.x = Math.max(0, Math.min(next.x, right - MIN_FIELD)); next.width = right - next.x }
  if (handle.includes('e')) next.width = Math.max(MIN_FIELD, Math.min(next.width, size.width - next.x))
  if (handle.includes('n')) { next.y = Math.max(0, Math.min(next.y, bottom - MIN_FIELD)); next.height = bottom - next.y }
  if (handle.includes('s')) next.height = Math.max(MIN_FIELD, Math.min(next.height, size.height - next.y))
  return next
}

export function newField(type: FieldType, page: number, box: Box, fields: readonly DraftField[], taken: Iterable<string>, group?: string): DraftField {
  const names = [...taken, ...fields.map((field) => field.name)]
  const name = type === 'radio' && group ? group : nextName(type, names)
  return {
    id: crypto.randomUUID(), page, type, name, label: '', required: false, multiline: false, maxLength: null,
    options: type === 'choice' ? ['Option 1', 'Option 2'] : [], editable: false,
    option: type === 'radio' ? nextOption(fields.filter((field) => field.type === 'radio' && field.name === name)) : '',
    ...roundedBox(box),
  }
}

const cleanOptions = (field: DraftField) => field.options.map((option) => option.trim()).filter(Boolean)

function textProblem(value: string, what: string, max: number, required: boolean): string | null {
  const text = value.trim()
  if (required && !text) return `${what} can't be empty.`
  if (text.length > max) return `${what} must be at most ${max} characters.`
  if (hasControl(text)) return `${what} can't contain control characters.`
  return null
}

/** Why the backend would refuse these fields, or null when it won't. */
export function builderProblem(fields: readonly DraftField[], existingNames: readonly string[], existingCount: number, sizes: readonly PdfSize[]): string | null {
  const taken = new Set(existingNames)
  const singles = new Set<string>()
  const groups = new Map<string, DraftField[]>()
  for (const field of fields) {
    const name = field.name.trim()
    const called = name ? `“${name}”` : `A ${TYPE_LABELS[field.type].toLowerCase()} on page ${field.page}`
    const problem = textProblem(field.name, `${called}: the name`, 100, true)
      ?? (name.includes('.') ? `${called}: field names can't contain a full stop.` : null)
      ?? textProblem(field.label, `${called}: the label`, 200, false)
    if (problem) return problem
    const size = sizes[field.page - 1]
    if (!size || field.x < 0 || field.y < 0 || field.width < MIN_FIELD || field.height < MIN_FIELD
        || field.x + field.width > size.width + 0.02 || field.y + field.height > size.height + 0.02) {
      return `${called} must fit on page ${field.page} and be at least ${MIN_FIELD} points wide and high.`
    }
    if (field.type === 'text' && field.maxLength !== null && (!Number.isInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > 5000)) {
      return `${called}: the maximum length must be a whole number from 1 to 5000.`
    }
    if (field.type === 'choice') {
      const options = cleanOptions(field)
      if (!options.length || options.length > 100) return `${called}: a dropdown needs 1 to 100 options.`
      const bad = options.find((option) => option.length > 200 || hasControl(option))
      if (bad) return `${called}: options must be at most 200 characters, without control characters.`
      if (new Set(options).size !== options.length) return `${called}: dropdown options must be different from each other.`
    }
    if (field.type === 'radio') {
      const optionProblem = textProblem(field.option, `${called}: each button’s option`, 60, true)
      if (optionProblem) return optionProblem
      if (field.option.trim() === 'Off') return `${called}: “Off” is reserved; choose another option name.`
    }
    if (taken.has(name)) return `${called}: this PDF already has a field with that name.`
    if (singles.has(name) || (field.type !== 'radio' && groups.has(name))) return `${called}: another new field already has that name.`
    if (field.type === 'radio') groups.set(name, [...groups.get(name) ?? [], field])
    else singles.add(name)
  }
  for (const [name, buttons] of groups) {
    if (buttons.length < 2) return `Radio group “${name}” needs at least 2 buttons.`
    const options = buttons.map((button) => button.option.trim())
    if (new Set(options).size !== options.length) return `Radio group “${name}” has two buttons with the same option.`
  }
  if (existingCount + singles.size + groups.size > MAX_FIELDS) return `A form can have at most ${MAX_FIELDS} fields. This PDF already has ${existingCount}.`
  return null
}

/** The fields as JSON for the backend. */
export function toSpec(fields: readonly DraftField[]): FieldSpec[] {
  return fields.map((field) => {
    const spec: FieldSpec = { type: field.type, name: field.name.trim(), page: field.page, ...roundedBox(field) }
    if (field.label.trim()) spec.label = field.label.trim()
    if (field.required) spec.required = true
    if (field.type === 'text') {
      if (field.multiline) spec.multiline = true
      if (field.maxLength !== null) spec.maxLength = field.maxLength
    }
    if (field.type === 'choice') {
      spec.options = cleanOptions(field)
      if (field.editable) spec.editable = true
    }
    if (field.type === 'radio') spec.option = field.option.trim()
    return spec
  })
}
