import type { KeyboardEvent } from 'react'
import { TOOLS, type ToolId } from '../lib/tools'
import { LogoIcon } from './icons'

// Keep the existing tool order in both navigation layouts and result handoffs.
const GROUPS = [
  { label: 'Pages & document', tools: TOOLS.slice(0, 5) },
  { label: 'Read & compare', tools: TOOLS.slice(5, 8) },
  { label: 'Edit & annotate', tools: TOOLS.slice(8, 13) },
  { label: 'Export & finish', tools: TOOLS.slice(13) },
]


const TOOL_PATHS: Record<ToolId, string> = {
  merge: 'M5 3v5l7 5 7-5V3M12 13v8m-4-4 4 4 4-4',
  split: 'M12 21v-8L5 8V3m0 0L2 6m3-3 3 3m4 7 7-5V3m0 0-3 3m3-3 3 3',
  organize: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  bookmarks: 'M6 3h12v18l-6-4-6 4V3Z',
  metadata: 'M14 2H5v20h14V7l-5-5Zm0 0v5h5M9 12h6m-6 4h6',
  text: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6M7 8h6m-6 4h4',
  compare: 'M3 4h7v16H3zM14 4h7v16h-7zM6 8h1m-1 4h1m10-4h1m-1 4h1',
  ocr: 'M3 8V3h5m8 0h5v5m0 8v5h-5m-8 0H3v-5M8 8h8m-4 0v9m-3 0h6',
  edit: 'm16 3 5 5L8 21H3v-5L16 3Zm-3 3 5 5',
  forms: 'M4 3h16v18H4zM8 7h8m-8 5h2m4 0h2m-8 5h8',
  redact: 'M4 3h16v18H4zM8 7h8M7 11h10v4H7zM8 18h5',
  signatures: 'M3 20h18M5 16 17 4l3 3L8 19H5v-3ZM3 12c3-6 7-5 4-1s2 3 4 1',
  stamps: 'M5 21h14M4 17h16v-4l-5-2V6a3 3 0 0 0-6 0v5l-5 2v4Z',
  compress: 'M8 3v5H3m5 0L2 2m14 19v-5h5m-5 0 6 6M16 3h5v5M3 16v5h5',
  'pdf-images': 'M14 2H4v20h16V8l-6-6Zm0 0v6h6M7 18l3-4 3 3 2-2 2 3M8 10h.01',
  passwords: 'M5 10h14v11H5zM8 10V6a4 4 0 0 1 8 0v4m-4 5v2',
  workflows: 'M3 3h6v6H3zM15 15h6v6h-6zM9 6h9v9m-3-3 3 3 3-3',
  images: 'M3 3h18v18H3zM3 16l6-6 5 5 3-3 4 4M16 7h.01',
  photo: 'M4 4h16v16H4zM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm-5 13v-2a5 5 0 0 1 10 0v2',
}

function ToolIcon({ tool }: { tool: ToolId }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={TOOL_PATHS[tool]} /></svg>
}

export function LocalFilesNote() {
  return <span className="local-files-note"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 8 3v5c0 5-4 8-8 10-4-2-8-5-8-10V6l8-3Z" /><path d="m8 12 3 3 5-6" /></svg><span>Files stay on your computer</span></span>
}


export function ToolNavigation({ selected, onSelect }: { selected: ToolId; onSelect: (tool: ToolId) => void }) {
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const index = TOOLS.findIndex((tool) => tool.id === selected)
    const next = event.key === 'ArrowDown' ? (index + 1) % TOOLS.length
      : event.key === 'ArrowUp' ? (index + TOOLS.length - 1) % TOOLS.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? TOOLS.length - 1 : null
    if (next === null) return
    event.preventDefault()
    const id = TOOLS[next].id
    onSelect(id)
    document.getElementById(`tab-${id}`)?.focus()
  }

  return <>
    <aside className="tool-sidebar" aria-label="PDF tools">
      <div className="app-brand"><LogoIcon className="brand-mark" /><div><span className="brand-name">pdfer</span><p>Local PDF tools</p></div></div>
      <div className="tool-navigation" role="tablist" aria-label="Tool" aria-orientation="vertical" onKeyDown={navigate}>
        {GROUPS.map((group) => <div className="tool-group" role="presentation" key={group.label}>
          <p className="tool-group-label" aria-hidden="true">{group.label}</p>
          {group.tools.map((tool) => <button
            key={tool.id}
            type="button"
            role="tab"
            id={`tab-${tool.id}`}
            aria-selected={selected === tool.id}
            aria-controls={`panel-${tool.id}`}
            tabIndex={selected === tool.id ? 0 : -1}
            onClick={() => onSelect(tool.id)}
            className="tool-tab"
          ><ToolIcon tool={tool.id} /><span>{tool.label}</span></button>)}
        </div>)}
      </div>
      <div className="sidebar-footer"><LocalFilesNote /></div>
    </aside>
    <header className="mobile-navigation">
      <div className="mobile-brand"><LogoIcon className="brand-mark" /><span className="brand-name">pdfer</span><span className="mobile-local">Local PDF tools</span></div>
      <label className="mobile-tool-picker" htmlFor="tool-picker"><span>Tool</span><select id="tool-picker" value={selected} onChange={(event) => onSelect(event.target.value as ToolId)}>
        {GROUPS.map((group) => <optgroup key={group.label} label={group.label}>{group.tools.map((tool) => <option key={tool.id} value={tool.id}>{tool.label}</option>)}</optgroup>)}
      </select></label>
    </header>
  </>
}
