import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { parse as parseJsonc } from "jsonc-parser"
import { parse as parseToml } from "smol-toml"
import { ensureScreenIdentities, installProjectMcp, projectIdentity, resolveScreenReference, screenReference, startBridge } from "../dist/node/index.js"

const cli = fileURLToPath(new URL("../dist/node/cli.js", import.meta.url))
const repo = path.resolve(path.dirname(cli), "../..")
const write = (root, name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value) }
const screens = [
  { id: "screen:one/é ?#%", title: "Same screen", group: "App", source: "src/App.tsx", actions: [] },
  { id: "screen-two", title: "Same screen", group: "App", source: "src/App.tsx", parent: "screen:one/é ?#%", trigger: "Continue", kind: "overlay",
    actions: [{ kind: "fill", selector: "#secret-selector", value: "private-entered-value" }, { kind: "click", selector: "button", text: "Continue" }] },
  { id: "other", title: "Another", group: "Other", source: "src/Other.tsx", kind: "screen" },
]
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uix-project with spaces-"))
  write(root, "package.json", JSON.stringify({ name: "same-name" }))
  write(root, ".ui-explorer/scenarios.json", JSON.stringify({ version: 1, scenarios: screens }))
  return root
}
async function connect(root, extra = [], roots) {
  const client = new Client({ name: "project-test", version: "1" }, roots ? { capabilities: { roots: { listChanged: true } } } : {})
  if (roots) client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: roots() }))
  await client.connect(new StdioClientTransport({ command: process.execPath, cwd: root, args: [cli, "mcp", "--root", root, ...extra] }))
  return client
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args })
  assert.equal(result.isError, undefined, result.content?.[0]?.text)
  const value = JSON.parse(result.content[0].text)
  if (!Array.isArray(value)) assert.deepEqual(result.structuredContent, value)
  return value
}
async function fails(client, name, args, pattern) {
  const result = await client.callTool({ name, arguments: args })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, pattern)
  return result.content[0].text
}

test("seven MCP tools provide bounded catalog pages and unambiguous private screen inspection", { timeout: 30000 }, async () => {
  const root = fixture(), client = await connect(root)
  try {
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ["explorer_catalog", "explorer_export_to_figma", "explorer_figma_status", "explorer_get_prepared_import", "explorer_get_screen_design", "explorer_inspect_screen", "explorer_review_interrupted_commands"])
    const query = { limit: 1, widths: [1440, 390, 390] }
    const seen = [], expected = []
    let cursor
    do {
      const page = await call(client, "explorer_catalog", { ...query, ...(cursor ? { cursor } : {}) })
      assert.equal(page.project.id, projectIdentity(root)); assert.equal(page.project.root, root)
      assert.equal(page.project.catalog, "saved"); assert.equal(page.total, 3); assert.equal(page.expectedFrames, 6)
      assert.equal(page.items.length, 1); seen.push(page.items[0]); expected.push(...page.expected)
      cursor = page.nextCursor
    } while (cursor)
    assert.equal(new Set(seen.map(s => s.id)).size, 3); assert.equal(expected.length, 6)
    const duplicates = await call(client, "explorer_catalog", { search: "Same screen" })
    assert.equal(duplicates.items.length, 2); assert.notEqual(duplicates.items[0].reference, duplicates.items[1].reference)
    const target = duplicates.items.find(s => s.id === "screen-two")
    const inspected = await call(client, "explorer_inspect_screen", { screenId: target.screenId })
    assert.equal(inspected.screen.id, "screen-two"); assert.equal(inspected.incoming[0].label, "Continue")
    assert.equal(inspected.incoming[0].steps[0].type, "fill"); assert.equal(inspected.incoming[0].steps[1].role, "button")
    assert.doesNotMatch(JSON.stringify([seen, inspected]), /private-entered-value|secret-selector|"selector"|"value"/)
    assert.equal(resolveScreenReference(target.reference, ensureScreenIdentities(root, []).projectId), target.screenId)
    assert.equal((await call(client, "explorer_inspect_screen", { reference: target.reference })).screen.screenId, target.screenId)
    assert.equal((await call(client, "explorer_catalog", { kind: "screen" })).total, 2, "unspecified kind means screen")
    assert.equal((await call(client, "explorer_catalog", { view: "groups" })).items.length, 2)
    const folders = await call(client, "explorer_catalog", { view: "folders" })
    assert.ok(folders.items.some(item => item.folder === "same-name/src/" && item.count === 3))
    assert.equal((await call(client, "explorer_catalog", { folder: "same-name/sr" })).total, 0, "folder boundaries are exact")
    assert.equal((await call(client, "explorer_catalog", { search: "no match" })).total, 0)
    const first = await call(client, "explorer_catalog", { limit: 1 })
    await fails(client, "explorer_catalog", { limit: 1, search: "Another", cursor: first.nextCursor }, /stale catalog cursor/)
    await fails(client, "explorer_inspect_screen", {}, /exactly one/)
    await fails(client, "explorer_inspect_screen", { id: "Same screen" }, /Unknown or stale/)
    await fails(client, "explorer_inspect_screen", { id: "other", reference: seen[0].reference }, /exactly one/)
    await fails(client, "explorer_inspect_screen", { reference: screenReference(ensureScreenIdentities(root, []).projectId, randomUUID()) }, /Unknown or stale/)
    await fails(client, "explorer_inspect_screen", { reference: `uix-screen:v1:${ensureScreenIdentities(root, []).projectId}:%broken` }, /Invalid screen reference/)
    const summary = await call(client, "explorer_catalog", { view: "summary", widths: [390] })
    assert.equal(summary.total, 3); assert.equal(summary.expectedFrames, 3); assert.deepEqual(summary.items, [])
    const status = await call(client, "explorer_figma_status")
    assert.equal(status.connected, false); assert.equal(status.available, false)
    const discovered = await call(client, "explorer_figma_status", { discoverDesktop: true })
    assert.equal(typeof discovered.desktop.available, "boolean")
    assert.equal(discovered.desktop.url, "http://127.0.0.1:3845/mcp")
  } finally { await client.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test("MCP rejects another working directory and changing client workspace roots for every operation", { timeout: 30000 }, async () => {
  const root = fixture(), other = fixture()
  let current = [{ uri: pathToFileURL(root).href }]
  const client = await connect(root, [], () => current)
  try {
    assert.notEqual(projectIdentity(root), projectIdentity(other), "same package name is not project identity")
    const wrong = spawnSync(process.execPath, [cli, "mcp", "--root", root], { cwd: other, encoding: "utf8", timeout: 5000 })
    assert.equal(wrong.status, 1); assert.match(wrong.stderr, /working directory must equal/)
    await call(client, "explorer_catalog")
    const foreignRegistry = ensureScreenIdentities(other, screens.map(s => s.id))
    const foreign = screenReference(foreignRegistry.projectId, foreignRegistry.screens[screens[0].id])
    await fails(client, "explorer_inspect_screen", { reference: foreign }, /another project checkout/)
    await fails(client, "explorer_get_screen_design", { reference: foreign, widths: [390] }, /another project checkout/)
    await fails(client, "explorer_export_to_figma", { references: [foreign], widths: [390], placement: { mode: "current-page" } }, /another project checkout/)
    current = [{ uri: pathToFileURL(other).href }]
    const valid = {
      explorer_catalog: {}, explorer_inspect_screen: { id: "other" }, explorer_get_screen_design: { id: "other", widths: [390] },
      explorer_figma_status: {}, explorer_get_prepared_import: {}, explorer_review_interrupted_commands: { ids: ["x"], reviewedInFigma: true },
      explorer_export_to_figma: { ids: ["other"], widths: [390], placement: { mode: "current-page" } },
    }
    for (const [name, args] of Object.entries(valid)) await fails(client, name, args, /workspace roots/)
    current = []
    await fails(client, "explorer_catalog", {}, /workspace roots/)
    current = [{ uri: pathToFileURL(root).href }]
    assert.equal((await call(client, "explorer_catalog")).total, 3)
  } finally { await client.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }) }
})

test("live discovery and URL overrides fail closed for foreign or older Explorer servers, before capture/export", { timeout: 30000 }, async () => {
  const root = fixture(), other = fixture()
  let identity = projectIdentity(other), requests = []
  const server = http.createServer((req, res) => { requests.push(req.url); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ projectId: identity, scenarios: screens })) })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const client = await connect(root, ["--base-url", url])
  const offline = await connect(root)
  try {
    await fails(client, "explorer_catalog", {}, /another project checkout/)
    await fails(client, "explorer_get_screen_design", { id: "other", widths: [390] }, /another project checkout/)
    await fails(offline, "explorer_get_screen_design", { id: "other", widths: [390], baseUrl: url }, /another project checkout/)
    await fails(client, "explorer_export_to_figma", { ids: ["other"], widths: [390], placement: { mode: "current-page" } }, /another project checkout/)
    identity = undefined
    await fails(client, "explorer_catalog", {}, /no project identity/)
    assert.ok(requests.every(route => route === "/__explorer/api/state"), "no browser or import side effects before identity verification")
    identity = projectIdentity(root)
    assert.equal((await call(client, "explorer_catalog")).project.catalog, "live")
  } finally { await client.close(); await offline.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }) }
})

test("prepared import codes cannot change the MCP session's project; stale/foreign bridge metadata is rejected", { timeout: 30000 }, async () => {
  const root = fixture(), other = fixture(), a = await startBridge({ root, port: 0, baseUrl: "http://example.test" }), b = await startBridge({ root: other, port: 0, baseUrl: "http://example.test" })
  const client = await connect(root)
  try {
    const foreign = b.prepareImport({ ids: ["other"], widths: [390] }, screens)
    const error = await fails(client, "explorer_get_prepared_import", { code: foreign.code }, /another project or Explorer session/)
    assert.ok(!error.includes(foreign.code)); assert.ok(!error.includes(b.token))
    const local = a.prepareImport({ ids: ["other"], widths: [390] }, screens)
    assert.equal((await call(client, "explorer_get_prepared_import", { code: local.code })).screenCount, 1)
    const file = path.join(root, ".ui-explorer/bridge.json"), original = fs.readFileSync(file, "utf8")
    fs.writeFileSync(file, JSON.stringify({ url: b.url, token: b.token, projectId: projectIdentity(other) }))
    await fails(client, "explorer_figma_status", {}, /different project identity/)
    await fails(client, "explorer_review_interrupted_commands", { ids: ["x"], reviewedInFigma: true }, /different project identity/)
    fs.writeFileSync(file, original)
  } finally { await client.close(); await a.close(); await b.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }) }
})

test("project installer preserves JSONC/TOML, is idempotent, rejects conflicts and launches the installed local package", { timeout: 30000 }, async () => {
  const root = fixture()
  const link = path.join(root, "node_modules/@danielfransix/web-app-ui-explorer")
  fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(repo, link, process.platform === "win32" ? "junction" : "dir")
  try {
    write(root, ".vscode/mcp.json", '{\n // Keep this comment\n "servers": {"other": {"command":"other"}},\n}\n')
    write(root, ".codex/config.toml", '# Keep this comment\nmodel = "example"\n[mcp_servers.other]\ncommand = "other"\n')
    for (const client of ["vscode", "codex"]) {
      const options = { root, client, baseUrl: "http://127.0.0.1:8443", route: "/custom/explorer" }
      const installed = installProjectMcp(options)
      assert.equal(installed.changed, true); assert.equal(installProjectMcp(options).changed, false)
      const content = fs.readFileSync(installed.file, "utf8")
      assert.match(content, /Keep this comment/)
      const config = client === "vscode" ? parseJsonc(content).servers : parseToml(content).mcp_servers
      assert.equal(config.other.command, "other"); assert.equal(config["ui-explorer"].cwd, client === "vscode" ? "${workspaceFolder}" : root)
      assert.equal(config["ui-explorer"].args[0], client === "vscode" ? "${workspaceFolder}/node_modules/@danielfransix/web-app-ui-explorer/dist/node/cli.js" : path.join(link, "dist/node/cli.js"))
      if (client === "vscode") {
        config["ui-explorer"] = Object.fromEntries(Object.entries(config["ui-explorer"]).toReversed())
        fs.writeFileSync(installed.file, JSON.stringify({ servers: config }, null, 2))
        assert.equal(installProjectMcp(options).changed, false, "property order does not change the settings")
      }
    }
    const config = parseToml(fs.readFileSync(path.join(root, ".codex/config.toml"), "utf8")).mcp_servers["ui-explorer"]
    const mcp = new Client({ name: "installed-config", version: "1" })
    try {
      const args = config.args.slice(0, 4) // Launch saved-catalog mode, independent of a dev server.
      await mcp.connect(new StdioClientTransport({ command: config.command, cwd: config.cwd, args }))
      assert.equal((await call(mcp, "explorer_catalog")).total, 3)
    } finally { await mcp.close() }
    write(root, "AGENTS.md", "# Project rules\nPreserve this instruction.\n")
    const setupArgs = [cli, "mcp", "install", "--client", "codex", "--root", root, "--base-url", "http://127.0.0.1:8443", "--route", "/custom/explorer"]
    for (let index = 0; index < 2; index++) {
      const setup = spawnSync(process.execPath, setupArgs, { encoding: "utf8", timeout: 10000 })
      assert.equal(setup.status, 0, setup.stderr)
      assert.match(setup.stdout, /Restart your MCP client in this project/)
      const guidance = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")
      assert.match(guidance, /Preserve this instruction/)
      assert.match(guidance, /explorer_inspect_screen/)
      assert.match(guidance, /ui-explorer.ids.json/)
    }
    const jsonFile = path.join(root, ".vscode/mcp.json"), before = fs.readFileSync(jsonFile, "utf8")
    assert.throws(() => installProjectMcp({ root, client: "vscode", baseUrl: "http://localhost:9000" }), /different settings/)
    assert.equal(fs.readFileSync(jsonFile, "utf8"), before)
    write(root, ".codex/config.toml", '[mcp_servers."ui-explorer"]\ncommand="manual"\n')
    assert.throws(() => installProjectMcp({ root, client: "codex" }), /unmarked/)
    write(root, ".vscode/mcp.json", '{broken')
    assert.throws(() => installProjectMcp({ root, client: "vscode" }), /Invalid/)
    assert.equal(fs.readFileSync(jsonFile, "utf8"), '{broken')
    write(root, ".vscode/mcp.json", '{"servers":null}')
    assert.throws(() => installProjectMcp({ root, client: "vscode" }), /Invalid/)
    write(root, ".vscode/mcp.json", '{"servers":{"ui-explorer":null}}')
    assert.throws(() => installProjectMcp({ root, client: "vscode" }), /different settings/)
    assert.throws(() => installProjectMcp({ root, client: "invalid" }), /Choose client/)
    assert.throws(() => installProjectMcp({ root, client: "codex", baseUrl: "http://user:secret@localhost" }), /without credentials/)
    const global = spawnSync(process.execPath, [cli, "mcp", "install", "--root", root, "--client", "vscode", "--global"], { encoding: "utf8" })
    assert.equal(global.status, 1); assert.match(global.stderr, /Global MCP installation is not supported/)
    for (const args of [["mcp", "--root", root, "--legacy-tools"], ["mcp", "install", "--root", root, "--client", "codex", "--legacy-tools"]]) {
      const removed = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", timeout: 5000 })
      assert.equal(removed.status, 1); assert.match(removed.stderr, /Unknown MCP option/)
    }
  } finally {
    // Remove the link itself before recursively cleaning the owned fixture.
    fs.unlinkSync(link); fs.rmSync(root, { recursive: true, force: true })
  }
})

test("project installer refuses redirected configuration directories", () => {
  const root = fixture(), other = fixture()
  const link = path.join(root, "node_modules/@danielfransix/web-app-ui-explorer"), redirected = path.join(root, ".vscode")
  fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(repo, link, process.platform === "win32" ? "junction" : "dir")
  fs.symlinkSync(other, redirected, process.platform === "win32" ? "junction" : "dir")
  try { assert.throws(() => installProjectMcp({ root, client: "vscode" }), /symlink/); assert.equal(fs.existsSync(path.join(other, "mcp.json")), false) }
  finally { fs.unlinkSync(redirected); fs.unlinkSync(link); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }) }
})
