import { useState } from 'react'
import { MAX_WORKFLOW_STEPS, newWorkflowStep, STEP_LABELS, type WorkflowStep, type WorkflowStepType } from '../lib/workflowPresets'
import { NUMBER_FORMATS, STAMP_POSITIONS, type StampStyle } from '../lib/stamps'
import { FIELD } from './ui'

export function WorkflowSteps({ steps, onChange }: { steps: WorkflowStep[]; onChange: (steps: WorkflowStep[]) => void }) {
  const [addType, setAddType] = useState<WorkflowStepType>('watermark')
  const hasProtection = steps.some((step) => step.type === 'protect')
  function move(index: number, delta: number) {
    const next = [...steps]
    ;[next[index], next[index + delta]] = [next[index + delta], next[index]]
    onChange(next)
  }
  return <div className="space-y-3">
    <div><h2 className="font-medium">Workflow steps</h2><p className="mt-1 text-sm text-zinc-500">Each PDF goes through these steps from top to bottom.</p></div>
    <ol className="space-y-3">
      {steps.map((step, index) => <li key={step.id} className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">{index + 1}. {STEP_LABELS[step.type]}</h3>
          <div className="flex gap-3 text-xs">
            <button type="button" aria-label={`Move step ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)} className="text-zinc-500 hover:underline disabled:opacity-30">Move up</button>
            <button type="button" aria-label={`Move step ${index + 1} down`} disabled={index === steps.length - 1} onClick={() => move(index, 1)} className="text-zinc-500 hover:underline disabled:opacity-30">Move down</button>
            <button type="button" aria-label={`Remove step ${index + 1}`} onClick={() => onChange(steps.filter((entry) => entry.id !== step.id))} className="text-rose-600 hover:underline">Remove</button>
          </div>
        </div>
        <StepFields step={step} prefix={`Step ${index + 1}`} onChange={(next) => onChange(steps.map((entry) => entry.id === step.id ? next : entry))} />
      </li>)}
    </ol>
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-0 flex-1 space-y-1 text-sm">Step to add<select aria-label="Step to add" value={addType} onChange={(e) => setAddType(e.target.value as WorkflowStepType)} className={`${FIELD} block w-full py-2`}>
        {(Object.entries(STEP_LABELS) as [WorkflowStepType, string][]).map(([type, label]) => <option key={type} value={type} disabled={type === 'protect' && hasProtection}>{label}</option>)}
      </select></label>
      <button type="button" onClick={() => onChange([...steps, newWorkflowStep(addType)])} disabled={steps.length >= MAX_WORKFLOW_STEPS || (addType === 'protect' && hasProtection)} className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium disabled:text-zinc-400 dark:border-zinc-700">Add step</button>
    </div>
    {steps.length >= MAX_WORKFLOW_STEPS && <p className="text-xs text-zinc-500">Up to {MAX_WORKFLOW_STEPS} steps per workflow.</p>}
  </div>
}

function StepFields({ step, prefix, onChange }: { step: WorkflowStep; prefix: string; onChange: (step: WorkflowStep) => void }) {
  if (step.type === 'compress') return <label className="block space-y-1 text-sm">Compression<select aria-label={`${prefix} compression`} value={step.level} onChange={(e) => onChange({ ...step, level: e.target.value as typeof step.level })} className={`${FIELD} block w-full py-2`}>
    <option value="light">Light · compact the PDF without changing images</option><option value="balanced">Balanced · smaller images and file size</option><option value="strong">Strong · smallest images and file size</option>
  </select></label>
  if (step.type === 'protect') return <p className="text-sm text-zinc-500">Use the opening password entered below for this run. Passwords are never saved in the preset.</p>
  return <div className="space-y-3">
    {step.type === 'watermark' ? <>
      <label className="block space-y-1 text-sm">Watermark text<input aria-label={`${prefix} watermark text`} value={step.settings.text} onChange={(e) => onChange({ ...step, settings: { ...step.settings, text: e.target.value } })} placeholder="DRAFT" className={`${FIELD} block w-full px-3 py-2`} /></label>
      <label className="block space-y-1 text-sm">Opacity ({Math.round(step.settings.opacity * 100)}%)<input type="range" aria-label={`${prefix} watermark opacity`} min={1} max={100} value={step.settings.opacity * 100} onChange={(e) => onChange({ ...step, settings: { ...step.settings, opacity: Number(e.target.value) / 100 } })} className="block w-full accent-rose-600" /></label>
    </> : <>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">Number format<select aria-label={`${prefix} number format`} value={step.settings.format} onChange={(e) => onChange({ ...step, settings: { ...step.settings, format: e.target.value as typeof step.settings.format } })} className={`${FIELD} block w-full py-2`}>
          {NUMBER_FORMATS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <Numeric label="Start number" ariaLabel={`${prefix} start number`} value={step.settings.start} min={1} max={1_000_000} onChange={(start) => onChange({ ...step, settings: { ...step.settings, start } })} />
        <label className="space-y-1 text-sm">Number using<select aria-label={`${prefix} numbering mode`} value={step.settings.mode} onChange={(e) => onChange({ ...step, settings: { ...step.settings, mode: e.target.value as typeof step.settings.mode } })} className={`${FIELD} block w-full py-2`}>
          <option value="document">Document page order</option><option value="selected">Selected pages in order</option>
        </select></label>
      </div>
      <p className="text-xs text-zinc-500">Numbering restarts for each PDF.</p>
    </>}
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1 text-sm">Apply to<select aria-label={`${prefix} pages`} value={step.pages === 'all' ? 'all' : 'ranges'} onChange={(e) => onChange({ ...step, pages: e.target.value === 'all' ? 'all' : '1-' })} className={`${FIELD} block w-full py-2`}>
        <option value="all">All pages in each PDF</option><option value="ranges">Page ranges</option>
      </select></label>
      {step.pages !== 'all' && <label className="space-y-1 text-sm">Page ranges<input aria-label={`${prefix} page ranges`} value={step.pages} onChange={(e) => onChange({ ...step, pages: e.target.value })} placeholder="e.g. 1-3, 5, 8-" autoComplete="off" spellCheck={false} className={`${FIELD} block w-full px-3 py-2 font-mono`} /></label>}
    </div>
    <details className="rounded border border-zinc-200 px-3 py-2 dark:border-zinc-700">
      <summary className="cursor-pointer text-sm text-zinc-600 dark:text-zinc-400">Appearance</summary>
      <div className="mt-3">
        <StyleFields value={step.settings} numbers={step.type === 'numbers'} prefix={prefix} onChange={(patch) => {
          if (step.type === 'watermark') onChange({ ...step, settings: { ...step.settings, ...patch } })
          else onChange({ ...step, settings: { ...step.settings, ...patch } })
        }} />
        {step.type === 'watermark' && <div className="mt-3"><Numeric label="Rotation (degrees)" ariaLabel={`${prefix} watermark rotation`} value={step.settings.rotation} min={-180} max={180} onChange={(rotation) => onChange({ ...step, settings: { ...step.settings, rotation } })} /></div>}
      </div>
    </details>
  </div>
}

function Numeric({ label, ariaLabel, value, min, max, onChange }: { label: string; ariaLabel: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return <label className="block space-y-1 text-sm">{label}<input aria-label={ariaLabel} type="number" min={min} max={max} step={1} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.valueAsNumber)} className={`${FIELD} block w-full px-2 py-2`} /></label>
}

function StyleFields({ value, numbers, prefix, onChange }: { value: StampStyle; numbers: boolean; prefix: string; onChange: (patch: Partial<StampStyle>) => void }) {
  const positions = STAMP_POSITIONS.filter(([position]) => !numbers || position.startsWith('top-') || position.startsWith('bottom-'))
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
    <label className="space-y-1 text-sm">Position<select aria-label={`${prefix} position`} value={value.position} onChange={(e) => onChange({ position: e.target.value as StampStyle['position'] })} className={`${FIELD} block w-full py-2`}>{positions.map(([position, label]) => <option key={position} value={position}>{label}</option>)}</select></label>
    <label className="space-y-1 text-sm">Font<select aria-label={`${prefix} font`} value={value.family} onChange={(e) => onChange({ family: e.target.value as StampStyle['family'] })} className={`${FIELD} block w-full py-2`}><option value="sans">Sans</option><option value="serif">Serif</option><option value="mono">Mono</option></select></label>
    <Numeric label="Font size (pt)" ariaLabel={`${prefix} font size`} value={value.size} min={6} max={numbers ? 72 : 200} onChange={(size) => onChange({ size })} />
    <Numeric label="Margin (pt)" ariaLabel={`${prefix} margin`} value={value.margin} min={0} max={144} onChange={(margin) => onChange({ margin })} />
    <label className="space-y-1 text-sm">Color<input aria-label={`${prefix} color`} type="color" value={value.color} onChange={(e) => onChange({ color: e.target.value })} className={`${FIELD} block h-10 w-full`} /></label>
  </div>
}
