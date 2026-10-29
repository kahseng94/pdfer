import { describe, expect, it } from 'vitest'
import { deleteWorkflowPreset, newWorkflowStep, normalizeWorkflowPreset, readWorkflowPresets, saveWorkflowPreset, starterWorkflow, workflowProblem, WORKFLOW_STORAGE_KEY, type WorkflowPreset } from './workflowPresets'

function storage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}
const preset = (id = 'first', name = 'Share PDFs'): WorkflowPreset => ({ id, name, steps: starterWorkflow() })

describe('saved workflow presets', () => {
  it('persists ordered steps and their settings, and supports rename, delete, and restore', () => {
    const store = storage()
    const draft = preset()
    expect(readWorkflowPresets(store)).toEqual([])
    saveWorkflowPreset(draft, store)
    expect(readWorkflowPresets(store)).toEqual([draft])
    const updated = { ...draft, name: 'Ready to share', steps: [draft.steps[2], draft.steps[0]] }
    saveWorkflowPreset(updated, store)
    expect(readWorkflowPresets(store)).toEqual([updated])
    expect(deleteWorkflowPreset(draft.id, store)).toEqual([])
    saveWorkflowPreset(updated, store)
    expect(readWorkflowPresets(store)).toEqual([updated])
  })
  it('strips unexpected fields, including passwords, from every saved record', () => {
    const store = storage()
    const input = { ...preset(), password: 'top secret', files: ['private.pdf'], steps: [{ id: 'protect', type: 'protect', password: 'step secret', settings: { password: 'nested secret' } }] }
    saveWorkflowPreset(input as WorkflowPreset, store)
    const saved = store.getItem(WORKFLOW_STORAGE_KEY)!
    expect(saved).not.toContain('secret')
    expect(saved).not.toContain('private.pdf')
    expect(JSON.parse(saved).presets[0].steps).toEqual([{ id: 'protect', type: 'protect' }])
  })
  it('reads fresh data before mutations so unrelated presets from another tab survive', () => {
    const store = storage()
    const first = preset()
    saveWorkflowPreset(first, store)
    saveWorkflowPreset(preset('second', 'Second preset'), store)
    saveWorkflowPreset({ ...first, name: 'Updated first' }, store)
    expect(readWorkflowPresets(store).map((entry) => entry.name)).toEqual(['Updated first', 'Second preset'])
  })
  it('rejects duplicate names, broken storage and unsupported versions without overwriting them', () => {
    const store = storage()
    saveWorkflowPreset(preset(), store)
    expect(() => saveWorkflowPreset(preset('other', 'share pdfs'), store)).toThrow('already exists')
    for (const raw of ['{broken', JSON.stringify({ version: 99, presets: [] }), JSON.stringify({ version: 1, presets: [{ name: 'bad' }] })]) {
      store.setItem(WORKFLOW_STORAGE_KEY, raw)
      expect(() => saveWorkflowPreset(preset(), store)).toThrow('could not be read')
      expect(store.getItem(WORKFLOW_STORAGE_KEY)).toBe(raw)
    }
  })
  it('reports blocked storage instead of pretending a preset was saved', () => {
    expect(() => saveWorkflowPreset(preset(), { getItem: () => null, setItem: () => { throw new Error('Quota exceeded') } })).toThrow('Could not save')
  })
})

describe('workflow validation', () => {
  it('validates settings and bounds steps while keeping open-ended page scopes reusable', () => {
    expect(workflowProblem([])).toContain('1–8')
    expect(workflowProblem(Array.from({ length: 9 }, () => newWorkflowStep('compress')))).toContain('1–8')
    expect(workflowProblem([newWorkflowStep('protect'), newWorkflowStep('protect')])).toContain('only one')
    const step = newWorkflowStep('watermark')
    if (step.type !== 'watermark') throw new Error('Unexpected step')
    expect(workflowProblem([{ ...step, pages: '2-' }])).toBeNull()
    expect(workflowProblem([{ ...step, pages: '3-1' }])).toContain('page ranges')
    expect(workflowProblem([{ ...step, settings: { ...step.settings, opacity: NaN } }])).toContain('Opacity')
    expect(workflowProblem([{ ...step, settings: { ...step.settings, text: '' } }])).toContain('Watermark text')
  })
  it('rejects duplicate IDs and invalid style values, and trims names', () => {
    const step = newWorkflowStep('compress')
    expect(workflowProblem([step, step])).toContain('IDs must be unique')
    expect(normalizeWorkflowPreset(preset('id', '  My preset  ')).name).toBe('My preset')
    expect(() => normalizeWorkflowPreset(preset('id', 'bad\nname'))).toThrow('single-line')
    const raw = { ...preset(), steps: [{ ...newWorkflowStep('watermark'), settings: { color: 'red' } }] }
    expect(() => normalizeWorkflowPreset(raw)).toThrow('color')
  })
})
