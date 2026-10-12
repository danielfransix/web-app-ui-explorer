import fs from "node:fs"
import path from "node:path"
import type { Scenario, Snapshot } from "../shared/types"

// Maps what a person sees (a heading, a dialog title, a button label) back to the file that renders it.
// The text on screen is written somewhere in the source, so matching it against string literals and JSX
// text finds the right file most of the time without understanding the framework.

const SOURCE_FILE = /\.(tsx|jsx|ts|js|mjs|vue|svelte|astro|html)$/
const IGNORED_FILE = /(\.d\.ts$|\.(test|spec|stories)\.[a-z]+$|\.config\.[a-z]+$)/
const IGNORED_DIR = new Set(["node_modules", "dist", "build", "coverage", ".git", ".ui-explorer", ".next", ".nuxt", ".svelte-kit", "storybook-static"])

const posix = (file: string) => file.split(path.sep).join("/")

const UI_FILE = /\.(tsx|jsx|vue|svelte|astro|html)$/

/** Source files that can render a screen. `all` also lists plain scripts, for matching text to files. */
export function listSources(root: string, dirs: string[] = ["src"], all = true): string[] {
  const found: string[] = []
  const walk = (directory: string) => {
    if (!fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (IGNORED_DIR.has(entry.name)) continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (SOURCE_FILE.test(entry.name) && !IGNORED_FILE.test(entry.name) && (all || UI_FILE.test(entry.name)))
        found.push(posix(path.relative(root, full)))
    }
  }
  for (const dir of dirs) walk(path.resolve(root, dir))
  return found.sort()
}

const normalise = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase()

/** Every user-visible string a file contains: JSX text, quoted strings and template literals. */
function stringsOf(source: string): Set<string> {
  const found = new Set<string>()
  const add = (text: string) => {
    const value = normalise(text.replace(/\{[^}]*\}/g, " "))
    if (value.length >= 2 && value.length <= 140) found.add(value)
  }
  for (const match of source.matchAll(/>([^<>{}]+)</g)) add(match[1])
  for (const match of source.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) add(match[1])
  for (const match of source.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) add(match[1])
  for (const match of source.matchAll(/`((?:[^`\\]|\\.)*)`/g)) add(match[1])
  return found
}

type Index = Map<string, string[]>

function buildIndex(root: string, files: string[]): Index {
  const index: Index = new Map()
  for (const file of files) {
    let source: string
    try {
      source = fs.readFileSync(path.resolve(root, file), "utf8")
    } catch {
      continue
    }
    if (source.length > 400_000) continue
    for (const text of stringsOf(source)) {
      const list = index.get(text)
      if (list) list.push(file)
      else index.set(text, [file])
    }
  }
  return index
}

// Shared building blocks (buttons, modals) contain generic words; the screen that uses them is the answer.
const SHARED = /(^|\/)(components\/primitives|primitives|ui|common|shared|lib|utils|hooks)\//i

export function guessSources(
  root: string,
  scenarios: Scenario[],
  snapshots: Record<string, Snapshot>,
  dirs?: string[],
): Record<string, string> {
  const files = listSources(root, dirs)
  const index = buildIndex(root, files)
  const result: Record<string, string> = {}
  for (const scenario of scenarios) {
    const snapshot = snapshots[scenario.id]
    const needles: [string, number][] = []
    for (const heading of snapshot?.headings ?? []) needles.push([heading, 4])
    for (const dialog of snapshot?.dialogs ?? []) needles.push([dialog, 5])
    needles.push([scenario.title, 3])
    const label = scenario.description?.split("›").pop()
    if (label) needles.push([label, 1])
    const score = new Map<string, number>()
    for (const [text, weight] of needles) {
      const hits = index.get(normalise(text))
      if (!hits) continue
      // A string found everywhere says little; one found in a single file says a lot.
      const share = weight / Math.sqrt(hits.length)
      for (const file of hits) score.set(file, (score.get(file) ?? 0) + share * (SHARED.test(file) ? 0.4 : 1))
    }
    let best: string | undefined
    let bestScore = 0
    for (const [file, value] of score) {
      if (value > bestScore || (value === bestScore && best && file.length < best.length)) {
        best = file
        bestScore = value
      }
    }
    if (best) result[scenario.id] = best
  }
  return result
}
