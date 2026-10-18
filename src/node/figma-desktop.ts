import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

/** Probe Figma's documented local MCP endpoint; never control or launch the desktop UI. */
export async function discoverFigmaDesktop(port = 3845) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid desktop MCP port")
  const url = `http://127.0.0.1:${port}/mcp`
  const client = new Client({ name: "ui-explorer-discovery", version: "1" })
  const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(1500), redirect: "error" }) })
  try {
    await client.connect(transport, { timeout: 2000 })
    const response = await client.listTools({}, { timeout: 2000 })
    return { available: true, url, tools: response.tools.map(tool => tool.name), note: "Use Figma's native MCP client for these operations. The companion importer must be open to write captured designs." }
  } catch {
    return { available: false, url, note: "Figma's desktop MCP is not reachable. Enable it in Figma Dev Mode to use native desktop tools. The companion importer connects separately." }
  } finally { await client.close().catch(() => {}) }
}
