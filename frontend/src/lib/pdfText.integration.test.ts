import { expect, it } from 'vitest'
import { exportText, extractPdfText, searchText } from './pdfText'

/** A small real PDF with split text runs, rotated/scaled text, and a blank page. */
function samplePdf(): Uint8Array<ArrayBuffer> {
  const streams = [
    'BT /F1 12 Tf 20 250 Td (Hello ) Tj (world.) Tj 0 -20 Td (Needle alpha) Tj ET',
    'BT /F1 12 Tf 20 250 Td (Needle beta) Tj ET',
    '',
  ]
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>',
  ]
  streams.forEach((text, index) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] ${index === 1 ? '/Rotate 90 /UserUnit 2 /CropBox [10 10 390 290]' : ''} /Resources << /Font << /F1 9 0 R >> >> /Contents ${4 + index * 2} 0 R >>`)
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`)
  })
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let pdf = '%PDF-1.6\n'
  const offsets = [0]
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF`
  return new TextEncoder().encode(pdf)
}

it('extracts, searches, and exports real PDF.js content with rotations and blank pages', async () => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = getDocument({ data: samplePdf(), useSystemFonts: true })
  try {
    const doc = await task.promise
    const pages = await extractPdfText(doc, { signal: new AbortController().signal })
    expect(pages.map((page) => page.text)).toEqual(['Hello world.\nNeedle alpha', 'Needle beta', ''])
    expect(searchText(pages, 'needle', { matchCase: false, wholeWord: true }).matches.map((match) => match.page)).toEqual([1, 2])
    expect(searchText(pages, 'world. Needle', { matchCase: true, wholeWord: false }).matches).toHaveLength(1)
    expect(exportText(pages, [2], true)).toBe('--- Page 2 ---\n\nNeedle beta\n')
    for (const page of pages) {
      const strings = page.content.items.filter((item) => 'str' in item).map((item) => item.str)
      for (const run of page.runs) if (run.end > run.start) expect(page.text.slice(run.start, run.end)).toBe(strings[run.item])
    }
  } finally {
    await task.destroy()
  }
})
