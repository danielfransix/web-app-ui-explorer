import fs from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { isScreenId } from "../shared/screen-reference"
import type { Scenario } from "../shared/types"

export const SCREEN_IDENTITIES_FILE = "ui-explorer.ids.json"
export type ScreenIdentities = { version: 1; projectId: string; screens: Record<string, string> }

function read(file: string): ScreenIdentities | undefined {
  if (!fs.existsSync(file)) return
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${SCREEN_IDENTITIES_FILE} must not be a symlink.`)
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as ScreenIdentities
    if (data.version !== 1 || typeof data.projectId !== "string" || !isScreenId(data.projectId) || !data.screens || typeof data.screens !== "object" || Array.isArray(data.screens)) throw new Error()
    const ids = Object.values(data.screens)
    if (ids.some(id => typeof id !== "string" || !isScreenId(id)) || new Set(ids).size !== ids.length) throw new Error()
    return data
  } catch { throw new Error(`${SCREEN_IDENTITIES_FILE} is invalid or contains duplicate IDs. Restore it from version control; Explorer will not replace existing identities.`) }
}

/** One framework-independent registry, shared by live HTTP, saved discovery, MCP and snapshots. */
export function ensureScreenIdentities(root: string, scenarios: readonly (string | Scenario)[], startPath = "/"): ScreenIdentities {
  const entries = scenarios.map(scenario => {
    if (typeof scenario === "string") return { id: scenario, key: `scenario:${scenario}` }
    if (scenario.identityKey) return { id: scenario.id, key: `key:${scenario.identityKey}`, explicit: true }
    // Crawler slugs depend on titles and discovery order. A recipe anchor prevents a reused slug
    // from inheriting another state's UUID. Hashes keep replay values/selectors out of the registry.
    const key = scenario.origin === "crawled" && scenario.actions
      ? `recipe:${createHash("sha256").update(JSON.stringify([scenario.startPath ?? startPath, scenario.url ?? null, scenario.actions])).digest("hex")}`
      : `scenario:${scenario.id}`
    return { id: scenario.id, key }
  })
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1)
  for (const entry of entries) if (counts.get(entry.key)! > 1) {
    if (entry.explicit) throw new Error("Two screens declare the same identityKey. Give each screen a unique stable key.")
    // Identical legacy recipes do not prove two screens are the same. Keep them distinct.
    entry.key += `:scenario:${entry.id}`
  }
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error("Cannot assign screen IDs: the catalog has duplicate scenario keys.")
  const file = path.join(root, SCREEN_IDENTITIES_FILE)
  let existing = read(file)
  const hasAll = (data?: ScreenIdentities) => data && entries.every(({ key }) => Object.hasOwn(data.screens, key))
  const project = (data: ScreenIdentities): ScreenIdentities => ({ version: 1, projectId: data.projectId, screens: Object.fromEntries(entries.map(({ id, key }) => [id, data.screens[key]])) })
  if (hasAll(existing)) return project(existing!)
  const lock = `${file}.lock`
  const wait = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + 2000
  while (true) {
    try { fs.mkdirSync(lock); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (Date.now() >= deadline) throw new Error(`Screen ID registry is busy. Retry shortly. If no Explorer process is running, remove ${SCREEN_IDENTITIES_FILE}.lock.`)
      Atomics.wait(wait, 0, 0, 10)
    }
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    // Another process may have assigned IDs while this one waited for the lock.
    existing = read(file)
    if (hasAll(existing)) return project(existing!)
    const data: ScreenIdentities = existing ?? { version: 1, projectId: randomUUID(), screens: {} }
    const used = new Set(Object.values(data.screens))
    for (const { id: scenarioId, key, explicit } of entries) if (!Object.hasOwn(data.screens, key)) {
      const prior = `scenario:${scenarioId}`
      if (explicit && Object.hasOwn(data.screens, prior)) {
        // Declaring a stable key before renaming an existing registered scenario is an explicit
        // identity migration. Move its assignment rather than issuing or duplicating the UUID.
        data.screens[key] = data.screens[prior]
        delete data.screens[prior]
        continue
      }
      let id: string
      do { id = randomUUID() } while (used.has(id))
      Object.defineProperty(data.screens, key, { value: id, enumerable: true, writable: true, configurable: true })
      used.add(id)
    }
    data.screens = Object.fromEntries(Object.entries(data.screens).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { flag: "wx" })
    fs.renameSync(temporary, file)
    return project(data)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    fs.rmdirSync(lock)
  }
}
