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
  'copy-pdf': { title: 'Copy between PDFs', description: 'Open two PDFs side by side and copy parts of one onto the pages of the other.' },
  forms: { title: 'Fill forms', description: 'Complete existing form fields and save a filled copy of your PDF.' },
  'form-builder': { title: 'Create a form', description: 'Add text boxes, checkboxes, dropdowns, and radio buttons to make a PDF fillable.' },
  redact: { title: 'Redact a PDF', description: 'Permanently remove sensitive text and areas from your document.' },
  signatures: { title: 'Add signatures', description: 'Place a saved signature on the pages you choose.' },
  stamps: { title: 'Numbers & watermarks', description: 'Add page numbers and watermarks to your PDF.' },
  compress: { title: 'Compress files', description: 'Reduce the size of PDFs or images with control over quality.' },
  'pdf-images': { title: 'PDF to images', description: 'Export the pages you need as individual image files.' },
  passwords: { title: 'PDF passwords', description: 'Protect a PDF with a password, or unlock one you can already open.' },
  workflows: { title: 'Workflows', description: 'Apply a saved sequence of PDF tools to a batch of documents.' },
  word: { title: 'Word to PDF', description: 'Export your document with its page layout and the fonts installed on this computer.' },
  excel: { title: 'Excel to PDF', description: 'Create a PDF using your workbook’s print areas, page breaks, and scaling.' },
  powerpoint: { title: 'PowerPoint to PDF', description: 'Save each visible slide as a PDF page in presentation order.' },
  png: { title: 'PNG to PDF', description: 'Arrange PNG images in order and choose the page size for your PDF.' },
  jpg: { title: 'JPG to PDF', description: 'Arrange JPEG photos in order and fit them to the PDF page size you choose.' },
  images: { title: 'Images to PDF', description: 'Turn your images into a PDF with the page size and layout you need.' },
  'sheet-view': { title: 'View a spreadsheet', description: 'Browse and search an Excel workbook or CSV file, with values shown as Excel formats them.' },
  'excel-csv': { title: 'Excel to CSV', description: 'Save a worksheet, or every sheet, as CSV text that other apps can import.' },
  'csv-excel': { title: 'CSV to Excel', description: 'Turn CSV files into a workbook with real numbers and dates, one sheet per file.' },
  markdown: { title: 'Markdown editor', description: 'Write or open a Markdown file and see it formatted as you type.' },
  'photo-resize': { title: 'Resize photos', description: 'Scale photos to a width, height, box or percentage, one or many at a time.' },
  'photo-crop': { title: 'Crop a photo', description: 'Cut out part of a photo with a free or fixed-ratio frame, after turning or flipping it.' },
  'photo-rotate': { title: 'Rotate & flip photos', description: 'Turn photos in quarter turns or mirror them, all at once.' },
  'photo-convert': { title: 'Convert images', description: 'Save photos as JPEG, PNG or WebP, choosing the quality and the colour behind transparency.' },
  'photo-adjust': { title: 'Adjust a photo', description: 'Change brightness, contrast, saturation and sharpness, or make a photo black and white.' },
  'photo-info': { title: 'Photo details', description: 'See a photo’s camera, exposure and location data, and remove it before sharing.' },
  photo: { title: 'Passport photo', description: 'Crop and size a photo for a passport or visa.' },
}

export function focusToolNavigation(tool: ToolId) {
  const tab = document.getElementById(`tab-${tool}`)
  const target = tab?.getClientRects().length ? tab : document.getElementById('tool-picker')
  target?.focus()
}
