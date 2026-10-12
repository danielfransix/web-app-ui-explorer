import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { createServer } from "vite"
import uiExplorer from "../dist/node/vite.js"

// The whole stack on an app the tool was not built beside: the plugin serves the explorer and injects the runtime, a
// crawl started through the API finds the states, thumbnails are captured, and a recorded scenario replays.
const here = path.dirname(fileURLToPath(import.meta.url))

const wait = async (check, timeoutMs, message) => {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeoutMs) assert.fail(message)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

test("the plugin serves the explorer, explores the app through its API, and replays what it found", { timeout: 300_000 }, async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "uix-demo-")))
  fs.copyFileSync(path.join(here, "fixtures/demo/index.html"), path.join(root, "index.html"))
  fs.mkdirSync(path.join(root, "src"))
  fs.writeFileSync(path.join(root, "src/Home.tsx"), "export default () => <h1>Welcome</h1>")
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "demo-app" }))

  const server = await createServer({
    root,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [uiExplorer({ maxStates: 40 })],
  })
  await server.listen()
  const base = `http://127.0.0.1:${server.httpServer.address().port}`
  const state = async () => (await fetch(`${base}/__explorer/api/state`)).json()

  try {
    // The explorer is its own page, and the app gets the runtime.
    const page = await fetch(`${base}/__explorer/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /<div id="root">/)
    assert.equal((await fetch(`${base}/__explorer/runtime.js`)).status, 200)
    assert.match(await (await fetch(`${base}/`)).text(), /__explorer\/runtime\.js/)

    const before = await state()
    assert.equal(before.project, "demo-app")
    assert.deepEqual(before.scenarios, [])
    assert.ok(before.sources.includes("demo-app/src/Home.tsx"))

    // Explore: nobody has written a scenario.
    const started = await fetch(`${base}/__explorer/api/crawl`, { method: "POST" })
    assert.equal(started.status, 202)
    const done = await wait(async () => {
      const current = await state()
      return current.jobs.crawl.status === "done" ? current : undefined
    }, 150_000, "the crawl did not finish")
    const titles = done.scenarios.map((scenario) => scenario.title)
    for (const wanted of ["Welcome", "Settings", "Reports", "Help centre", "Weekly", "Monthly"])
      assert.ok(titles.includes(wanted), `expected "${wanted}" in ${JSON.stringify(titles)}`)
    assert.ok(fs.existsSync(path.join(root, ".ui-explorer/scenarios.json")))

    // Thumbnails follow the crawl by themselves.
    const captured = await wait(async () => {
      const current = await state()
      return current.jobs.capture.status === "done" ? current : undefined
    }, 120_000, "the capture did not finish")
    assert.ok(Object.keys(captured.thumbnails.items).length >= 6)
    assert.equal(captured.thumbnails.revision, captured.revision, "captures belong to the current source")
    const image = await fetch(`${base}/__explorer/thumbnails/${Object.values(captured.thumbnails.items)[0]}`)
    assert.equal(image.status, 200)
    assert.equal(image.headers.get("content-type"), "image/jpeg")

    // A recorded scenario replays in a preview page and reports back.
    const weekly = done.scenarios.find((scenario) => scenario.title === "Weekly")
    assert.ok(weekly?.actions?.length, "the dropdown choice has a recipe")
    const browser = await chromium.launch({ args: ["--no-sandbox"] })
    try {
      const preview = await browser.newPage()
      await preview.goto(`${base}/?__uix=${encodeURIComponent(weekly.id)}&__uix_embed=1`)
      await preview.waitForFunction(() => document.documentElement.hasAttribute("data-uix-status"), undefined, { timeout: 30_000 })
      assert.equal(await preview.evaluate(() => document.documentElement.getAttribute("data-uix-status")), "ready")
      assert.equal(await preview.locator("#frequency").innerText(), "Weekly")
    } finally {
      await browser.close()
    }
  } finally {
    await server.close()
  }
})

test("opening the explorer captures thumbnails by itself when there are none", { timeout: 120_000 }, async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "uix-auto-")))
  fs.copyFileSync(path.join(here, "fixtures/demo/index.html"), path.join(root, "index.html"))
  fs.mkdirSync(path.join(root, "src"))
  fs.writeFileSync(path.join(root, "src/Home.tsx"), "export default () => <h1>Welcome</h1>")
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
    // One hand-written scenario, nothing explored, nothing captured yet.
    plugins: [uiExplorer({ mode: "manual", scenarios: [{ id: "settings", title: "Settings", group: "Settings", actions: [{ kind: "click", selector: "button", text: "Settings" }] }] })],
  })
  await server.listen()
  const base = `http://127.0.0.1:${server.httpServer.address().port}`
  try {
    const first = await (await fetch(`${base}/__explorer/api/state`)).json()
    assert.equal(first.thumbnails, null)
    const done = await wait(async () => {
      const current = await (await fetch(`${base}/__explorer/api/state`)).json()
      return current.jobs.capture.status === "done" ? current : undefined
    }, 90_000, "no capture started on its own")
    assert.deepEqual(Object.keys(done.thumbnails.items), ["settings"])
    assert.equal(done.thumbnails.revision, done.revision)
  } finally {
    await server.close()
  }
})
