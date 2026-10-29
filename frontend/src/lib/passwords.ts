// Passwords belong to File objects in this session. Nothing is persisted in
// browser storage, URLs or filenames; discarded files can be garbage-collected.
const passwords = new WeakMap<File, string>()

export function pdfPassword(file: File): string {
  return passwords.get(file) ?? ''
}

export function rememberPdfPassword(file: File, password: string) {
  if (password) passwords.set(file, password)
  else passwords.delete(file)
}

export function passwordProblem(password: string): string | null {
  if (!password) return 'Enter a password for the protected copy.'
  if (password.includes('\0')) return 'Passwords cannot contain a null character.'
  if (new TextEncoder().encode(password).length > 127) return 'Use a password of at most 127 UTF-8 bytes.'
  return null
}

export type PasswordPrompt = {
  id: number
  filename: string
  incorrect: boolean
  submit: (password: string) => void
  cancel: () => void
}

let nextId = 0
let queue: PasswordPrompt[] = []
const listeners = new Set<() => void>()

export function currentPasswordPrompt(): PasswordPrompt | null {
  return queue[0] ?? null
}

export function subscribePasswordPrompt(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Queue concurrent requests (for example, several protected files in Merge). */
export function requestPdfPassword(filename: string, incorrect: boolean, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let settled = false
    function finish(password?: string) {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', cancel)
      queue = queue.filter((item) => item !== prompt)
      for (const listener of listeners) listener()
      if (password === undefined) reject(new DOMException('Password entry cancelled.', 'AbortError'))
      else resolve(password)
    }
    const cancel = () => finish()
    const prompt: PasswordPrompt = { id: ++nextId, filename, incorrect, submit: finish, cancel }
    signal.addEventListener('abort', cancel, { once: true })
    queue = [...queue, prompt]
    for (const listener of listeners) listener()
  })
}
