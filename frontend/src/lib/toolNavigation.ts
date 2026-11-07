import type { ToolId } from './tools'

export const TOOL_DETAILS: Record<ToolId, { title: string; description: string }> = {
  merge: { title: 'Merge PDFs', description: 'Combine your documents into one PDF, in the order you choose.' },
  split: { title: 'Split a PDF', description: 'Extract selected pages or separate a document into individual files.' },
  organize: { title: 'Organize pages', description: 'Reorder, rotate, crop, and resize pages before saving a new PDF.' },
  bookmarks: { title: 'Bookmarks', description: 'Create and arrange a table of contents for your PDF.' },
  metadata: { title: 'Document details', description: 'Review and edit your PDF’s title, author, and other metadata.' },
  text: { title: 'Search & extract text', description: 'Find text across pages, copy a passage, or save it as a text file.' },
  compare: { title: 'Compare PDFs', description: 'Review two PDFs side by side and find changes in text and appearance.' },
  ocr: { title: 'Recognize text', description: 'Make scanned pages searchable with on-device text recognition.' },
  edit: { title: 'Edit a PDF', description: 'Add text, images, highlights, and drawings, or move page content.' },
  forms: { title: 'Fill forms', description: 'Complete existing form fields and save a filled copy of your PDF.' },
  redact: { title: 'Redact a PDF', description: 'Permanently remove sensitive text and areas from your document.' },
  signatures: { title: 'Add signatures', description: 'Place a saved signature on the pages you choose.' },
  stamps: { title: 'Numbers & watermarks', description: 'Add page numbers and watermarks to your PDF.' },
  compress: { title: 'Compress files', description: 'Reduce the size of PDFs or images with control over quality.' },
  'pdf-images': { title: 'PDF to images', description: 'Export the pages you need as individual image files.' },
  passwords: { title: 'PDF passwords', description: 'Protect a PDF with a password, or unlock one you can already open.' },
  workflows: { title: 'Workflows', description: 'Apply a saved sequence of PDF tools to a batch of documents.' },
  images: { title: 'Images to PDF', description: 'Turn your images into a PDF with the page size and layout you need.' },
  photo: { title: 'Passport photo', description: 'Crop and size a photo for a passport or visa.' },
}

export function focusToolNavigation(tool: ToolId) {
  const tab = document.getElementById(`tab-${tool}`)
  const target = tab?.getClientRects().length ? tab : document.getElementById('tool-picker')
  target?.focus()
}
