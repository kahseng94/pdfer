import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_STYLE, type Element } from './edits'
import { DEFAULT_ORGANIZE } from './organize'
import { pdfPassword, rememberPdfPassword } from './passwords'
import { checkProjectPages, deleteProject, listProjects, projectError, projectFingerprint, readProject, restoreProject, saveProject, serializeProject, validateProject, type ProjectDraft } from './projects'

function file(name = 'source.pdf', bytes = 'original PDF bytes') { return new File([bytes], name, { type: 'application/pdf', lastModified: 42 }) }
const text: Element = { id: 'text', type: 'text', page: 2, x: 30, y: 44, text: 'Unfinished\n你好', size: 18, color: '#123456', family: 'serif', bold: true, italic: false }
function edit(): ProjectDraft<'edit'> { return { tool: 'edit', file: file(), state: { elements: [text], style: DEFAULT_STYLE, zoom: 1.25 } } }

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('project snapshots', () => {
  it('round trips every edit kind, image bytes and source metadata without URLs or passwords', async () => {
    const draft = edit()
    const picture = new File(['image bytes'], 'stamp.png', { type: 'image/png', lastModified: 17 })
    const box = { page: 1, x: 25, y: 35, width: 75, height: 20 }
    draft.state.elements.push(
      { id: 'image', type: 'image', ...box, file: picture, url: 'blob:expired' },
      { id: 'highlight', type: 'highlight', ...box, color: '#ff0000' },
      { id: 'rect', type: 'rect', ...box, stroke: '#000000', strokeWidth: 2, fill: null },
      { id: 'ellipse', type: 'ellipse', ...box, stroke: '#000000', strokeWidth: 1, fill: '#ffffff' },
      { id: 'line', type: 'line', page: 2, x1: 1, y1: 2, x2: 3, y2: 4, stroke: '#000000', strokeWidth: 2 },
      { id: 'draw', type: 'draw', page: 2, points: [[1, 2], [3, 4]], stroke: '#000000', strokeWidth: 2 },
      { id: 'region', type: 'region', ...box, sourcePage: 2, source: { x: 10, y: 20, width: 150, height: 40 } },
      { id: 'deleted-region', type: 'region', ...box, sourcePage: 1, deleted: true, source: { x: 30, y: 50, width: 50, height: 20 } },
      { id: 'copied-region', type: 'region', ...box, sourcePage: 2, copy: true, source: { x: 10, y: 20, width: 150, height: 40 } },
      { id: 'rotated-region', type: 'region', ...box, sourcePage: 2, copy: true, rotation: 270, source: { x: 10, y: 20, width: 150, height: 40 } },
    )
    rememberPdfPassword(draft.file, 'never-persist-this')
    const stored = structuredClone(serializeProject(draft))
    expect(JSON.stringify(stored)).not.toContain('blob:expired')
    expect(JSON.stringify(stored)).not.toContain('never-persist-this')
    const restored = restoreProject(stored)
    expect(restored.draft.file).not.toBe(draft.file)
    expect(restored.draft.file.name).toBe('source.pdf')
    expect(restored.draft.file.lastModified).toBe(42)
    expect(await restored.draft.file.text()).toBe('original PDF bytes')
    expect(pdfPassword(restored.draft.file)).toBe('')
    expect(projectFingerprint(restored.draft.state)).toBe(projectFingerprint(draft.state))
    if (restored.draft.tool !== 'edit') throw new Error('Wrong tool')
    const image = restored.draft.state.elements[1]
    if (image.type !== 'image') throw new Error('Missing image')
    expect(image.url).not.toBe('blob:expired')
    expect(await image.file.text()).toBe('image bytes')
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    restored.dispose(); restored.dispose()
    expect(revoke).toHaveBeenCalledExactlyOnceWith(image.url)
  })

  it('keeps signature copies independent of the library, sharing one stored image and fresh URL', async () => {
    const picture = new File(['signature pixels'], 'signature.png', { type: 'image/png' })
    const placement = { id: 'first', type: 'image' as const, page: 1, x: 10, y: 20, width: 180, height: 60, file: picture, url: 'blob:old', signatureId: 'deleted-library-entry', label: 'My signature', aspect: 3 }
    const draft: ProjectDraft<'signatures'> = { tool: 'signatures', file: file(), state: { elements: [placement, { ...placement, id: 'second', page: 3, x: 66, y: 77 }], page: 3, assetId: placement.signatureId } }
    const content = structuredClone(serializeProject(draft))
    expect(content.images).toHaveLength(1)
    const restored = restoreProject(content)
    if (restored.draft.tool !== 'signatures') throw new Error('Wrong tool')
    const [first, second] = restored.draft.state.elements
    expect(first.file).toBe(second.file)
    expect(first.url).toBe(second.url)
    expect(await second.file.text()).toBe('signature pixels')
    expect(projectFingerprint(restored.draft.state)).toBe(projectFingerprint(draft.state))
    restored.dispose()
  })

  it('preserves page ordering, independent duplicate selections, crop/resize and unfinished fields', () => {
    const draft: ProjectDraft<'organize'> = { tool: 'organize', file: file(), state: {
      items: [{ id: 'a', page: 3, rotation: 270 }, { id: 'b', page: 1, rotation: 90 }, { id: 'copy', page: 1, rotation: 180 }],
      selected: ['a', 'copy'], referenceId: 'copy', settings: { ...DEFAULT_ORGANIZE, cropEnabled: true, resizeEnabled: true, paper: 'custom', width: NaN, height: 350, crop: { top: 10, bottom: 25, left: 12, right: 8 } },
    } }
    const restored = restoreProject(structuredClone(serializeProject(draft)))
    expect(restored.draft.state).toEqual(draft.state)
    expect(() => checkProjectPages(restored.draft.state, 2)).toThrow('damaged')
    expect(() => checkProjectPages(restored.draft.state, 3)).not.toThrow()
  })

  it('rejects damaged records and future formats before creating URLs', () => {
    const create = vi.spyOn(URL, 'createObjectURL')
    const content = serializeProject(edit())
    for (const damaged of [null, { ...content, version: 2 }, { ...content, file: {} }, { ...content, state: { elements: [null] } }, { ...content, tool: 'missing' }]) {
      expect(() => validateProject(damaged)).toThrow('damaged')
    }
    if (content.tool !== 'edit') throw new Error('Wrong tool')
    content.state.elements = [{ id: 'bad', type: 'image', page: 1, x: 1, y: 1, width: 10, height: 10, image: 42 }]
    expect(() => restoreProject(content)).toThrow('damaged')
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects malformed region geometry before restoring a project', () => {
    const content = serializeProject(edit())
    if (content.tool !== 'edit') throw new Error('Wrong tool')
    const region = { id: 'region', type: 'region' as const, page: 1, x: 0, y: 0, width: 10, height: 20, source: { x: 0, y: 0, width: 10, height: 20 } }
    for (const patch of [{ source: null }, { source: { ...region.source, width: NaN } }, { width: 0 }, { x: -5 }, { sourcePage: 0 }, { sourcePage: 1.5 }, { sourcePage: '2' }, { deleted: 'true' }, { deleted: 1 }, { deleted: null }, { copy: 'true' }, { copy: null }, { copy: true, deleted: true }, { rotation: 45 }, { rotation: -90 }, { rotation: '90' }, { rotation: false }, { rotation: null }]) {
      expect(() => validateProject({ ...content, state: { ...content.state, elements: [{ ...region, ...patch }] } })).toThrow('damaged')
    }
  })

  it('upgrades older same-page regions and checks both page references', () => {
    const content = serializeProject(edit())
    if (content.tool !== 'edit') throw new Error('Wrong tool')
    const legacy = { id: 'region', type: 'region', page: 2, x: 0, y: 0, width: 10, height: 20, source: { x: 10, y: 20, width: 10, height: 20 } }
    // Deliberately construct the format saved before sourcePage was introduced.
    const stored = { ...content, state: { ...content.state, elements: [legacy] } }
    validateProject(stored)
    const restored = restoreProject(stored)
    if (restored.draft.tool !== 'edit') throw new Error('Wrong tool')
    expect(restored.draft.state.elements[0]).toMatchObject({ page: 2, sourcePage: 2, source: legacy.source })
    const region = restored.draft.state.elements[0]
    const state = restored.draft.state
    expect(() => checkProjectPages({ ...state, elements: [{ ...region, page: 1 }] }, 1)).toThrow('damaged')
    expect(() => checkProjectPages(restored.draft.state, 2)).not.toThrow()
    restored.dispose()
  })
})

describe('local project storage', () => {
  it('creates, lists, resumes, renames, updates, copies and deletes projects across connections', async () => {
    const draft = edit()
    const first = await saveProject(draft, '  Contract draft  ')
    expect(first.name).toBe('Contract draft')
    expect(await listProjects()).toEqual([first])
    const read = await readProject(first.id)
    expect(await read.content.file.blob.text()).toBe('original PDF bytes')
    draft.state.elements = []
    const updated = await saveProject(draft, 'Ready for review', first)
    expect(updated.id).toBe(first.id)
    expect(updated.revision).toBe(2)
    expect(updated.createdAt).toBe(first.createdAt)
    expect((await readProject(first.id)).content.state).toEqual(draft.state)
    const copy = await saveProject(draft, 'Another version')
    expect(copy.id).not.toBe(first.id)
    expect(await listProjects()).toHaveLength(2)
    await deleteProject(first.id)
    await expect(readProject(first.id)).rejects.toThrow('no longer exists')
    expect(await listProjects()).toEqual([copy])
  })

  it('does not overwrite a newer revision or recreate a deleted project', async () => {
    const draft = edit()
    const first = await saveProject(draft, 'First')
    await saveProject(draft, 'From another tab', first)
    await expect(saveProject(draft, 'Stale edit', first)).rejects.toThrow('another tab')
    expect((await readProject(first.id)).summary.name).toBe('From another tab')
    await deleteProject(first.id)
    await expect(saveProject(draft, 'Deleted', first)).rejects.toThrow('another tab')
    expect(await listProjects()).toEqual([])
  })

  it('rolls back metadata and preserves the last saved bytes when writing content fails', async () => {
    const first = await saveProject(edit(), 'Original')
    const originalPut = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof originalPut>) {
      if (this.name === 'contents') throw new DOMException('Quota exceeded', 'QuotaExceededError')
      return originalPut.apply(this, args)
    })
    await expect(saveProject({ ...edit(), file: file('new.pdf', 'new bytes') }, 'Changed', first)).rejects.toThrow('Quota exceeded')
    const saved = await readProject(first.id)
    expect(saved.summary).toEqual(first)
    expect(await saved.content.file.blob.text()).toBe('original PDF bytes')
    expect(projectError(new DOMException('Quota exceeded', 'QuotaExceededError'))).toContain('Browser storage is full')
  })

  it('reports unavailable storage and invalid names without claiming success', async () => {
    await expect(saveProject(edit(), ' ')).rejects.toThrow('name')
    expect(await listProjects()).toEqual([])
    vi.stubGlobal('indexedDB', undefined)
    await expect(listProjects()).rejects.toThrow('does not support')
    await expect(saveProject(edit(), 'Draft')).rejects.toThrow('does not support')
  })
})
