// pdf.js renders previews and image exports; PDF rewriting happens in the backend.
import { getDocument, GlobalWorkerOptions, PasswordResponses, PDFWorker, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { pdfPassword, rememberPdfPassword, requestPdfPassword } from './passwords'

GlobalWorkerOptions.workerSrc = workerUrl

export type { PDFDocumentProxy, RenderTask }

// One worker for every document; otherwise pdf.js starts a new one per file.
let worker: PDFWorker | undefined

export async function loadPdf(file: File, signal?: AbortSignal): Promise<PDFDocumentProxy> {
  // pdf.js takes ownership of the buffer, so give it a fresh copy each time.
  const data = new Uint8Array(await file.arrayBuffer())
  signal?.throwIfAborted()
  worker ??= new PDFWorker()
  let password = pdfPassword(file)
  const task = getDocument({ data, worker, password })
  const prompting = new AbortController()
  let rejectCancellation: (reason: Error) => void = () => {}
  let cancelled = false
  const cancellationError = new Error('Opening this PDF was cancelled. Choose the file again to retry.')
  const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject })
  function cancel() {
    if (cancelled) return
    cancelled = true
    prompting.abort()
    void task.destroy()
    rejectCancellation(cancellationError)
  }
  signal?.addEventListener('abort', cancel, { once: true })
  task.onPassword = (updatePassword: (password: string) => void, reason: number) => {
    if (prompting.signal.aborted) return
    rememberPdfPassword(file, '')
    requestPdfPassword(file.name, reason === PasswordResponses.INCORRECT_PASSWORD, prompting.signal).then(
      (entered) => {
        if (cancelled) return
        password = entered
        updatePassword(entered)
      },
      cancel,
    )
  }
  try {
    const doc = await Promise.race([task.promise, cancellation])
    rememberPdfPassword(file, password)
    return doc
  } catch {
    void task.destroy()
    if (cancelled) throw cancellationError
    throw new Error(`${file.name} isn't a valid PDF.`)
  } finally {
    signal?.removeEventListener('abort', cancel)
    prompting.abort()
  }
}

/** Release a document's worker resources. */
export function closePdf(doc: PDFDocumentProxy | null | undefined) {
  doc?.loadingTask.destroy()
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
