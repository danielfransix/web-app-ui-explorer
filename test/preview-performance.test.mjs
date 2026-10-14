import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { chromium } from "playwright"
import { createServer } from "vite"
import uiExplorer from "../dist/node/vite.js"

const active = ".screen-preview-entry:not([hidden]) iframe"

// A custom host deliberately uses the status attribute only: no uix:ready message. This used to leave
// an otherwise-ready preview covered by its spinner until the 20-second watchdog fired.
test("attribute-only hosts become interactive promptly; visited previews are reused, bounded and resettable", { timeout: 90_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uix-preview-speed-"))
  fs.writeFileSync(path.join(root, "index.html"), `<!doctype html><html><head>
    <script>
      const params = new URLSearchParams(location.search)
      const ready = () => document.documentElement.setAttribute('data-uix-status', params.has('fail') ? 'error: Fixture failed' : 'ready')
      if (params.has('delay')) {
        document.documentElement.setAttribute('data-uix-status', 'loading')
        setTimeout(ready, 150)
      }
      else ready()
    </script>
    </head><body><h1>Attribute-only host</h1><label>Name <input id="name"></label></body></html>`)
  const scenarios = Array.from({ length: 5 }, (_, index) => ({
    id: `screen-${index}`, title: `Screen ${index}`, group: "Screens", source: "src/Home.tsx",
    url: `/?screen=${index}${index === 1 ? '&delay=1' : ''}${index === 4 ? '&fail=1' : ''}`,
  }))
  const server = await createServer({
    root, configFile: false, logLevel: "error", server: { host: "127.0.0.1", port: 0 },
    plugins: [uiExplorer({ mode: "manual", autoCapture: false, scenarios })],
  })
  let browser
  try {
    await server.listen()
    const base = `http://127.0.0.1:${server.httpServer.address().port}`
    browser = await chromium.launch({ args: ["--no-sandbox"] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(`${base}/__explorer/?view=gallery&preview=screen-0`)
    const dialog = page.getByRole("dialog")
    const frame = dialog.frameLocator(active)
    await frame.locator('html[data-uix-status="ready"]').waitFor()
    await dialog.locator(".screen-preview-entry:not([hidden]) .screen-thumbnail__loading").waitFor({ state: "detached", timeout: 5000 })
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 1280, height: 720 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport)
      const box = await dialog.boundingBox()
      for (const [actual, expected] of [[box.x, 16], [box.y, 16], [box.width, viewport.width - 32], [box.height, viewport.height - 32]])
        assert.ok(Math.abs(actual - expected) < 1, `16px modal margins at ${viewport.width}x${viewport.height}: ${JSON.stringify(box)}`)
      await page.waitForFunction(() => {
        const root = document.querySelector(".screen-preview-entry:not([hidden]) .screen-thumbnail")
        const iframe = root?.querySelector("iframe")
        if (!root || !iframe) return false
        const container = root.getBoundingClientRect(), preview = iframe.getBoundingClientRect()
        return container.height > 0 && Math.abs(container.width - preview.width) < 1 && Math.abs(container.height - preview.height) < 1
      })
      assert.ok(await dialog.evaluate((element) => element.scrollHeight <= element.clientHeight + 2), "the shell does not overflow in small windows")
      if (process.env.UIX_SCREENSHOT_DIR)
        await page.screenshot({ path: path.join(process.env.UIX_SCREENSHOT_DIR, `modal-${viewport.width}x${viewport.height}.png`) })
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    const identity = await frame.locator("body").evaluate(() => performance.timeOrigin)
    await frame.getByRole("textbox", { name: "Name" }).fill("Still here")
    await page.getByRole("button", { name: "Open live UI", exact: true }).click()
    await page.getByRole("button", { name: "Next screen state", exact: true }).click()
    const started = Date.now()
    await frame.locator('html[data-uix-status="ready"]').waitFor()
    await dialog.locator(".screen-preview-entry:not([hidden]) .screen-thumbnail__loading").waitFor({ state: "detached", timeout: 5000 })
    t.diagnostic(`Delayed attribute-only host interactive in ${Date.now() - started}ms (no 20s watchdog wait)`)
    await page.getByRole("button", { name: "Previous screen state", exact: true }).click()
    const returned = Date.now()
    assert.equal(await frame.getByRole("textbox", { name: "Name" }).inputValue(), "Still here")
    assert.equal(await frame.locator("body").evaluate(() => performance.timeOrigin), identity, "revisiting a cached screen performs no document reload")
    t.diagnostic(`Cached screen revisit verified in ${Date.now() - returned}ms`)
    assert.equal(await dialog.locator("iframe").count(), 2)
    assert.equal(await dialog.locator(".screen-preview-entry[hidden][inert]").count(), 1, "inactive cached previews cannot receive keyboard focus")
    for (let index = 1; index <= 3; index++) {
      await page.getByRole("button", { name: "Next screen state", exact: true }).click()
      await frame.locator('html[data-uix-status="ready"]').waitFor()
    }
    assert.equal(await dialog.locator("iframe").count(), 3, "retention is bounded")
    assert.equal(await dialog.locator('iframe[title="Screen 0 preview"]').count(), 0, "least recently visited screen is released")
    const beforeReset = await frame.locator("body").evaluate(() => performance.timeOrigin)
    await frame.getByRole("textbox", { name: "Name" }).fill("Reset me")
    await page.getByRole("button", { name: "Reset state", exact: true }).click()
    await frame.locator('html[data-uix-status="ready"]').waitFor()
    assert.equal(await frame.getByRole("textbox", { name: "Name" }).inputValue(), "")
    assert.notEqual(await frame.locator("body").evaluate(() => performance.timeOrigin), beforeReset)
    assert.equal(await dialog.locator("iframe").count(), 1, "reset releases retained documents")
    await page.getByRole("button", { name: "Next screen state", exact: true }).click()
    await dialog.locator(".screen-preview-entry:not([hidden])").getByRole("alert").waitFor({ timeout: 5000 })
    assert.match(await dialog.locator(".screen-preview-entry:not([hidden])").getByRole("alert").innerText(), /Fixture failed/)
    await page.getByRole("button", { name: "Back to preview", exact: true }).click()
    await page.getByRole("button", { name: "Close", exact: true }).click()
    await dialog.waitFor({ state: "detached" })
    assert.equal(await page.locator(".screen-preview-deck iframe").count(), 0, "closing the preview releases all retained documents")
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// Slow state responses must not fan out into simultaneous fetches or replace newer data out of order.
test("bursts of live state events share one request and retain a trailing refresh", { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uix-state-burst-"))
  fs.writeFileSync(path.join(root, "index.html"), "<h1>App</h1>")
  const server = await createServer({
    root, configFile: false, logLevel: "error", server: { host: "127.0.0.1", port: 0 },
    plugins: [uiExplorer({ mode: "manual", autoCapture: false, scenarios: [] })],
  })
  let browser
  try {
    await server.listen()
    const base = `http://127.0.0.1:${server.httpServer.address().port}`
    const state = await (await fetch(`${base}/__explorer/api/state`)).json()
    browser = await chromium.launch({ args: ["--no-sandbox"] })
    const page = await browser.newPage()
    await page.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        constructor() { super(); window.testEvents = this }
      }
    })
    const pending = []
    await page.route("**/__explorer/api/state", (route) => { pending.push(route) })
    await page.goto(`${base}/__explorer/`)
    await page.waitForFunction(() => !!window.testEvents)
    await page.evaluate(() => { for (let i = 0; i < 30; i++) window.testEvents.dispatchEvent(new Event("state")) })
    const waitForRequests = async (count) => {
      const deadline = Date.now() + 5000
      while (pending.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(pending.length, count)
    }
    await waitForRequests(1)
    await pending[0].fulfill({ json: state })
    await waitForRequests(2)
    const updated = { ...state, scenarios: [{ id: "latest", title: "Latest screen", group: "Updated", source: "src/Latest.tsx", origin: "manual" }] }
    await pending[1].fulfill({ json: updated })
    await page.getByRole("checkbox").first().waitFor()
    await page.getByRole("checkbox").first().click()
    await page.getByRole("button", { name: "Expand Latest screen", exact: true }).waitFor()
    assert.equal(pending.length, 2, "thirty overlapping events require only one initial and one trailing fetch")
  } finally {
    await browser?.close()
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("initial previews wait for async hydration but not unrelated slow images", { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uix-interactive-ready-"))
  fs.writeFileSync(path.join(root, "index.html"), `<!doctype html><html><head>
    <script async src="/hydrate.js"></script>
    </head><body><h1>Hydrated app</h1><button id="open">Open</button><output id="result">Waiting</output><img src="/slow-image.svg" alt="Slow decoration"></body></html>`)
  const server = await createServer({
    root, configFile: false, logLevel: "error", server: { host: "127.0.0.1", port: 0 },
    plugins: [uiExplorer({ mode: "manual", autoCapture: false, scenarios: [{
      id: "hydrated", title: "Hydrated", group: "Screens", actions: [{ kind: "click", selector: "#open" }],
    }] })],
  })
  let browser
  try {
    await server.listen()
    const base = `http://127.0.0.1:${server.httpServer.address().port}`
    browser = await chromium.launch({ args: ["--no-sandbox"] })
    const page = await browser.newPage()
    let script, image
    await page.route("**/hydrate.js", (route) => { script = route })
    await page.route("**/slow-image.svg", (route) => { image = route })
    await page.goto(`${base}/?__uix=hydrated&__uix_embed=1`, { waitUntil: "domcontentloaded" })
    const deadline = Date.now() + 5000
    while ((!script || !image) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(script && image, "the async script and slow image are pending")
    assert.equal(await page.locator("html").getAttribute("data-uix-status"), null, "the recipe must not run before hydration")
    const started = Date.now()
    await script.fulfill({ contentType: "application/javascript", body: `document.querySelector('#open').onclick = () => document.querySelector('#result').textContent = 'Opened after hydration'` })
    await page.locator('html[data-uix-status="ready"]').waitFor({ timeout: 5000 })
    assert.equal(await page.locator("#result").innerText(), "Opened after hydration")
    assert.equal(await page.evaluate(() => document.readyState), "interactive", "the image is still loading, but the app is usable")
    t.diagnostic(`Recipe ready ${Date.now() - started}ms after hydration, without waiting for the image`)
    await image.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' })
  } finally {
    await browser?.close()
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
