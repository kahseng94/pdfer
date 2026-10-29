import { Zip, ZipPassThrough } from 'fflate'
import { compressPdf, protectPdf, stampPdf } from './api'
import { passwordProblem, pdfPassword, rememberPdfPassword } from './passwords'
import { uniquePdfName } from './pdfCompression'
import { stampProblem, type StampSettings } from './stamps'
import { normalizeWorkflowSteps, STEP_LABELS, type WorkflowStep } from './workflowPresets'

export type WorkflowInput = { file: File; pageCount: number }
export type WorkflowOutput = { file: File; sourceName: string; before: number; after: number }
export type WorkflowBatch = { file: File; outputs: WorkflowOutput[] }
export type WorkflowProgress = {
  fileIndex: number; filename: string; stepIndex: number; stepLabel: string
  completed: number; total: number; completedFiles: number
}
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024

export class WorkflowRunError extends Error {
  readonly fileIndex: number
  readonly stepIndex: number
  constructor(fileIndex: number, stepIndex: number, filename: string, step: string, reason: unknown) {
    super(`${filename} · ${step}: ${reason instanceof Error ? reason.message : 'Something went wrong.'}`)
    this.fileIndex = fileIndex
    this.stepIndex = stepIndex
  }
}

function stampSettings(step: Extract<WorkflowStep, { type: 'watermark' | 'numbers' }>, total: number): StampSettings {
  return {
    pages: step.pages === 'all' ? `1-${total}` : step.pages,
    numbers: step.type === 'numbers' ? step.settings : null,
    watermark: step.type === 'watermark' ? step.settings : null,
  }
}

export function workflowInputProblem(inputs: readonly WorkflowInput[], steps: readonly WorkflowStep[]): WorkflowRunError | null {
  for (const [index, input] of inputs.entries()) {
    if (!Number.isInteger(input.pageCount) || input.pageCount < 1) return new WorkflowRunError(index, 0, input.file.name, 'Open PDF', new Error('The page count could not be read.'))
    for (const [stepIndex, step] of steps.entries()) {
      if (step.type !== 'watermark' && step.type !== 'numbers') continue
      const problem = stampProblem(stampSettings(step, input.pageCount), input.pageCount)
      if (problem) return new WorkflowRunError(index, stepIndex, input.file.name, STEP_LABELS[step.type], new Error(problem))
    }
  }
  return null
}

/** Every file runs through every step in order. Only complete batches are returned. */
export async function runWorkflow(inputs: readonly WorkflowInput[], draft: readonly WorkflowStep[], options: {
  name: string
  password: string
  signal: AbortSignal
  onProgress?: (progress: WorkflowProgress) => void
}): Promise<WorkflowBatch> {
  const { signal, password, onProgress } = options
  signal.throwIfAborted()
  if (!inputs.length) throw new Error('Choose at least one PDF to process.')
  if (inputs.length > 65_535) throw new Error('Choose fewer PDFs for one batch.')
  const steps = normalizeWorkflowSteps(draft)
  if (steps.some((step) => step.type === 'protect')) {
    const problem = passwordProblem(password)
    if (problem) throw new Error(problem)
  }
  const inputProblem = workflowInputProblem(inputs, steps)
  if (inputProblem) throw inputProblem
  const outputs: WorkflowOutput[] = []
  const used = new Set<string>()
  const chunks: BlobPart[] = []
  let outputBytes = 0, archiveBytes = 0
  let zipError: Error | null = null
  const zip = inputs.length > 1 ? new Zip((error, data) => {
    if (error) zipError = error
    else if (!zipError) {
      archiveBytes += data.byteLength
      if (archiveBytes > MAX_OUTPUT_BYTES) zipError = new Error('These results are too large for one ZIP. Run fewer PDFs at a time.')
      else chunks.push(new Uint8Array(data))
    }
  }) : null

  try {
    for (const [fileIndex, input] of inputs.entries()) {
      let current = input.file
      for (const [stepIndex, step] of steps.entries()) {
        signal.throwIfAborted()
        const progress = { fileIndex, filename: input.file.name, stepIndex, stepLabel: STEP_LABELS[step.type], completed: fileIndex * steps.length + stepIndex, total: inputs.length * steps.length, completedFiles: fileIndex }
        onProgress?.(progress)
        signal.throwIfAborted()
        try {
          switch (step.type) {
            case 'watermark': case 'numbers': current = await stampPdf(current, stampSettings(step, input.pageCount), signal); break
            case 'compress': current = (await compressPdf(current, step.level, signal)).file; break
            case 'protect': current = await protectPdf(current, password, signal); break
          }
          signal.throwIfAborted()
          if (current.type !== 'application/pdf') throw new Error('The operation did not return a PDF.')
        } catch (error) {
          signal.throwIfAborted()
          throw new WorkflowRunError(fileIndex, stepIndex, input.file.name, STEP_LABELS[step.type], error)
        }
        onProgress?.({ ...progress, completed: progress.completed + 1, completedFiles: stepIndex === steps.length - 1 ? fileIndex + 1 : fileIndex })
      }
      signal.throwIfAborted()
      outputBytes += current.size
      if (outputBytes > MAX_OUTPUT_BYTES) throw new Error('These results are too large for one batch. Run fewer PDFs at a time.')
      const name = uniquePdfName(`${input.file.name.replace(/\.pdf$/i, '')}_processed.pdf`, used)
      const file = new File([current], name, { type: 'application/pdf' })
      rememberPdfPassword(file, pdfPassword(current))
      outputs.push({ file, sourceName: input.file.name, before: input.file.size, after: file.size })
      if (zip) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        signal.throwIfAborted()
        const entry = new ZipPassThrough(name)
        zip.add(entry)
        entry.push(bytes, true)
        if (zipError) throw zipError
      }
    }
    signal.throwIfAborted()
    if (!zip) return { file: outputs[0].file, outputs }
    zip.end()
    if (zipError) throw zipError
    const archiveName = uniquePdfName(options.name.trim() || 'workflow', new Set()).replace(/\.pdf$/i, '_results.zip')
    return { file: new File(chunks, archiveName, { type: 'application/zip' }), outputs }
  } finally {
    zip?.terminate()
  }
}
