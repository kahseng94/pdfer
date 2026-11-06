import { createRequire } from 'node:module'
import { deflateSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { comparePdfs, comparisonReport, DEFAULT_COMPARE, differences } from './pdfCompare'
import type { PDFDocumentProxy } from './pdf'

// Use the very same PDF.js renderer in Node, backed by PDF.js's existing optional canvas dependency.
vi.mock('pdfjs-dist', async () => await import('pdfjs-dist/legacy/build/pdf.mjs'))
const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist/legacy/build/pdf.mjs')
const { loadPdf, closePdf } = await import('./pdf')
GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
const requirePdf = createRequire(import.meta.resolve('pdfjs-dist/package.json'))
const { createCanvas } = requirePdf('@napi-rs/canvas') as { createCanvas: (width: number, height: number) => HTMLCanvasElement }
const documents: PDFDocumentProxy[] = []
afterEach(async () => { for (const doc of documents.splice(0)) await doc.loadingTask.destroy(); releases.length = 0 })

function pdf(pages: { stream?: string; geometry?: string }[], compressed = false): Uint8Array<ArrayBuffer> {
  const objects: Buffer[] = []
  const object = (text: string) => objects.push(Buffer.from(text))
  object('<< /Type /Catalog /Pages 2 0 R >>')
  object(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`)
  pages.forEach(({ stream = '', geometry = '/MediaBox [0 0 200 150]' }, i) => {
    object(`<< /Type /Page /Parent 2 0 R ${geometry} /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`)
    const bytes = compressed ? deflateSync(Buffer.from(stream)) : Buffer.from(stream)
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${bytes.length} ${compressed ? '/Filter /FlateDecode' : ''} >>\nstream\n`), bytes, Buffer.from('\nendstream')]))
  })
  object('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const parts = [Buffer.from('%PDF-1.6\n')], offsets = [0]
  let offset = parts[0].length
  objects.forEach((o, i) => {
    offsets.push(offset)
    const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')])
    parts.push(part); offset += part.length
  })
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${offset}\n%%EOF`))
  return new Uint8Array(Buffer.concat(parts))
}
async function open(pages: Parameters<typeof pdf>[0], compressed = false) {
  const doc = await getDocument({ data: pdf(pages, compressed), useSystemFonts: true }).promise
  documents.push(doc); return doc
}
const text = (value: string, invisible = false) => `BT /F1 12 Tf ${invisible ? '3 Tr' : ''} 10 90 Td (${value}) Tj ET`
const scan = (color: string) => `q 100 0 0 80 20 20 cm BI /W 2 /H 2 /CS /RGB /BPC 8 /F /AHx ID ${color.repeat(4)}> EI Q`
const releases: (() => boolean)[] = []
const options = () => ({ signal: new AbortController().signal, createCanvas: () => {
  const canvas = createCanvas(1, 1)
  // Native canvas maps zero dimensions to its own defaults; observe disposal writes.
  const width = vi.spyOn(canvas, 'width', 'set'), height = vi.spyOn(canvas, 'height', 'set')
  releases.push(() => width.mock.calls.at(-1)?.[0] === 0 && height.mock.calls.at(-1)?.[0] === 0)
  return canvas
} })

it('compares rendered content, including identical PDFs with different stream encoding', async () => {
  const source = [{ stream: text('Same words') }, { stream: scan('808080') }, {}]
  const a = await open(source), b = await open(source, true)
  const result = await comparePdfs(a, b, DEFAULT_COMPARE, options())
  expect(result.map((p) => p.status)).toEqual(['unchanged', 'unchanged', 'unchanged'])
  expect(differences(result)).toEqual([])
  expect(result[1].originalHasText).toBe(false)
  expect(releases.every((released) => released())).toBe(true)
  // Document cleanup must not break fonts/images when another run or preview reopens a page.
  expect((await comparePdfs(a, b, DEFAULT_COMPARE, options())).map((p) => p.status)).toEqual(['unchanged', 'unchanged', 'unchanged'])
})

it('detects visible edits, scanned image changes and invisible text-only differences', async () => {
  const a = await open([{ stream: text('Old word') }, { stream: scan('000000') }, { stream: text('secret old', true) }, {}])
  const b = await open([{ stream: text('New word') }, { stream: scan('ff0000') }, { stream: text('secret new', true) }, {}])
  const result = await comparePdfs(a, b, DEFAULT_COMPARE, options())
  expect(result.map((p) => p.status)).toEqual(['changed', 'changed', 'changed', 'unchanged'])
  expect(result[0].regions.length).toBeGreaterThan(0)
  expect(result[1].regions.length).toBeGreaterThan(0)
  expect(result[1].textChanges).toEqual([])
  expect(result[2].regions).toEqual([])
  expect(result[2].textChanges).toEqual([{ removed: 'old', added: 'new' }])
  expect(differences(result)).toContainEqual({ page: 3, kind: 'text' })
  expect(comparisonReport('a.pdf', 'b.pdf', DEFAULT_COMPARE, result)).toContain('Removed: old\nAdded: new')
})

it('marks trailing blank/text pages as added or removed without inventing alignment', async () => {
  const a = await open([{}]), b = await open([{}, {}, { stream: text('New page') }])
  const added = await comparePdfs(a, b, DEFAULT_COMPARE, options())
  expect(added.map((p) => p.status)).toEqual(['unchanged', 'added', 'added'])
  expect(added[2].textChanges).toEqual([{ removed: '', added: 'New page' }])
  expect((await comparePdfs(b, a, DEFAULT_COMPARE, options())).map((p) => p.status)).toEqual(['unchanged', 'removed', 'removed'])
})

it('uses displayed crop, rotation and UserUnit geometry at a shared physical scale', async () => {
  const a = await open([{ stream: '0 0 20 20 re f' }, {}, { stream: text('Rotated') }])
  const b = await open([
    { stream: '0 0 20 20 re f', geometry: '/MediaBox [0 0 200 150] /CropBox [10 10 190 140] /Rotate 90 /UserUnit 2' },
    { geometry: '/MediaBox [0 0 250 150]' },
    { stream: text('Rotated'), geometry: '/MediaBox [0 0 200 150] /Rotate 180' },
  ])
  const result = await comparePdfs(a, b, DEFAULT_COMPARE, options())
  expect(result[0].revised).toEqual({ width: 260, height: 360 })
  expect(result[0].geometryChanged).toBe(true)
  expect(result[1].geometryChanged).toBe(true)
  expect(result[1].regions).toEqual([]) // Blank size changes are still changes.
  expect(result[2].geometryChanged).toBe(false)
  expect(result[2].regions.length).toBeGreaterThan(0)
  expect(result.every((p) => p.status === 'changed')).toBe(true)
})

it('keeps content outside the smaller page crop box out of the shared comparison canvas', async () => {
  const original = await open([{ stream: '150 30 30 30 re f', geometry: '/MediaBox [0 0 200 150] /CropBox [0 0 100 100]' }])
  const revised = await open([{}])
  const [result] = await comparePdfs(original, revised, DEFAULT_COMPARE, options())
  expect(result.geometryChanged).toBe(true)
  expect(result.regions).toEqual([])
  expect(result.changedPixels).toBe(0)
})

it('cancels between pairs, releases canvases, and returns no partial result', async () => {
  const a = await open([{}, {}, {}]), b = await open([{}, {}, {}]), controller = new AbortController()
  const getPage = vi.spyOn(a, 'getPage')
  await expect(comparePdfs(a, b, DEFAULT_COMPARE, { ...options(), signal: controller.signal,
    onProgress: ({ completed }) => { if (completed === 1) controller.abort() },
  })).rejects.toMatchObject({ name: 'AbortError' })
  expect(getPage.mock.calls.map(([n]) => n)).toEqual([1])
  expect(releases.every((released) => released())).toBe(true)
})

it('opens independently encrypted inputs using the existing prompt queue, retry and password memory', async () => {
  const { currentPasswordPrompt, pdfPassword } = await import('./passwords')
  const left = new File([new Uint8Array(await readFile(new URL('./fixtures/compare-original.pdf', import.meta.url)))], 'original.pdf')
  const right = new File([new Uint8Array(await readFile(new URL('./fixtures/compare-revised.pdf', import.meta.url)))], 'revised.pdf')
  const a = loadPdf(left), b = loadPdf(right)
  await vi.waitFor(() => expect(currentPasswordPrompt()).not.toBeNull())
  const answered = new Set<string>()
  let wrong = false, retried = false
  while (answered.size < 2) {
    await vi.waitFor(() => expect(currentPasswordPrompt()).not.toBeNull())
    const prompt = currentPasswordPrompt()!
    if (!wrong) { wrong = true; prompt.submit('incorrect'); continue }
    if (prompt.incorrect) retried = true
    prompt.submit(prompt.filename === 'original.pdf' ? 'original-secret' : 'revised-secret')
    answered.add(prompt.filename)
  }
  const docs = await Promise.all([a, b]); documents.push(...docs)
  expect(pdfPassword(left)).toBe('original-secret')
  expect(pdfPassword(right)).toBe('revised-secret')
  expect(retried).toBe(true)
  expect((await comparePdfs(docs[0], docs[1], DEFAULT_COMPARE, options()))[0].status).toBe('unchanged')
  expect(currentPasswordPrompt()).toBeNull()
})

it('cancels a protected input without leaving its password prompt queued', async () => {
  const { currentPasswordPrompt } = await import('./passwords')
  const file = new File([new Uint8Array(await readFile(new URL('./fixtures/compare-original.pdf', import.meta.url)))], 'cancel.pdf')
  const controller = new AbortController(), pending = loadPdf(file, controller.signal)
  const rejected = expect(pending).rejects.toThrow('cancelled')
  await vi.waitFor(() => expect(currentPasswordPrompt()?.filename).toBe('cancel.pdf'))
  controller.abort(); await rejected
  expect(currentPasswordPrompt()).toBeNull()
  closePdf(null)
})
