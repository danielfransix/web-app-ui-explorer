// Each live thumbnail is a full copy of the app in its own iframe, so only a few run at once. Eight covers
// two rows of cards on a wide screen; cards past the limit wait for a slot and load as others scroll away.
// Cached captures skip this budget entirely.
const LIMIT = 8
const owners = new Set<object>()
const listeners = new Set<() => void>()
const publish = () => listeners.forEach((listener) => listener())

export function subscribePreviewBudget(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function acquirePreview(owner: object) {
  if (owners.has(owner)) return true
  if (owners.size >= LIMIT) return false
  owners.add(owner)
  return true
}
export function releasePreview(owner: object) {
  if (owners.delete(owner)) queueMicrotask(publish)
}
