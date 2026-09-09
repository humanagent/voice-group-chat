const KEY = "the-room-draft"
const empty = { text: "", saved: true }
let current: typeof empty | null = null
const listeners = new Set<() => void>()

export const serverDraft = () => empty
export function getDraft() {
  if (!current) {
    try { current = { text: localStorage.getItem(KEY) ?? "", saved: true } }
    catch { current = { text: "", saved: false } }
  }
  return current
}
export function saveDraft(text: string) {
  let saved = true
  try { localStorage.setItem(KEY, text) } catch { saved = false }
  current = { text, saved }
  listeners.forEach((listener) => listener())
}
export function subscribeDraft(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
