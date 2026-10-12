import { getState } from "./data"

// Cached thumbnails come from the capture job. A capture is used only while its revision matches the app's
// current source; otherwise the card falls back to a live preview, so a stale image can never misrepresent
// a screen.
type Thumbnail =
  | { state: "fresh"; url: string; capturedAt: string }
  | { state: "stale" | "missing" | "failed"; reason?: string }

export function thumbnailFor(id: string): Thumbnail {
  const explorer = getState()
  const manifest = explorer?.thumbnails
  if (!explorer || !manifest) return { state: "missing" }
  const failure = manifest.failed[id]
  if (failure) return { state: "failed", reason: failure }
  const file = manifest.items[id]
  if (!file) return { state: "missing" }
  if (manifest.revision !== explorer.revision) return { state: "stale" }
  return { state: "fresh", url: `thumbnails/${file}?v=${encodeURIComponent(manifest.capturedAt)}`, capturedAt: manifest.capturedAt }
}
