import { useSyncExternalStore } from "react"
import type { CrawlStats, Scenario, Transition } from "../shared/types"
import { canvasConnections } from "../shared/transitions"

// The explorer's data comes from the Vite plugin's API and stays current through server-sent events:
// scenarios, thumbnails and running jobs all change while the page is open.

export type JobState = {
  status: "idle" | "running" | "done" | "error" | "cancelled"
  message?: string
  progress?: Record<string, number | string | undefined>
  startedAt?: number
  finishedAt?: number
}

export type ExplorerState = {
  project: string
  startPath: string
  route: string
  mode: string
  capabilities?: { figmaImports?: number }
  revision: string
  generatedAt?: string
  crawlStats?: CrawlStats
  scenarios: Scenario[]
  transitions: Transition[]
  sources: string[]
  thumbnails: null | {
    revision: string
    capturedAt: string
    items: Record<string, string>
    failed: Record<string, string>
  }
  jobs: { crawl: JobState; capture: JobState }
}

/** A production snapshot of the explorer: read-only data files instead of a live server. */
export const isStatic = (window as unknown as { __UIX_STATIC?: boolean }).__UIX_STATIC === true

let state: ExplorerState | null = null
let failure: string | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

let refreshing = false
let refreshAgain = false
// Burst events share a request, with one trailing refresh so changes during a request are not lost.
// This also prevents slower, older responses from overwriting a newer state.
async function refresh() {
  if (refreshing) {
    refreshAgain = true
    return
  }
  refreshing = true
  try {
    const response = await fetch(isStatic ? "api/state.json" : "api/state", { cache: "no-store" })
    if (!response.ok) throw new Error(`The explorer server answered ${response.status}`)
    const next = (await response.json()) as ExplorerState
    // Job/capture updates do not change the screen catalog. Preserve these references so memoized
    // cards and the folder tree do not rebuild for every progress event.
    if (state) {
      for (const key of ["scenarios", "transitions", "sources", "thumbnails"] as const) {
        if (JSON.stringify(state[key]) === JSON.stringify(next[key]))
          Object.assign(next, { [key]: state[key] })
      }
    }
    state = next
    failure = null
  } catch (error) {
    failure = error instanceof Error ? error.message : "The explorer server is not reachable"
  }
  notify()
  refreshing = false
  if (refreshAgain) {
    refreshAgain = false
    void refresh()
  }
}

let connected = false
export function connect() {
  if (connected) return
  connected = true
  void refresh()
  if (isStatic) return
  const events = new EventSource("api/events")
  events.addEventListener("state", () => void refresh())
  events.addEventListener("job", (event) => {
    const { name, job } = JSON.parse((event as MessageEvent<string>).data) as {
      name: "crawl" | "capture"
      job: JobState
    }
    if (!state) return
    state = { ...state, jobs: { ...state.jobs, [name]: job } }
    if (refreshing) refreshAgain = true
    notify()
  })
}

export const getState = () => state
export const useExplorerState = () => useSyncExternalStore(subscribe, () => state)
export const useExplorerFailure = () => useSyncExternalStore(subscribe, () => failure)
// Cards care about capture/source changes, not each crawler progress tick.
export function useThumbnailUpdates() {
  useSyncExternalStore(subscribe, () => state?.thumbnails)
  useSyncExternalStore(subscribe, () => state?.revision)
}

const call = (path: string, method: "POST" | "DELETE", body?: unknown) =>
  fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

export const startCrawl = () => call("api/crawl", "POST")
export const cancelCrawl = () => call("api/crawl", "DELETE")
export const startCapture = (only?: string[]) => call("api/capture", "POST", { only })
export const cancelCapture = () => call("api/capture", "DELETE")

/** True for states reached by doing something on a screen, as opposed to screens themselves. */
export const isState = (scenario: Scenario) =>
  scenario.kind ? scenario.kind === "overlay" || scenario.kind === "variant" : !!scenario.actions?.length

/** Connections drawn on the canvas: parent links, plus any the project declares. */
export function connections(scenarios: Scenario[], declared: Transition[]): Transition[] {
  return canvasConnections(scenarios, declared)
}
