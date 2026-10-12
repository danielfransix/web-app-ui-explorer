import fs from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"
import type { Scenario, ScenariosFile, Transition } from "../shared/types"
import { capture, readManifest } from "./capture"
import { crawl } from "./crawl"
import type { UiExplorerOptions } from "./options"
import { affectsPreviews, computeRevision } from "./revision"
import { guessSources, listSources } from "./sources"

export type { UiExplorerOptions } from "./options"

type JobName = "crawl" | "capture"
type Job = {
  status: "idle" | "running" | "done" | "error" | "cancelled"
  message?: string
  progress?: Record<string, unknown>
  startedAt?: number
  finishedAt?: number
}

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
function packageFile(...candidates: string[]) {
  for (const candidate of candidates) {
    const file = path.resolve(here, candidate)
    if (fs.existsSync(file)) return file
  }
  throw new Error(`ui-explorer: ${candidates[0]} is missing from the package. Build it with \`pnpm build\`.`)
}

const posix = (value: string) => value.split(path.sep).join("/")

export default function uiExplorer(options: UiExplorerOptions = {}): Plugin {
  const route = `/${(options.route ?? "/__explorer").replace(/^\/+|\/+$/g, "")}`
  const mode = options.mode ?? "merge"
  const sourceDirs = options.sources ?? ["src"]
  let root = process.cwd()
  let project = path.basename(root)
  let outDir = path.join(root, options.dir ?? ".ui-explorer")
  let building = false
  // Where the app is hosted ("" at the domain root); production builds may live under a prefix.
  let basePrefix = ""

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
    const relative = source.replace(/^\.?\//, "").replace(new RegExp(`^${project}/`), "")
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
  const jobs: Record<JobName, Job> = { crawl: { status: "idle" }, capture: { status: "idle" } }
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

  function state() {
    const generated = readGenerated()
    const manifest = readManifest(path.join(outDir, "thumbnails"))
    return {
      project,
      startPath: options.startPath ?? generated?.startPath ?? "/",
      route,
      mode,
      revision: revision(),
      generatedAt: generated?.generatedAt,
      scenarios: visible(),
      transitions: [...(options.transitions ?? [])] as Transition[],
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

  async function startCrawl(baseUrl: string) {
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
        deny: options.deny,
        storageState: options.storageState,
        blockWrites: !options.allowWrites,
        signal: controller.signal,
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
      setJob("crawl", { status: cancelled ? "cancelled" : "done", finishedAt: Date.now(), progress: { ...result.stats } })
      ping()
      if (!cancelled) void startCapture(baseUrl)
    } catch (error) {
      live = []
      setJob("crawl", { status: "error", message: error instanceof Error ? error.message : String(error) })
      ping()
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

  return {
    name: "ui-explorer",

    configResolved(config) {
      root = config.root
      // Without a package.json the project's own folder name stands in (not the folder Vite was started from).
      project = path.basename(root)
      building = config.command === "build"
      basePrefix = /^\.?\/?$/.test(config.base) || config.base.startsWith(".") ? "" : config.base.replace(/\/+$/, "")
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { name?: string }
        if (pkg.name) project = pkg.name.replace(/^@[^/]+\//, "")
      } catch {
        // No package.json: the folder name stands in.
      }
      outDir = path.join(root, options.dir ?? ".ui-explorer")
    },

    transformIndexHtml() {
      // Loaded on every page in development (and in builds that ship the explorer); it only takes over for
      // preview pages and crawls.
      if (building && !options.static) return
      const prefix = building ? basePrefix : ""
      return [
        {
          tag: "script",
          children: `window.__UIX_ROUTE=${JSON.stringify(`${prefix}${route}/`)}${building ? ";window.__UIX_STATIC=true" : ""}`,
          injectTo: "head-prepend",
        },
        { tag: "script", attrs: { src: `${prefix}${route}/runtime.js` }, injectTo: "head-prepend" },
      ]
    },

    // A production build carries a read-only snapshot of the explorer: no server, so no exploring or capturing.
    generateBundle() {
      if (!building || !options.static) return
      const emit = (fileName: string, source: string | Uint8Array) => this.emitFile({ type: "asset", fileName, source })
      const dir = route.slice(1)
      const prefixed = (value: string | undefined) =>
        value && value.startsWith("/") && !(basePrefix && value.startsWith(`${basePrefix}/`)) ? `${basePrefix}${value}` : value

      emit(`${dir}/runtime.js`, fs.readFileSync(packageFile("runtime/runtime.js", "../runtime/runtime.js")))

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
          emit(
            `${dir}/${name}`,
            name === "index.html"
              ? content.toString("utf8").replace("<head>", "<head><script>window.__UIX_STATIC=true</script>")
              : content,
          )
        }
      }
      walk(client)

      const snapshot = state()
      emit(
        `${dir}/api/state.json`,
        JSON.stringify({
          ...snapshot,
          mode: "manual",
          route: `${basePrefix}${route}`,
          startPath: prefixed(snapshot.startPath),
          scenarios: snapshot.scenarios.map((scenario) => ({
            ...scenario,
            url: prefixed(scenario.url),
            startPath: prefixed(scenario.startPath),
          })),
          jobs: { crawl: { status: "idle" }, capture: { status: "idle" } },
        }),
      )
      for (const scenario of scenarios()) emit(`${dir}/api/scenario/${encodeURIComponent(scenario.id)}.json`, JSON.stringify(scenario))

      // Thumbnails are optional: without them the gallery falls back to live previews.
      const thumbnails = path.join(outDir, "thumbnails")
      if (fs.existsSync(thumbnails))
        for (const name of fs.readdirSync(thumbnails))
          if (fs.statSync(path.join(thumbnails, name)).isFile()) emit(`${dir}/thumbnails/${name}`, fs.readFileSync(path.join(thumbnails, name)))
    },

    configureServer(server) {
      server.watcher.add(outDir)
      for (const dir of sourceDirs) server.watcher.add(path.resolve(root, dir))
      const changed = (file: string, structural: boolean) => {
        const relative = posix(path.relative(root, file))
        if (relative.startsWith(posix(path.relative(root, outDir)))) return ping()
        if (!affectsPreviews(relative)) return
        revisionCache = undefined
        if (structural) sourcesCache = undefined
        ping()
      }
      server.watcher.on("change", (file) => changed(file, false))
      server.watcher.on("add", (file) => changed(file, true))
      server.watcher.on("unlink", (file) => changed(file, true))

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost")
        if (url.pathname !== route && !url.pathname.startsWith(`${route}/`)) return next()
        const rest = url.pathname.slice(route.length)
        try {
          if (rest === "") {
            res.statusCode = 302
            res.setHeader("Location", `${route}/${url.search}`)
            return res.end()
          }
          if (rest === "/runtime.js") return serveFile(res, packageFile("runtime/runtime.js", "../runtime/runtime.js"))
          if (rest === "/" || rest === "/index.html")
            return serveFile(res, path.join(packageFile("client", "../client"), "index.html"))
          if (rest === "/api/state") {
            json(res, state())
            captureIfNeeded(`http://${req.headers.host ?? "localhost"}`)
            return
          }
          if (rest.startsWith("/api/scenario/")) {
            const id = decodeURIComponent(rest.slice("/api/scenario/".length))
            const found = scenarios().find((scenario) => scenario.id === id)
            return found ? json(res, found) : json(res, { error: "Unknown scenario" }, 404)
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
          const origin = `http://${req.headers.host ?? "localhost"}`
          if (rest === "/api/crawl" && req.method === "POST") {
            if (jobs.crawl.status === "running") return json(res, { error: "A crawl is already running" }, 409)
            void startCrawl(origin)
            return json(res, { started: true }, 202)
          }
          if (rest === "/api/crawl" && req.method === "DELETE") {
            controllers.crawl?.abort()
            return json(res, { cancelled: true })
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
          if (rest.startsWith("/thumbnails/"))
            return serveFile(res, path.join(outDir, "thumbnails", path.basename(rest)))
          // Everything else is the explorer's own built files.
          const client = packageFile("client", "../client")
          const target = path.normalize(path.join(client, rest))
          if (!target.startsWith(client)) return next()
          return serveFile(res, target)
        } catch (error) {
          return json(res, { error: error instanceof Error ? error.message : String(error) }, 500)
        }
      })
    },
  }
}
