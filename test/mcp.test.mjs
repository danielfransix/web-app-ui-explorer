import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { createServer } from "vite"
import { chromium } from "playwright"
import uiExplorer from "../dist/node/vite.js"
import { startBridge } from "../dist/node/index.js"

// A real protocol-level test: spawns the actual CLI binary over stdio, the same way any MCP client
// would, rather than calling the server's internals directly in-process.

const cliPath = fileURLToPath(new URL("../dist/node/cli.js", import.meta.url))

function textOf(result) {
  return JSON.parse(result.content[0].text)
}

test('agents read prepared scope without connecting the plugin, disambiguate selections and receive destination context', {timeout:30000}, async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uix-prepared-mcp-'))
 const bridge=await startBridge({root,port:0,baseUrl:'http://example.test'})
 const scenarios=[{id:'a',title:'Role settings',group:'Settings',source:'web-app/src/settings/App.tsx'},{id:'b',title:'Hiring home',group:'Hiring',source:'web-app/src/hiring/App.tsx'}]
 const first=bridge.prepareImport({ids:['a','b'],widths:[1440,390],createComponents:false},scenarios)
 const client=new Client({name:'prepared-test',version:'1'})
 const pluginHeaders={Authorization:'Bearer '+bridge.token,'Content-Type':'application/json','X-UIX-Client':'test-plugin'}
 const post=(route,body)=>fetch(bridge.url+route,{method:'POST',headers:pluginHeaders,body:JSON.stringify(body)})
 try{
  await client.connect(new StdioClientTransport({command:process.execPath,cwd:root,args:[cliPath,'mcp','--root',root]}))
  const read=async(args={})=>textOf(await client.callTool({name:'explorer_get_prepared_import',arguments:args}))
  const prepared=await read({code:first.code})
  assert.equal(prepared.screenCount,2);assert.equal(prepared.frameCount,4)
  assert.deepEqual(prepared.widths,[1440,390]);assert.equal(prepared.createComponents,false)
  assert.deepEqual(prepared.screens.map(s=>s.folder),['web-app/src/hiring','web-app/src/settings'])
  assert.equal((await read()).id,first.summary.id)
  assert.equal(textOf(await client.callTool({name:'explorer_figma_status',arguments:{}})).connected,false,'read-only inspection does not claim the plugin connection')
  assert.equal((await fetch(bridge.url+'/handoffs/'+first.summary.id)).status,401)
  const second=bridge.prepareImport({ids:['a'],widths:[768]},scenarios)
  const ambiguous=await client.callTool({name:'explorer_get_prepared_import',arguments:{}})
  assert.equal(ambiguous.isError,true);assert.match(ambiguous.content[0].text,/Several imports/)
  assert.equal((await read({code:second.code})).screenCount,1)
  await post('/connect',{})
  await post('/handoff/loaded',{id:first.summary.id})
  assert.equal((await read()).id,first.summary.id)
  const context={documentName:'Utilities',pageId:'12:34',pageName:'Hiring'}
  assert.equal((await post('/connection/context',{context})).status,200)
  assert.deepEqual(textOf(await client.callTool({name:'explorer_figma_status',arguments:{}})).destination,context)
  const outsider={...pluginHeaders,'X-UIX-Client':'other'}
  assert.equal((await fetch(bridge.url+'/connection/context',{method:'POST',headers:outsider,body:JSON.stringify({context:{...context,documentName:'Other'}})})).status,409)
  await post('/disconnect',{})
  assert.equal(textOf(await client.callTool({name:'explorer_figma_status',arguments:{}})).destination,null)
  const invalid=await client.callTool({name:'explorer_get_prepared_import',arguments:{code:'https://example.com'}})
  assert.equal(invalid.isError,true)
 }finally{await client.close();await bridge.close();fs.rmSync(root,{recursive:true,force:true})}
})

test('a real MCP session appears in the plugin before any export and disappears on disconnect, even when the bridge starts later', {timeout:30000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uix-mcp-presence-'))
 fs.mkdirSync(path.join(root,'.ui-explorer'))
 fs.writeFileSync(path.join(root,'.ui-explorer','scenarios.json'),JSON.stringify({version:1,scenarios:[]}))
 const client=new Client({name:'integration-editor',title:'Integration editor',version:'1'})
 let bridge,browser
 try{
  await client.connect(new StdioClientTransport({command:process.execPath,cwd:root,args:[cliPath,'mcp','--root',root]}))
  assert.ok((await client.listTools()).tools.length>0,'discovery works without a bridge')
  bridge=await startBridge({root,port:0})
  browser=await chromium.launch()
  const page=await browser.newPage({viewport:{width:540,height:820}})
  await page.setContent(fs.readFileSync('figma-plugin/ui.html','utf8'))
  await page.locator('#bridge-controls > summary').click()
  await page.locator('#bridge-url').fill(bridge.url+'/#'+bridge.token)
  await page.getByRole('button',{name:'Connect bridge',exact:true}).click()
  await page.locator('#mcp-status').filter({hasText:'MCP connected: Integration editor'}).waitFor({timeout:12000})
  const status=textOf(await client.callTool({name:'explorer_figma_status',arguments:{}}))
  assert.equal(status.connected,true)
  assert.equal(status.transport,'websocket')
  assert.equal(status.mcpClients[0].name,'Integration editor')
  assert.equal(await page.locator('#import-progress').isVisible(),false,'connected does not imply importing')
  await page.screenshot({path:'.ui-explorer/plugin-mcp-connected.png'})
  await client.close()
  await page.locator('#mcp-status').filter({hasText:'MCP: No client connected'}).waitFor({timeout:7000})
  let legacyReads=0
  await page.route(bridge.url+'/agents',route=>{legacyReads++;return route.fulfill({status:404,contentType:'application/json',body:'{"error":"Not found"}'})})
  await page.waitForTimeout(1100)
  assert.equal(legacyReads,0,'WebSocket presence does not depend on HTTP polling')
  assert.equal(await page.getByRole('button',{name:'Disconnect bridge',exact:true}).isEnabled(),true)
  await page.unroute(bridge.url+'/agents')
  await page.locator('#mcp-status').filter({hasText:'MCP: No client connected'}).waitFor()
  await page.getByRole('button',{name:'Disconnect bridge',exact:true}).click()
  await page.locator('#mcp-status').waitFor({state:'hidden'})
 }finally{await client.close();await browser?.close();await bridge?.close();fs.rmSync(root,{recursive:true,force:true})}
})

test("the mcp subcommand exposes scanned screens over the real MCP protocol, with no kind filtering by default", { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uix-mcp-"))
  fs.mkdirSync(path.join(root, ".ui-explorer"), { recursive: true })
  fs.writeFileSync(
    path.join(root, ".ui-explorer", "scenarios.json"),
    JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      baseUrl: "http://example.test",
      startPath: "/",
      scenarios: [
        { id: "a", title: "Role Details", group: "Role details", source: "src/screens/RoleDetails.tsx", kind: "screen" },
        { id: "b", title: "Role Details (menu open)", group: "Role details", source: "src/screens/RoleDetails.tsx", kind: "overlay" },
        { id: "c", title: "Candidate Directory", group: "Candidate Directory", source: "src/screens/CandidateDirectory.tsx", kind: "screen" },
      ],
    }),
  )
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "test-app" }))

  const client = new Client({ name: "test-client", version: "1.0.0" })
  const transport = new StdioClientTransport({ command: process.execPath, cwd: root, args: [cliPath, "mcp", "--root", root] })
  try {
    await client.connect(transport)

    const instructions = client.getInstructions()
    assert.match(instructions, /companion importer plugin/)
    assert.match(instructions, /Figma's native MCP tools or existing Plugin API connection/)
    assert.match(instructions, /Do not expand it/)

    const tools = await client.listTools()
    const names = tools.tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, ["explorer_catalog", "explorer_export_to_figma", "explorer_figma_status", "explorer_get_prepared_import", "explorer_get_screen_design", "explorer_inspect_screen", "explorer_review_interrupted_commands"])

    const groups = textOf(await client.callTool({ name: "explorer_catalog", arguments: { view: "groups" } }))
    assert.deepEqual(groups.items, [{ group: "Candidate Directory", count: 1 }, { group: "Role details", count: 2 }])

    const everything = textOf(await client.callTool({ name: "explorer_catalog", arguments: {} }))
    assert.equal(everything.items.length, 3, "no kind filter is applied by default - every scenario is returned")

    const scoped = textOf(await client.callTool({ name: "explorer_catalog", arguments: { group: "Role details" } }))
    assert.deepEqual(scoped.items.map((s) => s.id).sort(), ["a", "b"])

    const counts = textOf(await client.callTool({ name: "explorer_catalog", arguments: { view: "summary", group: "Role details" } }))
    assert.equal(counts.total, 2); assert.deepEqual(counts.byKind, { screen: 1, overlay: 1 })
    const sized = textOf(await client.callTool({ name: "explorer_catalog", arguments: { group: "Role details", widths: [1440, 390, 390] } }))
    assert.equal(sized.expectedFrames, 4)
    const folders = textOf(await client.callTool({ name: "explorer_catalog", arguments: { view: "folders" } }))
    assert.ok(folders.items.some((folder) => folder.folder === "test-app/src/screens/" && folder.count === 3))

    const missingBaseUrl = await client.callTool({ name: "explorer_get_screen_design", arguments: { id: "a", widths: [1440] } })
    assert.equal(missingBaseUrl.isError, true)
    assert.match(missingBaseUrl.content[0].text, /base URL/i)
  } finally {
    await client.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("MCP bulk export discovers live-only curated states, sends every requested pair, and verifies plugin coverage", { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uix-bulk-"))
  fs.writeFileSync(path.join(root, "index.html"), "<h1>Bulk export</h1>")
  const scenarios = [
    { id: "base", title: "Base", kind: "screen", group: "Group", source: "src/Home.tsx", actions: [] },
    { id: "overlay", title: "Overlay", kind: "overlay", group: "Group", source: "src/Home.tsx", actions: [] },
  ]
  const server = await createServer({ root, configFile: false, logLevel: "error", server: { port: 0 }, plugins: [uiExplorer({ mode: "manual", autoCapture: false, scenarios })] })
  const bridge = await startBridge({ root, port: 0 })
  const headers = { Authorization: `Bearer ${bridge.token}`, "X-UIX-Client": "fixture", "Content-Type": "application/json" }
  const client = new Client({ name: "bulk-test", version: "1" })
  let stopped = false
  const actual = [], commands = []
  await fetch(`${bridge.url}/connect`, { method: "POST", headers, body: "{}" })
  const plugin = (async () => {
    while (!stopped) {
      const batch = await (await fetch(`${bridge.url}/poll`, { headers })).json()
      for (const item of batch) {
        commands.push(item.command)
        let result
        if (item.command.type === "build") {
          actual.push(...item.command.plan.frames.map(({ scenarioId, width }) => ({ scenarioId, width })))
          result = { report: ["created"], conflicts: [], warnings: [] }
        } else if (item.command.type === "verify") result = { coverage: { missing: item.command.expected.filter((pair) => !actual.some((other) => JSON.stringify(pair) === JSON.stringify(other))), unexpected: [] } }
        else result = { report: [], conflicts: [], warnings: [] }
        await fetch(`${bridge.url}/result`, { method: "POST", headers, body: JSON.stringify({ id: item.id, result }) })
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  })()
  try {
    await server.listen()
    await client.connect(new StdioClientTransport({ command: process.execPath, cwd: root, args: [cliPath, "mcp", "--root", root, "--base-url", `http://localhost:${server.httpServer.address().port}`] }))
    const catalog = textOf(await client.callTool({ name: "explorer_catalog", arguments: {} }))
    const response = await client.callTool({ name: "explorer_export_to_figma", arguments: { references: catalog.items.map(s => s.reference), group: "Group", widths: [1440, 390], placement: { mode: "current-page" } } })
    assert.equal(response.isError, undefined, JSON.stringify(response))
    const result = textOf(response)
    assert.equal(result.scenarios, 2); assert.equal(result.expectedFrames, 4)
    assert.equal(actual.length, 4); assert.ok(commands.some((command) => command.type === "verify"))
    assert.equal(commands[0].type, "begin-export"); assert.equal(commands.at(-1).type, "end-export")
    assert.deepEqual(result.coverage, { missing: [], unexpected: [] })
  } finally { stopped = true; await plugin; await client.close(); await bridge.close(); await server.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test("explorer_get_screen_design captures a real screen when a base URL is reachable", { timeout: 60_000 }, async () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uix-mcp-app-"))
  fs.writeFileSync(path.join(appRoot, "index.html"), `<!doctype html><html><body><h1>Hello MCP</h1></body></html>`)
  const scenario = { id: "screen-0", title: "Screen 0", group: "Screens", source: "src/Home.tsx", actions: [] }
  fs.mkdirSync(path.join(appRoot, ".ui-explorer"), { recursive: true })
  fs.writeFileSync(
    path.join(appRoot, ".ui-explorer", "scenarios.json"),
    JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), baseUrl: "http://x", startPath: "/", scenarios: [scenario] }),
  )

  const server = await createServer({
    root: appRoot, configFile: false, logLevel: "error", server: { host: "127.0.0.1", port: 0 },
    plugins: [uiExplorer({ mode: "manual", autoCapture: false, scenarios: [scenario] })],
  })
  const client = new Client({ name: "test-client", version: "1.0.0" })
  try {
    await server.listen()
    const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`
    const transport = new StdioClientTransport({
      command: process.execPath,
      cwd: appRoot,
      args: [cliPath, "mcp", "--root", appRoot, "--base-url", baseUrl],
    })
    await client.connect(transport)
    const catalog = textOf(await client.callTool({ name: "explorer_catalog", arguments: {} }))
    const result = textOf(await client.callTool({ name: "explorer_get_screen_design", arguments: { screenId: catalog.items[0].screenId, widths: [1440] } }))
    assert.equal(result.version, 1)
    assert.equal(result.plan.frames.length, 1)
    assert.match(JSON.stringify(result.plan), /Hello MCP/)
    const referenced = textOf(await client.callTool({ name: "explorer_get_screen_design", arguments: { reference: catalog.items[0].reference, widths: [390] } }))
    assert.equal(referenced.plan.frames[0].scenarioId, "screen-0")
  } finally {
    await client.close()
    await server.close()
    fs.rmSync(appRoot, { recursive: true, force: true })
  }
})
