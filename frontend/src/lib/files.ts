// Which files each tool takes. Shared by the Dropzone, window drops and paste.

export type FileKind = 'pdf' | 'image' | 'png' | 'jpg' | 'word' | 'excel' | 'powerpoint' | 'compressible'

type KindSpec = {
  /** The `accept` attribute for a file input. */
  accept: string
  /** Wording for one file ("a PDF") and several ("PDFs"). */
  one: string
  many: string
  is: (f: File) => boolean
}

const PDF: KindSpec = {
  accept: 'application/pdf,.pdf',
  one: 'a PDF',
  many: 'PDFs',
  is: (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'),
}

const IMAGE: KindSpec = {
  accept: 'image/jpeg,image/png,.jpg,.jpeg,.png',
  one: 'an image',
  many: 'images',
  is: (f) => f.type === 'image/jpeg' || f.type === 'image/png' || /\.(jpe?g|png)$/i.test(f.name),
}

export const FILE_KINDS: Record<FileKind, KindSpec> = {
  pdf: PDF,
  image: IMAGE,
  png: {
    accept: 'image/png,.png', one: 'a PNG image', many: 'PNG images',
    is: (f) => f.type === 'image/png' || /\.png$/i.test(f.name),
  },
  jpg: {
    accept: 'image/jpeg,.jpg,.jpeg', one: 'a JPG image', many: 'JPG images',
    is: (f) => f.type === 'image/jpeg' || /\.jpe?g$/i.test(f.name),
  },
  // Office conversion requires a supported extension, even if the OS omits MIME.
  word: {
    accept: '.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    one: 'a Word document', many: 'Word documents', is: (f) => /\.docx?$/i.test(f.name),
  },
  excel: {
    accept: '.xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    one: 'an Excel workbook', many: 'Excel workbooks', is: (f) => /\.xlsx?$/i.test(f.name),
  },
  powerpoint: {
    accept: '.ppt,.pptx,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation',
    one: 'a PowerPoint presentation', many: 'PowerPoint presentations', is: (f) => /\.pptx?$/i.test(f.name),
  },
  /** What the Compress tool takes: a PDF, or pictures including WebP. */
  compressible: {
    accept: `${PDF.accept},${IMAGE.accept},image/webp,.webp`,
    one: 'a PDF or image',
    many: 'PDFs or images',
    is: (f) => PDF.is(f) || IMAGE.is(f) || f.type === 'image/webp' || f.name.toLowerCase().endsWith('.webp'),
  },
}

/** Keep the files of the wanted kind, in order; `skipped` counts the rest. */
export function pickFiles(files: Iterable<File>, kind: FileKind): { wanted: File[]; skipped: number } {
  const all = [...files]
  const wanted = all.filter(FILE_KINDS[kind].is)
  return { wanted, skipped: all.length - wanted.length }
}
