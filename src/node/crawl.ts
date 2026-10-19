import crypto from "node:crypto"
import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type BrowserContext, type Page } from "playwright"
import { replayPage } from "./replay"
import { candidateStep, recipeStep } from "../shared/transitions"
import type {
  Action,
  AutofillResult,
  Candidate,
  CrawlStats,
  ReplayResult,
  Scenario,
  Snapshot,
  UixRuntime,
  TransitionStep,
} from "../shared/types"

export type CrawlOptions = {
  /** Origin of the running dev server, for example http://localhost:5173. */
  baseUrl: string
  /** Where every recipe starts. */
  startPath?: string
  maxStates?: number
  /** Longest recipe, in steps. */
  maxDepth?: number
  concurrency?: number
  timeBudgetMs?: number
  /** Patterns (regular expressions) for controls that must never be clicked. */
  deny?: string[]
  /** A Playwright storage-state file for apps behind a login. */
  storageState?: string
  headless?: boolean
  viewport?: { width: number; height: number }
  /** Stop the page from changing anything on a server. On by default. */
  blockWrites?: boolean
  log?: (line: string) => void
  /** Print the full recipe of every step that fails to replay. */
  debug?: boolean
  /** Called as the crawl goes, for progress displays. */
  onProgress?: (progress: CrawlProgress) => void
  /** Called once for every new state, in the order they are found. */
  onState?: (scenario: Scenario, snapshot: Snapshot) => void
  /** Aborting stops the crawl and returns what was found so far. */
  signal?: AbortSignal
}

export type CrawlProgress = {
  states: number
  queued: number
  seconds: number
  last?: string
}

type Item = {
  actions: Action[]
  steps?: TransitionStep[]
  parentId?: string
  label: string
  /** The step that was added last, to learn which controls never lead anywhere. */
  via?: string
  /** Lower goes first. Moving the flow on finds new screens; everything else mostly finds variants. */
  priority: number
  destination?: string
}

type State = {
  id: string
  title: string
  group: string
  parentId?: string
  kind: NonNullable<Scenario["kind"]>
  actions: Action[]
  steps?: TransitionStep[]
  snapshot: Snapshot
  key: string
  label: string
  overlayDepth: number
  /** The controls this state offered, to tell what a choice made appear. */
  controls: Set<string>
}

type W = Window & { __uix?: UixRuntime }


const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function runtimeSource(): string {
  // The shared chunk sits in dist/, the entry points in dist/node/: look in both places.
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const candidate of ["runtime/runtime.js", "../runtime/runtime.js"]) {
    const file = path.resolve(here, candidate)
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8")
  }
  throw new Error("The browser runtime is missing from the package. Build it with `pnpm build`.")
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "state"

function stateKey(snapshot: Snapshot) {
  return crypto
    .createHash("sha1")
    .update(
      JSON.stringify([
        snapshot.url,
        snapshot.headings,
        snapshot.dialogs,
        snapshot.menus,
        snapshot.selected,
        snapshot.tokens.join(" "),
      ]),
    )
    .digest("hex")
    .slice(0, 12)
}

function similarity(a: string[], b: string[]) {
  if (!a.length && !b.length) return 1
  const set = new Set(a)
  let shared = 0
  for (const token of b) if (set.has(token)) shared++
  return shared / (a.length + b.length - shared)
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])

function classify(snapshot: Snapshot, parent: State | undefined): State["kind"] {
  if (!parent) return "screen"
  const parentDialogs = new Set(parent.snapshot.dialogs)
  if (snapshot.dialogs.some((dialog) => !parentDialogs.has(dialog))) return "overlay"
  if (
    snapshot.url !== parent.snapshot.url ||
    !sameList(snapshot.headings, parent.snapshot.headings)
  )
    return "navigation"
  return "variant"
}

export type CrawlResult = {
  scenarios: Scenario[]
  stats: CrawlStats
  /** What each state looked like, for measuring the crawl against known states. */
  snapshots: Record<string, Snapshot>
}

export async function crawl(options: CrawlOptions): Promise<CrawlResult> {
  options.signal?.throwIfAborted()
  const started = Date.now()
  const log = options.log ?? (() => {})
  const startPath = options.startPath ?? "/"
  const maxStates = options.maxStates ?? 250
  const maxDepth = options.maxDepth ?? 14
  // Each browser runs a full copy of the app. More of them than the machine can keep up with make pages
  // slow enough that recipes start to fail, so the default leaves headroom.
  const concurrency = Math.max(1, options.concurrency ?? Math.max(2, Math.min(5, Math.floor(os.cpus().length / 2))))
  const budget = options.timeBudgetMs ?? 15 * 60_000
  const deny = options.deny
  const viewport = options.viewport ?? { width: 1280, height: 900 }
  const runtime = runtimeSource()
  const startUrl = new URL(startPath, options.baseUrl).toString()

  const browser = await chromium.launch({
    headless: options.headless ?? true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  })

  const states: State[] = []
  const byKey = new Map<string, State>()
  const byId = new Map<string, State>()
  const usedIds = new Set<string>()
  const visitedUrls = new Set<string>()
  const queue: Item[] = [{ actions: [], label: "Start", priority: 0 }]
  const nextItem = () => {
    let best = -1
    // A shared header/footer appears on every page. Replaying those links before deeper routes can
    // exhaust the budget on duplicates. Defer visited destinations without dropping any interactions.
    const priority = (item: Item) => item.destination ? visitedUrls.has(item.destination) ? 3 : -1 : item.priority
    for (let i = 0; i < queue.length; i++) if (best < 0 || priority(queue[i]) < priority(queue[best])) best = i
    return best < 0 ? undefined : queue.splice(best, 1)[0]
  }
  // A control that keeps producing nothing new (a disabled-looking nav link, a decorative button) is not
  // worth trying from every state. Learned as the crawl goes.
  const outcomes = new Map<string, { tries: number; fresh: number }>()
  const pointless = (key: string | undefined) => {
    const seen = key ? outcomes.get(key) : undefined
    return !!seen && ((seen.tries >= 3 && seen.fresh === 0) || seen.tries >= 8)
  }
  const learn = (key: string | undefined, fresh: boolean) => {
    if (!key) return
    const seen = outcomes.get(key) ?? { tries: 0, fresh: 0 }
    seen.tries++
    if (fresh) seen.fresh++
    outcomes.set(key, seen)
  }
  const stats: CrawlStats = {
    states: 0,
    duplicates: 0,
    skipped: 0,
    failedReplays: 0,
    candidatesTried: 0,
    seconds: 0,
    stoppedBy: "complete",
  }
  let inFlight = 0
  let stopped = false

  const stop = (reason: CrawlStats["stoppedBy"]) => {
    if (!stopped) {
      stopped = true
      stats.stoppedBy = reason
    }
  }
  const abort = () => { stop("cancelled"); void browser.close().catch(() => {}) }
  options.signal?.addEventListener("abort", abort, { once: true })
  if (options.signal?.aborted) abort()
  const deadline = setTimeout(() => { stop("time-budget"); void browser.close().catch(() => {}) }, budget)

  async function newContext(): Promise<BrowserContext> {
    const context = await browser.newContext({
      viewport,
      storageState: options.storageState,
    })
    // __UIX_FORCE switches the runtime on in every page, not only in preview pages.
    await context.addInitScript({ content: `window.__UIX_FORCE = true;
${runtime}` })
    await context.route("**/*", (route) => {
      const request = route.request()
      if (request.isNavigationRequest() && request.frame().parentFrame() === null && new URL(request.url()).origin !== new URL(startUrl).origin)
        return route.abort("blockedbyclient")
      const method = request.method()
      if (!(options.blockWrites ?? true) || method === "GET" || method === "HEAD" || method === "OPTIONS") return route.continue()
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    return context
  }

  async function load(page: Page) {
    // A failed or interrupted attempt must not leave a continuation to run during the next reset.
    await page.evaluate(() => (window as W).__uix?.cancelReplay()).catch(() => {})
    await page.goto(startUrl, { waitUntil: "domcontentloaded" })
    // A page rendered on the server shows its text at once, but its buttons do nothing until the scripts have run
    // and the framework has taken over. Waiting for the load event means every script the page asked for has run.
    await page.waitForLoadState("load", { timeout: 20_000 })
    await page.waitForFunction(
      () => !!(window as W).__uix && document.body && document.body.innerText.trim().length > 0,
      undefined,
      { timeout: 20_000 },
    )
    await page.evaluate(() => (window as W).__uix!.settle(150, 1200))
  }

  async function replay(page: Page, actions: Action[]): Promise<ReplayResult> {
    try {
      await load(page)
    } catch (error) {
      // A dev server that reloads while the page opens (someone saved a file) is not a failure of the state.
      const message = error instanceof Error ? error.message.split("\n")[0] : "The page did not load"
      return { ok: false, step: -1, message }
    }
    if (!actions.length) return { ok: true }
    try {
      return await replayPage(page, actions, { settleMs: 90, timeoutMs: 15_000 })
    } catch (error) {
      return {
        ok: false,
        step: -1,
        message: error instanceof Error ? error.message.split("\n")[0] : "The page navigated",
      }
    }
  }

  const toScenario = (state: State): Scenario => ({
    id: state.id,
    title: state.title,
    group: state.group,
    description: state.parentId ? `${byId.get(state.parentId)?.title} › ${state.label}` : undefined,
    parent: state.parentId,
    trigger: state.parentId ? state.label : undefined,
    transition: state.parentId ? { steps: state.steps } : undefined,
    kind: state.kind,
    actions: state.actions,
    fingerprint: state.key,
    replayViewport: viewport,
  })

  const announce = (last?: string) =>
    options.onProgress?.({
      states: states.length,
      queued: queue.length,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      last,
    })

  function register(item: Item, snapshot: Snapshot): State {
    const parent = item.parentId ? byId.get(item.parentId) : undefined
    const kind = classify(snapshot, parent)
    const parentDialogs = new Set(parent?.snapshot.dialogs ?? [])
    const newDialog = snapshot.dialogs.find((dialog) => !parentDialogs.has(dialog))
    const heading = snapshot.headings[0] || snapshot.title || item.label
    const title =
      kind === "overlay" ? newDialog || item.label : kind === "variant" ? item.label : heading
    const group = kind === "overlay" || kind === "variant" ? (parent?.group ?? heading) : heading
    let id = slug(title)
    for (let n = 2; usedIds.has(id); n++) id = `${slug(title)}-${n}`
    usedIds.add(id)
    const state: State = {
      id,
      title,
      group,
      parentId: parent?.id,
      kind,
      actions: item.actions,
      steps: item.steps,
      snapshot,
      key: stateKey(snapshot),
      label: item.label,
      overlayDepth: (parent?.overlayDepth ?? 0) + (kind === "overlay" ? 1 : 0),
      controls: new Set(),
    }
    states.push(state)
    visitedUrls.add(snapshot.url)
    byKey.set(state.key, state)
    byId.set(state.id, state)
    stats.states = states.length
    log(`  [${String(states.length).padStart(3)}] ${kind.padEnd(10)} ${title}`)
    options.onState?.(toScenario(state), snapshot)
    announce(title)
    return state
  }

  function isNearDuplicate(snapshot: Snapshot): boolean {
    for (const existing of states) {
      if (
        existing.snapshot.url === snapshot.url &&
        sameList(existing.snapshot.dialogs, snapshot.dialogs) &&
        sameList(existing.snapshot.headings, snapshot.headings) &&
        sameList(existing.snapshot.selected, snapshot.selected) &&
        similarity(existing.snapshot.tokens, snapshot.tokens) >= 0.985
      )
        return true
    }
    return false
  }

  async function process(page: Page, item: Item) {
    if (pointless(item.via) && (!item.destination || visitedUrls.has(item.destination))) {
      stats.skipped++
      return
    }
    let result = await replay(page, item.actions)
    // Slow loads and a dev server reloading under us are worth a few more tries before giving up.
    for (let attempt = 0; attempt < 2 && !result.ok && !stopped; attempt++) {
      await sleep(400 * (attempt + 1))
      result = await replay(page, item.actions)
    }
    if (!result.ok) {
      if (stopped) return
      stats.failedReplays++
      log(`  ! could not replay "${item.label}": ${result.message}`)
      if (options.debug) log(`    ${JSON.stringify(item.actions)}`)
      return
    }
    const snapshot = await page.evaluate(() => (window as W).__uix!.snapshot())

    // An open dropdown is not a state: each of its choices is.
    if (snapshot.listbox && item.actions.length) {
      const options = await page.evaluate(() => (window as W).__uix!.popupOptions())
      for (const option of options) {
        queue.push({
          actions: [...item.actions, option.action],
          steps: [...(item.steps ?? []), candidateStep(option)],
          parentId: item.parentId,
          label: option.label,
          via: JSON.stringify(option.action),
          priority: 2,
        })
      }
      return
    }

    const key = stateKey(snapshot)
    if (byKey.has(key) || isNearDuplicate(snapshot)) {
      stats.duplicates++
      learn(item.via, false)
      return
    }
    learn(item.via, true)
    const state = register(item, snapshot)
    if (states.length >= maxStates) {
      stop("max-states")
      return
    }
    if (item.actions.length >= maxDepth || state.overlayDepth > 2) return

    const candidates: Candidate[] = await page.evaluate((d) => (window as W).__uix!.candidates({ deny: d }), deny)
    state.controls = new Set(candidates.map((c) => JSON.stringify(c.action)))
    // From a variant, trying every combination of every control would multiply states without showing
    // anything new. Worth following: moving the flow on, and whatever the choice made appear.
    const parent = state.parentId ? byId.get(state.parentId) : undefined
    const wanted =
      state.kind === "variant"
        ? candidates.filter(
            (c) => c.primary || !parent?.controls.has(JSON.stringify(c.action)),
          )
        : candidates
    for (const candidate of wanted) {
      stats.candidatesTried++
      queue.push({
        actions: [...item.actions, candidate.action],
        steps: [candidateStep(candidate)],
        parentId: state.id,
        label: candidate.label,
        // Moving the flow on depends on the state it is pressed in, so it is never written off.
        via: candidate.primary ? undefined : JSON.stringify(candidate.action),
        priority: candidate.primary ? 0 : 1,
        destination: candidate.destination,
      })
    }

    // Forms usually have to be valid before they let the flow continue.
    const filled: AutofillResult = await page.evaluate(() => (window as W).__uix!.autofill())
    if (filled.filled > 0 && state.kind === "overlay") {
      // Closing a form that has unsaved changes usually asks for confirmation: that is a state too.
      const dirty: Candidate[] = await page.evaluate((d) => (window as W).__uix!.candidates({ deny: d }), deny)
      for (const candidate of dirty.filter((c) => !c.primary)) {
        stats.candidatesTried++
        queue.push({
          actions: [...item.actions, ...filled.actions, candidate.action],
          steps: [...(filled.steps ?? filled.actions.map(recipeStep)), candidateStep(candidate)],
          parentId: state.id,
          label: candidate.label,
          priority: 1,
        })
      }
    }
    if (filled.filled > 0 && state.kind !== "variant") {
      const next: Candidate[] = await page.evaluate((d) => (window as W).__uix!.candidates({ deny: d }), deny)
      for (const candidate of next.filter((c) => c.primary)) {
        stats.candidatesTried++
        queue.push({
          actions: [...item.actions, ...filled.actions, candidate.action],
          steps: [...(filled.steps ?? filled.actions.map(recipeStep)), candidateStep(candidate)],
          parentId: state.id,
          label: candidate.label,
          via: JSON.stringify(["filled", candidate.action]),
          priority: 0,
        })
      }
    }
  }

  async function worker() {
    let context: BrowserContext | undefined
    try {
      if (stopped) return
      context = await newContext()
      const page = await context.newPage()
      page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}))
      for (;;) {
        if (stopped) break
        if (options.signal?.aborted) {
          stop("cancelled")
          break
        }
        if (Date.now() - started > budget) {
          stop("time-budget")
          break
        }
        const item = nextItem()
        if (!item) {
          if (inFlight === 0) break
          await sleep(40)
          continue
        }
        inFlight++
        try {
          await process(page, item)
        } catch (error) {
          if (stopped) break
          stats.failedReplays++
          log(`  ! ${item.label}: ${error instanceof Error ? error.message.split("\n")[0] : error}`)
        } finally {
          inFlight--
        }
      }
    } catch (error) {
      if (!stopped) throw error
    } finally {
      await context?.close().catch(() => {})
    }
  }

  log(`Exploring ${startUrl} (up to ${maxStates} states, ${concurrency} browsers)`)
  try {
    await Promise.all(Array.from({ length: concurrency }, worker))
  } finally {
    options.signal?.removeEventListener("abort", abort)
    clearTimeout(deadline)
    await browser.close().catch(() => {})
  }
  stats.seconds = Math.round((Date.now() - started) / 100) / 10

  const scenarios: Scenario[] = states.map(toScenario)
  return {
    scenarios,
    stats,
    snapshots: Object.fromEntries(states.map((state) => [state.id, state.snapshot])),
  }
}
