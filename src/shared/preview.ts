import type { Scenario } from "./types"

// How a scenario is shown. A recipe scenario is the app itself at its start path, with two query
// parameters that make the page replay the recipe and report back. A scenario with its own `url` is shown
// as given, for hosts that render states themselves.

export const PREVIEW_PARAM = "__uix"
export const EMBED_PARAM = "__uix_embed"

/** Messages a preview page posts to the explorer that embeds it. */
export type PreviewMessage =
  | { type: "uix:ready"; id: string }
  | { type: "uix:error"; id: string; message: string }
  | { type: "uix:gallery" }

/** Set on <html> by a preview page: `ready`, or `error: <message>`. Lets tools that are not an embedding page wait for it. */
export const STATUS_ATTRIBUTE = "data-uix-status"

export function previewPath(scenario: Scenario, startPath: string): string {
  if (scenario.url) return scenario.url
  const base = scenario.startPath ?? startPath
  const separator = base.includes("?") ? "&" : "?"
  return `${base}${separator}${PREVIEW_PARAM}=${encodeURIComponent(scenario.id)}&${EMBED_PARAM}=1`
}
