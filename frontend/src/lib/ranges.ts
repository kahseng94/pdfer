// Client-side page-range parsing, used to highlight pages and warn early.
// The backend is the source of truth and validates the spec again.

/** 1-based, inclusive. */
export type PageRange = [start: number, end: number]

/** Parse a spec like "1-3, 5, 8-". "N-" runs to the last page, "-N" starts at 1. */
export function parseSpec(spec: string, total: number): { ranges: PageRange[]; invalid: string[] } {
  const ranges: PageRange[] = []
  const invalid: string[] = []
  for (const raw of spec.split(',')) {
    const part = raw.trim()
    if (!part) continue
    const m = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(part)
    if (!m || !(m[1] || m[3])) {
      invalid.push(part)
      continue
    }
    const start = m[2] ? (m[1] ? Number(m[1]) : 1) : Number(m[1] ?? m[3])
    const end = m[2] ? (m[3] ? Number(m[3]) : total) : start
    if (start < 1 || end > total || start > end) invalid.push(part)
    else ranges.push([start, end])
  }
  return { ranges, invalid }
}

export function pagesIn(ranges: PageRange[]): Set<number> {
  const pages = new Set<number>()
  for (const [start, end] of ranges) for (let p = start; p <= end; p++) pages.add(p)
  return pages
}

/** Turn page numbers into a compact spec, e.g. {1,2,3,5} -> "1-3, 5". */
export function toSpec(pages: Iterable<number>): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b)
  const parts: string[] = []
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`)
    i = j + 1
  }
  return parts.join(', ')
}

export type Rotation = 0 | 90 | 180 | 270

/** One page of an organized document: its original number and a clockwise turn. */
export type PageOp = { page: number; rotation: Rotation }

/** The next quarter turn clockwise. */
export function turn(rotation: Rotation): Rotation {
  return ((rotation + 90) % 360) as Rotation
}

/** Turn page ops into the spec the backend takes, e.g. "3:90,1,2:180". */
export function toPageSpec(ops: readonly PageOp[]): string {
  return ops.map(({ page, rotation }) => (rotation ? `${page}:${rotation}` : `${page}`)).join(',')
}
