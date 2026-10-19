import { createHash } from "node:crypto"
import type { Scenario } from "../shared/types"
import { screenReference } from "../shared/screen-reference"
import { selectScreens, sourceFolders } from "./local-import"
import type { ScreenIdentities } from "./screen-identities"

export function screenSummary(screen: Scenario, identities: ScreenIdentities) {
  const screenId = identities.screens[screen.id]
  return { id: screen.id, screenId, reference: screenReference(identities.projectId, screenId), title: screen.title,
    group: screen.group, source: screen.source ?? null, kind: screen.kind ?? "screen", origin: screen.origin ?? null }
}

export type CatalogQuery = { view?: "screens" | "groups" | "folders" | "summary"; group?: string; folder?: string;
  kind?: Scenario["kind"]; search?: string; limit?: number; cursor?: string; widths?: number[] }

export function catalogPage(all: Scenario[], identities: ScreenIdentities, query: CatalogQuery) {
  const { cursor, limit = 50, ...scope } = query
  const search = query.search?.trim().toLowerCase()
  const matched = selectScreens(all, query).filter(screen => !search || [screen.id, identities.screens[screen.id], screen.title, screen.group, screen.source ?? ""].some(value => value.toLowerCase().includes(search)))
  const byKind: Record<string, number> = {}, groups = new Map<string, number>()
  for (const screen of matched) {
    byKind[screen.kind ?? "screen"] = (byKind[screen.kind ?? "screen"] ?? 0) + 1
    groups.set(screen.group, (groups.get(screen.group) ?? 0) + 1)
  }
  const items = query.view === "summary" ? [] : query.view === "groups"
    ? [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([group, count]) => ({ group, count }))
    : query.view === "folders" ? sourceFolders(matched) : matched.map(screen => screenSummary(screen, identities))
  // Reject continuations after the catalog or query changes; do not silently omit or repeat screens.
  const digest = createHash("sha256").update(JSON.stringify([identities.projectId, scope, items, byKind])).digest("hex")
  let offset = 0
  if (cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
      if (parsed.digest !== digest || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || parsed.offset >= items.length) throw new Error()
      offset = parsed.offset
    } catch { throw new Error("Invalid or stale catalog cursor. Repeat the query without a cursor; keep its filters unchanged between pages.") }
  }
  const page = items.slice(offset, offset + limit)
  const widths = [...new Set(query.widths ?? [])]
  return { total: matched.length, byKind, totalItems: items.length, items: page,
    nextCursor: offset + limit < items.length ? Buffer.from(JSON.stringify({ digest, offset: offset + limit })).toString("base64url") : null,
    ...(query.widths ? { expectedFrames: matched.length * widths.length,
      ...(query.view === undefined || query.view === "screens" ? { expected: matched.slice(offset, offset + limit).flatMap(screen => widths.map(width => ({ scenarioId: screen.id, width }))) } : {}) } : {}) }
}
