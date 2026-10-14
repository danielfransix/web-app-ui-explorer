import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { chromium } from "playwright"
import { createServer } from "vite"
import uiExplorer from "../dist/node/vite.js"

const wait = async (check, message, timeout = 20_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(message)
}

test("previews are interactive and preserve the modal, workbench and history across live view", { timeout: 120_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uix-preview-"))
  fs.writeFileSync(path.join(root, "index.html"), `<!doctype html><html><body>
    <h1>Interactive app</h1>
    <label>Name <input id="name"></label>
    <button id="increment" onclick="document.querySelector('#count').textContent = ++window.count">Increment</button>
    <output id="count">0</output>
    <label>Choice <select id="choice"><option>First</option><option>Second</option></select></label>
    <button id="menu" onclick="document.querySelector('#details').hidden = false">Open menu</button>
    <p id="details" hidden>Menu opened</p>
    <div style="height:1500px">Scrollable content</div>
    <script>window.count = 0</script>
  </body></html>`)
  const scenarios = Array.from({ length: 9 }, (_, i) => ({
    id: `screen-${i}`, title: `Screen ${i}`, group: "Screens", source: "src/Home.tsx", actions: [],
  }))
  const server = await createServer({
    root, configFile: false, logLevel: "error", server: { host: "127.0.0.1", port: 0 },
    plugins: [uiExplorer({ mode: "manual", scenarios })],
  })
  let browser
  try {
    await server.listen()
    const base = `http://127.0.0.1:${server.httpServer.address().port}`
    browser = await chromium.launch({ args: ["--no-sandbox"] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(`${base}/__explorer/?view=gallery`)
    await page.getByRole("checkbox").first().click()
    await page.getByRole("textbox", { name: "Search screen states" }).fill("Screen")
    const card = page.getByRole("button", { name: "Expand Screen 4", exact: true })
    await card.scrollIntoViewIfNeeded()
    const scroll = await page.evaluate(() => window.scrollY)
    await page.evaluate(() => { window.workbenchMarker = "same document"; document.querySelector(".design-screen-grid").dataset.marker = "same gallery" })
    await card.click()
    const dialog = page.getByRole("dialog")
    await dialog.waitFor()
    const frame = dialog.frameLocator("iframe")
    await frame.locator('html[data-uix-status="ready"]').waitFor()
    assert.equal(await dialog.locator("iframe").getAttribute("tabindex"), "0")
    await frame.getByRole("textbox", { name: "Name" }).fill("Kept across sizes")
    await frame.locator("#name").press("Tab")
    assert.equal(await frame.locator("body").evaluate(() => document.activeElement.id), "increment", "keyboard focus enters the preview UI")
    await frame.getByRole("button", { name: "Increment", exact: true }).click()
    await frame.getByRole("combobox", { name: "Choice" }).selectOption("Second")
    await frame.getByRole("button", { name: "Open menu" }).click()
    assert.equal(await frame.locator("#count").innerText(), "1")
    assert.equal(await frame.locator("#details").isVisible(), true)
    await frame.locator("#name").press("ArrowLeft")
    assert.equal(await dialog.locator("iframe").getAttribute("title"), "Screen 4 preview", "typing arrows do not change the selected screen")
    if (process.env.UIX_SCREENSHOT_DIR)
      await page.screenshot({ path: path.join(process.env.UIX_SCREENSHOT_DIR, "modal.png") })
    const frameIdentity = await frame.locator("body").evaluate(() => performance.timeOrigin)
    await page.getByRole("button", { name: "Open live UI", exact: true }).click()
    await page.getByRole("button", { name: "Back to preview", exact: true }).waitFor()
    await wait(async () => (await dialog.boundingBox()).width === 1440, "live view fills the viewport")
    if (process.env.UIX_SCREENSHOT_DIR)
      await page.screenshot({ path: path.join(process.env.UIX_SCREENSHOT_DIR, "fullscreen.png") })
    assert.equal(await frame.locator("#name").inputValue(), "Kept across sizes")
    assert.equal(await frame.locator("body").evaluate(() => performance.timeOrigin), frameIdentity, "expanding does not reload the iframe")
    await frame.getByRole("button", { name: "Increment", exact: true }).click()
    await frame.locator("body").evaluate(() => history.pushState({}, "", `${location.href}&route=details`))
    await page.getByRole("button", { name: "Back to preview", exact: true }).click()
    await page.getByRole("button", { name: "Open live UI", exact: true }).waitFor()
    assert.equal(await frame.locator("#count").innerText(), "2", "returning preserves interactions")
    assert.equal(await frame.locator("body").evaluate(() => performance.timeOrigin), frameIdentity)
    await page.getByRole("button", { name: "Close", exact: true }).click()
    await wait(() => dialog.count().then((n) => n === 0), "closing the modal returns to the gallery")
    assert.equal(await page.evaluate(() => window.workbenchMarker), "same document")
    assert.equal(await page.getByRole("textbox", { name: "Search screen states" }).inputValue(), "Screen")
    assert.equal(await page.locator(".design-screen-grid").getAttribute("data-marker"), "same gallery")
    await wait(async () => Math.abs(await page.evaluate(() => window.scrollY) - scroll) < 2, "gallery scroll is preserved")

    // Browser Back/Forward traverses the two layers, not a freshly mounted page.
    await card.click()
    await page.getByRole("button", { name: "Open live UI", exact: true }).click()
    await page.goBack()
    await page.getByRole("button", { name: "Open live UI", exact: true }).waitFor()
    await page.goBack()
    await wait(() => dialog.count().then((n) => n === 0), "browser Back closes the modal")
    await page.goForward()
    await page.getByRole("button", { name: "Open live UI", exact: true }).waitFor()
    await page.goForward()
    await page.getByRole("button", { name: "Back to preview", exact: true }).waitFor()
    await page.getByRole("button", { name: "Next screen state", exact: true }).click()
    assert.equal(await dialog.locator("iframe").getAttribute("title"), "Screen 5 preview")
    await page.getByRole("button", { name: "Back to preview", exact: true }).click()
    await page.getByRole("button", { name: "Open live UI", exact: true }).waitFor()
    assert.equal(await dialog.locator("iframe").getAttribute("title"), "Screen 4 preview", "screen stepping preserves the original modal destination")
    await page.getByRole("button", { name: "Close", exact: true }).click()
    await wait(() => dialog.count().then((n) => n === 0), "modal closes")

    // Canvas zoom and viewport are retained because the canvas is never unmounted.
    await page.goto(`${base}/__explorer/?view=canvas`)
    await page.locator('.design-flow-canvas[data-layout-ready="true"]').waitFor()
    await page.waitForTimeout(500)
    await page.getByRole("button", { name: "Zoom in", exact: true }).click()
    await page.waitForTimeout(400)
    const viewport = await page.locator(".react-flow__viewport").getAttribute("style")
    await page.evaluate(() => document.querySelector(".react-flow").dataset.marker = "same canvas")
    await page.getByRole("button", { name: "Expand Screen 0", exact: true }).click({ force: true })
    await page.getByRole("button", { name: "Open live UI", exact: true }).click()
    await page.getByRole("button", { name: "Back to preview", exact: true }).click()
    await page.getByRole("button", { name: "Open live UI", exact: true }).waitFor()
    await page.getByRole("button", { name: "Close", exact: true }).click()
    await wait(() => dialog.count().then((n) => n === 0), "modal closes back to canvas")
    assert.equal(await page.locator(".react-flow").getAttribute("data-marker"), "same canvas")
    assert.equal(await page.locator(".react-flow__viewport").getAttribute("style"), viewport)

    // A direct live link has a local return even without an explorer-owned history entry.
    await page.goto(`${base}/__explorer/?view=screen&scenario=screen-0`)
    await page.getByRole("button", { name: "All screens", exact: true }).click()
    await page.getByRole("button", { name: "Expand Screen 0", exact: true }).waitFor()
    assert.equal(new URL(page.url()).searchParams.get("view"), "gallery")
    await page.goto(`${base}/__explorer/?view=canvas&preview=screen-0`)
    await page.getByRole("button", { name: "Open live UI", exact: true }).waitFor()
    await page.evaluate(() => Object.defineProperty(window, "navigation", { value: undefined, configurable: true }))
    await page.getByRole("button", { name: "Next preview", exact: true }).click()
    await page.getByRole("button", { name: "Open live UI", exact: true }).click()
    await page.getByRole("button", { name: "Back to preview", exact: true }).click()
    await page.getByRole("button", { name: "Open live UI", exact: true }).waitFor()
    await page.getByRole("button", { name: "Close", exact: true }).click()
    await wait(() => dialog.count().then((n) => n === 0), "a direct modal link closes locally")
    assert.equal(new URL(page.url()).searchParams.get("view"), "canvas")
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
