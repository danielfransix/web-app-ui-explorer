import type { Action, ReplayOptions, ReplayResult, ReplayStatus } from "../shared/types"

// Only an unloading document writes this checkpoint. The destination consumes it once; a completed
// preview leaves nothing to replay on refresh or when someone subsequently follows a link themselves.
const KEY = "__uix:replay:v1"
// getRandomValues also works on HTTP development hosts where randomUUID is unavailable.
export const replayId = () => crypto.getRandomValues(new Uint32Array(4)).join("-")
// sessionStorage is shared by same-origin iframes in a tab. The embedding element survives its
// document's navigation, so give each frame its own key without changing window.name or app URLs.
function contextKey(): string | undefined {
  if (window === window.top) return KEY
  const frame = window.frameElement
  if (!frame) return // A cross-origin embedding cannot provide a stable frame identity.
  let id = frame.getAttribute("data-uix-replay-context")
  if (!id) { id = replayId(); frame.setAttribute("data-uix-replay-context", id) }
  return `${KEY}:${id}`
}
type Job = {
  id: string
  actions: Action[]
  next: number
  deadline: number
  remainingMs: number
  options: ReplayOptions
  endpoint: string
  preview?: string
  static?: boolean
}

export function takeContinuation(): Job | undefined {
  try {
    // Removed frames may never consume their checkpoint. Expire those records on the next runtime load.
    for (const key of Object.keys(sessionStorage).filter(key => key === KEY || key.startsWith(`${KEY}:`))) {
      try { if (!(JSON.parse(sessionStorage.getItem(key)!).deadline > Date.now())) sessionStorage.removeItem(key) }
      catch { sessionStorage.removeItem(key) }
    }
    const key = contextKey()
    if (!key) return
    const raw = sessionStorage.getItem(key)
    if (!raw) return
    sessionStorage.removeItem(key)
    const job = JSON.parse(raw) as Job
    if (typeof job.id !== "string" || !Array.isArray(job.actions) || job.actions.length > 1000 || !job.options || typeof job.options !== "object" || !Number.isInteger(job.next) ||
      job.next < 0 || job.next > job.actions.length || typeof job.deadline !== "number" ||
      job.deadline <= Date.now() || job.deadline > Date.now() + 300_000 ||
      !Number.isFinite(job.remainingMs) || job.remainingMs <= 0 || job.remainingMs > 300_000 ||
      typeof job.endpoint !== "string" || !job.endpoint.startsWith("/") || job.endpoint.startsWith("//") ||
      (job.preview !== undefined && typeof job.preview !== "string")) return
    if (!job.actions.every(action => action && typeof action.selector === "string" &&
      (action.kind === "click" || (action.kind === "fill" && typeof action.value === "string")))) return
    return job
  } catch { return }
}

export function replayController(host: {
  resolve(action: Action, timeoutMs: number): Promise<Element | null>
  perform(action: Action, element: Element): void
  settle(quietMs: number): Promise<void>
  ready(): Promise<void>
  report(id: string, error?: string): void
  endpoint(): string
  isStatic(): boolean
}) {
  const timer = window.setTimeout.bind(window)
  const key = contextKey()
  let job: Job | undefined
  let status: ReplayStatus | undefined
  let leaving = false
  let watchdog: number | undefined
  let complete: ((result: ReplayResult) => void) | undefined
  let segmentStarted = 0
  const clear = () => { try { if (key) sessionStorage.removeItem(key) } catch { /* Storage can be disabled. */ } }
  const finish = (current: Job, result: ReplayResult) => {
    if (job !== current || status?.result) return
    clearTimeout(watchdog)
    clear()
    status = { id: current.id, step: status?.step ?? 0, result }
    if (current.preview) host.report(current.preview, result.ok ? undefined : result.message)
    complete?.(result)
    complete = undefined
  }
  window.addEventListener("pagehide", () => {
    if (!job || status?.result) return
    leaving = true
    // Capture freezes Date; performance.timeOrigin can also differ across document clock contexts.
    // Carry the remaining duration, measured locally in each document, as well as the expiry timestamp.
    job.remainingMs -= Math.max(0, performance.now() - segmentStarted)
    try { if (key) sessionStorage.setItem(key, JSON.stringify(job)) } catch { /* Checked before native navigation. */ }
  })
  // Programmatic location changes and form navigation can unload without an anchor click.
  window.addEventListener("beforeunload", () => { if (job && !status?.result) leaving = true })

  const execute = async (current: Job) => {
    try {
      await host.ready()
      for (let index = current.next; index < current.actions.length; index++) {
        if (job !== current || status?.result || leaving) return
        status = { id: current.id, step: index }
        const action = current.actions[index]
        const element = await host.resolve(action, current.options.timeoutMs ?? 8000)
        if (job !== current || status?.result || leaving) return
        if (!element) throw new Error(`could not find ${action.selector}${action.kind === "click" && action.text ? ` "${action.text}"` : ""}`)
        let nativeNavigation = false
        let navigationError: string | undefined
        const events: Event[] = []
        const observe = (event: Event) => { events.push(event) }
        // Observe the actual event after application handlers have had a chance to prevent its default.
        // SPA links stay in this document; native links/forms must await the destination, even when its
        // response is slower than the old document's quiet-DOM window.
        const navigation = (event: Event) => {
          if (event.defaultPrevented) return
          const target = event.target instanceof Element ? event.target : undefined
          const anchor = event.type === "click" ? target?.closest("a[href]") as HTMLAnchorElement | null : null
          const form = event.type === "submit" && event.target instanceof HTMLFormElement ? event.target : null
          if (!anchor && !form) return
          const submitter = event instanceof SubmitEvent ? event.submitter as HTMLButtonElement | null : null
          if (form && (submitter?.getAttribute("formmethod") || form.method).toLowerCase() === "dialog") return
          const targetName = anchor?.target || submitter?.formTarget || form?.target
          if (targetName && targetName !== "_self") { event.preventDefault(); navigationError = "navigation to another browsing context is unsupported"; return }
          if (anchor?.hasAttribute("download")) { event.preventDefault(); navigationError = "download links cannot be replayed"; return }
          const url = new URL(anchor?.href ?? submitter?.getAttribute("formaction") ?? form!.action, location.href)
          if (url.protocol === "javascript:") return
          if (url.origin !== location.origin) { event.preventDefault(); navigationError = "navigation outside the app origin is unsupported"; return }
          if (anchor && url.pathname === location.pathname && url.search === location.search && url.hash) return
          try {
            if (!key) throw new Error("No same-origin frame identity")
            sessionStorage.setItem(key, JSON.stringify(current))
            sessionStorage.removeItem(key)
          } catch {
            event.preventDefault()
            navigationError = "page navigation requires session storage; enable it for this app"
            return
          }
          nativeNavigation = true
        }
        window.addEventListener("click", navigation)
        window.addEventListener("submit", navigation)
        window.addEventListener("click", observe, true)
        window.addEventListener("submit", observe, true)
        current.next = index + 1
        try {
          host.perform(action, element)
          // stopPropagation does not cancel a link's default navigation. Capture its event and inspect
          // defaultPrevented after dispatch even when application handlers stop the bubbling phase.
          for (const event of events) navigation(event)
        }
        finally {
          window.removeEventListener("click", navigation)
          window.removeEventListener("submit", navigation)
          window.removeEventListener("click", observe, true)
          window.removeEventListener("submit", observe, true)
        }
        if (navigationError) throw new Error(navigationError)
        await host.settle(current.options.settleMs ?? 120)
        if (nativeNavigation || leaving || job !== current || status?.result) return
      }
      if (!leaving) finish(current, { ok: true })
    } catch (error) {
      const step = status?.step ?? 0
      finish(current, { ok: false, step, message: `Step ${step + 1} of ${current.actions.length}: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  const run = (current: Job) => {
    if (job && job.id !== current.id && !status?.result) finish(job, { ok: false, step: status?.step ?? 0, message: "Replay replaced by a new job" })
    clearTimeout(watchdog)
    clear()
    job = current
    leaving = false
    status = { id: current.id, step: current.next }
    segmentStarted = performance.now()
    watchdog = timer(() => finish(current, { ok: false, step: status?.step ?? 0, message: "Replay timed out waiting for page navigation or content" }), Math.max(1, Math.min(current.remainingMs, current.deadline - Date.now())))
    // Return control to the host before any action can replace this document.
    timer(() => void execute(current), 0)
  }
  const start = (id: string, actions: Action[], options: ReplayOptions = {}, preview?: string) => {
    const remainingMs = Math.min(300_000, 20_000 + Math.max(1, actions.length) * (options.timeoutMs ?? 8000))
    run({ id, actions, next: 0, options, preview, endpoint: host.endpoint(), static: host.isStatic(), remainingMs, deadline: Date.now() + remainingMs })
  }
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return
    const continuation = takeContinuation()
    if (continuation) run(continuation)
  })
  return {
    start,
    resume: run,
    status: () => status,
    cancel: () => {
      if (job) finish(job, { ok: false, step: status?.step ?? 0, message: "Replay cancelled" })
      clear()
    },
    replay: (actions: Action[], options?: ReplayOptions) => {
      start(replayId(), actions, options)
      return new Promise<ReplayResult>(resolve => { complete = resolve })
    },
  }
}
