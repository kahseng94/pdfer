// Helpers for image files the user adds, shared by the Images and Edit tools.

// Pasted screenshots arrive as a nameless blob (Chrome calls every one "image.png").
let pasted = 0

/** The file, or a copy with a name of its own when it came from the clipboard. */
export function named(file: File): File {
  if (file.name && file.name !== 'image.png') return file
  pasted += 1
  return new File([file], `pasted-${pasted}.${file.type === 'image/jpeg' ? 'jpg' : 'png'}`, { type: file.type })
}

/** The image's size in pixels as the browser shows it, with its EXIF orientation applied. */
export function imageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('unreadable'))
    img.src = url
  })
}
