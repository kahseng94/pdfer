// Remembers which tab was open last. Storage can be blocked, so every call is guarded.

const KEY = 'pdfer.tool'

/** The stored value when it is one of the known ids, else the fallback. */
export function parseToolId<T extends string>(value: unknown, ids: readonly T[], fallback: T): T {
  return typeof value === 'string' && (ids as readonly string[]).includes(value) ? (value as T) : fallback
}

export function loadTool<T extends string>(ids: readonly T[], fallback: T): T {
  try {
    return parseToolId(localStorage.getItem(KEY), ids, fallback)
  } catch {
    return fallback
  }
}

export function saveTool(id: string): void {
  try {
    localStorage.setItem(KEY, id)
  } catch {
    // Not remembered this time; nothing else depends on it.
  }
}
