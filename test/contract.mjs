import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { chromium } from "playwright"
import { serve, snapshot } from "../dist/node/index.js"

// The adapter contract: what must hold for the explorer to be listed as supporting a bundler. Every bundler runs
// this same function against its own dev server (and, where given, its production build).

export const EXPECTED_TITLES = ["Welcome", "Settings", "Reports", "Help centre", "Weekly", "Monthly"]

const wait = async (check, timeoutMs, message) => {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeoutMs) assert.fail(message)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

export const temp = (prefix = "uix-") => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))

async function getText(url, headers = {}) {
  const response = await fetch(url, { headers })
  return { status: response.status, text: await response.text(), headers: response.headers }
}

/**
 * @param {object} spec
 * @param {string} spec.name           shown in failure messages
 * @param {string} spec.target         the running dev server
 * @param {string} spec.root           the project folder (sources live under `src`)
 * @param {string} [spec.edit]         a file under root to change, to see the revision move
 * @param {"websocket"|"sse"|"none"} [spec.live]  the dev server's live-reload channel, which must work through the proxy
 * @param {string[]} [spec.titles]     states the crawl must find
 * @param {() => Promise<string>} [spec.build]   runs a production build and returns its output folder
 * @param {number} [spec.maxStates]
 */
export async function runContract(spec) {
  const label = (what) => `${spec.name}: ${what}`
  const running = await serve({ target: spec.target, root: spec.root, port: 0, maxStates: spec.maxStates ?? 40, wait: 20 })
  const base = running.url
  const state = async () => (await fetch(`${base}/__explorer/api/state`)).json()
  const browser = await chromium.launch({ args: ["--no-sandbox"] })
  try {
    // 1. The app, served through the proxy, carries the runtime and still works.
    const home = await getText(`${base}/`, { accept: "text/html" })
    assert.equal(home.status, 200, label("the app answers through the proxy"))
    assert.match(home.text, /<script src="\/__explorer\/runtime\.js"><\/script>/, label("the page carries the runtime tag"))
    assert.equal((home.text.match(/__explorer\/runtime\.js/g) ?? []).length, 1, label("exactly one tag"))

    const page = await browser.newPage()
    const sockets = []
    const failures = []
    page.on("websocket", (socket) => sockets.push(socket))
    page.on("pageerror", (error) => failures.push(error.message))
    await page.goto(`${base}/`)
    await page.waitForSelector("h1", { timeout: 60_000 })
    assert.equal(await page.locator("h1").first().innerText(), "Welcome", label("the app renders"))
    await page.getByRole("button", { name: "Settings" }).click()
    assert.equal(await page.locator("h1").first().innerText(), "Settings", label("the app responds to clicks"))
    assert.deepEqual(failures, [], label("no page errors through the proxy"))

    // 2. The dev server's live-reload channel works through the proxy.
    if (spec.live === "websocket") {
      await wait(() => sockets.length > 0, 15_000, label("the dev server opened a WebSocket through the proxy"))
      await new Promise((resolve) => setTimeout(resolve, 1500))
      assert.ok(sockets.some((socket) => !socket.isClosed()), label("the WebSocket stays open"))
    }
    if (spec.live === "sse") {
      const open = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const source = new EventSource("/esbuild")
            source.onopen = () => resolve(true)
            source.onerror = () => resolve(false)
          }),
      )
      assert.equal(open, true, label("the live-reload event stream opens through the proxy"))
    }

    // 3. The explorer page is there.
    const explorerPage = await getText(`${base}/__explorer/`)
    assert.equal(explorerPage.status, 200, label("the explorer page answers"))
    assert.match(explorerPage.text, /<div id="root">/)

    // 4. Exploring finds the states, and thumbnails follow.
    assert.equal((await fetch(`${base}/__explorer/api/crawl`, { method: "POST" })).status, 202)
    const done = await wait(async () => {
      const current = await state()
      return ["done", "error"].includes(current.jobs.crawl.status) ? current : undefined
    }, 240_000, label("the crawl finished"))
    assert.equal(done.jobs.crawl.status, "done", label(`the crawl succeeded (${done.jobs.crawl.message ?? ""})`))
    const titles = done.scenarios.map((scenario) => scenario.title)
    for (const wanted of spec.titles ?? EXPECTED_TITLES) assert.ok(titles.includes(wanted), label(`expected "${wanted}" in ${JSON.stringify(titles)}`))
    const captured = await wait(async () => {
      const current = await state()
      return current.jobs.capture.status === "done" ? current : undefined
    }, 180_000, label("the capture finished"))
    assert.ok(Object.keys(captured.thumbnails.items).length >= 6, label("thumbnails were captured"))
    assert.equal(captured.thumbnails.revision, captured.revision)

    // 5. A recorded scenario replays through the proxy.
    const weekly = done.scenarios.find((scenario) => scenario.title === "Weekly")
    assert.ok(weekly?.actions?.length, label("the dropdown choice has a recipe"))
    const preview = await browser.newPage()
    await preview.goto(`${base}/?__uix=${encodeURIComponent(weekly.id)}&__uix_embed=1`)
    await preview.waitForFunction(() => document.documentElement.hasAttribute("data-uix-status"), undefined, { timeout: 60_000 })
    assert.equal(await preview.evaluate(() => document.documentElement.getAttribute("data-uix-status")), "ready", label("the scenario replays"))
    assert.equal(await preview.locator("#frequency").innerText(), "Weekly")

    // 6. A source edit is noticed.
    if (spec.edit) {
      const before = (await state()).revision
      fs.appendFileSync(path.join(spec.root, spec.edit), "\n// edited by the contract test\n")
      await wait(async () => (await state()).revision !== before, 10_000, label("editing a source file changes the revision"))
    }

    // 7. A production build gets a working read-only explorer.
    if (spec.build) {
      const out = await spec.build()
      const result = snapshot({ dir: out, root: spec.root })
      assert.ok(result.tagged.length >= 1, label("the build's HTML was tagged"))
      const staticServer = await serveFolder(out)
      try {
        const staticPage = await browser.newPage()
        await staticPage.goto(`${staticServer.url}/__explorer/`)
        // The read-only explorer loads its data from files and counts the views it was given.
        await staticPage.waitForFunction(() => document.body.innerText.includes("Base screens"), undefined, { timeout: 30_000 })
        const shown = await staticPage.evaluate(() => document.body.innerText)
        assert.match(shown, new RegExp(`\\n${done.scenarios.length}\\n`), label("the snapshot shows every state"))
        const data = await (await fetch(`${staticServer.url}/__explorer/api/state.json`)).json()
        assert.equal(data.scenarios.length, done.scenarios.length, label("the snapshot's data holds every state"))
        const statically = await browser.newPage()
        await statically.goto(`${staticServer.url}/?__uix=${encodeURIComponent(weekly.id)}&__uix_embed=1`)
        await statically.waitForFunction(() => document.documentElement.hasAttribute("data-uix-status"), undefined, { timeout: 30_000 })
        assert.equal(await statically.evaluate(() => document.documentElement.getAttribute("data-uix-status")), "ready", label("a scenario replays from the snapshot"))
        assert.equal(await statically.locator("#frequency").innerText(), "Weekly")
      } finally {
        await staticServer.close()
      }
    }
    return { states: done.scenarios.length, thumbnails: Object.keys(captured.thumbnails.items).length }
  } finally {
    await browser.close()
    await running.close()
  }
}

/** A static file server for a build folder, like any host would serve it. */
export function serveFolder(dir) {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2" }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x")
    let file = path.join(dir, decodeURIComponent(url.pathname))
    if (!file.startsWith(dir)) return res.writeHead(403).end()
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html")
    if (!fs.existsSync(file)) return res.writeHead(404).end("not found")
    res.setHeader("Content-Type", types[path.extname(file)] ?? "application/octet-stream")
    fs.createReadStream(file).pipe(res)
  })
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => (server.closeAllConnections(), server.close(() => done()))),
      }),
    ),
  )
}

/** Copies a fixture app into a fresh project folder. */
export function copyFixture(from, to = temp()) {
  fs.cpSync(from, to, { recursive: true })
  return to
}
