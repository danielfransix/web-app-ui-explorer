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
  /** Set on a finished crawl that found little besides a login screen. */
  needsLogin?: boolean
}

export type ExplorerState = {
  project: string
  projectId?: string
  identities?: { version: 1; projectId: string; screens: Record<string, string> }
  startPath: string
  route: string
  mode: string
  capabilities?: { figmaImports?: number }
  revision: string
  generatedAt?: string
  crawlStats?: CrawlStats
  /** This project's configured crawl limits, shown as placeholders for a per-run override. */
  crawlDefaults?: { maxStates: number; timeBudgetMs: number }
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

// A rolling copy of what the server has logged (crawl/capture/login), for copying out when a run looks
// stuck or its result is a surprise. Capped the same way the server caps its own buffer.
const LOG_LIMIT = 4000
let logLines: string[] = []
const logListeners = new Set<() => void>()
const notifyLogs = () => logListeners.forEach((listener) => listener())
const subscribeLogs = (listener: () => void) => {
  logListeners.add(listener)
  return () => {
    logListeners.delete(listener)
  }
}
export const useLogs = () => useSyncExternalStore(subscribeLogs, () => logLines)
export async function fetchLogs(): Promise<string[]> {
  const response = await fetch("api/logs", { cache: "no-store" })
  logLines = (await response.text()).split("\n").filter(Boolean)
  notifyLogs()
  return logLines
}

let connected = false
export function connect() {
  if (connected) return
  connected = true
  void refresh()
  if (isStatic) return
  void fetchLogs()
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
  events.addEventListener("log", (event) => {
    const { line } = JSON.parse((event as MessageEvent<string>).data) as { line: string }
    logLines = logLines.length >= LOG_LIMIT ? [...logLines.slice(1), line] : [...logLines, line]
    notifyLogs()
  })
}

export const getState = () => state
export const useExplorerState = () => useSyncExternalStore(subscribe, () => state)
export const useScreenId = (scenarioId: string) => useSyncExternalStore(subscribe, () => state?.identities?.screens[scenarioId])
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

export const startCrawl = (overrides?: { maxStates?: number; timeBudgetMs?: number }) => call("api/crawl", "POST", overrides)
export const cancelCrawl = () => call("api/crawl", "DELETE")
export const startCapture = (only?: string[]) => call("api/capture", "POST", { only })
export const cancelCapture = () => call("api/capture", "DELETE")
/** Everything in this origin's localStorage, read straight from the browser — same origin as the app the proxy
 *  fronts, so this is whatever the app itself wrote there, including after a login completed in another tab. */
function readLocalStorage(): Record<string, string> {
  const entries: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key !== null) entries[key] = localStorage.getItem(key) ?? ""
  }
  return entries
}

/** Checked once before a login attempt starts, so the server has something to compare against once it's done
 *  (see useLoginCapture and ../node/login-check for why one page, not a whole crawl, is what gets compared). */
export const checkLoginPage = (url: string) => call("api/login/check", "POST", { url }).then((response) => response.json())

/** Saves the session the person just logged into (cookies ride along on this same-origin request automatically;
 *  localStorage is read explicitly since, unlike cookies, it isn't attached to a request). `checkUrl`, when
 *  given, must match what was passed to checkLoginPage for the server to compare before/after. */
export const saveSession = (checkUrl?: string) => call("api/login", "POST", { localStorage: readLocalStorage(), checkUrl })

export type AutoLoginResult = { started?: boolean; error?: string }

/** Fills and submits a login form once, using credentials typed into Explorer's own UI for this run only —
 *  see useAutoLogin and ../node/auto-login for the full reasoning. The same session that logs in is handed
 *  straight to the crawl server-side; progress shows up the normal way (job status, Logs panel), not through
 *  this call. `headless` false opens a visible window instead, for watching it work or finishing a step a
 *  generic selector couldn't reach. Only ever available when Explorer is bound to loopback only; the server
 *  refuses it otherwise. */
export const submitAutoLogin = (url: string, username: string, password: string, headless: boolean): Promise<AutoLoginResult> =>
  call("api/login/headless", "POST", { url, username, password, headless }).then((response) => response.json())

/** True for states reached by doing something on a screen, as opposed to screens themselves. */
export const isState = (scenario: Scenario) =>
  scenario.kind ? scenario.kind === "overlay" || scenario.kind === "variant" : !!scenario.actions?.length

/** Connections drawn on the canvas: parent links, plus any the project declares. */
export function connections(scenarios: Scenario[], declared: Transition[]): Transition[] {
  return canvasConnections(scenarios, declared)
}
