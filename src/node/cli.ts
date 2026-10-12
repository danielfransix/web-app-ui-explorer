#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { capture } from "./capture"
import { crawl } from "./crawl"
import { init } from "./init"
import { computeRevision } from "./revision"
import { guessSources } from "./sources"
import type { ScenariosFile } from "../shared/types"

const HELP = `web-app-ui-explorer

Usage
  web-app-ui-explorer init                       Add the explorer to a Vite project
  web-app-ui-explorer crawl --url <server> ...   Explore the running app and write its scenarios
  web-app-ui-explorer capture --url <server> ... Take thumbnails of the scenarios

Options for crawl
  --url <url>            Origin of the running dev server (required)
  --start <path>         Where every recipe starts (default /)
  --out <file>           Where to write the scenarios (default .ui-explorer/scenarios.json)
  --max-states <n>       Stop after this many states (default 250)
  --max-depth <n>        Longest recipe in steps (default 14)
  --concurrency <n>      Browsers working at once (default: half the CPU cores, 2 to 5)
  --time-budget <min>    Stop after this many minutes (default 15)
  --deny <regex>         Never click a control whose label matches (repeatable)
  --storage-state <file> Playwright storage state, for apps behind a login
  --root <dir>           Project root, used to find the source file of each state (default .)
  --src <dir>            Source folder to search, relative to the root (repeatable, default src)
  --headed               Show the browsers
  --debug                Print failing recipes and save what each state looked like
  --allow-writes         Let the app send POST/PUT/DELETE requests (blocked by default)

Options for capture
  --url <url>            Origin of the running dev server (required)
  --root <dir>           Project root (default .)
  --dir <dir>            Folder holding scenarios.json and thumbnails (default .ui-explorer)
  --src <dir>            Source folder the revision is computed from (repeatable, default src)
  --concurrency <n>      Browsers working at once (default 4)
`

function parse(argv: string[]) {
  const flags = new Map<string, string[]>()
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const name = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) flags.set(name, [...(flags.get(name) ?? []), "true"])
    else {
      flags.set(name, [...(flags.get(name) ?? []), next])
      i++
    }
  }
  return { flags, positional }
}

async function main() {
  const { flags, positional } = parse(process.argv.slice(2))
  const command = positional[0]
  const one = (name: string) => flags.get(name)?.[0]
  const number = (name: string) => (one(name) ? Number(one(name)) : undefined)
  if (!command || command === "help" || flags.has("help")) {
    console.log(HELP)
    return
  }

  if (command === "init") {
    process.exitCode = init(path.resolve(one("root") ?? "."), (line) => console.log(line)) ? 0 : 1
    return
  }

  const url = one("url")
  if (command !== "crawl" && command !== "capture") {
    console.error(`Unknown command: ${command}\n\n${HELP}`)
    process.exit(2)
  }
  if (!url) {
    console.error("Missing --url, the address of your running dev server.\n")
    console.log(HELP)
    process.exit(2)
  }
  const root = path.resolve(one("root") ?? ".")

  if (command === "capture") {
    const dir = path.resolve(root, one("dir") ?? ".ui-explorer")
    const file = path.join(dir, "scenarios.json")
    if (!fs.existsSync(file)) {
      console.error(`No scenarios found at ${file}. Run \`web-app-ui-explorer crawl\` first.`)
      process.exit(1)
    }
    const scenarios = JSON.parse(fs.readFileSync(file, "utf8")) as ScenariosFile
    const manifest = await capture({
      baseUrl: url,
      startPath: scenarios.startPath,
      scenarios: scenarios.scenarios,
      outDir: path.join(dir, "thumbnails"),
      revision: computeRevision(root, flags.get("src")),
      concurrency: number("concurrency"),
      log: (line) => console.log(line),
    })
    console.log(
      `\nCaptured ${Object.keys(manifest.items).length} thumbnails, ${Object.keys(manifest.failed).length} failed.`,
    )
    return
  }

  const out = path.resolve(one("out") ?? ".ui-explorer/scenarios.json")
  const result = await crawl({
    baseUrl: url,
    startPath: one("start"),
    maxStates: number("max-states"),
    maxDepth: number("max-depth"),
    concurrency: number("concurrency"),
    timeBudgetMs: number("time-budget") ? number("time-budget")! * 60_000 : undefined,
    deny: flags.get("deny"),
    storageState: one("storage-state"),
    headless: !flags.has("headed"),
    blockWrites: !flags.has("allow-writes"),
    log: (line) => console.log(line),
    debug: flags.has("debug"),
  })
  // Place each state in the source tree by matching what it shows against the code.
  const sources = guessSources(root, result.scenarios, result.snapshots, flags.get("src"))
  for (const scenario of result.scenarios) scenario.source = sources[scenario.id]
  const file: ScenariosFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    baseUrl: url,
    startPath: one("start") ?? "/",
    stats: result.stats,
    scenarios: result.scenarios,
  }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`)
  // With --debug, keep what each state looked like so a crawl can be compared with known states.
  if (flags.has("debug"))
    fs.writeFileSync(out.replace(/\.json$/, ".snapshots.json"), `${JSON.stringify(result.snapshots)}\n`)
  const { stats } = result
  console.log(
    `\nFound ${stats.states} states in ${stats.seconds}s (${stats.duplicates} repeats, ${stats.skipped} skipped, ${stats.failedReplays} failed replays, stopped: ${stats.stoppedBy}).\nWrote ${path.relative(process.cwd(), out)}`,
  )
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
