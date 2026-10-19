import { createExplorer } from "./core/explorer"
import type { Scenario } from "../shared/types"

// Public Node API for querying a saved manifest without a dev server. Live MCP discovery uses
// projectState and selectScreens instead, so live-only registered scenarios are included there.

export type QueryFilters = {
  group?: string
  /** A source path prefix, e.g. "web-app/src/screens/Candidate" - matches by prefix, not exact folder. */
  folder?: string
  /** Deliberately optional with no default: every kind is included unless this narrows it. */
  kind?: Scenario["kind"]
}

function matches(scenario: Scenario, filters: QueryFilters): boolean {
  if (filters.group && scenario.group !== filters.group) return false
  if (filters.folder && !(scenario.source ?? "").startsWith(filters.folder)) return false
  if (filters.kind && scenario.kind !== filters.kind) return false
  return true
}

function allScenarios(root: string): Scenario[] {
  return createExplorer({ root }).state().scenarios
}

export function listScenarios(root: string, filters: QueryFilters = {}): Scenario[] {
  return allScenarios(root).filter((scenario) => matches(scenario, filters))
}

export function listGroups(root: string): { group: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const scenario of allScenarios(root)) counts.set(scenario.group, (counts.get(scenario.group) ?? 0) + 1)
  return Array.from(counts, ([group, count]) => ({ group, count })).sort((a, b) => a.group.localeCompare(b.group))
}

export type CountReport = { total: number; byKind: Record<string, number> }

export function getCounts(root: string, filters: QueryFilters = {}): CountReport {
  const matched = listScenarios(root, filters)
  const byKind: Record<string, number> = {}
  for (const scenario of matched) {
    const kind = scenario.kind ?? "screen"
    byKind[kind] = (byKind[kind] ?? 0) + 1
  }
  return { total: matched.length, byKind }
}
