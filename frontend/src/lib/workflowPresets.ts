import type { CompressLevel } from './api'
import { parseSpec } from './ranges'
import { DEFAULT_NUMBERS, DEFAULT_WATERMARK, NUMBER_FORMATS, STAMP_POSITIONS, stampProblem, type NumberSettings, type StampStyle, type WatermarkSettings } from './stamps'

export type WorkflowStep =
  | { id: string; type: 'watermark'; pages: string; settings: WatermarkSettings }
  | { id: string; type: 'numbers'; pages: string; settings: NumberSettings }
  | { id: string; type: 'compress'; level: CompressLevel }
  | { id: string; type: 'protect' }
export type WorkflowStepType = WorkflowStep['type']
export type WorkflowPreset = { id: string; name: string; steps: WorkflowStep[] }
export const WORKFLOW_STORAGE_KEY = 'pdfer.workflows.v1'
export const MAX_WORKFLOW_STEPS = 8
export const STEP_LABELS: Record<WorkflowStepType, string> = {
  watermark: 'Watermark', numbers: 'Page numbers', compress: 'Compress', protect: 'Password protection',
}

export function newWorkflowStep(type: WorkflowStepType): WorkflowStep {
  const id = crypto.randomUUID()
  switch (type) {
    case 'watermark': return { id, type, pages: 'all', settings: { ...DEFAULT_WATERMARK } }
    case 'numbers': return { id, type, pages: 'all', settings: { ...DEFAULT_NUMBERS } }
    case 'compress': return { id, type, level: 'balanced' }
    case 'protect': return { id, type }
  }
}

export function starterWorkflow(): WorkflowStep[] {
  return (['watermark', 'compress', 'protect'] as const).map(newWorkflowStep)
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workflow settings.')
  return value as Record<string, unknown>
}
function string(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must contain 1–${max} characters.`)
  return value
}
function number(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be from ${min} to ${max}.`)
  return value
}
function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new Error(`Choose a valid ${label}.`)
  return value as T
}
function style(value: Record<string, unknown>, numbers: boolean): StampStyle {
  const positions = STAMP_POSITIONS.map(([position]) => position).filter((position) => !numbers || position.startsWith('top-') || position.startsWith('bottom-'))
  if (typeof value.color !== 'string' || !/^#[\da-f]{6}$/i.test(value.color)) throw new Error('Choose a valid color.')
  return {
    position: choice(value.position, positions, 'position'),
    family: choice(value.family, ['sans', 'serif', 'mono'], 'font'),
    color: value.color,
    size: number(value.size, 'Font size', 6, numbers ? 72 : 200),
    margin: number(value.margin, 'Margin', 0, 144),
  }
}
function scope(value: unknown): string {
  const pages = string(value, 'Pages', 500)
  if (pages === 'all') return pages
  const parsed = parseSpec(pages, 1_000_000)
  if (parsed.invalid.length || !parsed.ranges.length) throw new Error('Enter page ranges such as 1-3, 5, 8-.')
  return pages
}

/** Rebuild only known fields. Files and passwords never enter a saved preset. */
export function normalizeWorkflowSteps(input: unknown): WorkflowStep[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_WORKFLOW_STEPS) throw new Error(`Use 1–${MAX_WORKFLOW_STEPS} workflow steps.`)
  const ids = new Set<string>()
  let protects = 0
  return input.map((raw, index): WorkflowStep => {
    try {
      const value = record(raw)
      const id = string(value.id, 'Step ID', 128)
      if (ids.has(id)) throw new Error('Step IDs must be unique.')
      ids.add(id)
      const type = choice(value.type, ['watermark', 'numbers', 'compress', 'protect'], 'step type')
      if (type === 'compress') return { id, type, level: choice(value.level, ['light', 'balanced', 'strong'], 'compression level') }
      if (type === 'protect') {
        if (++protects > 1) throw new Error('Use only one password-protection step.')
        return { id, type }
      }
      const pages = scope(value.pages)
      const settings = record(value.settings)
      if (type === 'watermark') {
        const watermark: WatermarkSettings = {
          ...style(settings, false), text: string(settings.text, 'Watermark text', 400),
          opacity: number(settings.opacity, 'Opacity', 0.01, 1), rotation: number(settings.rotation, 'Rotation', -180, 180),
        }
        const problem = stampProblem({ pages: '1', watermark, numbers: null }, 1)
        if (problem) throw new Error(problem)
        return { id, type, pages, settings: watermark }
      }
      const numbers: NumberSettings = {
        ...style(settings, true), start: number(settings.start, 'Starting number', 1, 1_000_000),
        format: choice(settings.format, NUMBER_FORMATS.map(([format]) => format), 'number format'),
        mode: choice(settings.mode, ['document', 'selected'], 'numbering mode'),
      }
      if (!Number.isInteger(numbers.start)) throw new Error('Starting number must be a whole number.')
      return { id, type, pages, settings: numbers }
    } catch (error) {
      throw new Error(`Step ${index + 1}: ${(error as Error).message}`)
    }
  })
}

export function workflowProblem(steps: readonly WorkflowStep[]): string | null {
  try { normalizeWorkflowSteps(steps); return null } catch (error) { return (error as Error).message }
}

export function normalizeWorkflowPreset(input: unknown): WorkflowPreset {
  const value = record(input)
  const name = string(value.name, 'Preset name', 80).trim()
  if (/[\x00-\x1f\x7f]/.test(name)) throw new Error('Use a single-line preset name.') // oxlint-disable-line no-control-regex
  return { id: string(value.id, 'Preset ID', 128), name, steps: normalizeWorkflowSteps(value.steps) }
}

type PresetStorage = Pick<Storage, 'getItem' | 'setItem'>
const sameName = (first: string, second: string) => first.normalize('NFC').toLowerCase() === second.normalize('NFC').toLowerCase()

export function readWorkflowPresets(storage: PresetStorage = localStorage): WorkflowPreset[] {
  const raw = storage.getItem(WORKFLOW_STORAGE_KEY)
  if (raw === null) return []
  try {
    const envelope = record(JSON.parse(raw))
    if (envelope.version !== 1 || !Array.isArray(envelope.presets) || envelope.presets.length > 50) throw new Error('Unsupported preset library.')
    const presets = envelope.presets.map(normalizeWorkflowPreset)
    if (new Set(presets.map((preset) => preset.id)).size !== presets.length) throw new Error('Duplicate preset IDs.')
    return presets
  } catch {
    throw new Error('Saved presets could not be read. Existing saved data has been left intact; you can still run an unsaved workflow.')
  }
}

function writePresets(presets: WorkflowPreset[], storage: PresetStorage): WorkflowPreset[] {
  if (presets.length > 50) throw new Error('You can save up to 50 presets. Remove an unused preset first.')
  try { storage.setItem(WORKFLOW_STORAGE_KEY, JSON.stringify({ version: 1, presets })) }
  catch { throw new Error('Could not save presets in this browser. Your current workflow is still available to run.') }
  return presets
}

/** Read afresh before each mutation so another tab's unrelated presets are preserved. */
export function saveWorkflowPreset(input: WorkflowPreset, storage: PresetStorage = localStorage): WorkflowPreset[] {
  const preset = normalizeWorkflowPreset(input)
  const existing = readWorkflowPresets(storage)
  if (existing.some((entry) => entry.id !== preset.id && sameName(entry.name, preset.name))) throw new Error('A preset with that name already exists. Use a different name.')
  const found = existing.some((entry) => entry.id === preset.id)
  return writePresets(found ? existing.map((entry) => entry.id === preset.id ? preset : entry) : [...existing, preset], storage)
}

export function deleteWorkflowPreset(id: string, storage: PresetStorage = localStorage): WorkflowPreset[] {
  return writePresets(readWorkflowPresets(storage).filter((preset) => preset.id !== id), storage)
}
