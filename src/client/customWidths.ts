import { useSyncExternalStore } from "react"
import { isCustomWidth } from "./viewports"

// Custom widths a person has saved - shared between the Copy control (which can copy several at once)
// and the preview viewport picker (which can jump straight to one), so a size saved in either place
// shows up in both. Kept in localStorage: a per-browser convenience, not state anything else reads back,
// so it's fine if it's empty in a private window or another browser.

export type CustomWidth = { id: string; label: string; width: number }

const STORAGE_KEY = "uix:customWidths"
const listeners = new Set<() => void>()

function read(): CustomWidth[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is CustomWidth =>
        entry && typeof entry.id === "string" && typeof entry.label === "string" && isCustomWidth(entry.width),
    )
  } catch {
    return []
  }
}

let cache = read()

function write(next: CustomWidth[]) {
  cache = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // A full or blocked localStorage just means this session's additions don't persist - not fatal.
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCustomWidths(): CustomWidth[] {
  return useSyncExternalStore(subscribe, () => cache)
}

export function addCustomWidth(label: string, width: number): CustomWidth {
  if (!isCustomWidth(width)) throw new Error("Enter a whole-number width from 1 to 7680 pixels.")
  const existing = cache.find((entry) => entry.width === width)
  if (existing) return existing
  const entry: CustomWidth = { id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, label, width }
  write([...cache, entry])
  return entry
}

if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY && event.key !== null) return
  cache = read()
  listeners.forEach((listener) => listener())
})

export function removeCustomWidth(id: string) {
  write(cache.filter((entry) => entry.id !== id))
}
