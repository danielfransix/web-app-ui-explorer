import fs from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Browser, BrowserContext } from "playwright"
import type { Scenario, ScenariosFile, Transition } from "../../shared/types"
import { buildPlan } from "../../shared/plan"
import { capture, readManifest } from "../capture"
import { crawl } from "../crawl"
import { captureDesigns } from "../design-capture"
import type { UiExplorerOptions } from "../options"
import { affectsPreviews, computeRevision } from "../revision"
import { guessSources, listSources } from "../sources"
import { startBridge } from "../bridge"
import { selectionSchema } from "../local-import"
import { projectIdentity } from "../project-identity"
import { ensureScreenIdentities } from "../screen-identities"
import { buildStorageState } from "../session-capture"
import { checkPage, compareLoginCheck, type PageCheck } from "../login-check"
import { runAutoLogin } from "../auto-login"

// Named breakpoints the manual Copy control and the Figma export plan agree on - matches the client's
// own viewport presets (src/client/viewports.ts). A width outside this map falls back to its raw pixel
// value as the variant label, handled by buildPlan itself.
const BREAKPOINT_LABELS: Record<number, string> = { 1440: "Desktop", 768: "Tablet", 390: "Mobile" }

// The explorer itself, with no knowledge of any bundler. It is a Node request handler plus a few hooks, so
// the same code runs behind the standalone `serve` proxy and inside the Vite plugin. A host only has to
// (1) put `runtimeTag()` into the app's HTML, (2) route requests under the explorer route to `handle()`,
// (3) call `invalidate()` when source files change and (4) write `snapshotFiles()` into a production build.

type JobName = "crawl" | "capture"
type Job = {
  status: "idle" | "running" | "done" | "error" | "cancelled"
  message?: string
  progress?: Record<string, unknown>
  startedAt?: number
  finishedAt?: number
  /** Set on a finished crawl that found little besides a login screen: little to show except the login option. */
  needsLogin?: boolean
}

// The one place every job name's idle shape is listed, so a static snapshot's placeholder jobs (below) can
// never drift out of sync with the live ones and omit a job the client expects to find.
const IDLE_JOBS: Record<JobName, Job> = { crawl: { status: "idle" }, capture: { status: "idle" } }

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json",
}

const here = path.dirname(fileURLToPath(import.meta.url))

/** Finds a file the build put next to the node code, whichever of the candidate layouts the package has. */
export function packageFile(...candidates: string[]) {
  for (const candidate of candidates) {
    for (const base of [here, path.resolve(here, "..")]) {
      const file = path.resolve(base, candidate)
      if (fs.existsSync(file)) return file
    }
  }
  throw new Error(`ui-explorer: ${candidates[0]} is missing from the package. Build it with \`npm run build\`.`)
}

const posix = (value: string) => value.split(path.sep).join("/")

/** The project's own name: package.json's, without a scope, else its folder. */
export function projectName(root: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { name?: string }
    if (pkg.name) return pkg.name.replace(/^@[^/]+\//, "")
  } catch {
    // No package.json: the folder name stands in.
  }
  return path.basename(root)
}

export type ExplorerInit = {
  /** Project root: where sources and the output folder live. */
  root: string
  options?: UiExplorerOptions
  /** Overrides the name taken from package.json. */
  project?: string
  /**
   * True only when the host this Explorer answers to is known to be loopback-only. Gates the automated-login
   * credential form specifically — stricter than the general proxy's own host checking, which (by design)
   * trusts a person's explicit choice to bind wider; a real plaintext password is sensitive enough to warrant
   * its own, non-configurable rule rather than inheriting that trust. Default false: unknown is treated as
   * "cannot prove this is safe," not "assume it's fine."
   */
  loopbackOnly?: boolean
}

export type Explorer = ReturnType<typeof createExplorer>

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

/**
 * The address crawl/capture/login agree the app lives at. A browser treats "localhost" and "127.0.0.1" as
 * different origins even though they're the same server here, so a request on one and a crawl triggered
 * against the other would silently see none of a session saved under the first — normalising every loopback
 * alias to the same host keeps a saved session usable regardless of which one a particular tab happened to
 * be on.
 */
function canonicalOrigin(req: IncomingMessage): string {
  const host = req.headers.host ?? "localhost"
  const separator = host.lastIndexOf(":")
  const hostname = separator === -1 ? host : host.slice(0, separator)
  const port = separator === -1 ? "" : host.slice(separator)
  return `http://${LOOPBACK_HOSTNAMES.has(hostname) ? "127.0.0.1" : hostname}${port}`
}

/** A write from another site must never start a crawl: it carries a foreign Origin or is marked cross-site. */
function isCrossSiteWrite(req: IncomingMessage): boolean {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return false
  if (req.headers["sec-fetch-site"] === "cross-site") return true
  const origin = req.headers.origin
  if (!origin) return false
  try {
    return new URL(origin).host !== req.headers.host
  } catch {
    return true
  }
}

export function createExplorer(init: ExplorerInit) {
  const options = init.options ?? {}
  const root = init.root
  const project = init.project ?? projectName(root)
  const loopbackOnly = init.loopbackOnly ?? false
  const route = `/${(options.route ?? "/__explorer").replace(/^\/+|\/+$/g, "")}`
  const mode = options.mode ?? "merge"
  const sourceDirs = options.sources ?? ["src"]
  const outDir = path.join(root, options.dir ?? ".ui-explorer")
  // A session saved earlier through the Explorer UI's login flow (see saveSession, below) lives here by
  // default. Picked up automatically on the next start so it survives a restart without editing the config
  // file — the config's own `storageState`, when set, always wins.
  if (!options.storageState && fs.existsSync(path.join(outDir, "auth.json"))) options.storageState = path.join(outDir, "auth.json")
  let bridge: ReturnType<typeof startBridge> | undefined
  let disposed = false
  let closing: Promise<void> | undefined
  const localBridge = (baseUrl: string) => {
    if (disposed) throw new Error("UI Explorer is closing. Reopen it to prepare an import.")
    // Start on first use, on a free loopback port, with the same capture settings as this Explorer.
    return bridge ??= startBridge({ root, baseUrl, port: 0, route, startPath: options.startPath, storageState: options.storageState, allowWrites: options.allowWrites }).catch(error => { bridge = undefined; throw error })
  }

  let revisionCache: string | undefined
  let sourcesCache: string[] | undefined
  const revision = () => (revisionCache ??= computeRevision(root, sourceDirs))
  // The source tree lists files that can render a screen, not every script.
  const sources = () => (sourcesCache ??= listSources(root, sourceDirs, false))

  // ---- Generated scenarios ---------------------------------------------------------------------------
  const scenariosFile = () => path.join(outDir, "scenarios.json")
  function readGenerated(): ScenariosFile | undefined {
    try {
      return JSON.parse(fs.readFileSync(scenariosFile(), "utf8"))
    } catch {
      return undefined
    }
  }
  const normaliseSource = (source: string | undefined) => {
    if (!source) return undefined
    const relative = source.replace(/^\.?\//, "").replace(new RegExp(`^${project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`), "")
    return `${project}/${relative}`
  }
  let live: Scenario[] = []

  function scenarios(): Scenario[] {
    const generated = (mode === "manual" ? [] : jobs.crawl.status === "running" ? live : (readGenerated()?.scenarios ?? [])).map(
      (scenario): Scenario => ({ ...scenario, origin: "crawled" }),
    )
    const manual = (mode === "auto" ? [] : (options.scenarios ?? [])).map((scenario): Scenario => ({ ...scenario, origin: "manual" }))
    const manualIds = new Set(manual.map((scenario) => scenario.id))
    return [...generated.filter((scenario) => !manualIds.has(scenario.id)), ...manual]
  }
  const visible = () =>
    scenarios()
      .filter((scenario) => !scenario.hidden)
      .map((scenario) => ({
        ...scenario,
        // States that could not be matched to a file are grouped under a stand-in folder.
        source: normaliseSource(scenario.source) ?? `${project}/other/${scenario.group.replace(/\//g, " ")}`,
      }))

  // ---- Jobs and events -------------------------------------------------------------------------------
  const jobs: Record<JobName, Job> = { ...IDLE_JOBS }
  const controllers: Partial<Record<JobName, AbortController>> = {}
  const clients = new Set<ServerResponse>()
  const send = (event: string, data: unknown) => {
    for (const client of clients) client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  let pingTimer: NodeJS.Timeout | undefined
  const ping = () => {
    clearTimeout(pingTimer)
    pingTimer = setTimeout(() => send("state", {}), 150)
  }
  const setJob = (name: JobName, job: Job) => {
    jobs[name] = job
    send("job", { name, job })
  }

  // A rolling record of what crawl/capture/login actually did, for copying out when a run looks stuck or its
  // result is a surprise. Kept server-side (not just the terminal `serve` happens to be running in) so it's
  // reachable from the UI even when nobody's watching that terminal.
  const LOG_LIMIT = 4000
  const logs: string[] = []
  const recordLog = (line: string) => {
    const stamped = `[${new Date().toISOString().slice(11, 23)}] ${line}`
    logs.push(stamped)
    if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT)
    send("log", { line: stamped })
  }

  function state() {
    const generated = readGenerated()
    const manifest = readManifest(path.join(outDir, "thumbnails"))
    const scenarios = visible()
    const identities = ensureScreenIdentities(root, scenarios, options.startPath ?? generated?.startPath ?? "/")
    return {
      project,
      projectId: projectIdentity(root),
      identities,
      startPath: options.startPath ?? generated?.startPath ?? "/",
      route,
      mode,
      capabilities: { figmaImports: 1 },
      revision: revision(),
      generatedAt: generated?.generatedAt,
      crawlStats: generated?.stats,
      scenarios,
      transitions: [...(mode === "manual" ? [] : generated?.transitions ?? []), ...(options.transitions ?? [])] as Transition[],
      sources: sources().map((file) => `${project}/${file}`),
      thumbnails: manifest
        ? {
            revision: manifest.revision,
            capturedAt: manifest.capturedAt,
            items: Object.fromEntries(Object.entries(manifest.items).map(([id, item]) => [id, item.file])),
            failed: manifest.failed,
          }
        : null,
      jobs,
    }
  }

  async function startCapture(baseUrl: string, only?: string[]) {
    if (jobs.capture.status === "running") return
    const controller = new AbortController()
    controllers.capture = controller
    setJob("capture", { status: "running", startedAt: Date.now(), progress: { done: 0, total: 0 } })
    try {
      // The curated set is what is shown by default, so it goes first.
      const all = scenarios()
        .filter((scenario) => !scenario.hidden)
        .sort((a, b) => Number(b.origin === "manual") - Number(a.origin === "manual"))
      await capture({
        baseUrl,
        startPath: options.startPath ?? "/",
        scenarios: all,
        outDir: path.join(outDir, "thumbnails"),
        revision: revision(),
        only,
        storageState: options.storageState,
        blockWrites: !options.allowWrites,
        signal: controller.signal,
        log: recordLog,
        onProgress: (progress) => {
          jobs.capture.progress = progress
          send("job", { name: "capture", job: jobs.capture })
        },
      })
      setJob("capture", { status: controller.signal.aborted ? "cancelled" : "done", finishedAt: Date.now() })
    } catch (error) {
      setJob("capture", { status: "error", message: error instanceof Error ? error.message : String(error) })
    }
    ping()
  }

  async function startCrawl(baseUrl: string, context?: BrowserContext, concurrency?: number) {
    if (jobs.crawl.status === "running") return
    const controller = new AbortController()
    controllers.crawl = controller
    live = []
    setJob("crawl", { status: "running", startedAt: Date.now(), progress: { states: 0, queued: 0, seconds: 0 } })
    try {
      const result = await crawl({
        baseUrl,
        startPath: options.startPath ?? "/",
        maxStates: options.maxStates,
        concurrency,
        deny: options.deny,
        storageState: options.storageState,
        context,
        blockWrites: !options.allowWrites,
        signal: controller.signal,
        log: recordLog,
        onProgress: (progress) => {
          jobs.crawl.progress = { ...progress }
          send("job", { name: "crawl", job: jobs.crawl })
        },
        onState: (scenario) => {
          live.push(scenario)
          ping()
        },
      })
      const guessed = guessSources(root, result.scenarios, result.snapshots, sourceDirs)
      for (const scenario of result.scenarios) scenario.source = guessed[scenario.id]
      const file: ScenariosFile = {
        version: 1,
        generatedAt: new Date().toISOString(),
        baseUrl,
        startPath: options.startPath ?? "/",
        stats: result.stats,
        scenarios: result.scenarios,
      }
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(scenariosFile(), `${JSON.stringify(file, null, 2)}\n`)
      live = []
      const cancelled = controller.signal.aborted
      // A crawl that reached hardly anything, and what it did reach has a password field, found a login wall
      // rather than an empty app. Checked only when no session is already configured: with one configured and
      // this still happening, the session has likely expired, which is a different, harder-to-mistake problem.
      const needsLogin =
        !cancelled &&
        !options.storageState &&
        result.scenarios.length <= 2 &&
        Object.values(result.snapshots).some((snapshot) => snapshot.hasPasswordField)
      setJob("crawl", {
        status: cancelled ? "cancelled" : "done",
        finishedAt: Date.now(),
        progress: { ...result.stats },
        needsLogin,
        message: needsLogin ? "Only a login screen was found." : undefined,
      })
      ping()
      if (!cancelled && !needsLogin) void startCapture(baseUrl)
    } catch (error) {
      live = []
      setJob("crawl", { status: "error", message: error instanceof Error ? error.message : String(error) })
      ping()
    }
  }

  // A single page, checked once before the person starts logging in and once after, so whether the attempt
  // actually changed anything can be judged from that one page alone instead of guessed at from the DOM of
  // the login tab (see ../login-check for why). Keyed by URL since only one login attempt is ever in flight
  // from the UI at a time; a stale entry is simply never matched and is harmless.
  let pendingLoginCheck: { url: string; before: PageCheck } | undefined

  function defaultSessionPath(): string {
    return path.resolve(root, options.storageState ?? path.join(outDir, "auth.json"))
  }

  // Shared by both ways a session can be produced (captured from the person's own browser, or an automated
  // fill-and-submit): point the explorer at the saved file, verify it against whatever was checked before the
  // attempt, and re-explore. Neither path needs to know about the other's mechanics.
  async function finalizeSession(out: string, baseUrl: string, checkUrl?: string) {
    options.storageState = path.relative(root, out) || out
    if (checkUrl && pendingLoginCheck?.url === checkUrl) {
      const { before } = pendingLoginCheck
      pendingLoginCheck = undefined
      try {
        const after = await checkPage(checkUrl, options.storageState)
        const outcome = compareLoginCheck(before, after)
        recordLog(
          outcome === "changed"
            ? `Login check: ${checkUrl} changed ("${before.title}" -> "${after.title}") — looks like it worked.`
            : `Login check: ${checkUrl} looks the same as before (still ${after.hasPasswordField ? "showing a password field" : `titled "${after.title}"`}) — login may not have finished. Exploring anyway, but check the result.`,
        )
      } catch (error) {
        recordLog(`Could not verify the login: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    recordLog("Re-exploring with the current session.")
    void startCrawl(baseUrl)
  }

  // Writes a session captured from the person's own browser (see ../session-capture) and re-explores with it —
  // the server-side half of the Explorer UI's manual "Log in" flow. No browser is opened here: the person
  // already logged in themselves, in a tab they opened, and the proof is in this very request's cookies.
  async function saveSession(captured: { cookieHeader?: string; localStorage?: Record<string, string> }, baseUrl: string, checkUrl?: string) {
    const out = defaultSessionPath()
    const state = buildStorageState({ ...captured, origin: baseUrl })
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, JSON.stringify(state, null, 2))
    recordLog(`Session saved to ${out}: ${state.cookies.length} cookie(s), ${state.origins[0]?.localStorage.length ?? 0} localStorage entr${state.origins[0]?.localStorage.length === 1 ? "y" : "ies"}.`)
    await finalizeSession(out, baseUrl, checkUrl)
  }

  // Logs in and explores using that exact same session — no file hand-off for the crawl itself (see
  // ../auto-login and crawl.ts's `context` option: the crawl just gets handed the live context directly).
  // Whether it actually got anywhere is left to the crawl's own needsLogin detection to say, honestly, rather
  // than a separate check that would just restate what the crawl is about to find out directly anyway.
  //
  // Headless by default: faster, and able to run the crawl's usual several concurrent workers without a
  // window flashing through dozens of pages. Visible is an explicit choice to watch it happen or finish a
  // step a generic selector couldn't reach — concurrency drops to 1 for that run so there's exactly one tab
  // to follow, not several racing through pages at once.
  async function autoLoginAndExplore(url: string, credentials: { username: string; password: string }, baseUrl: string, headless: boolean) {
    recordLog(`Automatic login: opened ${url} ${headless ? "headlessly" : "in a visible window"}.`)
    let browser: Browser | undefined
    try {
      const result = await runAutoLogin(url, credentials, headless)
      browser = result.browser
      const { context, outcome } = result
      recordLog(
        outcome === "submitted"
          ? "Automatic login: submitted the form."
          : "Automatic login: could not find a password field on that screen to fill.",
      )

      const out = defaultSessionPath()
      const save = async (note: string) => {
        const state = await context.storageState()
        fs.mkdirSync(path.dirname(out), { recursive: true })
        fs.writeFileSync(out, JSON.stringify(state, null, 2))
        options.storageState = path.relative(root, out) || out
        recordLog(`Session saved to ${out}${note}.`)
      }
      await save(" after logging in")

      recordLog("Exploring with this same session now — no file hand-off, nothing to go stale.")
      await startCrawl(baseUrl, context, headless ? undefined : 1)
      await save(" after exploring")
    } catch (error) {
      recordLog(`Automatic login failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await browser?.close().catch(() => {})
    }
  }

  // Opening the explorer with no (or out-of-date) thumbnails captures them, once per revision, so cards
  // show pictures without anyone asking. Editing the source starts a new revision and, on the next visit, a new capture.
  const attempted = new Set<string>()
  function captureIfNeeded(baseUrl: string) {
    if (options.autoCapture === false) return
    if (jobs.capture.status === "running" || jobs.crawl.status === "running") return
    const current = revision()
    const manifest = readManifest(path.join(outDir, "thumbnails"))
    if ((manifest && manifest.revision === current) || attempted.has(current)) return
    if (!scenarios().some((scenario) => !scenario.hidden)) return
    attempted.add(current)
    void startCapture(baseUrl)
  }

  // ---- The runtime script ----------------------------------------------------------------------------
  // The route constants ride at the top of runtime.js itself, so the page needs one `<script src>` tag and
  // no inline script, which a strict Content Security Policy would block.
  function runtimeScript(prefix: string, isStatic: boolean): string {
    const constants = `window.__UIX_ROUTE=${JSON.stringify(`${prefix}${route}/`)};${isStatic ? "window.__UIX_STATIC=true;" : ""}\n`
    return constants + fs.readFileSync(packageFile("runtime/runtime.js", "../runtime/runtime.js"), "utf8")
  }
  /** The tag every page of the app needs, for a host to add to its HTML. */
  const runtimeSrc = (prefix = "") => `${prefix}${route}/runtime.js`
  const runtimeTag = (prefix = "") => `<script src="${runtimeSrc(prefix)}"></script>`

  // ---- HTTP ------------------------------------------------------------------------------------------
  const json = (res: ServerResponse, body: unknown, status = 200) => {
    res.statusCode = status
    res.setHeader("Content-Type", TYPES[".json"])
    res.setHeader("Cache-Control", "no-store")
    res.end(JSON.stringify(body))
  }
  function serveFile(res: ServerResponse, file: string) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.statusCode = 404
      res.end("Not found")
      return
    }
    res.setHeader("Content-Type", TYPES[path.extname(file)] ?? "application/octet-stream")
    res.setHeader("Cache-Control", "no-cache")
    fs.createReadStream(file).pipe(res)
  }
  async function readBody(req: IncomingMessage) {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
    } catch {
      return {}
    }
  }

  /** True for a request path the explorer owns. */
  const owns = (pathname: string) => pathname === route || pathname.startsWith(`${route}/`)

  /** Node middleware: serves everything under the explorer route and calls `next` for the rest. */
  async function handle(req: IncomingMessage, res: ServerResponse, next: () => void) {
    const url = new URL(req.url ?? "/", "http://localhost")
    if (!owns(url.pathname)) return next()
    const rest = url.pathname.slice(route.length)
    try {
      if (isCrossSiteWrite(req)) return json(res, { error: "Cross-site requests are not allowed" }, 403)
      if (rest === "") {
        res.statusCode = 302
        res.setHeader("Location", `${route}/${url.search}`)
        return res.end()
      }
      if (rest === "/runtime.js") {
        res.setHeader("Content-Type", TYPES[".js"])
        res.setHeader("Cache-Control", "no-cache")
        return res.end(runtimeScript("", false))
      }
      if (rest === "/" || rest === "/index.html") return serveFile(res, path.join(packageFile("client", "../client"), "index.html"))
      if (rest === "/api/state") {
        json(res, state())
        captureIfNeeded(canonicalOrigin(req))
        return
      }
      if (rest.startsWith("/api/scenario/")) {
        const id = decodeURIComponent(rest.slice("/api/scenario/".length))
        const found = scenarios().find((scenario) => scenario.id === id)
        return found ? json(res, found) : json(res, { error: "Unknown scenario" }, 404)
      }
      if (rest === "/api/figma/connection") {
        res.setHeader("Cache-Control", "no-store")
        if (req.method !== "POST") { res.setHeader("Allow", "POST"); return json(res, { error: "Use POST to open a Figma connection" }, 405) }
        const instance = await localBridge(canonicalOrigin(req))
        return json(res, { connectionUrl: instance.url + "/#" + instance.token })
      }
      if (rest === "/api/figma/imports" && req.method === "POST") {
        try {
          const selection = selectionSchema.parse(await readBody(req))
          // Resolve only the submitted IDs against this Explorer's visible catalog. No plugin browsing.
          const selected = visible()
          const instance = await localBridge(canonicalOrigin(req))
          return json(res, instance.prepareImport(selection, selected, project), 201)
        } catch (error) { return json(res, { error: error instanceof Error ? error.message : String(error) }, 400) }
      }
      if (rest === "/api/design" && req.method === "POST") {
        const body = await readBody(req)
        if (body.createComponents !== undefined && typeof body.createComponents !== "boolean") return json(res, { error: "Create components must be a boolean" }, 400)
        const found = scenarios().find((scenario) => scenario.id === body.id)
        if (!found) return json(res, { error: "Unknown scenario" }, 404)
        const widths = Array.isArray(body.widths) ? body.widths : []
        if (!widths.length || widths.some((width: unknown) => !Number.isInteger(width) || (width as number) < 1 || (width as number) > 7680))
          return json(res, { error: "Choose widths from 1 to 7680 pixels" }, 400)
        // A saved custom width's own label (e.g. "Laptop (1366px)") takes over from the generic
        // "Breakpoint=1366" fallback - the client knows the name it saved, the server doesn't.
        const labels = { ...BREAKPOINT_LABELS } as Record<number, string>
        if (body.labels && typeof body.labels === "object") {
          for (const [width, label] of Object.entries(body.labels as Record<string, unknown>)) {
            if (Number.isInteger(Number(width)) && typeof label === "string" && label) labels[Number(width)] = label
          }
        }
        try {
          const captures = await captureDesigns({
            baseUrl: canonicalOrigin(req),
            startPath: options.startPath ?? "/",
            scenario: found,
            projectRoot: root,
            widths,
            storageState: options.storageState,
            blockWrites: !options.allowWrites,
          })
          return json(res, { version: 1, plan: buildPlan(captures, labels, { createComponents: body.createComponents }) })
        } catch (error) {
          return json(res, { error: error instanceof Error ? error.message : String(error) }, 500)
        }
      }
      if (rest === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        })
        res.write(": connected\n\n")
        clients.add(res)
        const beat = setInterval(() => res.write(": ping\n\n"), 25_000)
        req.on("close", () => {
          clearInterval(beat)
          clients.delete(res)
        })
        return
      }
      if (rest === "/api/logs" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
        return res.end(logs.join("\n"))
      }
      const origin = canonicalOrigin(req)
      if (rest === "/api/crawl" && req.method === "POST") {
        if (jobs.crawl.status === "running") return json(res, { error: "A crawl is already running" }, 409)
        void startCrawl(origin)
        return json(res, { started: true }, 202)
      }
      if (rest === "/api/crawl" && req.method === "DELETE") {
        controllers.crawl?.abort()
        return json(res, { cancelled: true })
      }
      if (rest === "/api/login/check" && req.method === "POST") {
        const body = await readBody(req)
        const url = typeof body.url === "string" ? body.url : undefined
        if (!url) return json(res, { error: "Missing url" }, 400)
        try {
          const before = await checkPage(url, options.storageState)
          pendingLoginCheck = { url, before }
          recordLog(`Checked ${url} before logging in: ${before.hasPasswordField ? "has a password field" : "no password field"}, titled "${before.title}".`)
          return json(res, { before }, 200)
        } catch (error) {
          return json(res, { error: error instanceof Error ? error.message : String(error) }, 500)
        }
      }
      if (rest === "/api/login" && req.method === "POST") {
        const body = await readBody(req)
        const localStorageEntries = body.localStorage && typeof body.localStorage === "object" ? body.localStorage : undefined
        const checkUrl = typeof body.checkUrl === "string" ? body.checkUrl : undefined
        void saveSession({ cookieHeader: req.headers.cookie, localStorage: localStorageEntries }, origin, checkUrl)
        return json(res, { saved: true }, 202)
      }
      // Carries a real plaintext password and drives a live browser, so it's refused outright unless this
      // Explorer is known to be loopback-only — stricter than the general proxy's own host checking just
      // above, which, by design, trusts an explicit choice to bind wider. That trust doesn't extend to a
      // feature this sensitive.
      if (rest === "/api/login/headless" && !loopbackOnly)
        return json(res, { error: "Automated login is only available when Explorer is bound to loopback only." }, 403)
      if (rest === "/api/login/headless" && req.method === "POST") {
        const body = await readBody(req)
        const url = typeof body.url === "string" ? body.url : undefined
        const username = typeof body.username === "string" ? body.username : undefined
        const password = typeof body.password === "string" ? body.password : undefined
        if (!url || !username || !password) return json(res, { error: "Missing url, username or password" }, 400)
        const headless = body.headless !== false
        void autoLoginAndExplore(url, { username, password }, origin, headless)
        return json(res, { started: true }, 202)
      }
      if (rest === "/api/capture" && req.method === "POST") {
        if (jobs.capture.status === "running") return json(res, { error: "A capture is already running" }, 409)
        const body = await readBody(req)
        void startCapture(origin, Array.isArray(body.only) ? body.only : undefined)
        return json(res, { started: true }, 202)
      }
      if (rest === "/api/capture" && req.method === "DELETE") {
        controllers.capture?.abort()
        return json(res, { cancelled: true })
      }
      if (rest.startsWith("/thumbnails/")) return serveFile(res, path.join(outDir, "thumbnails", path.basename(rest)))
      // Everything else is the explorer's own built files.
      const client = packageFile("client", "../client")
      const target = path.normalize(path.join(client, rest))
      if (!target.startsWith(client)) return next()
      return serveFile(res, target)
    } catch (error) {
      return json(res, { error: error instanceof Error ? error.message : String(error) }, 500)
    }
  }

  /** A source file changed (`file` is absolute). `structural` is true when a file was added or removed. */
  function invalidate(file: string, structural = false) {
    const relative = posix(path.relative(root, file))
    if (relative.startsWith(posix(path.relative(root, outDir)))) return ping()
    if (!affectsPreviews(relative)) return
    revisionCache = undefined
    if (structural) sourcesCache = undefined
    ping()
  }

  /**
   * The files of a read-only copy of the explorer for a production build, keyed by path relative to the build
   * output. `prefix` is where the app is hosted ("" at the domain root); the app and explorer share an origin.
   */
  function snapshotFiles(prefix = ""): Map<string, string | Uint8Array> {
    const files = new Map<string, string | Uint8Array>()
    const dir = route.slice(1)
    const prefixed = (value: string | undefined) =>
      value && value.startsWith("/") && !(prefix && value.startsWith(`${prefix}/`)) ? `${prefix}${value}` : value

    files.set(`${dir}/runtime.js`, runtimeScript(prefix, true))

    const client = packageFile("client", "../client")
    const walk = (folder: string) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name)
        if (entry.isDirectory()) {
          walk(file)
          continue
        }
        const name = posix(path.relative(client, file))
        const content = fs.readFileSync(file)
        files.set(
          `${dir}/${name}`,
          name === "index.html" ? content.toString("utf8").replace("<head>", "<head><script>window.__UIX_STATIC=true</script>") : content,
        )
      }
    }
    walk(client)

    const snapshot = state()
    files.set(
      `${dir}/api/state.json`,
      JSON.stringify({
        ...snapshot,
        capabilities: { figmaImports: 0 },
        mode: "manual",
        route: `${prefix}${route}`,
        startPath: prefixed(snapshot.startPath),
        scenarios: snapshot.scenarios.map((scenario) => ({
          ...scenario,
          url: prefixed(scenario.url),
          startPath: prefixed(scenario.startPath),
        })),
        jobs: IDLE_JOBS,
      }),
    )
    for (const scenario of scenarios()) files.set(`${dir}/api/scenario/${encodeURIComponent(scenario.id)}.json`, JSON.stringify(scenario))

    // Thumbnails are optional: without them the gallery falls back to live previews.
    const thumbnails = path.join(outDir, "thumbnails")
    if (fs.existsSync(thumbnails))
      for (const name of fs.readdirSync(thumbnails))
        if (fs.statSync(path.join(thumbnails, name)).isFile()) files.set(`${dir}/thumbnails/${name}`, fs.readFileSync(path.join(thumbnails, name)))
    return files
  }

  /** Stops running jobs and closes event streams. */
  function dispose() {
    disposed = true
    controllers.crawl?.abort()
    controllers.capture?.abort()
    clearTimeout(pingTimer)
    for (const client of clients) client.end()
    clients.clear()
    return closing ??= bridge?.then(instance => instance.close()) ?? Promise.resolve()
  }

  return {
    root,
    project,
    route,
    outDir,
    /** Folders whose files change what a preview renders, absolute. */
    sourceDirs: sourceDirs.map((dir) => path.resolve(root, dir)),
    options,
    owns,
    handle,
    invalidate,
    runtimeSrc,
    runtimeTag,
    snapshotFiles,
    state,
    dispose,
  }
}
