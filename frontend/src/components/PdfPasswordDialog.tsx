import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { currentPasswordPrompt, subscribePasswordPrompt, type PasswordPrompt } from '../lib/passwords'
import { Button, ErrorMessage, FIELD } from './ui'

export function PdfPasswordDialog() {
  const prompt = useSyncExternalStore(subscribePasswordPrompt, currentPasswordPrompt)
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (prompt && !element.open) element.showModal()
    else if (!prompt && element.open) element.close()
    if (prompt) element.querySelector('input')?.focus()
  }, [prompt])

  return (
    <dialog ref={dialog} aria-labelledby="pdf-password-title" aria-describedby="pdf-password-description" onCancel={(event) => {
      event.preventDefault()
      prompt?.cancel()
    }} className="m-auto w-[calc(100%_-_2rem)] max-w-md rounded-xl border border-zinc-200 bg-white p-6 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
      {prompt && <PasswordForm key={prompt.id} prompt={prompt} />}
    </dialog>
  )
}

function PasswordForm({ prompt }: { prompt: PasswordPrompt }) {
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  return (
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); prompt.submit(password) }}>
      <div>
        <h2 id="pdf-password-title" className="text-lg font-semibold">Open protected PDF</h2>
        <p id="pdf-password-description" className="mt-1 break-words text-sm text-zinc-500">Enter the password for {prompt.filename}.</p>
      </div>
      {prompt.incorrect && <ErrorMessage>That password didn’t work. Try again.</ErrorMessage>}
      <div>
        <label htmlFor="pdf-open-password" className="mb-1 block text-sm font-medium">PDF password</label>
        <input id="pdf-open-password" type={visible ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" className={`${FIELD} w-full px-3 py-2`} />
        <label className="mt-2 flex items-center gap-2 text-sm text-zinc-500">
          <input type="checkbox" checked={visible} onChange={(event) => setVisible(event.target.checked)} className="accent-rose-600" /> Show password
        </label>
      </div>
      <p className="text-sm text-zinc-500">Used only for files open in this session.</p>
      <div className="flex items-center gap-3">
        <button type="button" onClick={prompt.cancel} className="rounded-lg border border-zinc-300 px-4 py-2.5 text-sm dark:border-zinc-700">Cancel</button>
        <Button type="submit" disabled={!password}>Open PDF</Button>
      </div>
    </form>
  )
}
