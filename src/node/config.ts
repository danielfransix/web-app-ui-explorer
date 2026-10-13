import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { UiExplorerOptions } from "./options"

/** Settings for `serve`, kept beside the options so one file describes a project. */
export type ServeSettings = {
  /** The dev server to put the explorer in front of. */
  url?: string
  port?: number
  host?: string
  /** Seconds to wait for the dev server to start. */
  wait?: number
  insecure?: boolean
  allowedHosts?: string[]
}

export type ExplorerConfig = UiExplorerOptions & { serve?: ServeSettings }

/** Gives a config file its types: `export default defineConfig({ ... })`. */
export function defineConfig(config: ExplorerConfig): ExplorerConfig {
  return config
}

export const CONFIG_FILES = ["ui-explorer.config.mjs", "ui-explorer.config.js", "ui-explorer.config.cjs", "ui-explorer.config.json", "ui-explorer.config.ts", "ui-explorer.config.mts"]

/** Finds and loads the project's config file, or returns an empty config when there is none. */
export async function loadConfig(root: string, file?: string): Promise<{ config: ExplorerConfig; file?: string }> {
  const found = file ? path.resolve(root, file) : CONFIG_FILES.map((name) => path.join(root, name)).find((candidate) => fs.existsSync(candidate))
  if (!found) return { config: {} }
  if (!fs.existsSync(found)) throw new Error(`Config file not found: ${found}`)
  if (found.endsWith(".json")) return { config: JSON.parse(fs.readFileSync(found, "utf8")) as ExplorerConfig, file: found }
  try {
    const loaded = (await import(pathToFileURL(found).href)) as { default?: ExplorerConfig }
    return { config: loaded.default ?? {}, file: found }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/\.m?ts$/.test(found))
      throw new Error(`Could not load ${path.basename(found)}: ${message}\nTypeScript config files need Node 22.18 or newer; otherwise use ui-explorer.config.mjs.`)
    throw new Error(`Could not load ${path.basename(found)}: ${message}`)
  }
}
