import path from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { listScenarios } from "./query"
import { captureDesigns } from "./design-capture"
import { buildPlan, orderComponents } from "../shared/plan"
import { hashString } from "../shared/hash"
import type { Scenario, DesignCapture } from "../shared/types"
import type { BridgeCommand, BridgeResult, ImportProgress, ImportRequest } from "../shared/bridge"

export type LocalProject = { root: string; baseUrl?: string; startPath?: string; route?: string; storageState?: string; allowWrites?: boolean }
export const placementSchema = z.object({ mode: z.enum(["current-page", "page", "section", "per-folder"]), name: z.string().trim().min(1).optional(), nodeId: z.string().optional(), container: z.string().trim().min(1).max(160).optional() })
export const layoutSchema = z.object({ mode: z.enum(["horizontal", "grid"]), columns: z.number().int().min(1).max(20).optional(), gap: z.number().int().min(0).max(1000).optional() })
export const librarySchema = z.object({ components: z.record(z.string(), z.object({ key: z.string(), set: z.boolean().optional() })).optional(), paintStyleKeys: z.array(z.string()).optional(), textStyleKeys: z.array(z.string()).optional() })
export const selectionSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(10000), widths: z.array(z.number().int().min(1).max(7680)).min(1).max(12), labels: z.record(z.string(), z.string().trim().min(1).max(80)).optional(), createComponents: z.boolean().optional() })
export const importSchema = z.object({ folder: z.string().trim().min(1).optional(), group: z.string().optional(), ids: selectionSchema.shape.ids.optional(), widths: selectionSchema.shape.widths, labels: selectionSchema.shape.labels, createComponents: selectionSchema.shape.createComponents, placement: placementSchema, layout: layoutSchema.optional(), libraries: librarySchema.optional() })
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const normalized = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
export function selectScreens(all: Scenario[], filters: { folder?: string; group?: string; ids?: string[]; kind?: Scenario["kind"] } = {}) {
  const folder = filters.folder && normalized(filters.folder)
  const selected = all.filter(s => (!folder || normalized(s.source ?? "").startsWith(folder + "/")) && (!filters.group || s.group === filters.group) && (!filters.kind || s.kind === filters.kind) && (!filters.ids || filters.ids.includes(s.id)))
    .sort((a, b) => compare(normalized(a.source ?? ""), normalized(b.source ?? "")) || compare(a.id, b.id))
  if (filters.ids?.some(id => !selected.some(s => s.id === id))) throw new Error("Some requested screen IDs do not exist in the selected scope. Refresh the source list.")
  return selected
}
export async function projectScenarios(options: LocalProject): Promise<Scenario[]> {
  if (!options.baseUrl) return listScenarios(options.root)
  const response = await fetch(new URL(`${options.route ?? "/__explorer"}/api/state`, options.baseUrl), { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`Explorer discovery failed: HTTP ${response.status}. Check the running app URL.`)
  const data = await response.json() as { scenarios: Scenario[] }
  if (!Array.isArray(data.scenarios)) throw new Error("The app URL did not return a UI Explorer catalog.")
  const seen = new Set<string>()
  for (const s of data.scenarios) { if (!s.id || seen.has(s.id)) throw new Error("The catalog contains missing or duplicate screen IDs."); seen.add(s.id) }
  return data.scenarios
}
export function sourceFolders(scenarios: Scenario[]) {
  const counts = new Map<string, number>()
  for (const s of scenarios) {
    const parts = normalized(s.source ?? "").split("/").slice(0, -1)
    for (let i = 1; i <= parts.length; i++) { const key = parts.slice(0, i).join("/") + "/"; counts.set(key, (counts.get(key) ?? 0) + 1) }
  }
  return [...counts].map(([folder, count]) => ({ folder, count })).sort((a, b) => compare(a.folder, b.folder))
}
export async function projectCatalog(options: LocalProject) {
  const scenarios = selectScreens(await projectScenarios(options))
  return { project: path.basename(options.root), baseUrl: options.baseUrl ?? "", captureReady: !!options.baseUrl, scenarios, folders: sourceFolders(scenarios) }
}
export async function exportScreens(options: LocalProject, input: ImportRequest, dispatch: (command: BridgeCommand) => Promise<BridgeResult>, hooks: { signal?: AbortSignal; progress?: (value: ImportProgress) => void; selected?: Scenario[]; capture?: typeof captureDesigns } = {}) {
  const request = importSchema.parse(input)
  if (!options.baseUrl) throw new Error("Start the bridge with --base-url <running-app-url> to import local screens.")
  if (["page", "section"].includes(request.placement.mode) && !request.placement.name && !request.placement.nodeId) throw new Error("Enter a destination name.")
  const selected = hooks.selected ?? selectScreens(await projectScenarios(options), request)
  if (!selected.length) throw new Error("No registered screens match this scope.")
  const widths = [...new Set(request.widths)].sort((a, b) => b - a)
  const expectedFrames = selected.length * widths.length
  const progress = (phase: ImportProgress["phase"], completed: number, total: number, message: string) => hooks.progress?.({ phase, completed, total, message })
  const check = () => hooks.signal?.throwIfAborted()
  const captures: DesignCapture[] = []
  const report: string[] = [], conflicts: string[] = [], warnings: string[] = []
  const send = async (command: BridgeCommand) => {
    check(); const result = await dispatch(command)
    if (result.error) throw new Error(result.error)
    report.push(...result.report ?? []); conflicts.push(...result.conflicts ?? []); warnings.push(...result.warnings ?? [])
    return result
  }
  const runId = randomUUID()
  // Pin the target page and edit baseline before capture. Always release the run, including cancellation.
  await send({ type: "begin-export", runId, placement: request.placement, createComponents: request.createComponents, deferComponentBaseline: true,
    ...(request.placement.mode === "per-folder" ? { folders: [...new Set(selected.map(s => normalized(s.source ?? "").split("/").slice(0, -1).join("/") || s.group))] } : {}) })
  try {
    for (let i = 0; i < selected.length; i++) {
      check(); const scenario = selected[i]
      progress("capturing", i, selected.length, `Capturing ${i + 1} of ${selected.length}: ${scenario.title}`)
      captures.push(...await (hooks.capture ?? captureDesigns)({ baseUrl: options.baseUrl, startPath: options.startPath ?? "/", scenario, widths, projectRoot: options.root, storageState: options.storageState, blockWrites: !options.allowWrites, signal: hooks.signal }))
    }
    check()
    const expectedPairs = new Set(selected.flatMap(s => widths.map(width => JSON.stringify([s.id, width]))))
    const actualPairs = captures.map(capture => JSON.stringify([capture.scenarioId, capture.width]))
    if (actualPairs.length !== expectedPairs.size || new Set(actualPairs).size !== expectedPairs.size || actualPairs.some(pair => !expectedPairs.has(pair))) throw new Error("Capture coverage differs from the requested screen/width pairs. No frames were imported.")
    const plan = buildPlan(captures, { 1440: "Desktop", 768: "Tablet", 390: "Mobile", ...request.labels }, { createComponents: request.createComponents })
    warnings.push(...plan.warnings ?? [])
    for (const frame of plan.frames) { const s = selected.find(s => s.id === frame.scenarioId)!; frame.folder = normalized(s.source ?? "").split("/").slice(0, -1).join("/") || s.group }
    const components = orderComponents(plan.components)
    for (let i = 0; i < components.length; i++) {
      progress("components", i, components.length, `Preparing component ${i + 1} of ${components.length}`)
      await send({ type: "build", plan: { components: [components[i]], frames: [] }, placement: request.placement, libraries: request.libraries, runId,
        ...(i === 0 ? { componentScope: components.map(component => ({ componentId: component.componentId, variants: component.variants.map(variant => ({ name: variant.variantName, contentHash: hashString(JSON.stringify(variant.node)) })) })) } : {}) })
    }
    for (let i = 0; i < plan.frames.length; i++) {
      progress("frames", i, expectedFrames, `Importing frame ${i + 1} of ${expectedFrames}`)
      await send({ type: "build", plan: { components: [], frames: [plan.frames[i]], ...(plan.createComponents === false ? { createComponents: false } : {}) }, placement: request.placement, libraries: request.libraries, runId })
    }
    const coverage = { missing: [] as { scenarioId: string; width: number }[], unexpected: [] as { scenarioId: string; width: number }[] }
    const folders = request.placement.mode === "per-folder" ? [...new Set(plan.frames.map(f => f.folder!))] : [undefined]
    for (const folder of folders) {
      const expected = plan.frames.filter(f => !folder || f.folder === folder).map(({ scenarioId, width }) => ({ scenarioId, width }))
      const placement = folder ? { ...request.placement, mode: "page" as const, name: folder } : request.placement
      progress("verifying", expectedFrames, expectedFrames, "Arranging frames and verifying coverage…")
      if (request.layout) await send({ type: "arrange", expected, placement, layout: request.layout, runId })
      const result = await send({ type: "verify", expected, placement, runId })
      if (!result.coverage) throw new Error("Figma did not return a coverage report.")
      coverage.missing.push(...result.coverage.missing); coverage.unexpected.push(...result.coverage.unexpected)
    }
    progress("completed", expectedFrames, expectedFrames, `Finished ${expectedFrames} frames. Review import results.`)
    return { scenarios: selected.length, expectedFrames, report, conflicts, warnings: [...new Set(warnings)], coverage }
  } finally { await dispatch({ type: "end-export", runId }).catch(() => {}) }
}
