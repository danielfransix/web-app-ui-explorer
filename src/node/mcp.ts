import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { version } from "../../package.json"
import { buildPlan } from "../shared/plan"
import { captureDesigns } from "./design-capture"
import { readBridgeConnection, readPreparedImport, reportMcpPresence, sendToBridge } from "./bridge"
import { discoverFigmaDesktop } from "./figma-desktop"
import type { Scenario } from "../shared/types"
import { exportScreens, importSchema, projectState, selectScreens } from "./local-import"
import { ORCHESTRATION_GUIDANCE } from "./agent-guidance"
import { assertProjectDirectory, assertWorkspaceRoots, projectIdentity } from "./project-identity"
import { catalogPage, screenSummary } from "./mcp-catalog"
import { resolveScreenReference } from "../shared/screen-reference"
import { canvasConnections, describeConnection, recipeStep } from "../shared/transitions"
import { parseImportCode } from "../shared/handoff"
import { ensureScreenIdentities, type ScreenIdentities } from "./screen-identities"
import { isScreenId } from "../shared/screen-reference"

// Project-local stdio MCP entry point. Discovery works without a Figma connection; importing uses
// this project's optional bridge. The explorer_ prefix keeps names distinct from other MCP servers.

const BREAKPOINT_LABELS: Record<number, string> = { 1440: "Desktop", 768: "Tablet", 390: "Mobile" }
const KIND = z.enum(["screen", "navigation", "overlay", "variant"])

export type McpServerOptions = {
  root: string
  /** The target app's reachable dev server - required for captures and exports. */
  baseUrl?: string
  startPath?: string
  route?: string
  storageState?: string
  allowWrites?: boolean
}

export function createMcpServer(options: McpServerOptions): McpServer {
  assertProjectDirectory(options.root)
  const projectId = projectIdentity(options.root)
  const scopedOptions = { ...options, expectedProjectId: projectId }
  const server = new McpServer({ name: "web-app-ui-explorer", version }, { instructions: ORCHESTRATION_GUIDANCE })
  async function guard() {
    assertProjectDirectory(options.root)
    if (server.server.getClientCapabilities()?.roots) {
      // Read on every call: a long-lived MCP process must not retain a previous workspace's authority.
      const { roots } = await server.server.listRoots({}, { timeout: 5000 })
      assertWorkspaceRoots(options.root, roots)
    }
  }
  function bridgeConnection() {
    const connection = readBridgeConnection(options.root)
    if (connection.projectId !== projectId) throw new Error("The local bridge has a missing or different project identity. Update and restart this project's Explorer and reconnect its plugin before using MCP Figma tools.")
    return connection
  }
  async function bridgeStatus() {
    bridgeConnection()
    return sendToBridge(options.root)
  }
  const presence = { id: randomUUID(), name: "MCP client" }
  let presenceTimer: ReturnType<typeof setInterval> | undefined
  let presenceWork: Promise<void> = Promise.resolve(), presenceBusy = false
  server.server.oninitialized = () => {
    const client = server.server.getClientVersion()
    presence.name = (client?.title || client?.name || "MCP client").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 100) || "MCP client"
    const heartbeat = () => {
      if (presenceBusy) return
      presenceBusy = true
      // Discovery still works before Explorer starts; retry when its bridge becomes available.
      presenceWork = guard().then(() => { bridgeConnection(); return reportMcpPresence(options.root, presence, true) }).catch(() => {}).finally(() => { presenceBusy = false })
    }
    heartbeat(); presenceTimer = setInterval(heartbeat, 5000); presenceTimer.unref()
  }
  server.server.onclose = () => {
    clearInterval(presenceTimer)
    void presenceWork.then(() => { bridgeConnection(); return reportMcpPresence(options.root, presence, false) }).catch(() => {})
  }
  const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], ...(value && typeof value === "object" && !Array.isArray(value) ? { structuredContent: value as Record<string, unknown> } : {}) })

  const indexes = new WeakMap<ScreenIdentities, Map<string, string>>()
  const identityFor = (screens: Scenario[], state?: { startPath?: string; identities?: ScreenIdentities }) => {
    const identities = ensureScreenIdentities(options.root, screens, state?.startPath ?? options.startPath ?? "/")
    if (state?.identities && (state.identities.projectId !== identities.projectId || screens.some(s => state.identities!.screens[s.id] !== identities.screens[s.id])))
      throw new Error("Screen identities differ between MCP and live Explorer. Restore ui-explorer.ids.json and restart both; no screen was substituted.")
    return identities
  }
  const exactId = (input: { id?: string; screenId?: string; reference?: string }, identities: ScreenIdentities) => {
    if ([input.id, input.screenId, input.reference].filter(value => value !== undefined).length !== 1)
      throw new Error("Provide exactly one screenId, reference or internal id. Names and folders are not unique identifiers.")
    if (input.id !== undefined) return input.id
    const screenId = input.reference ? resolveScreenReference(input.reference, identities.projectId) : input.screenId!
    if (!isScreenId(screenId)) throw new Error("Invalid generated screen ID. Copy it from the screen preview.")
    if (!indexes.has(identities)) indexes.set(identities, new Map(Object.entries(identities.screens).map(([key, generated]) => [generated, key])))
    const found = indexes.get(identities)!.get(screenId)
    if (!found) throw new Error("Unknown or stale screen ID, or an ID from another project. Refresh explorer_catalog; never substitute a screen with the same name.")
    return found
  }
  server.registerTool("explorer_catalog", {
    description: "Start here. Returns this project's checkout identity/root, paginated screens, groups, folders or exact summary counts. Search titles/IDs/source paths; all screen kinds are included by default. Screen references identify an exact screen even when names and folders repeat. Coverage totals cover the entire filter; expected pairs cover this page only. Continue nextCursor with unchanged filters.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { view: z.enum(["screens", "groups", "folders", "summary"]).optional(), group: z.string().optional(), folder: z.string().optional(), kind: KIND.optional(),
      search: z.string().max(500).optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(4096).optional(),
      widths: z.array(z.number().int().min(1).max(7680)).min(1).max(12).optional() },
  }, async query => {
    await guard()
    const state = await projectState(scopedOptions), identities = identityFor(state.scenarios, state)
    return text({ project: { id: projectId, identityId: identities.projectId, root: path.resolve(options.root), catalog: options.baseUrl ? "live" : "saved", captureConfigured: !!options.baseUrl },
      revision: state.revision, generatedAt: state.generatedAt, ...catalogPage(state.scenarios, identities, query) })
  })
  server.registerTool("explorer_inspect_screen", {
    description: "Inspect one exact screen reference or ID: source, identity, safe replay action summaries, incoming/outgoing connection labels and evidence. Does not execute replay, capture or write to Figma. Rejects foreign project references and unknown IDs; never picks a screen by title.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { screenId: z.string().uuid().optional().describe("The generated UUID copied with Copy screen ID"), id: z.string().min(1).optional().describe("Internal scenario key, for existing integrations"), reference: z.string().max(16384).optional() },
  }, async input => {
    await guard()
    const state = await projectState(scopedOptions), identities = identityFor(state.scenarios, state)
    const id = exactId(input, identities)
    const screen = state.scenarios.find(s => s.id === id)
    if (!screen) throw new Error("Unknown or stale screen ID. Refresh explorer_catalog and copy the current reference; do not substitute another screen with the same name.")
    const byId = new Map(state.scenarios.map(s => [s.id, s]))
    const describe = (edge: Parameters<typeof describeConnection>[0]) => ({
      source: screenSummary(byId.get(edge.source)!, identities),
      target: screenSummary(byId.get(edge.target)!, identities),
      ...describeConnection(edge, byId.get(edge.source), byId.get(edge.target)),
    })
    const edges = canvasConnections(state.scenarios, state.transitions)
    return text({ projectId, screen: screenSummary(screen, identities), description: screen.description,
      actions: screen.actions?.map(recipeStep) ?? [], captureConfigured: !!options.baseUrl,
      incoming: edges.filter(edge => edge.target === id).map(describe), outgoing: edges.filter(edge => edge.source === id).map(describe) })
  })

  server.registerTool(
    "explorer_get_screen_design",
    {
      description: "Capture one scanned screen at the requested pixel widths and return a structured design plan (components, variants, linked styles) - the same payload the Explorer UI's manual Copy control produces, ready to hand to a Figma-writing tool. Unlike the other tools here, this needs the target app's dev server to actually be reachable; it cannot be answered from the static manifest alone.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: {
        id: z.string().min(1).optional().describe("An exact ID from explorer_catalog; supply id or reference"),
        screenId: z.string().uuid().optional().describe("Generated UUID copied from a screen preview"),
        reference: z.string().max(16384).optional().describe("A copied project-qualified screen reference; preferred when supplied by the person"),
        widths: z.array(z.number().int().min(1).max(7680)).min(1).max(12),
        createComponents: z.boolean().optional().describe("False returns regular editable layers without components or instances"),
        baseUrl: z.string().optional().describe("Overrides the server's configured --base-url for this one call"),
      },
    },
    async ({ id, screenId, reference, widths, createComponents, baseUrl: callBaseUrl }) => {
      await guard()
      if (reference) resolveScreenReference(reference, ensureScreenIdentities(options.root, []).projectId)
      const resolvedBaseUrl = callBaseUrl ?? options.baseUrl
      if (!resolvedBaseUrl)
        throw new Error("No base URL configured (pass --base-url when starting the mcp server, or `baseUrl` on this call) - the target app's dev server must be reachable to capture a design.")
      const state = await projectState({ ...scopedOptions, baseUrl: resolvedBaseUrl }), all = state.scenarios
      const scenarioId = exactId({ id, screenId, reference }, identityFor(all, state))
      const scenario = all.find((candidate) => candidate.id === scenarioId)
      if (!scenario) throw new Error(`Unknown scenario "${scenarioId}" - call explorer_catalog first.`)
      const captures = await captureDesigns({ baseUrl: resolvedBaseUrl, startPath: options.startPath ?? "/", scenario, widths, projectRoot: options.root, storageState: options.storageState, blockWrites: !options.allowWrites })
      return { content: [{ type: "text", text: JSON.stringify({ version: 1, plan: buildPlan(captures, BREAKPOINT_LABELS, { createComponents }) }) }] }
    },
  )

  server.registerTool("explorer_figma_status", {
    description: "Check this project's companion plugin connection and destination before a batch. Optionally discover the official local Figma desktop MCP (read-only detection, not file selection or desktop control). No bridge token is returned.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { discoverDesktop: z.boolean().optional() },
  }, async ({ discoverDesktop }) => {
    await guard()
    let status
    try { status = await bridgeStatus() }
    catch (error) {
      // Missing bridge is an ordinary diagnostic state; a foreign/stale bridge must fail closed.
      if (error instanceof Error && error.message.startsWith("In UI Explorer,")) status = { connected: false, available: false, message: error.message }
      else throw error
    }
    return text({ ...status, ...(discoverDesktop ? { desktop: await discoverFigmaDesktop() } : {}) })
  })

  server.registerTool("explorer_review_interrupted_commands", {
    description: "Clear the retry block for specific interrupted importer commands only after inspecting their outcomes with native Figma tools. Never use this to blindly retry or clear commands still executing. Read needsReview from explorer_figma_status, inspect the affected destinations, then acknowledge those exact command IDs.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: { ids: z.array(z.string().min(1)).min(1), reviewedInFigma: z.literal(true) },
  }, async (input) => {
    await guard()
    const connection = bridgeConnection()
    const response = await fetch(connection.url + "/commands/reviewed", { method: "POST", headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(5000) })
    const result = await response.json() as { error?: string }
    if (!response.ok) throw new Error(result.error ?? "Interrupted import review failed")
    return text(result)
  })

  server.registerTool("explorer_get_prepared_import", {
    description: "Read the exact prepared selection, widths, layer mode and source folders without importing or requiring the plugin to connect. Use the supplied short code when available; otherwise resolves the import loaded in the plugin or the sole prepared selection. Never ask the person to retype selection details from a code.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { code: z.string().optional().describe("The short UIX1 import code; a local credential that must not be repeated in replies or logs") },
  }, async ({ code }) => {
    await guard()
    const local = bridgeConnection()
    if (code) {
      const supplied = parseImportCode(code)
      if (supplied.url !== local.url || supplied.token !== local.token) throw new Error("This import code belongs to another project or Explorer session. Connect that project's local MCP server, or prepare a new selection here.")
    }
    return text(await readPreparedImport(options.root, code))
  })


  server.registerTool("explorer_export_to_figma", {
    description: "Import registered screens/states by folder, group or exact IDs. Supports named sections and horizontal/grid layout, then verifies exact coverage. Placement is required. Reports protected edits and does not delete orphaned frames.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: { ...importSchema.shape, screenIds: z.array(z.string().uuid()).min(1).max(10000).optional(), references: z.array(z.string().max(16384)).min(1).max(10000).optional() },
  }, async (input) => {
    await guard()
    if ([input.ids, input.screenIds, input.references].filter(Boolean).length > 1) throw new Error("Use screenIds, references or internal ids, not more than one.")
    const state = await projectState(scopedOptions), all = state.scenarios, identities = identityFor(all, state)
    const ids = input.references?.map(reference => exactId({ reference }, identities)) ?? input.screenIds?.map(screenId => exactId({ screenId }, identities)) ?? input.ids
    // Verify the app's identity and every requested ID before contacting a write-capable bridge.
    const selected = selectScreens(all, { ...input, ids })
    if (!selected.length) throw new Error("No registered screens match this scope.")
    if (!(await bridgeStatus()).connected) throw new Error("No Figma plugin connected. Launch it and connect its bridge first.")
    return text(await exportScreens(scopedOptions, { ...input, ids }, command => sendToBridge(options.root, command), { selected }))
  })

  return server
}

export async function runMcpServer(options: McpServerOptions): Promise<void> {
  const server = createMcpServer(options)
  const close = () => { void server.close() }
  const onclose = server.server.onclose
  server.server.onclose = () => {
    process.stdin.off("end", close); process.off("SIGINT", close); process.off("SIGTERM", close)
    onclose?.()
  }
  process.stdin.once("end", close); process.once("SIGINT", close); process.once("SIGTERM", close)
  await server.connect(new StdioServerTransport())
}
