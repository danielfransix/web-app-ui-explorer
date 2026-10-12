import { useSyncExternalStore } from "react"
import type { Scenario, Transition } from "../shared/types"

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
  revision: string
  generatedAt?: string
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

async function refresh() {
  try {
    const response = await fetch(isStatic ? "api/state.json" : "api/state", { cache: "no-store" })
    if (!response.ok) throw new Error(`The explorer server answered ${response.status}`)
    state = (await response.json()) as ExplorerState
    failure = null
  } catch (error) {
    failure = error instanceof Error ? error.message : "The explorer server is not reachable"
  }
  notify()
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
    notify()
  })
}

export const getState = () => state
export const useExplorerState = () => useSyncExternalStore(subscribe, () => state)
export const useExplorerFailure = () => useSyncExternalStore(subscribe, () => failure)

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
  const ids = new Set(scenarios.map((scenario) => scenario.id))
  const fromParents = scenarios
    .filter((scenario) => scenario.parent && ids.has(scenario.parent))
    .map((scenario) => ({
      source: scenario.parent!,
      target: scenario.id,
      label: scenario.trigger,
    }))
  const seen = new Set(fromParents.map((edge) => `${edge.source}>${edge.target}`))
  return [...fromParents, ...declared.filter((edge) => !seen.has(`${edge.source}>${edge.target}`))]
}
