import type { Element, ImageElement, RegionElement, Style } from './edits'
import type { OrganizeItem, OrganizeSettings } from './organize'
import type { SignaturePlacement } from './signatures'

export type ProjectStates = {
  edit: { elements: Element[]; style: Style; zoom: number }
  /** The Copy between PDFs tab: the same editor, whose copies refer to other PDFs stored with the project. */
  'copy-pdf': { elements: Element[]; style: Style; zoom: number }
  organize: { items: OrganizeItem[]; selected: string[]; settings: OrganizeSettings; referenceId: string }
  signatures: { elements: SignaturePlacement[]; page: number; assetId: string | null }
}
export type ProjectTool = keyof ProjectStates
export type ProjectDraft<T extends ProjectTool = ProjectTool> = {
  [K in T]: { tool: K; file: File; state: ProjectStates[K] }
}[T]
export type ProjectSummary = {
  id: string; name: string; tool: ProjectTool; filename: string; size: number
  createdAt: number; updatedAt: number; revision: number
}
type StoredFile = { blob: Blob; name: string; lastModified: number }
type StoredImage = Omit<ImageElement, 'file' | 'url'> & { image: number }
/** A region copied from another PDF names it by index into the stored sources. */
type StoredRegion = Omit<RegionElement, 'sourceFile'> & { sourceDocument?: number }
type StoredElement = Exclude<Element, ImageElement | RegionElement> | StoredImage | StoredRegion
type StoredSignature = Omit<SignaturePlacement, 'file' | 'url'> & { image: number }
type StoredState =
  | { tool: 'edit' | 'copy-pdf'; state: Omit<ProjectStates['edit'], 'elements'> & { elements: StoredElement[] } }
  | { tool: 'organize'; state: ProjectStates['organize'] }
  | { tool: 'signatures'; state: Omit<ProjectStates['signatures'], 'elements'> & { elements: StoredSignature[] } }
/** `sources` are the other PDFs that copied regions come from; only Copy between PDFs projects have any. */
export type ProjectContent = StoredState & { version: 1; file: StoredFile; images: StoredFile[]; sources?: StoredFile[] }
export type SavedProject = { summary: ProjectSummary; content: ProjectContent }

const DATABASE = 'pdfer-projects'
const FORMAT_ERROR = 'This project is damaged or was saved by a newer version of pdfer.'

function storeFile(file: File): StoredFile {
  // Keep bytes and metadata explicitly: File structured cloning varies by browser.
  return { blob: file.slice(0, file.size, file.type), name: file.name, lastModified: file.lastModified }
}
function restoreFile(file: StoredFile): File {
  return new File([file.blob], file.name, { type: file.blob.type, lastModified: file.lastModified })
}

/** Original PDF bytes, independent image copies and the other PDFs regions copy from; never passwords or object URLs. */
export function serializeProject(draft: ProjectDraft): ProjectContent {
  const images: StoredFile[] = []
  const indices = new Map<File, number>()
  function image<T extends ImageElement>(element: T): Omit<T, 'file' | 'url'> & { image: number } {
    const { file, url: _url, ...rest } = element
    let index = indices.get(file)
    if (index === undefined) { index = images.push(storeFile(file)) - 1; indices.set(file, index) }
    return { ...rest, image: index }
  }
  const sources: StoredFile[] = []
  const sourceIndices = new Map<File, number>()
  function region(element: RegionElement): StoredRegion {
    const { sourceFile, ...rest } = element
    if (!sourceFile) return rest
    let index = sourceIndices.get(sourceFile)
    if (index === undefined) { index = sources.push(storeFile(sourceFile)) - 1; sourceIndices.set(sourceFile, index) }
    return { ...rest, sourceDocument: index }
  }
  const base = { version: 1 as const, file: storeFile(draft.file), images, sources }
  switch (draft.tool) {
    case 'edit': case 'copy-pdf': return { ...base, tool: draft.tool, state: { ...draft.state, elements: draft.state.elements.map((el) => el.type === 'image' ? image(el) : el.type === 'region' ? region(el) : el) } }
    case 'signatures': return { ...base, tool: draft.tool, state: { ...draft.state, elements: draft.state.elements.map(image) } }
    case 'organize': return { ...base, tool: draft.tool, state: draft.state }
  }
}

/** Stable comparison excludes disposable URLs and includes image identity metadata. */
export function projectFingerprint(state: ProjectStates[ProjectTool]): string {
  return JSON.stringify(state, (key, value) => {
    if (key === 'url') return undefined
    if (value instanceof File) return [value.name, value.size, value.type, value.lastModified]
    if (object(value) && !Array.isArray(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
    return value
  })
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' }
function numbers(value: Record<string, unknown>, keys: string[]): boolean { return keys.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key])) }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === 'string') }
function storedFile(value: unknown): boolean { return object(value) && value.blob instanceof Blob && typeof value.name === 'string' && numbers(value, ['lastModified']) }
function style(value: unknown): boolean {
  return object(value) && numbers(value, ['size', 'strokeWidth']) && ['sans', 'serif', 'mono'].includes(value.family as string)
    && ['color', 'stroke', 'highlight'].every((key) => typeof value[key] === 'string')
    && typeof value.bold === 'boolean' && typeof value.italic === 'boolean' && (value.fill === null || typeof value.fill === 'string')
}
function storedElement(value: unknown, images: number, sources: number, signature: boolean): boolean {
  if (!object(value) || typeof value.id !== 'string' || !Number.isInteger(value.page) || (value.page as number) < 1) return false
  if (signature && (value.type !== 'image' || typeof value.signatureId !== 'string' || typeof value.label !== 'string' || !numbers(value, ['aspect']) || (value.aspect as number) <= 0)) return false
  const stroke = typeof value.stroke === 'string' && numbers(value, ['strokeWidth'])
  switch (value.type) {
    case 'text': return numbers(value, ['x', 'y', 'size']) && typeof value.text === 'string' && typeof value.color === 'string'
      && ['sans', 'serif', 'mono'].includes(value.family as string) && typeof value.bold === 'boolean' && typeof value.italic === 'boolean'
    case 'image': return numbers(value, ['x', 'y', 'width', 'height']) && Number.isInteger(value.image) && (value.image as number) >= 0 && (value.image as number) < images
    case 'region': return numbers(value, ['x', 'y', 'width', 'height']) && (value.x as number) >= 0 && (value.y as number) >= 0
      && (value.rotation === undefined || [0, 90, 180, 270].includes(value.rotation as number))
      && (value.copy === undefined || typeof value.copy === 'boolean') && !(value.copy && value.deleted)
      && (value.deleted === undefined || typeof value.deleted === 'boolean')
      && (value.sourcePage === undefined || (Number.isInteger(value.sourcePage) && (value.sourcePage as number) >= 1))
      && (value.sourceDocument === undefined || (Number.isInteger(value.sourceDocument) && (value.sourceDocument as number) >= 0 && (value.sourceDocument as number) < sources && value.copy === true))
      && (value.width as number) >= 2 && (value.height as number) >= 2 && object(value.source)
      && numbers(value.source, ['x', 'y', 'width', 'height']) && (value.source.x as number) >= 0 && (value.source.y as number) >= 0
      && (value.source.width as number) >= 2 && (value.source.height as number) >= 2
    case 'rect': case 'ellipse': return numbers(value, ['x', 'y', 'width', 'height']) && stroke && (value.fill === null || typeof value.fill === 'string')
    case 'highlight': return numbers(value, ['x', 'y', 'width', 'height']) && typeof value.color === 'string'
    case 'line': return numbers(value, ['x1', 'y1', 'x2', 'y2']) && stroke
    case 'draw': return stroke && Array.isArray(value.points) && value.points.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n)))
    default: return false
  }
}

export function validateProject(value: unknown): asserts value is ProjectContent {
  if (!object(value) || value.version !== 1 || !storedFile(value.file) || !Array.isArray(value.images) || !value.images.every(storedFile)
    || !(value.sources === undefined || (Array.isArray(value.sources) && value.sources.every(storedFile))) || !object(value.state)) throw new Error(FORMAT_ERROR)
  const state = value.state
  const editor = value.tool === 'edit' || value.tool === 'copy-pdf'
  if (editor || value.tool === 'signatures') {
    // Edit works on one PDF, so only Copy between PDFs projects may refer to others.
    const sources = value.tool === 'copy-pdf' && Array.isArray(value.sources) ? value.sources.length : 0
    if (!Array.isArray(state.elements) || !state.elements.every((el) => storedElement(el, (value.images as unknown[]).length, sources, value.tool === 'signatures')) || new Set(state.elements.map((el) => el.id)).size !== state.elements.length) throw new Error(FORMAT_ERROR)
    if (editor ? !style(state.style) || !numbers(state, ['zoom']) || (state.zoom as number) <= 0
      : !Number.isInteger(state.page) || (state.page as number) < 1 || !(state.assetId === null || typeof state.assetId === 'string')) throw new Error(FORMAT_ERROR)
  } else if (value.tool === 'organize') {
    if (!Array.isArray(state.items) || !state.items.every((item) => object(item) && typeof item.id === 'string' && Number.isInteger(item.page) && (item.page as number) > 0 && [0, 90, 180, 270].includes(item.rotation as number))
      || new Set(state.items.map((item) => item.id)).size !== state.items.length || !strings(state.selected) || typeof state.referenceId !== 'string') throw new Error(FORMAT_ERROR)
    const settings = state.settings
    // Invalid numeric inputs are valid unfinished work, including NaN from an empty field.
    if (!object(settings) || typeof settings.cropEnabled !== 'boolean' || typeof settings.resizeEnabled !== 'boolean'
      || !['a4', 'letter', 'custom'].includes(settings.paper as string) || !['portrait', 'landscape'].includes(settings.orientation as string)
      || typeof settings.width !== 'number' || typeof settings.height !== 'number' || !object(settings.crop)
      || !['top', 'right', 'bottom', 'left'].every((key) => typeof (settings.crop as Record<string, unknown>)[key] === 'number')) throw new Error(FORMAT_ERROR)
  } else throw new Error(FORMAT_ERROR)
}

export function restoreProject(content: ProjectContent): { draft: ProjectDraft; dispose: () => void } {
  validateProject(content)
  const urls: string[] = []
  const images = content.images.map(restoreFile)
  const sources = (content.sources ?? []).map(restoreFile)
  const pictures = new Map<number, { file: File; url: string }>()
  const dispose = () => { for (const url of urls.splice(0)) URL.revokeObjectURL(url) }
  function image<T extends StoredImage>(element: T): Omit<T, 'image'> & { file: File; url: string } {
    const { image: index, ...rest } = element
    let picture = pictures.get(index)
    if (!picture) {
      const url = URL.createObjectURL(images[index])
      urls.push(url)
      picture = { file: images[index], url }
      pictures.set(index, picture)
    }
    return { ...rest, ...picture }
  }
  function region(element: StoredRegion): RegionElement {
    const { sourceDocument, ...rest } = element
    // Older projects stored same-page regions with only the destination page.
    return { ...rest, sourcePage: rest.sourcePage ?? rest.page, ...(sourceDocument === undefined ? {} : { sourceFile: sources[sourceDocument] }) }
  }
  try {
    const file = restoreFile(content.file)
    switch (content.tool) {
      case 'edit': case 'copy-pdf': return { draft: { tool: content.tool, file, state: { ...content.state, elements: content.state.elements.map((el) =>
        el.type === 'image' ? image(el) : el.type === 'region' ? region(el) : el) } }, dispose }
      case 'signatures': return { draft: { tool: content.tool, file, state: { ...content.state, elements: content.state.elements.map(image) } }, dispose }
      case 'organize': return { draft: { tool: content.tool, file, state: content.state }, dispose }
    }
  } catch (error) { dispose(); throw error }
}

/** Every page reference into the PDF itself; pages of other PDFs are checked with `checkSourcePages` once those are open. */
export function checkProjectPages(state: ProjectStates[ProjectTool], total: number) {
  const entries = 'items' in state ? state.items : state.elements
  if (entries.some((entry) => entry.page > total || ('sourcePage' in entry && !('sourceFile' in entry && entry.sourceFile) && entry.sourcePage > total)) || ('page' in state && state.page > total)) throw new Error(FORMAT_ERROR)
}

export function checkSourcePages(elements: readonly Element[], file: File, total: number) {
  if (elements.some((el) => el.type === 'region' && el.sourceFile === file && el.sourcePage > total)) throw new Error(FORMAT_ERROR)
}

export function projectError(error: unknown): string {
  if (error instanceof Error && error.name === 'QuotaExceededError') return 'Browser storage is full. Free some space or delete a saved project, then try again.'
  if (error instanceof Error && ['SecurityError', 'InvalidStateError', 'UnknownError'].includes(error.name)) return 'Local project storage is unavailable. Check this browser’s storage settings and try again.'
  return error instanceof Error ? error.message : 'The project could not be saved or opened. Please try again.'
}

async function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') throw new Error('This browser does not support local project storage.')
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    let blocked = false
    request.onupgradeneeded = () => {
      request.result.createObjectStore('projects', { keyPath: 'id' })
      request.result.createObjectStore('contents')
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => { blocked = true; reject(new Error('Close other pdfer tabs, then retry opening local projects.')) }
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return }
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
  })
}

async function transaction<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction, done: (value: T) => void, fail: (error: Error) => void) => void, stores = ['projects', 'contents']): Promise<T> {
  const db = await openDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode)
      let result: T
      let error: Error | null = null
      tx.oncomplete = () => resolve(result)
      tx.onabort = () => reject(error ?? tx.error ?? new Error('Local project storage was interrupted. Please try again.'))
      const fail = (reason: Error) => { error = reason; tx.abort() }
      try { work(tx, (value) => { result = value }, fail) } catch (reason) { fail(reason as Error) }
    })
  } finally { db.close() }
}

export function listProjects(): Promise<ProjectSummary[]> {
  return transaction('readonly', (tx, done) => {
    const request = tx.objectStore('projects').getAll()
    request.onsuccess = () => done((request.result as ProjectSummary[]).sort((a, b) => b.updatedAt - a.updatedAt))
  }, ['projects'])
}

export function saveProject(draft: ProjectDraft, name: string, previous?: ProjectSummary): Promise<ProjectSummary> {
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 120) return Promise.reject(new Error('Give the project a name of 1–120 characters.'))
  const content = serializeProject(draft)
  validateProject(content)
  return transaction('readwrite', (tx, done, fail) => {
    const projects = tx.objectStore('projects')
    const write = (current?: ProjectSummary) => {
      if (previous && (!current || current.revision !== previous.revision)) {
        fail(new Error('This project was changed or deleted in another tab. Save as new project to keep your work.'))
        return
      }
      const now = Date.now()
      const summary: ProjectSummary = {
        id: current?.id ?? crypto.randomUUID(), name: trimmed, tool: draft.tool, filename: draft.file.name,
        size: draft.file.size + [...content.images, ...content.sources ?? []].reduce((sum, stored) => sum + stored.blob.size, 0),
        createdAt: current?.createdAt ?? now, updatedAt: now, revision: (current?.revision ?? 0) + 1,
      }
      projects.put(summary)
      tx.objectStore('contents').put(content, summary.id)
      done(summary)
    }
    if (previous) {
      const request = projects.get(previous.id)
      request.onsuccess = () => { try { write(request.result) } catch (error) { fail(error as Error) } }
    }
    else write()
  })
}

export async function readProject(id: string): Promise<SavedProject> {
  const saved = await transaction<SavedProject>('readonly', (tx, done) => {
    const summary = tx.objectStore('projects').get(id)
    const content = tx.objectStore('contents').get(id)
    content.onsuccess = () => done({ summary: summary.result, content: content.result })
  })
  if (!saved.summary) throw new Error('This project no longer exists. Refresh the saved projects list.')
  validateProject(saved.content)
  if (saved.summary.tool !== saved.content.tool) throw new Error(FORMAT_ERROR)
  return saved
}

export function deleteProject(id: string): Promise<void> {
  return transaction('readwrite', (tx, done) => {
    tx.objectStore('projects').delete(id)
    tx.objectStore('contents').delete(id)
    done(undefined)
  })
}
