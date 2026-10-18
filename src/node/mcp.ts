import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { randomUUID } from "node:crypto"
import { buildPlan } from "../shared/plan"
import { captureDesigns } from "./design-capture"
import { type QueryFilters } from "./query"
import { readBridgeConnection, readPreparedImport, reportMcpPresence, sendToBridge } from "./bridge"
import { discoverFigmaDesktop } from "./figma-desktop"
import type { Scenario } from "../shared/types"
import { exportScreens, importSchema, projectScenarios, selectScreens, sourceFolders } from "./local-import"
import { ORCHESTRATION_GUIDANCE } from "./agent-guidance"

// The "front door" for agent-driven automation (system 8): a standard MCP server, shipped as a
// subcommand of this package's own CLI bin rather than a separate package - any consumer adds one block
// to their mcp.json, the same way they'd add any other MCP server, and gets this for free on `npm
// update`. Discovery works independently; the explicit export tool uses the optional local Figma bridge.
//
// Tools are prefixed `explorer_` to avoid collisions when multiple MCP servers are active in one agent
// session at once (this project's own Figma connector is itself namespaced the same way).

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
  const server = new McpServer({ name: "web-app-ui-explorer", version: "1.0.0" }, { instructions: ORCHESTRATION_GUIDANCE })
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
      presenceWork = reportMcpPresence(options.root, presence, true).catch(() => {}).finally(() => { presenceBusy = false })
    }
    heartbeat(); presenceTimer = setInterval(heartbeat, 5000); presenceTimer.unref()
  }
  server.server.onclose = () => {
    clearInterval(presenceTimer)
    void presenceWork.then(() => reportMcpPresence(options.root, presence, false)).catch(() => {})
  }
  const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] })
  async function scenarios(filters: QueryFilters = {}): Promise<Scenario[]> {
    return selectScreens(await projectScenarios(options), filters)
  }

  server.registerTool(
    "explorer_list_groups",
    {
      description: "List every group of scanned screens in this project, each with how many screens are in it. Call this (or explorer_list_screens with no filters) before scoping a run to a specific folder/group, to see what's actually there.",
      inputSchema: {},
    },
    async () => {
      const groups = new Map<string, number>()
      for (const screen of await scenarios()) groups.set(screen.group, (groups.get(screen.group) ?? 0) + 1)
      return text(Array.from(groups, ([group, count]) => ({ group, count })).sort((a, b) => a.group.localeCompare(b.group)))
    },
  )

  server.registerTool(
    "explorer_list_screens",
    {
      description: "List scanned screens, optionally filtered by group, by folder (a source-path prefix), or by kind. Every kind (screen, navigation, overlay, variant) is included unless `kind` narrows it - this is deliberate, not a default exclusion.",
      inputSchema: { group: z.string().optional(), folder: z.string().optional(), kind: KIND.optional() },
    },
    async (filters) => text(await scenarios(filters)),
  )

  server.registerTool(
    "explorer_get_counts",
    {
      description: "Deterministic, non-LLM counts of scanned screens for a scope, by kind - the ground truth to check any downstream (e.g. Figma) output against. Never trust a bare count from the agent's own narration instead of calling this.",
      inputSchema: { group: z.string().optional(), folder: z.string().optional(), kind: KIND.optional(), widths: z.array(z.number().int().min(1).max(7680)).optional() },
    },
    async (filters) => {
      const matched = await scenarios(filters)
      const byKind: Record<string, number> = {}
      for (const screen of matched) byKind[screen.kind ?? "screen"] = (byKind[screen.kind ?? "screen"] ?? 0) + 1
      return text({ total: matched.length, byKind, ...("widths" in filters && Array.isArray(filters.widths) ? {
        expectedFrames: matched.length * new Set(filters.widths).size,
        expected: matched.flatMap((screen) => [...new Set(filters.widths as number[])].map((width) => ({ scenarioId: screen.id, width }))),
      } : {}) })
    },
  )

  server.registerTool(
    "explorer_get_screen_design",
    {
      description: "Capture one scanned screen at the requested pixel widths and return a structured design plan (components, variants, linked styles) - the same payload the Explorer UI's manual Copy control produces, ready to hand to a Figma-writing tool. Unlike the other tools here, this needs the target app's dev server to actually be reachable; it cannot be answered from the static manifest alone.",
      inputSchema: {
        id: z.string().describe("A scenario id from explorer_list_screens"),
        widths: z.array(z.number().int().min(1).max(7680)).min(1),
        createComponents: z.boolean().optional().describe("False returns regular editable layers without components or instances"),
        baseUrl: z.string().optional().describe("Overrides the server's configured --base-url for this one call"),
      },
    },
    async ({ id, widths, createComponents, baseUrl: callBaseUrl }) => {
      const resolvedBaseUrl = callBaseUrl ?? options.baseUrl
      if (!resolvedBaseUrl)
        throw new Error("No base URL configured (pass --base-url when starting the mcp server, or `baseUrl` on this call) - the target app's dev server must be reachable to capture a design.")
      const scenario = (await scenarios()).find((candidate) => candidate.id === id)
      if (!scenario) throw new Error(`Unknown scenario "${id}" - call explorer_list_screens first.`)
      const captures = await captureDesigns({ baseUrl: resolvedBaseUrl, startPath: options.startPath ?? "/", scenario, widths, projectRoot: options.root, storageState: options.storageState, blockWrites: !options.allowWrites })
      return { content: [{ type: "text", text: JSON.stringify({ version: 1, plan: buildPlan(captures, BREAKPOINT_LABELS, { createComponents }) }) }] }
    },
  )

  server.registerTool("explorer_figma_status", {
    description: "Check whether the companion Figma plugin is connected to the local bridge before a batch.", inputSchema: {},
  }, async () => text(await sendToBridge(options.root)))

  server.registerTool("explorer_review_interrupted_commands", {
    description: "Clear the retry block for specific interrupted importer commands only after inspecting their outcomes with native Figma tools. Never use this to blindly retry or clear commands still executing. Read needsReview from explorer_figma_status, inspect the affected destinations, then acknowledge those exact command IDs.",
    inputSchema: { ids: z.array(z.string().min(1)).min(1), reviewedInFigma: z.literal(true) },
  }, async (input) => {
    const connection = readBridgeConnection(options.root)
    const response = await fetch(connection.url + "/commands/reviewed", { method: "POST", headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(5000) })
    const result = await response.json() as { error?: string }
    if (!response.ok) throw new Error(result.error ?? "Interrupted import review failed")
    return text(result)
  })

  server.registerTool("explorer_get_prepared_import", {
    description: "Read the exact prepared selection, widths, layer mode and source folders without importing or requiring the plugin to connect. Use the supplied short code when available; otherwise resolves the import loaded in the plugin or the sole prepared selection. Never ask the person to retype selection details from a code.",
    inputSchema: { code: z.string().optional().describe("The short UIX1 import code; a local credential that must not be repeated in replies or logs") },
  }, async ({ code }) => text(await readPreparedImport(options.root, code)))

  server.registerTool("explorer_discover_figma_desktop", {
    description: "Detect Figma's official desktop MCP endpoint on localhost:3845 and report its tools. Does not control the desktop, launch the importer, or claim a target file. Use native Figma tools to inspect and confirm the intended file; check explorer_figma_status for the importer destination handshake.", inputSchema: {},
  }, async () => text(await discoverFigmaDesktop()))

  server.registerTool("explorer_list_folders", {
    description: "List source-folder prefixes and their exact screen/state counts. Use one returned path as the folder filter for a batch.", inputSchema: {},
  }, async () => {
    return text(sourceFolders(await scenarios()))
  })

  server.registerTool("explorer_export_to_figma", {
    description: "Import registered screens/states by folder, group or exact IDs. Supports named sections and horizontal/grid layout, then verifies exact coverage. Placement is required. Reports protected edits and does not delete orphaned frames.",
    inputSchema: importSchema.shape,
  }, async (input) => {
    if (!(await sendToBridge(options.root)).connected) throw new Error("No Figma plugin connected. Launch it and connect its bridge first.")
    return text(await exportScreens(options, input, command => sendToBridge(options.root, command)))
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
