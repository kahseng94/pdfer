// Remembers whether the tool sidebar was hidden. Storage can be blocked, so every call is guarded.

const KEY = 'pdfer.sidebar'

export function loadSidebarHidden(): boolean {
  try {
    return localStorage.getItem(KEY) === 'hidden'
  } catch {
    return false
  }
}

export function saveSidebarHidden(hidden: boolean): void {
  try {
    localStorage.setItem(KEY, hidden ? 'hidden' : 'shown')
  } catch {
    // Not remembered this time; the sidebar still shows or hides.
  }
}
