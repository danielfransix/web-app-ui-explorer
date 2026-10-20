#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import type { ScenariosFile } from "../shared/types"
import { capture } from "./capture"
import { loadConfig, type ExplorerConfig } from "./config"
import { crawl } from "./crawl"
import { init } from "./init"
import { installAgentGuidance } from "./agent-guidance"
import { runMcpServer } from "./mcp"
import { installProjectMcp } from "./mcp-install"
import { startBridge } from "./bridge"
import { computeRevision } from "./revision"
import { normaliseTarget, serve } from "./serve"
import { snapshot } from "./snapshot"
import { guessSources } from "./sources"

const HELP = `web-app-ui-explorer

Works with any bundler: it sits in front of your running dev server, so nothing in your build changes.

Usage
  web-app-ui-explorer init                       Set the project up (adds the Vite plugin, or a config file and "explorer" script)
  web-app-ui-explorer agents --root <dir>         Add or update orchestration guidance in the project's AGENTS.md
  web-app-ui-explorer serve --url <server> ...   Put the explorer in front of your dev server
  web-app-ui-explorer snapshot --dir <build>     Add a read-only explorer to a production build folder
  web-app-ui-explorer crawl --url <server> ...   Explore the running app and write its scenarios
  web-app-ui-explorer capture --url <server> ... Take thumbnails of the scenarios
  web-app-ui-explorer mcp --root <dir> ...       Run the MCP server exposing scanned screens to an agent (stdio)
  web-app-ui-explorer mcp install --client <vscode|codex>  Install MCP in this project's configuration only
  web-app-ui-explorer bridge --root <dir>       Connect the companion Figma plugin to MCP (loopback port 5198)

Options for init
  --serve                Set up the standalone server even in a Vite project
  --vite                 Add the Vite plugin (the default in a Vite project)

Options for serve
  --url <url>            The dev server, for example http://localhost:3000 (or serve.url in the config file)
  --port <n>             Port to listen on (default 5199; 0 picks a free one)
  --host <host>          Interface to listen on (default 127.0.0.1)
  --wait <seconds>       Wait for the dev server to start answering (default 0)
  --allowed-host <name>  Accept another Host header (repeatable)
  --insecure             Accept a self-signed certificate from an https dev server
  --config <file>        Config file (default ui-explorer.config.mjs, .js, .json or .ts)
  --root <dir>           Project root (default .)
  --start <path>         Where every recipe starts (default /)
  --src <dir>            Source folder to watch and show, relative to the root (repeatable, default src)
  --deny <regex>         Never click a control whose label matches (repeatable)

Options for snapshot
  --dir <folder>         The build output, for example build or dist (required)
  --base <path>          Where the app is hosted, for example /app (default: the domain root)
  --html <file>          An HTML file in the folder to tag (repeatable; default every .html file)
  --config <file>, --root <dir>, --src <dir>

Options for crawl
  --url <url>            Origin of the running dev server, or of serve (required)
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
  --url <url>            Origin the explorer is served from: the serve address, or a Vite dev server with the plugin (required)
  --root <dir>           Project root (default .)
  --dir <dir>            Folder holding scenarios.json and thumbnails (default .ui-explorer)
  --src <dir>            Source folder the revision is computed from (repeatable, default src)
  --concurrency <n>      Browsers working at once (default 4)

Options for mcp
  --root <dir>           Project root; server working directory must match (default .)
  --base-url <url>       The target app's reachable dev server, required for captures and exports
  --start <path>         Where every recipe starts (default /)
  --route <path>         Explorer route for discovery (default /__explorer)
  --storage-state <file> Playwright storage state for authenticated captures
  --allow-writes         Allow app requests that change data during design capture

Options for mcp install
  --client <name>        vscode (.vscode/mcp.json) or codex (.codex/config.toml), required
  --root <dir>           App root containing the local npm dependency (default .)
  --base-url <url>       App serving Explorer; omit for saved-catalog discovery only
  --route <path>         Custom Explorer route (default /__explorer)
  No global installation is supported. Restart your MCP client after setup.

Options for bridge
  --root <dir>           Target app root (connection saved under .ui-explorer, default .)
  --port <n>             Loopback port (default 5198; custom ports also need a matching plugin manifest domain)
  --base-url <url>       Running app URL; enables the plugin's local folder and screen-ID imports
  --start <path>         Where replay recipes start (default /)
  --route <path>         Explorer catalog route (default /__explorer)
  --storage-state <file> Playwright storage state for authenticated captures
  --allow-writes         Allow app requests that change data during capture
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

  const root = path.resolve(one("root") ?? ".")

  if (command === "agents") {
    installAgentGuidance(root, (line) => console.log(line))
    return
  }

  if (command === "init") {
    const mode = flags.has("serve") ? "serve" : flags.has("vite") ? "vite" : undefined
    process.exitCode = init(root, (line) => console.log(line), { mode }) ? 0 : 1
    return
  }

  if (command === "mcp") {
    if (flags.has("global")) throw new Error("Global MCP installation is not supported. Install separately in each project.")
    const supported = new Set(positional[1] === "install"
      ? ["client", "root", "base-url", "route"]
      : ["root", "base-url", "start", "route", "storage-state", "allow-writes"])
    const unknown = [...flags.keys()].filter(flag => !supported.has(flag))
    if (unknown.length) throw new Error(`Unknown MCP option: ${unknown.map(flag => `--${flag}`).join(", ")}. Run ui-explorer mcp --help for supported options.`)
    if (positional[1] === "install") {
      const client = one("client")
      if (client !== "vscode" && client !== "codex") throw new Error("Choose --client vscode or --client codex. MCP installation is project-local only.")
      const result = installProjectMcp({ root, client, baseUrl: one("base-url"), route: one("route") })
      installAgentGuidance(root, line => console.log(line))
      console.log(`${result.changed ? "Installed" : "Already installed"}: ${result.file}\nRestart your MCP client in this project. Verify explorer_catalog.project.root before using screens. Project configuration must be trusted by your client.`)
      return
    }
    if (positional[1]) throw new Error("Unknown MCP subcommand. Use `mcp` or `mcp install`.")
    await runMcpServer({ root, baseUrl: one("base-url"), startPath: one("start"), route: one("route"), storageState: one("storage-state"), allowWrites: flags.has("allow-writes") })
    return
  }

  if (command === "bridge") {
    const bridge = await startBridge({ root, port: number("port"), baseUrl: one("base-url"), startPath: one("start"), route: one("route"), storageState: one("storage-state"), allowWrites: flags.has("allow-writes") })
    console.log(`Paste this connection URL into the Figma plugin: ${bridge.url}/#${bridge.token}`)
    const close = () => { void bridge.close().then(() => process.exit()) }
    process.once("SIGINT", close); process.once("SIGTERM", close)
    return
  }

  if (!["serve", "snapshot", "crawl", "capture"].includes(command)) {
    console.error(`Unknown command: ${command}\n\n${HELP}`)
    process.exit(2)
  }

  const { config: loaded, file: configFile } = await loadConfig(root, one("config"))
  const { serve: serveSettings, ...fileOptions } = loaded as ExplorerConfig
  const sources = flags.get("src") ?? fileOptions.sources
  const deny = [...(fileOptions.deny ?? []), ...(flags.get("deny") ?? [])]

  if (command === "snapshot") {
    const dir = one("dir") ?? positional[1]
    if (!dir) {
      console.error("Missing --dir, the build folder to add the explorer to.\n")
      console.log(HELP)
      process.exit(2)
    }
    snapshot({
      ...fileOptions,
      sources,
      dir,
      root,
      base: one("base"),
      html: flags.get("html"),
      log: (line) => console.log(line),
    })
    return
  }

  const rawUrl = one("url") ?? (command === "serve" || command === "crawl" || command === "capture" ? serveSettings?.url : undefined)
  if (!rawUrl) {
    console.error("Missing --url, the address of your running dev server (or serve.url in ui-explorer.config.mjs).\n")
    console.log(HELP)
    process.exit(2)
  }
  const url = normaliseTarget(rawUrl)

  if (command === "serve") {
    if (configFile) console.log(`Using ${path.relative(process.cwd(), configFile) || configFile}`)
    const running = await serve({
      ...fileOptions,
      sources,
      deny: deny.length ? deny : undefined,
      startPath: one("start") ?? fileOptions.startPath,
      target: url,
      root,
      port: number("port") ?? serveSettings?.port,
      host: one("host") ?? serveSettings?.host,
      wait: number("wait") ?? serveSettings?.wait,
      interactiveDiscovery: true,
      insecure: flags.has("insecure") || serveSettings?.insecure,
      allowedHosts: flags.get("allowed-host") ?? serveSettings?.allowedHosts,
      log: (line) => console.log(line),
    })
    console.log(`\nUI Explorer is running.\n  Your app:  ${running.url}/\n  Explorer:  ${running.url}${running.explorer.route}/\n  Forwarding to ${url}\n\nPress Ctrl+C to stop.`)
    const stop = () => void running.close().then(() => process.exit(0))
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
    return
  }

  if (command === "capture") {
    const dir = path.resolve(root, one("dir") ?? fileOptions.dir ?? ".ui-explorer")
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
      revision: computeRevision(root, sources),
      concurrency: number("concurrency"),
      storageState: fileOptions.storageState,
      blockWrites: !fileOptions.allowWrites,
      log: (line) => console.log(line),
    })
    console.log(
      `\nCaptured ${Object.keys(manifest.items).length} thumbnails, ${Object.keys(manifest.failed).length} failed.`,
    )
    return
  }

  const out = path.resolve(root, one("out") ?? path.join(fileOptions.dir ?? ".ui-explorer", "scenarios.json"))
  const startPath = one("start") ?? fileOptions.startPath
  const result = await crawl({
    baseUrl: url,
    startPath,
    maxStates: number("max-states") ?? fileOptions.maxStates,
    maxDepth: number("max-depth"),
    concurrency: number("concurrency"),
    timeBudgetMs: number("time-budget") ? number("time-budget")! * 60_000 : undefined,
    deny: deny.length ? deny : undefined,
    storageState: one("storage-state") ?? fileOptions.storageState,
    headless: !flags.has("headed"),
    blockWrites: !(flags.has("allow-writes") || fileOptions.allowWrites),
    log: (line) => console.log(line),
    debug: flags.has("debug"),
  })
  // Place each state in the source tree by matching what it shows against the code.
  const guessed = guessSources(root, result.scenarios, result.snapshots, sources)
  for (const scenario of result.scenarios) scenario.source = guessed[scenario.id]
  const file: ScenariosFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    baseUrl: url,
    startPath: startPath ?? "/",
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
