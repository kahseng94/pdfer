import { useState } from 'react'
import { HandoffContext, type Delivery } from './lib/handoff'
import { loadTool, saveTool } from './lib/lastTool'
import { TOOL_IDS, TOOLS, type ToolId } from './lib/tools'
import { CompressTool } from './components/CompressTool'
import { EditTool } from './components/EditTool'
import { LogoIcon } from './components/icons'
import { ImagesTool } from './components/ImagesTool'
import { MergeTool } from './components/MergeTool'
import { OrganizeTool } from './components/OrganizeTool'
import { PdfImagesTool } from './components/PdfImagesTool'
import { PasswordTool } from './components/PasswordTool'
import { PdfPasswordDialog } from './components/PdfPasswordDialog'
import { PhotoTool } from './components/PhotoTool'
import { SplitTool } from './components/SplitTool'
import { StampTool } from './components/StampTool'
import { SignatureTool } from './components/SignatureTool'
import { TextTool } from './components/TextTool'
import { WorkflowTool } from './components/WorkflowTool'
import { BookmarksTool } from './components/BookmarksTool'
import { FormsTool } from './components/FormsTool'
import { RedactTool } from './components/RedactTool'

export default function App() {
  const [tool, setTool] = useState<ToolId>(() => loadTool(TOOL_IDS, 'merge'))
  const [delivery, setDelivery] = useState<Delivery | null>(null)

  function select(id: ToolId) {
    setTool(id)
    saveTool(id)
  }

  function send(to: ToolId, file: File) {
    setDelivery((prev) => ({ to, file, id: (prev?.id ?? 0) + 1 }))
    select(to)
    window.scrollTo({ top: 0 })
    // The button pressed is in the tab being hidden, so keyboard focus moves to the new tab.
    document.getElementById(`tab-${to}`)?.focus()
  }

  return (
    <HandoffContext value={{ delivery, send }}>
      <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
          <header className="mb-8 flex items-center gap-3">
            <LogoIcon className="size-9" />
            <div>
              <h1 className="text-xl font-semibold tracking-tight">pdfer</h1>
              <p className="text-sm text-zinc-500">Merge, split, organize, search, edit, compress and protect PDFs, convert between PDFs and images, or crop a passport photo, on your own computer.</p>
            </div>
          </header>

          <div role="tablist" aria-label="Tool" className="mb-6 inline-flex flex-wrap rounded-lg bg-zinc-200/70 p-1 dark:bg-zinc-800/70">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={tool === t.id}
                aria-controls={`panel-${t.id}`}
                onClick={() => select(t.id)}
                className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                  tool === t.id
                    ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100'
                    : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* All tools stay mounted so switching tabs keeps your files. */}
          <section id="panel-merge" role="tabpanel" aria-labelledby="tab-merge" hidden={tool !== 'merge'}>
            <MergeTool active={tool === 'merge'} />
          </section>
          <section id="panel-split" role="tabpanel" aria-labelledby="tab-split" hidden={tool !== 'split'}>
            <SplitTool active={tool === 'split'} />
          </section>
          <section id="panel-organize" role="tabpanel" aria-labelledby="tab-organize" hidden={tool !== 'organize'}>
            <OrganizeTool active={tool === 'organize'} />
          </section>
          <section id="panel-bookmarks" role="tabpanel" aria-labelledby="tab-bookmarks" hidden={tool !== 'bookmarks'}>
            <BookmarksTool active={tool === 'bookmarks'} />
          </section>
          <section id="panel-text" role="tabpanel" aria-labelledby="tab-text" hidden={tool !== 'text'}>
            <TextTool active={tool === 'text'} />
          </section>
          <section id="panel-edit" role="tabpanel" aria-labelledby="tab-edit" hidden={tool !== 'edit'}>
            <EditTool active={tool === 'edit'} />
          </section>
          <section id="panel-forms" role="tabpanel" aria-labelledby="tab-forms" hidden={tool !== 'forms'}>
            <FormsTool active={tool === 'forms'} />
          </section>
          <section id="panel-redact" role="tabpanel" aria-labelledby="tab-redact" hidden={tool !== 'redact'}>
            <RedactTool active={tool === 'redact'} />
          </section>
          <section id="panel-signatures" role="tabpanel" aria-labelledby="tab-signatures" hidden={tool !== 'signatures'}>
            <SignatureTool active={tool === 'signatures'} />
          </section>
          <section id="panel-stamps" role="tabpanel" aria-labelledby="tab-stamps" hidden={tool !== 'stamps'}>
            <StampTool active={tool === 'stamps'} />
          </section>
          <section id="panel-compress" role="tabpanel" aria-labelledby="tab-compress" hidden={tool !== 'compress'}>
            <CompressTool active={tool === 'compress'} />
          </section>
          <section id="panel-pdf-images" role="tabpanel" aria-labelledby="tab-pdf-images" hidden={tool !== 'pdf-images'}>
            <PdfImagesTool active={tool === 'pdf-images'} />
          </section>
          <section id="panel-passwords" role="tabpanel" aria-labelledby="tab-passwords" hidden={tool !== 'passwords'}>
            <PasswordTool active={tool === 'passwords'} />
          </section>
          <section id="panel-workflows" role="tabpanel" aria-labelledby="tab-workflows" hidden={tool !== 'workflows'}>
            <WorkflowTool active={tool === 'workflows'} />
          </section>
          <section id="panel-images" role="tabpanel" aria-labelledby="tab-images" hidden={tool !== 'images'}>
            <ImagesTool active={tool === 'images'} />
          </section>
          <section id="panel-photo" role="tabpanel" aria-labelledby="tab-photo" hidden={tool !== 'photo'}>
            <PhotoTool active={tool === 'photo'} />
          </section>
        </main>
        <PdfPasswordDialog />
      </div>
    </HandoffContext>
  )
}
