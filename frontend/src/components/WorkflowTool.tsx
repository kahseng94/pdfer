import { useEffect, useMemo, useRef, useState } from 'react'
import { pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import { passwordProblem, pdfPassword } from '../lib/passwords'
import { formatSize } from '../lib/pdf'
import { useResult } from '../lib/result'
import { useWindowDrop } from '../lib/windowDrop'
import { useWorkflowInputs } from '../lib/useWorkflowInputs'
import { deleteWorkflowPreset, normalizeWorkflowSteps, readWorkflowPresets, saveWorkflowPreset, starterWorkflow, STEP_LABELS, WORKFLOW_STORAGE_KEY, type WorkflowPreset, type WorkflowStep } from '../lib/workflowPresets'
import { runWorkflow, workflowInputProblem, WorkflowRunError, type WorkflowBatch, type WorkflowProgress } from '../lib/workflows'
import { Dropzone } from './Dropzone'
import { WorkflowResults } from './WorkflowResults'
import { WorkflowSteps } from './WorkflowSteps'
import { Button, DropOverlay, ErrorMessage, FIELD } from './ui'

function loadLibrary(): { presets: WorkflowPreset[]; error: string | null } {
  try { return { presets: readWorkflowPresets(), error: null } }
  catch (error) { return { presets: [], error: (error as Error).message } }
}

export function WorkflowTool({ active = true }: { active?: boolean }) {
  const [library, setLibrary] = useState(loadLibrary)
  const [selectedId, setSelectedId] = useState('')
  const [name, setName] = useState('Share protected PDFs')
  const [steps, setSteps] = useState<WorkflowStep[]>(starterWorkflow)
  const [deleted, setDeleted] = useState<WorkflowPreset | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [fileNotice, setFileNotice] = useState<string | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [progress, setProgress] = useState<WorkflowProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [failedId, setFailedId] = useState<string | null>(null)
  const pending = useRef<AbortController | null>(null)
  const validation = useMemo(() => {
    try { return { signature: JSON.stringify(normalizeWorkflowSteps(steps)), problem: null } }
    catch (reason) { return { signature: JSON.stringify(steps), problem: (reason as Error).message } }
  }, [steps])
  const inputs = useWorkflowInputs(invalidate)
  const result = useResult<WorkflowBatch>([name, validation.signature, ...inputs.items.map((item) => item.id)])
  const selected = library.presets.find((preset) => preset.id === selectedId)
  const dirty = !selected || selected.name !== name || JSON.stringify(selected.steps) !== validation.signature
  const stepProblem = validation.problem
  const needsPassword = steps.some((step) => step.type === 'protect')
  const passwordError = needsPassword ? passwordProblem(password) : null
  const mismatch = needsPassword && password !== confirmation
  const opening = inputs.items.some((item) => item.pageCount === null && !item.error)
  const unreadable = inputs.items.some((item) => item.error)
  const readyInputs = inputs.items.flatMap((item) => item.pageCount !== null && !item.error ? [{ file: item.file, pageCount: item.pageCount }] : [])
  const inputProblem = !stepProblem && !opening && !unreadable ? workflowInputProblem(readyInputs, steps) : null

  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === WORKFLOW_STORAGE_KEY || event.key === null) setLibrary(loadLibrary()) }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [])
  useEffect(() => () => { pending.current?.abort(); pending.current = null }, [])

  function clearCredentials() { setPassword(''); setConfirmation(''); setShowPassword(false) }
  function cancel() {
    if (pending.current) clearCredentials()
    pending.current?.abort()
    pending.current = null
    setBusy(false)
    setProgress(null)
  }
  function invalidate() {
    cancel()
    result.clear()
    setError(null)
    setFailedId(null)
    setCancelled(false)
  }
  function changeSteps(next: WorkflowStep[]) {
    invalidate()
    setSteps(next)
    setNotice(null)
    if (!next.some((step) => step.type === 'protect')) clearCredentials()
  }
  function choosePreset(id: string) {
    invalidate()
    clearCredentials()
    setSelectedId(id)
    setStorageError(null)
    setNotice(null)
    const preset = library.presets.find((entry) => entry.id === id)
    if (preset) { setName(preset.name); setSteps(normalizeWorkflowSteps(preset.steps)) }
  }
  function newPreset() {
    choosePreset('')
    setName('')
    setSteps([])
  }
  function save(asNew = false) {
    try {
      const preset = { id: asNew || !selected ? crypto.randomUUID() : selected.id, name, steps }
      const saved = saveWorkflowPreset(preset)
      setLibrary({ presets: saved, error: null })
      setSelectedId(preset.id)
      setName(name.trim())
      setStorageError(null)
      setNotice(`Saved “${name.trim()}” in this browser.`)
    } catch (reason) { setStorageError((reason as Error).message) }
  }
  function removePreset() {
    if (!selected) return
    try {
      setLibrary({ presets: deleteWorkflowPreset(selected.id), error: null })
      setDeleted(selected)
      setSelectedId('')
      setNotice('Preset deleted. The current steps are still available to run.')
      setStorageError(null)
    } catch (reason) { setStorageError((reason as Error).message) }
  }
  function undoDelete() {
    if (!deleted) return
    try {
      setLibrary({ presets: saveWorkflowPreset(deleted), error: null })
      setNotice(`Restored “${deleted.name}”.`)
      setDeleted(null)
      setStorageError(null)
    } catch (reason) { setStorageError((reason as Error).message) }
  }
  function take(files: File[]) {
    const { wanted, skipped } = pickFiles(files, 'pdf')
    inputs.add(wanted)
    setFileNotice(skipped ? `Skipped ${skipped} ${skipped === 1 ? 'file that is not a PDF' : 'files that are not PDFs'}.` : null)
  }
  const dragging = useWindowDrop(take, active)
  useReceive('workflows', take)

  async function run() {
    if (pending.current || !readyInputs.length || stepProblem || inputProblem || opening || unreadable || passwordError || mismatch) return
    invalidate()
    const controller = new AbortController()
    pending.current = controller
    const finish = result.begin()
    setBusy(true)
    try {
      const output = await runWorkflow(readyInputs, steps, {
        name: name || 'workflow', password, signal: controller.signal,
        onProgress: (next) => { if (pending.current === controller && !controller.signal.aborted) setProgress(next) },
      })
      if (pending.current === controller && !controller.signal.aborted) finish(output)
    } catch (reason) {
      if (pending.current === controller && !controller.signal.aborted) {
        if (reason instanceof WorkflowRunError) setFailedId(inputs.items[reason.fileIndex]?.id ?? null)
        setError(`${(reason as Error).message} No downloadable results were created.`)
      }
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false); setProgress(null); clearCredentials() }
    }
  }

  return <div className="space-y-5">
    {dragging && <DropOverlay label="Drop PDFs to run through the workflow" />}
    <fieldset disabled={busy} className="min-w-0 space-y-5 disabled:opacity-60">
      <legend className="sr-only">Workflow preset and inputs</legend>
      <div className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between gap-3"><h2 className="font-medium">Saved presets</h2><button type="button" onClick={newPreset} className="text-sm text-rose-600 hover:underline">New workflow</button></div>
        <select aria-label="Saved workflow preset" value={selected?.id ?? ''} onChange={(e) => choosePreset(e.target.value)} className={`${FIELD} w-full py-2`}>
          <option value="">Unsaved workflow</option>
          {library.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
        </select>
        <label className="block space-y-1 text-sm">Preset name<input aria-label="Workflow preset name" value={name} onChange={(e) => { invalidate(); setName(e.target.value); setNotice(null) }} maxLength={80} placeholder="e.g. Share protected PDFs" className={`${FIELD} block w-full px-3 py-2`} /></label>
        <div className="flex flex-wrap gap-3 text-sm">
          <button type="button" disabled={!name.trim() || !!stepProblem || (!dirty && !!selected)} onClick={() => save()} className="rounded border border-zinc-300 px-3 py-1.5 font-medium disabled:text-zinc-400 dark:border-zinc-700">{selected ? 'Update preset' : 'Save preset'}</button>
          {selected && <><button type="button" disabled={!name.trim() || !!stepProblem} onClick={() => save(true)} className="text-rose-600 hover:underline disabled:text-zinc-400">Save as new preset</button><button type="button" onClick={removePreset} className="text-zinc-500 hover:underline">Delete preset</button></>}
          {dirty && <span className="self-center text-xs text-zinc-500">Unsaved changes</span>}
        </div>
        <p className="text-xs text-zinc-500">Presets are saved in this browser for this app address. Files and passwords are never saved in a preset. You can also run without saving.</p>
        {(library.error || storageError) && <ErrorMessage>{storageError ?? library.error}</ErrorMessage>}
        {notice && <p role="status" className="text-sm text-zinc-500">{notice}</p>}
        {deleted && <button type="button" onClick={undoDelete} className="text-sm text-rose-600 hover:underline">Undo deletion of {deleted.name}</button>}
      </div>

      <WorkflowSteps steps={steps} onChange={changeSteps} />
      {stepProblem && <ErrorMessage>{stepProblem}</ErrorMessage>}

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3"><h2 className="font-medium">PDFs to process</h2>{inputs.items.length > 0 && <button type="button" onClick={() => { inputs.clear(); setFileNotice(null) }} className="text-sm text-zinc-500 hover:underline">Clear files</button>}</div>
        <Dropzone multiple compact={inputs.items.length > 0} title={inputs.items.length ? 'Add more PDFs' : 'Choose PDFs for this workflow'} onFiles={take} />
        {fileNotice && <p role="status" className="text-sm text-zinc-500">{fileNotice}</p>}
        <ul aria-label="Workflow input PDFs" className="max-h-80 space-y-2 overflow-y-auto">
          {inputs.items.map((item, index) => <li key={item.id} className={`flex items-center gap-3 rounded-lg border bg-white px-3 py-2 dark:bg-zinc-900 ${failedId === item.id ? 'border-red-400' : 'border-zinc-200 dark:border-zinc-800'}`}>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{item.file.name}</p>
              <p className="text-xs text-zinc-500">{formatSize(item.file.size)} · {item.error ? item.error : item.pageCount === null ? 'Opening PDF…' : `${item.pageCount} ${item.pageCount === 1 ? 'page' : 'pages'}${pdfPassword(item.file) ? ' · Password provided' : ''}`}</p>
              {progress && <p className="text-xs text-rose-600">{index < progress.completedFiles ? 'Complete' : index === progress.fileIndex ? progress.stepLabel : 'Queued'}</p>}
              {failedId === item.id && <p className="text-xs text-red-600">Workflow stopped on this file.</p>}
            </div>
            {item.error && <button type="button" onClick={() => inputs.retry(item)} className="text-xs text-rose-600 hover:underline">Retry opening</button>}
            <button type="button" aria-label={`Remove input PDF ${index + 1}`} onClick={() => inputs.remove(item.id)} className="text-xs text-zinc-500 hover:underline">Remove</button>
          </li>)}
        </ul>
      </div>

      {needsPassword && <div className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="font-medium">Password for this run</h2>
        <p className="text-sm text-zinc-500">Use the same opening password for every output PDF. Enter it again for each run; it is never saved in the preset.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">Opening password<input aria-label="Workflow output password" type={showPassword ? 'text' : 'password'} value={password} autoComplete="new-password" onChange={(e) => { invalidate(); setPassword(e.target.value) }} className={`${FIELD} block w-full px-3 py-2`} /></label>
          <label className="space-y-1 text-sm">Confirm password<input aria-label="Confirm workflow output password" type={showPassword ? 'text' : 'password'} value={confirmation} autoComplete="new-password" aria-invalid={!!confirmation && mismatch} onChange={(e) => { invalidate(); setConfirmation(e.target.value) }} className={`${FIELD} block w-full px-3 py-2`} /></label>
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-500"><input type="checkbox" checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} className="accent-rose-600" />Show passwords</label>
        {password && passwordError && <ErrorMessage>{passwordError}</ErrorMessage>}
        {confirmation && mismatch && <ErrorMessage>The passwords don’t match.</ErrorMessage>}
      </div>}
    </fieldset>

    {unreadable && <ErrorMessage>Remove or retry PDFs that could not be opened before running.</ErrorMessage>}
    {inputProblem && <ErrorMessage>{inputProblem.message}</ErrorMessage>}
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {cancelled && <p role="status" className="text-sm text-zinc-500">Workflow cancelled. No downloadable results were created.</p>}
    {busy && progress && <div className="space-y-2 rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
      <p role="status">PDF {progress.fileIndex + 1} of {inputs.items.length} · Step {progress.stepIndex + 1} of {steps.length}: {progress.stepLabel}</p>
      <p className="truncate text-zinc-500">{progress.filename}</p>
      <progress aria-label="Workflow progress" value={progress.completed} max={progress.total} className="h-2 w-full accent-rose-600" />
    </div>}
    <p className="text-sm text-zinc-500">{steps.length > 0 && `${steps.map((step) => STEP_LABELS[step.type]).join(' → ')}. `}One processed PDF per input; multiple PDFs also get a ZIP. Nothing downloads automatically.</p>
    <Button onClick={run} disabled={busy || !inputs.items.length || opening || unreadable || !!stepProblem || !!inputProblem || !!passwordError || mismatch}>
      {busy ? 'Running workflow…' : opening ? 'Opening PDFs…' : `Run workflow${inputs.items.length ? ` on ${inputs.items.length} ${inputs.items.length === 1 ? 'PDF' : 'PDFs'}` : ''}`}
    </Button>
    {busy && <button type="button" onClick={() => { cancel(); setCancelled(true) }} className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">Cancel workflow</button>}
    {result.value && <WorkflowResults batch={result.value} onDismiss={result.clear} />}
  </div>
}
