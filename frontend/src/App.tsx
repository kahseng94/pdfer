import { lazy, Suspense, useState } from 'react'
import { HandoffContext, type Delivery } from './lib/handoff'
import { loadTool, saveTool } from './lib/lastTool'
import { TOOL_IDS, type ToolId } from './lib/tools'
import { CompressTool } from './components/CompressTool'
import { EditTool } from './components/EditTool'
import { LocalFilesNote, ToolNavigation } from './components/ToolNavigation'
import { focusToolNavigation, TOOL_DETAILS } from './lib/toolNavigation'
import { ImagesTool } from './components/ImagesTool'
import { OfficeTool } from './components/OfficeTool'
import { ExcelCsvTool } from './components/ExcelCsvTool'
import { SheetViewTool } from './components/SheetViewTool'
import { CsvExcelTool } from './components/CsvExcelTool'
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
import { OcrTool } from './components/OcrTool'
import { WorkflowTool } from './components/WorkflowTool'
import { BookmarksTool } from './components/BookmarksTool'
import { MetadataTool } from './components/MetadataTool'
import { FormsTool } from './components/FormsTool'
import { RedactTool } from './components/RedactTool'
import { ProjectsPanel } from './components/ProjectsPanel'
import { ProjectContext, useProjectManager } from './lib/useProject'
import { DesktopUpdates } from './components/DesktopControls'

const CompareTool = lazy(() => import('./components/CompareTool').then((module) => ({ default: module.CompareTool })))

export default function App() {
  const [tool, setTool] = useState<ToolId>(() => loadTool(TOOL_IDS, 'merge'))
  const [delivery, setDelivery] = useState<Delivery | null>(null)

  function select(id: ToolId) {
    setTool(id)
    saveTool(id)
  }
  const projects = useProjectManager(select)

  function send(to: ToolId, file: File) {
    setDelivery((prev) => ({ to, file, id: (prev?.id ?? 0) + 1 }))
    select(to)
    window.scrollTo({ top: 0 })
    // The button pressed is in the tab being hidden, so keyboard focus moves to the new tab.
    focusToolNavigation(to)
  }

  return (
    <HandoffContext value={{ delivery, send }}>
      <ProjectContext value={projects}>
        <div className="app-shell">
          <div className="title-bar" aria-hidden="true" />
          <a className="skip-link" href="#workspace">Skip to workspace</a>
          <ToolNavigation selected={tool} onSelect={select} />
          <main id="workspace" tabIndex={-1} className={`workspace ${tool === 'compare' ? 'workspace-wide' : ''}`}>
            <DesktopUpdates />
            <ProjectsPanel />
            <header className="workspace-heading">
              <h1>{TOOL_DETAILS[tool].title}</h1>
              <p>{TOOL_DETAILS[tool].description}</p>
            </header>

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
            <section id="panel-metadata" role="tabpanel" aria-labelledby="tab-metadata" hidden={tool !== 'metadata'}>
              <MetadataTool active={tool === 'metadata'} />
            </section>
            <section id="panel-text" role="tabpanel" aria-labelledby="tab-text" hidden={tool !== 'text'}>
              <TextTool active={tool === 'text'} />
            </section>
            <section id="panel-compare" role="tabpanel" aria-labelledby="tab-compare" hidden={tool !== 'compare'}>
              <Suspense fallback={<p role="status">Loading comparison tool…</p>}><CompareTool active={tool === 'compare'} /></Suspense>
            </section>
            <section id="panel-ocr" role="tabpanel" aria-labelledby="tab-ocr" hidden={tool !== 'ocr'}>
              <OcrTool active={tool === 'ocr'} />
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
            {(['word', 'excel', 'powerpoint'] as const).map((kind) => <section key={kind} id={`panel-${kind}`} role="tabpanel" aria-labelledby={`tab-${kind}`} hidden={tool !== kind}>
              <OfficeTool kind={kind} active={tool === kind} />
            </section>)}
            {(['png', 'jpg'] as const).map((kind) => <section key={kind} id={`panel-${kind}`} role="tabpanel" aria-labelledby={`tab-${kind}`} hidden={tool !== kind}>
              <ImagesTool kind={kind} active={tool === kind} />
            </section>)}
            <section id="panel-sheet-view" role="tabpanel" aria-labelledby="tab-sheet-view" hidden={tool !== 'sheet-view'}>
              <SheetViewTool active={tool === 'sheet-view'} />
            </section>
            <section id="panel-excel-csv" role="tabpanel" aria-labelledby="tab-excel-csv" hidden={tool !== 'excel-csv'}>
              <ExcelCsvTool active={tool === 'excel-csv'} />
            </section>
            <section id="panel-csv-excel" role="tabpanel" aria-labelledby="tab-csv-excel" hidden={tool !== 'csv-excel'}>
              <CsvExcelTool active={tool === 'csv-excel'} />
            </section>
            <section id="panel-photo" role="tabpanel" aria-labelledby="tab-photo" hidden={tool !== 'photo'}>
              <PhotoTool active={tool === 'photo'} />
            </section>
            <footer className="workspace-footer"><LocalFilesNote /></footer>
          </main>
          <PdfPasswordDialog />
        </div>
      </ProjectContext>
    </HandoffContext>
  )
}
