export type ImagePdfLayout = {
  paper: 'image' | 'a4' | 'letter'
  orientation: 'portrait' | 'landscape'
  marginMm: number
  fit: 'contain' | 'cover' | 'stretch'
}

export const DEFAULT_IMAGE_LAYOUT: ImagePdfLayout = { paper: 'a4', orientation: 'portrait', marginMm: 10, fit: 'contain' }
export const IMAGE_FITS = [
  { value: 'contain', label: 'Fit whole image', hint: 'Keep proportions; leave extra space if needed' },
  { value: 'cover', label: 'Fill and crop', hint: 'Keep proportions; crop equally from the edges' },
  { value: 'stretch', label: 'Stretch', hint: 'Fill the area by changing the image’s proportions' },
] as const

/** Hidden paper-layout controls do not affect the original image-size mode. */
export function effectiveImageLayout(layout: ImagePdfLayout): ImagePdfLayout {
  return layout.paper === 'image' ? { paper: 'image', orientation: 'portrait', marginMm: 0, fit: 'contain' } : layout
}

export function imageLayoutProblem(layout: ImagePdfLayout): string | null {
  if (layout.paper === 'image') return null
  if (!Number.isFinite(layout.marginMm) || layout.marginMm < 0 || layout.marginMm > 100) return 'Margins must be from 0 to 100 mm.'
  return null
}

export function imagePaperSize(layout: ImagePdfLayout): [number, number] | null {
  if (layout.paper === 'image') return null
  const size: [number, number] = layout.paper === 'a4' ? [210, 297] : [215.9, 279.4]
  return layout.orientation === 'landscape' ? [size[1], size[0]] : size
}

export function imageLayoutSummary(layout: ImagePdfLayout): string {
  const size = imagePaperSize(layout)
  if (!size) return 'Each page matches its image’s size and resolution'
  return `${layout.paper === 'a4' ? 'A4' : 'Letter'} ${layout.orientation} · ${size[0]} × ${size[1]} mm · ${layout.marginMm} mm margins`
}
