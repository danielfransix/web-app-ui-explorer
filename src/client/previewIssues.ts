import { useSyncExternalStore } from "react"

// Live previews that failed to start, reported by the card (or enlarged view) that is showing them.
// The explorer lists these next to failed thumbnail captures so a failure can be traced to its source.
// Several views can show the same screen, so each reporter holds its own entry and an issue clears
// only when every reporter has let go of it.
const holders = new Map<string, Map<symbol, string>>()
let snapshot: ReadonlyMap<string, string> = new Map()
const listeners = new Set<() => void>()

function publish() {
  snapshot = new Map(
    [...holders].flatMap(([id, owners]) => {
      const message = [...owners.values()][0]
      return message ? [[id, message] as const] : []
    }),
  )
  listeners.forEach((listener) => listener())
}

export function reportPreviewIssue(id: string, message: string) {
  const owner = Symbol(id)
  const owners = holders.get(id) ?? new Map<symbol, string>()
  owners.set(owner, message)
  holders.set(id, owners)
  publish()
  return () => {
    owners.delete(owner)
    if (!owners.size) holders.delete(id)
    publish()
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function usePreviewIssues() {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  )
}
