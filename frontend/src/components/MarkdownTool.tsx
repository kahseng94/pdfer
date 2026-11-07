import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { saveFile } from '../lib/api'
import { pickFiles } from '../lib/files'
import { useReceive } from '../lib/handoff'
import {
  applyEdit, continueList, decodeText, insertLink, insertTable, loadDraft, loadMode, markdownName, MAX_MARKDOWN_BYTES, renderMarkdown,
  saveDraft, saveMode, taskMarkers, toggleCode, toggleLines, toggleTask, toggleWrap, type Edit, type MarkdownMode,
} from '../lib/markdown'
import { useWindowDrop } from '../lib/windowDrop'
import { Dropzone } from './Dropzone'
import { Button, DropOverlay, ErrorMessage, FIELD, IconButton } from './ui'

type Doc = {
  name: string
  text: string
  /** The text as last opened or downloaded; null when it has never been saved. */
  saved: string | null
  /** Saved back with Windows line endings when it was opened with them. */
  crlf: boolean
  encoding: string
}

const MODES: { value: MarkdownMode; label: string }[] = [
  { value: 'write', label: 'Write' },
  { value: 'split', label: 'Split' },
  { value: 'preview', label: 'Preview' },
]
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'

function Glyph({ d }: { d: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-4"><path d={d} /></svg>
}

function restore(): Doc | null {
  const draft = loadDraft()
  return draft && { name: draft.name, text: draft.text, saved: draft.edited ? null : draft.text, crlf: draft.crlf, encoding: 'UTF-8' }
}

/** Write Markdown or open a .md file, with a formatted preview as you type. */
export function MarkdownTool({ active = true }: { active?: boolean }) {
  const [doc, setDoc] = useState<Doc | null>(restore)
  const [notice, setNotice] = useState<string | null>(() => (doc ? `Reopened ${doc.name} from your last session.` : null))
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<MarkdownMode>(loadMode)
  // Something that would close the document, waiting for a decision about unsaved changes.
  const [pending, setPending] = useState<{ what: string; run: () => void } | null>(null)
  const [printing, setPrinting] = useState(0)
  const editor = useRef<HTMLTextAreaElement>(null)
  const preview = useRef<HTMLDivElement>(null)

  const text = doc?.text ?? ''
  const dirty = !!doc && doc.saved !== doc.text
  // Rendering waits while typing quickly, so long documents stay responsive.
  const shown = useDeferredValue(text)
  const open = doc !== null
  const rendered = useMemo(() => (open ? renderMarkdown(shown) : null), [shown, open])
  const markers = useMemo(() => taskMarkers(shown), [shown])

  // Keep the document between sessions, in this browser only.
  useEffect(() => {
    const timer = setTimeout(() => saveDraft(doc && { name: doc.name, text: doc.text, edited: doc.saved !== doc.text, crlf: doc.crlf }), 300)
    return () => clearTimeout(timer)
  }, [doc])

  useEffect(() => {
    if (!printing) return
    const done = () => setPrinting(0)
    const root = document.documentElement
    root.classList.add('printing-markdown')
    window.addEventListener('afterprint', done)
    // Let the print copy render before the print dialog opens.
    const timer = setTimeout(() => {
      try { window.print() } catch { done() }
    }, 50)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('afterprint', done)
      root.classList.remove('printing-markdown')
    }
  }, [printing])

  function guard(what: string, run: () => void) {
    if (dirty) setPending({ what, run })
    else run()
  }

  function begin(next: Doc) {
    setPending(null)
    setError(null)
    setDoc(next)
  }

  async function read(file: File) {
    setPending(null)
    if (file.size > MAX_MARKDOWN_BYTES) { setError('Choose a Markdown file of 5 MB or smaller.'); return }
    try {
      const { text: raw, encoding } = decodeText(await file.arrayBuffer())
      const content = raw.replace(/\r\n?/g, '\n')
      begin({ name: file.name, text: content, saved: content, crlf: raw.includes('\r\n'), encoding })
      setNotice(encoding === 'UTF-8' ? null : `Read as ${encoding} text. Downloads are saved as UTF-8.`)
    } catch {
      setError('This file could not be read. Check that it still exists and try again.')
    }
  }

  function take(files: File[]) {
    const { wanted, skipped } = pickFiles(files, 'markdown')
    if (!wanted.length) {
      if (skipped) setNotice('Choose a Markdown file (.md or .markdown).')
      return
    }
    setNotice(wanted.length > 1 ? 'One document is open at a time. Only the first one was opened.' : null)
    guard(`open ${wanted[0].name}`, () => void read(wanted[0]))
  }
  const dragging = useWindowDrop(take, active)
  useReceive('markdown', take)

  function startNew() {
    guard('start a new document', () => {
      begin({ name: 'Untitled.md', text: '', saved: '', crlf: false, encoding: 'UTF-8' })
      setNotice(null)
      if (mode === 'preview') choose('split')
      setTimeout(() => editor.current?.focus(), 0)
    })
  }

  function choose(next: MarkdownMode) {
    setMode(next)
    saveMode(next)
  }

  function setText(next: string) {
    setDoc((current) => current && { ...current, text: next })
  }

  function download() {
    if (!doc) return
    const name = markdownName(doc.name)
    saveFile(new File([doc.crlf ? doc.text.replace(/\n/g, '\r\n') : doc.text], name, { type: 'text/markdown' }))
    setDoc({ ...doc, name, saved: doc.text })
  }

  /** Make an edit through the browser, so Undo and Redo include it. */
  function apply(edit: Edit) {
    const area = editor.current
    if (!area) return
    area.focus()
    area.setSelectionRange(edit.from, edit.to)
    let done = false
    try {
      done = edit.insert
        ? document.execCommand('insertText', false, edit.insert)
        : edit.from === edit.to || document.execCommand('delete')
    } catch {
      done = false
    }
    if (!done || area.value !== applyEdit(text, edit)) {
      area.setRangeText(edit.insert, edit.from, edit.to, 'end')
      setText(area.value)
    }
    area.setSelectionRange(...edit.select)
  }

  function act(make: (value: string, start: number, end: number) => Edit) {
    const area = editor.current
    if (!area) return
    apply(make(area.value, area.selectionStart, area.selectionEnd))
  }

  const actions: { label: string; keys?: string; icon: ReactNode; run: () => void }[] = [
    { label: 'Bold', keys: 'B', icon: <span className="text-sm font-bold">B</span>, run: () => act((v, s, e) => toggleWrap(v, s, e, '**', 'bold text')) },
    { label: 'Italic', keys: 'I', icon: <span className="font-serif text-sm italic">I</span>, run: () => act((v, s, e) => toggleWrap(v, s, e, '_', 'italic text')) },
    { label: 'Strikethrough', icon: <span className="text-sm line-through">S</span>, run: () => act((v, s, e) => toggleWrap(v, s, e, '~~', 'text')) },
    { label: 'Heading', icon: <span className="text-sm font-semibold">H</span>, run: () => act((v, s, e) => toggleLines(v, s, e, 'heading')) },
    { label: 'Link', keys: 'K', icon: <Glyph d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1m-2 7.4-1 1a4 4 0 0 1-5.7-5.7l3-3a4 4 0 0 1 5.7 0" />, run: () => act(insertLink) },
    { label: 'Bulleted list', icon: <Glyph d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />, run: () => act((v, s, e) => toggleLines(v, s, e, 'bullet')) },
    { label: 'Numbered list', icon: <Glyph d="M10 6h10M10 12h10M10 18h10M4 5l1-1v4M4 14h2l-2 3h2" />, run: () => act((v, s, e) => toggleLines(v, s, e, 'number')) },
    { label: 'Task list', icon: <Glyph d="M4 5h4v4H4zM4 15h4v4H4zM12 7h8M12 17h8M5 17l1 1 2-2" />, run: () => act((v, s, e) => toggleLines(v, s, e, 'task')) },
    { label: 'Quote', icon: <Glyph d="M6 7h4v5H6c0 3 1 4 3 5M14 7h4v5h-4c0 3 1 4 3 5" />, run: () => act((v, s, e) => toggleLines(v, s, e, 'quote')) },
    { label: 'Code', keys: 'E', icon: <Glyph d="m8 8-4 4 4 4m8-8 4 4-4 4" />, run: () => act(toggleCode) },
    { label: 'Table', icon: <Glyph d="M3 5h18v14H3zM3 10h18M3 15h18M10 5v14" />, run: () => act((v, s) => insertTable(v, s)) },
  ]

  function keys(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const area = event.currentTarget
      if (area.selectionStart !== area.selectionEnd) return
      const edit = continueList(area.value, area.selectionStart)
      if (edit) { event.preventDefault(); apply(edit) }
      return
    }
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
    const key = event.key.toUpperCase()
    if (key === 'S') { event.preventDefault(); download(); return }
    const action = actions.find((item) => item.keys === key)
    if (action) { event.preventDefault(); action.run() }
  }

  function syncScroll() {
    const area = editor.current, view = preview.current
    if (mode !== 'split' || !area || !view) return
    const range = area.scrollHeight - area.clientHeight
    view.scrollTop = range > 0 ? (area.scrollTop / range) * (view.scrollHeight - view.clientHeight) : 0
  }

  function previewClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement
    const box = target.closest<HTMLInputElement>('input[data-task]')
    if (box) {
      event.preventDefault()
      const position = markers[Number(box.dataset.task)]
      // Ticking edits the source, so it only happens when the preview is up to date and matches it.
      if (position !== undefined && shown === text && rendered?.tasks === markers.length) setText(toggleTask(text, position))
      return
    }
    const link = target.closest('a')
    if (!link) return
    const href = link.getAttribute('href') ?? ''
    if (href.startsWith('#')) {
      event.preventDefault()
      const anchor = decodeURIComponent(href.slice(1))
      const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(anchor) : anchor.replace(/["\\]/g, '\\$&')
      preview.current?.querySelector(`[data-anchor="${escaped}"]`)?.scrollIntoView({ block: 'start' })
    } else if (link.hasAttribute('data-unavailable')) {
      event.preventDefault()
    }
  }

  const overlay = dragging && <DropOverlay label="Drop a Markdown file to open" />
  const confirm = pending && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
    <p className="min-w-0 flex-1">{doc?.name} has changes that haven’t been downloaded. Discard them and {pending.what}?</p>
    <button type="button" onClick={() => { download(); pending.run() }} className="rounded-md border border-amber-300 px-2.5 py-1 font-medium dark:border-amber-800">Download, then continue</button>
    <button type="button" onClick={pending.run} className="rounded-md bg-amber-700 px-2.5 py-1 font-medium text-white dark:bg-amber-600">Discard changes</button>
    <button type="button" onClick={() => setPending(null)} className="px-1 font-medium">Cancel</button>
  </div>

  if (!doc) {
    return <div className="space-y-3">
      {overlay}
      <Dropzone kind="markdown" title="Open a Markdown file" onFiles={take} onSkipped={take} />
      <div className="flex items-center gap-3 text-sm text-zinc-500">
        <span>or</span>
        <button type="button" onClick={startNew} className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">Start a new document</button>
      </div>
      {notice && <p role="status" className="text-sm text-zinc-500">{notice}</p>}
      {error && <ErrorMessage>{error}</ErrorMessage>}
    </div>
  }

  const lines = text ? text.split('\n').length : 0
  const editorPane = <textarea
    ref={editor}
    aria-label="Markdown source"
    value={text}
    onChange={(event) => setText(event.target.value)}
    onKeyDown={keys}
    onScroll={syncScroll}
    spellCheck
    placeholder={'# Title\n\nWrite in **Markdown** here.'}
    className="markdown-editor h-full min-h-0 w-full resize-none rounded-lg border border-zinc-200 bg-white p-3 font-mono text-[13px] leading-relaxed text-zinc-900 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
  />
  const previewPane = <div
    ref={preview}
    aria-label="Formatted preview"
    role="document"
    tabIndex={0}
    onClick={previewClick}
    className="h-full min-h-0 overflow-auto rounded-lg border border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-950"
  >
    {text.trim()
      ? <div className="markdown-body" dangerouslySetInnerHTML={{ __html: rendered?.html ?? '' }} />
      : <p className="text-sm text-zinc-500">The formatted document appears here as you write.</p>}
  </div>

  return <div className="space-y-3">
    {overlay}
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
      <label className="min-w-40 flex-1">
        <span className="sr-only">File name</span>
        <input value={doc.name} onChange={(e) => setDoc({ ...doc, name: e.target.value })} onBlur={() => setDoc((d) => d && { ...d, name: markdownName(d.name) })} className={`${FIELD} w-full font-medium`} />
      </label>
      <span role="status" className="text-sm text-zinc-500">{dirty ? 'Not downloaded yet' : 'All changes downloaded'}</span>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={download} title={`Download (${MOD}S)`} className="min-h-0 w-auto px-3 py-1.5">Download</Button>
        <button type="button" onClick={() => setPrinting((n) => n + 1)} disabled={!text.trim()} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">Print or save as PDF</button>
        <button type="button" onClick={startNew} className="px-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">New</button>
        <button type="button" onClick={() => guard('close it', () => { setPending(null); setDoc(null); setNotice(null) })} className="px-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Close</button>
      </div>
    </div>
    {confirm}
    {notice && <p role="status" className="text-sm text-zinc-500">{notice}</p>}
    {error && <ErrorMessage>{error}</ErrorMessage>}

    <div className="flex flex-wrap items-center justify-between gap-2">
      <div role="toolbar" aria-label="Formatting" className={`flex flex-wrap items-center gap-0.5 ${mode === 'preview' ? 'invisible' : ''}`}>
        {actions.map((action) => <IconButton key={action.label} label={action.keys ? `${action.label} (${MOD}${action.keys})` : action.label} onClick={action.run}>{action.icon}</IconButton>)}
      </div>
      <div role="group" aria-label="View" className="flex rounded-lg border border-zinc-200 p-0.5 text-sm dark:border-zinc-800">
        {MODES.map((item) => <button key={item.value} type="button" aria-pressed={mode === item.value} onClick={() => choose(item.value)} className={`rounded-md px-3 py-1 ${mode === item.value ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'}`}>{item.label}</button>)}
      </div>
    </div>

    <div className={`grid h-[min(72vh,760px)] min-h-80 gap-3 ${mode === 'split' ? 'grid-rows-2 md:grid-cols-2 md:grid-rows-1' : ''}`}>
      {mode !== 'preview' && editorPane}
      {mode !== 'write' && previewPane}
    </div>
    <p className="text-sm text-zinc-500">
      {`${(rendered?.words ?? 0).toLocaleString('en-US')} ${rendered?.words === 1 ? 'word' : 'words'} · ${lines.toLocaleString('en-US')} ${lines === 1 ? 'line' : 'lines'}`}
      {rendered && rendered.images > 0 && ` · ${rendered.images === 1 ? '1 image is' : `${rendered.images} images are`} shown by description only; pdfer never loads pictures from the web or other files`}
    </p>
    {printing > 0 && rendered && createPortal(<div className="markdown-print-copy markdown-body" dangerouslySetInnerHTML={{ __html: rendered.html }} />, document.body)}
  </div>
}
