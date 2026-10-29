import { useEffect, useRef, useState } from 'react'

/** Whether a drag carries files, as opposed to text or links. */
export function isFileDrag(types: readonly string[] | undefined): boolean {
  return !!types && Array.from(types).includes('Files')
}

/**
 * Accept file drops anywhere in the window while `enabled`. A drop that lands
 * on a Dropzone (marked with data-dropzone) is left to it. Returns whether
 * files are being dragged over the window, so the caller can show an overlay.
 */
export function useWindowDrop(onFiles: (files: File[]) => void, enabled: boolean): boolean {
  const [dragging, setDragging] = useState(false)
  // Always call the latest handler without re-subscribing on every render.
  const latest = useRef(onFiles)
  useEffect(() => {
    latest.current = onFiles
  })

  useEffect(() => {
    if (!enabled) return
    // dragenter/dragleave fire for every element the cursor crosses, so count them.
    let depth = 0

    function onEnter(e: DragEvent) {
      if (!isFileDrag(e.dataTransfer?.types)) return
      depth += 1
      setDragging(true)
    }
    function onOver(e: DragEvent) {
      if (isFileDrag(e.dataTransfer?.types)) e.preventDefault() // lets the drop happen
    }
    function onLeave(e: DragEvent) {
      if (!isFileDrag(e.dataTransfer?.types)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    function onDrop(e: DragEvent) {
      if (!isFileDrag(e.dataTransfer?.types)) return
      depth = 0
      setDragging(false)
      if ((e.target as Element | null)?.closest?.('[data-dropzone]')) return
      e.preventDefault()
      latest.current([...(e.dataTransfer?.files ?? [])])
    }

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
      setDragging(false)
    }
  }, [enabled])

  return dragging
}
