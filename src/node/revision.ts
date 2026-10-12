import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

// A thumbnail is only trustworthy while the app it was captured from is unchanged. The revision is a hash of
// every source file that can alter what a preview renders, computed the same way by the dev server and by
// the CLI, so stale captures are recognised.
const AFFECTS = /\.(tsx?|jsx?|mjs|vue|svelte|astro|css|scss|less|json|svg|html)$/
const SKIP_FILE = /(\.d\.ts$|\.(test|spec|stories)\.[a-z]+$)/
const SKIP_DIR = new Set(["node_modules", "dist", "build", "coverage", ".git", ".ui-explorer", "storybook-static", "stories", "__tests__"])

export function affectsPreviews(relative: string): boolean {
  if (!AFFECTS.test(relative) || SKIP_FILE.test(relative)) return false
  return !relative.split("/").some((part) => SKIP_DIR.has(part))
}

function walk(directory: string, found: string[] = []): string[] {
  if (!fs.existsSync(directory)) return found
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIR.has(entry.name)) continue
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(full, found)
    else found.push(full)
  }
  return found
}

export function computeRevision(root: string, dirs: string[] = ["src"]): string {
  const hash = crypto.createHash("sha1")
  const files = dirs
    .flatMap((dir) => walk(path.resolve(root, dir)))
    .map((file) => ({ file, relative: path.relative(root, file).split(path.sep).join("/") }))
    .filter(({ relative }) => affectsPreviews(relative))
    .sort((a, b) => a.relative.localeCompare(b.relative))
  for (const { file, relative } of files) {
    // Normalise line endings so the same source hashes identically on every platform.
    hash.update(`${relative}\0${fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")}\0`)
  }
  return hash.digest("hex").slice(0, 12)
}
