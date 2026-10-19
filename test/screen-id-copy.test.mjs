import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { createServer } from "vite"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import uiExplorer from "../dist/node/vite.js"

test("copy a generated screen ID from modal/full-screen; MCP resolves the exact duplicate; clipboard denial has an accessible fallback", { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uix-copy-id-"))
  fs.writeFileSync(path.join(root, "index.html"), '<h1>Screen ID fixture</h1>')
  const scenarios = ["one", "two"].map(id => ({ id, title: "Same title", group: "App", source: "src/App.tsx", startPath: `/?screen=${id}`, actions: [] }))
  const route = "/review/explorer"
  const server = await createServer({ root, configFile: false, logLevel: "error", server: { host: "127.0.0.1", port: 0 }, plugins: [uiExplorer({ route, mode: "manual", autoCapture: false, scenarios })] })
  const client = new Client({ name: "screen-id-ui-test", version: "1" })
  let browser
  try {
    await server.listen()
    const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`
    const state = await (await fetch(baseUrl + route + "/api/state")).json()
    browser = await chromium.launch()
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    await context.addInitScript(() => {
      window.copyResults = []; window.denyCopy = false
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async value => { if (window.denyCopy) throw new Error("denied"); window.copyResults.push(value) } } })
    })
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    await page.goto(baseUrl + route + "/?view=gallery")
    await page.getByRole("checkbox").first().click()
    await page.getByRole("button", { name: "Expand Same title", exact: true }).nth(1).click()
    await page.frameLocator(".screen-preview-entry:not([hidden]) iframe").getByRole("heading", { name: "Screen ID fixture", exact: true }).waitFor()
    await page.locator(".screen-preview-entry:not([hidden]) .screen-thumbnail__loading").waitFor({ state: "hidden" })
    const copy = page.getByRole("button", { name: "Copy screen ID", exact: true })
    await copy.focus(); await page.keyboard.press("Enter")
    await page.getByRole("status").filter({ hasText: "Screen ID copied" }).waitFor()
    const copied = (await page.evaluate(() => window.copyResults)).at(-1)
    assert.equal(copied, state.identities.screens.two)
    assert.notEqual(copied, state.identities.screens.one)
    const cli = fileURLToPath(new URL("../dist/node/cli.js", import.meta.url))
    await client.connect(new StdioClientTransport({ command: process.execPath, cwd: root, args: [cli, "mcp", "--root", root, "--base-url", baseUrl, "--route", route] }))
    const inspected = await client.callTool({ name: "explorer_inspect_screen", arguments: { screenId: copied } })
    assert.equal(inspected.isError, undefined, inspected.content[0].text)
    assert.equal(inspected.structuredContent.screen.id, "two")
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      await copy.scrollIntoViewIfNeeded()
      assert.equal(await copy.isVisible(), true)
      assert.ok(await page.getByRole("dialog").evaluate(node => node.scrollWidth <= node.clientWidth + 1), `no dialog overflow at ${width}`)
      await page.screenshot({ path: `.ui-explorer/screen-id-${width}.png` })
    }
    await page.evaluate(() => { window.denyCopy = true })
    await copy.click()
    const manual = page.getByRole("textbox", { name: "Screen ID", exact: true })
    await manual.waitFor()
    assert.equal(await manual.inputValue(), copied)
    assert.equal(await manual.evaluate(input => input.selectionEnd - input.selectionStart), copied.length)
    await page.getByRole("alert").filter({ hasText: "Clipboard access is unavailable" }).waitFor()
    await page.screenshot({ path: ".ui-explorer/screen-id-fallback-320.png" })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole("button", { name: "Previous preview", exact: true }).click()
    assert.equal(await manual.count(), 0, "fallback resets when the active screen changes")
    await page.evaluate(() => { window.denyCopy = false })
    await copy.click()
    assert.equal((await page.evaluate(() => window.copyResults)).at(-1), state.identities.screens.one)
    await page.getByRole("button", { name: "Open live UI", exact: true }).click()
    await page.getByRole("button", { name: "Copy screen ID", exact: true }).click()
    assert.equal((await page.evaluate(() => window.copyResults)).at(-1), state.identities.screens.one)
    await page.getByRole("button", { name: "Back to preview", exact: true }).click()
    await page.getByRole("button", { name: "Close", exact: true }).click()
    await page.getByRole("button", { name: "Canvas", exact: true }).click()
    await page.locator('[data-layout-ready="true"]').waitFor()
    await page.getByRole("button", { name: "Expand Same title", exact: true }).nth(1).click()
    await page.getByRole("button", { name: "Copy screen ID", exact: true }).click()
    assert.equal((await page.evaluate(() => window.copyResults)).at(-1), state.identities.screens.two)
    assert.deepEqual(errors, [])
  } finally { await client.close(); await browser?.close(); await server.close(); fs.rmSync(root, { recursive: true, force: true }) }
})
