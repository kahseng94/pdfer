import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { cellAlign, cellKey, cellText, columnName, type CellPosition, type SheetView } from '../lib/sheetView'

const ROW_HEIGHT = 28
const HEADER_HEIGHT = 28
const OVERSCAN = 6
/** Used until the grid has been measured, and by test environments without layout. */
const FALLBACK_SIZE = { width: 960, height: 560 }

type Props = {
  view: SheetView
  widths: number[]
  label: string
  selected: CellPosition | null
  onSelect: (cell: CellPosition) => void
  /** Keys of cells that match the search, and the match being looked at. */
  matches: Set<number>
  current: CellPosition | null
}

/** The column under `x`, measured from the first column's left edge; the last column past the end. */
function columnAt(offsets: number[], x: number): number {
  let low = 0, high = offsets.length - 2
  while (low < high) {
    const middle = (low + high) >> 1
    if (offsets[middle + 1] <= x) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * A read-only spreadsheet grid that draws only the rows and columns in view, so
 * a sheet of 100,000 rows scrolls as smoothly as one of ten. Column letters and
 * row numbers stay put while scrolling; arrow keys move the selected cell.
 */
export function SheetGrid({ view, widths, label, selected, onSelect, matches, current }: Props) {
  const id = useId()
  const scroller = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ top: 0, left: 0 })
  const [size, setSize] = useState(FALLBACK_SIZE)
  const rowCount = view.rows.length
  const columnCount = view.columns
  const gutter = Math.max(44, String(rowCount).length * 8 + 20)
  const offsets = useMemo(() => {
    const out = [0]
    for (const width of widths) out.push(out[out.length - 1] + width)
    return out
  }, [widths])
  const totalWidth = gutter + offsets[columnCount]

  useEffect(() => {
    const node = scroller.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (node.clientWidth && node.clientHeight) setSize({ width: node.clientWidth, height: node.clientHeight })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // Bring the selected cell into view, clear of the pinned header row and row numbers.
  useLayoutEffect(() => {
    const node = scroller.current
    if (!node || !selected) return
    const height = node.clientHeight || size.height
    const width = node.clientWidth || size.width
    const top = selected.row * ROW_HEIGHT
    if (top < node.scrollTop) node.scrollTop = top
    else if (top + ROW_HEIGHT > node.scrollTop + height - HEADER_HEIGHT) node.scrollTop = top + ROW_HEIGHT - height + HEADER_HEIGHT
    const left = offsets[selected.column], right = offsets[selected.column + 1]
    if (left < node.scrollLeft) node.scrollLeft = left
    else if (right > node.scrollLeft + width - gutter) node.scrollLeft = right - width + gutter
    setScroll({ top: node.scrollTop, left: node.scrollLeft })
  }, [selected, offsets, gutter, size])

  const firstRow = Math.max(0, Math.floor(scroll.top / ROW_HEIGHT) - OVERSCAN)
  const lastRow = Math.min(rowCount - 1, Math.ceil((scroll.top + size.height - HEADER_HEIGHT) / ROW_HEIGHT) + OVERSCAN)
  const firstColumn = columnCount ? Math.max(0, columnAt(offsets, scroll.left) - 2) : 0
  const lastColumn = columnCount ? Math.min(columnCount - 1, columnAt(offsets, scroll.left + size.width - gutter) + 2) : -1
  const columns: number[] = []
  for (let column = firstColumn; column <= lastColumn; column++) columns.push(column)
  const cellId = (cell: CellPosition) => `${id}-${cell.row}-${cell.column}`
  const activeVisible = selected && selected.row >= firstRow && selected.row <= lastRow && selected.column >= firstColumn && selected.column <= lastColumn

  function move(event: KeyboardEvent<HTMLDivElement>) {
    if (!rowCount || !columnCount) return
    const at = selected ?? { row: 0, column: 0 }
    const page = Math.max(1, Math.floor((size.height - HEADER_HEIGHT) / ROW_HEIGHT) - 1)
    const jump = event.ctrlKey || event.metaKey
    let next: CellPosition | null = null
    switch (event.key) {
      case 'ArrowDown': next = { row: jump ? rowCount - 1 : at.row + 1, column: at.column }; break
      case 'ArrowUp': next = { row: jump ? 0 : at.row - 1, column: at.column }; break
      case 'ArrowRight': next = { row: at.row, column: jump ? columnCount - 1 : at.column + 1 }; break
      case 'ArrowLeft': next = { row: at.row, column: jump ? 0 : at.column - 1 }; break
      case 'PageDown': next = { row: at.row + page, column: at.column }; break
      case 'PageUp': next = { row: at.row - page, column: at.column }; break
      case 'Home': next = jump ? { row: 0, column: 0 } : { row: at.row, column: 0 }; break
      case 'End': next = jump ? { row: rowCount - 1, column: columnCount - 1 } : { row: at.row, column: columnCount - 1 }; break
      default:
        if (jump && event.key.toLowerCase() === 'c' && selected) {
          const text = cellText(view.rows[selected.row]?.[selected.column])
          void navigator.clipboard?.writeText(text).catch(() => {})
        }
        return
    }
    event.preventDefault()
    onSelect({ row: Math.min(Math.max(next.row, 0), rowCount - 1), column: Math.min(Math.max(next.column, 0), columnCount - 1) })
  }

  const header = 'border-r border-b border-zinc-200 bg-zinc-100 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400'
  return (
    <div
      ref={scroller}
      role="grid"
      aria-label={label}
      aria-rowcount={rowCount + 1}
      aria-colcount={columnCount + 1}
      aria-readonly="true"
      aria-activedescendant={activeVisible ? cellId(selected) : undefined}
      tabIndex={0}
      onKeyDown={move}
      onScroll={(event) => setScroll({ top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft })}
      className="relative h-[min(70vh,640px)] min-h-60 overflow-auto rounded-lg border border-zinc-200 bg-white text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <div role="row" aria-rowindex={1} className="sticky top-0 z-20 flex" style={{ width: totalWidth, height: HEADER_HEIGHT }}>
        <div role="columnheader" aria-colindex={1} aria-label="Row numbers" className={`${header} sticky left-0 z-30 shrink-0`} style={{ width: gutter }} />
        <div role="presentation" className="shrink-0" style={{ width: offsets[firstColumn] }} />
        {columns.map((column) => <div
          key={column}
          role="columnheader"
          aria-colindex={column + 2}
          className={`${header} flex shrink-0 items-center justify-center ${selected?.column === column ? 'bg-zinc-200 font-semibold text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100' : ''}`}
          style={{ width: widths[column] }}
        >{columnName(column)}</div>)}
      </div>
      <div role="rowgroup" className="relative" style={{ width: totalWidth, height: rowCount * ROW_HEIGHT }}>
        {Array.from({ length: Math.max(0, lastRow - firstRow + 1) }, (_, index) => {
          const row = firstRow + index
          const cells = view.rows[row]
          return <div key={row} role="row" aria-rowindex={row + 2} className="absolute left-0 flex" style={{ top: row * ROW_HEIGHT, height: ROW_HEIGHT, width: totalWidth }}>
            <div role="rowheader" aria-colindex={1} className={`${header} sticky left-0 z-10 flex shrink-0 items-center justify-end px-2 tabular-nums ${selected?.row === row ? 'bg-zinc-200 font-semibold text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100' : ''}`} style={{ width: gutter }}>{row + 1}</div>
            <div role="presentation" className="shrink-0" style={{ width: offsets[firstColumn] }} />
            {columns.map((column) => {
              const cell = cells[column]
              const position = { row, column }
              const isSelected = selected?.row === row && selected.column === column
              const isCurrent = current?.row === row && current.column === column
              const isMatch = matches.has(cellKey(view, position))
              const align = cellAlign(cell)
              return <div
                key={column}
                id={cellId(position)}
                role="gridcell"
                aria-colindex={column + 2}
                aria-selected={isSelected}
                onMouseDown={() => onSelect(position)}
                className={`shrink-0 truncate border-r border-b border-zinc-100 px-2 leading-[27px] whitespace-nowrap dark:border-zinc-800/70 ${
                  align === 'right' ? 'text-right tabular-nums' : align === 'center' ? 'text-center' : ''
                } ${isCurrent ? 'bg-amber-300 dark:bg-amber-700/70' : isMatch ? 'bg-amber-100 dark:bg-amber-900/40' : ''} ${
                  isSelected ? 'outline-2 -outline-offset-2 outline-rose-600' : ''
                } ${cell != null && typeof cell !== 'string' && cell[1] === 'e' ? 'text-red-700 dark:text-red-400' : 'text-zinc-800 dark:text-zinc-200'}`}
                style={{ width: widths[column] }}
              >{cellText(cell)}</div>
            })}
          </div>
        })}
      </div>
    </div>
  )
}
