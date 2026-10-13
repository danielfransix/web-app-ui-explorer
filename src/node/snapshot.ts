import fs from "node:fs"
import path from "node:path"
import { createExplorer } from "./core/explorer"
import { injectIntoHtml } from "./html"
import type { UiExplorerOptions } from "./options"

// A read-only copy of the explorer for a production build from any bundler: the output folder is plain files, so
// the explorer is copied in and the app's HTML pages get the runtime tag. Nothing here reads the bundler's config.

export type SnapshotOptions = UiExplorerOptions & {
  /** The build output folder, for example `build` or `dist`. */
  dir: string
  root?: string
  /** Where the app is hosted ("" at the domain root, "/app" under a prefix). */
  base?: string
  /** HTML files to tag, relative to `dir`. Default: every .html file in it. */
  html?: string[]
  log?: (line: string) => void
}

function htmlFiles(dir: string, skip: string): string[] {
  const found: string[] = []
  const walk = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== skip && entry.name !== "node_modules") walk(full)
      } else if (/\.html?$/i.test(entry.name)) found.push(path.relative(dir, full).split(path.sep).join("/"))
    }
  }
  walk(dir)
  return found
}

export function snapshot(config: SnapshotOptions): { files: number; tagged: string[] } {
  const log = config.log ?? (() => {})
  const root = fs.realpathSync.native(path.resolve(config.root ?? "."))
  const out = path.resolve(root, config.dir)
  if (!fs.existsSync(out) || !fs.statSync(out).isDirectory()) throw new Error(`Build folder not found: ${out}. Build your app first.`)
  const prefix = (config.base ?? "").replace(/\/+$/, "")
  if (prefix && !prefix.startsWith("/")) throw new Error(`--base must start with a slash, got "${config.base}".`)

  const { dir: _dir, root: _root, base: _base, html: _html, log: _log, ...options } = config
  const explorer = createExplorer({ root, options })
  const routeDir = explorer.route.slice(1)

  // Start clean so a thumbnail from an earlier run never lingers.
  fs.rmSync(path.join(out, routeDir), { recursive: true, force: true })
  const files = explorer.snapshotFiles(prefix)
  for (const [name, content] of files) {
    const file = path.join(out, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }

  const tag = explorer.runtimeTag(prefix)
  const tagged: string[] = []
  for (const name of config.html ?? htmlFiles(out, routeDir)) {
    const file = path.join(out, name)
    if (!fs.existsSync(file)) throw new Error(`HTML file not found in the build folder: ${name}`)
    const before = fs.readFileSync(file, "utf8")
    const after = injectIntoHtml(before, tag)
    if (after !== before) {
      fs.writeFileSync(file, after)
      tagged.push(name)
    }
  }
  explorer.dispose()
  log(`Wrote ${files.size} files to ${path.join(path.relative(process.cwd(), out) || ".", routeDir)} and tagged ${tagged.length} HTML file(s).`)
  return { files: files.size, tagged }
}
