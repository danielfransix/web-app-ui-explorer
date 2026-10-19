import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { chromium } from "playwright"
import { capture, captureDesigns, crawl, previewPath, serve, snapshot } from "../dist/node/index.js"

const click = selector => ({ kind: "click", selector })
const scenarios = [
  { id: "second", title: "Second page", group: "Pages", actions: [click("#second")] },
  { id: "slow", title: "Slow destination", group: "Pages", actions: [click("#slow")] },
  { id: "redirect", title: "Redirect destination", group: "Pages", actions: [click("#redirect"), click("#open")] },
  { id: "programmatic", title: "Programmatic destination", group: "Pages", actions: [click("#programmatic")] },
  { id: "workflow", title: "Completed workflow", group: "Pages", actions: [click("#mark"), click("#second"), { kind: "fill", selector: "#name", value: "Alex" }, click("#continue"), click("#open")] },
  { id: "spa", title: "Client route", group: "Pages", actions: [click("#spa"), click("#hash")] },
  { id: "stopped-event", title: "Stopped event", group: "Pages", actions: [click("#stopped")] },
  { id: "history", title: "History workflow", group: "Pages", actions: [click("#second"), click("#back"), click("#mark")] },
  { id: "responsive", title: "Responsive destination", group: "Pages", replayViewport: { width: 1280, height: 900 }, actions: [click("#second")] },
]
const html = content => `<!doctype html><html><head><meta charset="utf-8"><title>Navigation fixture</title><style>body{font:18px system-ui;padding:24px}a,button,input{display:block;margin:12px}dialog{padding:32px}@media(max-width:600px){#second{display:none}}</style></head><body>${content}</body></html>`
const open = '<button id="open" onclick="document.querySelector(\'dialog\').showModal()">Open dialog</button><dialog aria-label="Destination dialog"><h2>Destination dialog</h2><button onclick="this.closest(\'dialog\').close()">Close</button></dialog>'
const first = html(`<h1>First page</h1>
  <button id="mark" onclick="sessionStorage.setItem('marks',String(+(sessionStorage.getItem('marks')||0)+1))">Mark</button>
  <a id="second" href="/second">Second page</a><a id="redirect" href="/redirect">Redirect</a><a id="slow" href="/slow">Slow page</a>
  <a id="stopped" href="/slow" onclick="event.stopPropagation()">Stopped propagation</a>
  <button id="programmatic" onclick="setTimeout(()=>location.assign('/second'),150)">Programmatic</button>
  <a id="spa" href="/client" onclick="event.preventDefault();history.pushState({},'',this.href);document.querySelector('h1').textContent='Client route'">Client route</a>
  <a id="hash" href="#section">Section</a><h2 id="section">Section</h2>
  <a id="external" href="http://127.0.0.1:1/escape">External</a>`)
const second = html(`<h1>Second page</h1><form action="/third" method="get"><label>Name<input name="name" id="name"></label><button id="continue">Continue</button></form><button id="back" onclick="history.back()">Back</button>${open}`)
const third = html(`<h1>Third page</h1><output id="value"></output>${open}<script>document.querySelector('#value').textContent=new URLSearchParams(location.search).get('name')</script>`)
let root, upstream, running, browser, base
test.before(async () => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "uix-navigation-")))
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fixture")
    if (url.pathname === "/redirect") return res.writeHead(302, { Location: "/landing" }).end()
    res.setHeader("Content-Type", "text/html")
    if (url.pathname === "/slow") return setTimeout(() => res.end(html("<h1>Slow destination</h1>")), 1200)
    res.end(url.pathname === "/second" ? second : url.pathname === "/third" ? third : url.pathname === "/landing" ? html(`<h1>Redirect destination</h1>${open}`) : first)
  })
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve))
  running = await serve({ root, target: `http://127.0.0.1:${upstream.address().port}`, port: 0, route: "/inspect", mode: "manual", scenarios, autoCapture: false })
  base = running.url
  browser = await chromium.launch()
})
test.after(async () => {
  await browser?.close()
  await running?.close()
  upstream?.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  fs.rmSync(root, { recursive: true, force: true })
})

async function preview(page, id) {
  await page.goto(base + previewPath(scenarios.find(s => s.id === id), "/"))
  await page.locator('html[data-uix-status="ready"]').waitFor({ timeout: 25_000 })
}

test("native links, slow responses, redirects and programmatic navigation reach the destination", { timeout: 90_000 }, async () => {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    const errors = []
    page.on("pageerror", e => errors.push(e.message))
    for (const [id, destination, heading] of [["second", "/second", "Second page"], ["slow", "/slow", "Slow destination"], ["redirect", "/landing", "Redirect destination"], ["programmatic", "/second", "Second page"], ["stopped-event", "/slow", "Slow destination"]]) {
      await preview(page, id)
      assert.equal(new URL(page.url()).pathname, destination)
      assert.equal(await page.locator("h1").innerText(), heading)
      assert.equal(await page.evaluate(() => sessionStorage.getItem("__uix:replay:v1")), null)
      if (id === "redirect") assert.equal(await page.locator("dialog").isVisible(), true)
    }
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test("multi-document workflows execute each action once, including GET forms and destination interactions", { timeout: 45_000 }, async () => {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await preview(page, "workflow")
    assert.equal(new URL(page.url()).pathname, "/third")
    assert.equal(await page.locator("#value").innerText(), "Alex")
    assert.equal(await page.evaluate(() => sessionStorage.getItem("marks")), "1")
    assert.equal(await page.locator("dialog").isVisible(), true)
    await page.getByRole("button", { name: "Close", exact: true }).click()
    await page.reload()
    assert.equal(await page.locator("dialog").isVisible(), false, "completed recipes do not restart on refresh")
    assert.equal(await page.evaluate(() => sessionStorage.getItem("__uix:replay:v1")), null)
    assert.equal(await page.locator("html").getAttribute("data-uix-status"), null)
  } finally { await context.close() }
})

test("SPA prevention and hash changes stay in the same document", { timeout: 30_000 }, async () => {
  const page = await browser.newPage()
  try {
    await preview(page, "spa")
    assert.equal(new URL(page.url()).pathname, "/client")
    assert.equal(new URL(page.url()).hash, "#section")
    assert.equal(await page.locator("h1").innerText(), "Client route")
  } finally { await page.close() }
})

test("history traversal resumes the remaining recipe, including a page restored from cache", { timeout: 35_000 }, async () => {
  const page = await browser.newPage()
  try {
    await preview(page, "history")
    assert.equal(await page.locator("h1").innerText(), "First page")
    assert.equal(await page.evaluate(() => sessionStorage.getItem("marks")), "1")
    assert.equal(await page.evaluate(() => sessionStorage.getItem("__uix:replay:v1")), null)
  } finally { await page.close() }
})

test("jobs report genuine missing controls and reject external navigation", { timeout: 30_000 }, async () => {
  const page = await browser.newPage()
  try {
    await preview(page, "second")
    await page.evaluate(() => window.__uix.startReplay("missing", [{ kind: "click", selector: "#absent" }], { timeoutMs: 200 }))
    await page.waitForFunction(() => window.__uix.replayStatus()?.result)
    const failure = await page.evaluate(() => window.__uix.replayStatus().result)
    assert.equal(failure.ok, false)
    assert.match(failure.message, /could not find #absent/)
    await page.goto(base + "/?__uix_embed=1")
    await page.addScriptTag({ content: "window.__UIX_FORCE=true" })
    await page.addScriptTag({ url: base + "/inspect/runtime.js" })
    await page.evaluate(() => window.__uix.startReplay("external", [{ kind: "click", selector: "#external" }]))
    await page.waitForFunction(() => window.__uix.replayStatus()?.result)
    assert.match((await page.evaluate(() => window.__uix.replayStatus().result)).message, /outside the app origin/)
    assert.equal(new URL(page.url()).origin, base)
  } finally { await page.close() }
})

test("continuations are isolated between tabs and stale/malformed state does not activate a normal page", { timeout: 40_000 }, async () => {
  const context = await browser.newContext()
  try {
    const a = await context.newPage(), b = await context.newPage()
    await Promise.all([preview(a, "workflow"), preview(b, "second")])
    assert.equal(await a.locator("dialog").isVisible(), true)
    assert.equal(await b.locator("#name").inputValue(), "")
    assert.equal(await b.evaluate(() => sessionStorage.getItem("marks")), null)
    for (const raw of ["invalid json", JSON.stringify({ id: "old", actions: [], next: 0, deadline: Date.now() - 1000, endpoint: "/inspect/" })]) {
      await b.evaluate(raw => sessionStorage.setItem("__uix:replay:v1", raw), raw)
      await b.goto(base + "/")
      assert.equal(await b.evaluate(() => !!window.__uix), false)
      assert.equal(await b.evaluate(() => sessionStorage.getItem("__uix:replay:v1")), null)
    }
  } finally { await context.close() }
})

test("simultaneous preview iframes in the same tab do not consume each other's continuation", { timeout: 35_000 }, async () => {
  const page = await browser.newPage()
  try {
    await page.route("**/inspect/runtime.js", async route => { await new Promise(resolve => setTimeout(resolve, 250)); await route.continue() })
    await page.goto(base + "/")
    const urls = ["workflow", "redirect"].map(id => base + previewPath(scenarios.find(s => s.id === id), "/"))
    await page.evaluate(urls => {
      for (const [index, url] of urls.entries()) {
        const frame = document.createElement("iframe")
        frame.style.width = "1280px"; frame.style.height = "900px"
        frame.id = `preview-${index}`; frame.src = url; document.body.append(frame)
      }
    }, urls)
    const workflow = page.frameLocator("#preview-0"), redirect = page.frameLocator("#preview-1")
    await Promise.all([workflow.locator('html[data-uix-status="ready"]').waitFor({ timeout: 25_000 }), redirect.locator('html[data-uix-status="ready"]').waitFor({ timeout: 25_000 })])
    assert.equal(await workflow.locator("#value").innerText(), "Alex")
    assert.equal(await redirect.locator("h1").innerText(), "Redirect destination")
    assert.equal(await workflow.locator("dialog").isVisible(), true)
    assert.equal(await redirect.locator("dialog").isVisible(), true)
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("__uix:replay:v1")).length), 0)
  } finally { await page.close() }
})

test("disabled session storage gives a clear navigation error while SPA replay still works", { timeout: 30_000 }, async () => {
  const context = await browser.newContext()
  await context.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException("disabled", "SecurityError") } })
  try {
    const page = await context.newPage()
    await page.goto(base + previewPath(scenarios[0], "/"))
    await page.locator('html[data-uix-status^="error:"]').waitFor()
    assert.match(await page.locator("html").getAttribute("data-uix-status"), /requires session storage/)
    await preview(page, "spa")
    assert.equal(await page.locator("h1").innerText(), "Client route")
  } finally { await context.close() }
})

test("crawler discovers native page transitions and records replayable destination recipes", { timeout: 120_000 }, async () => {
  const logs = []
  const result = await crawl({ baseUrl: base, concurrency: 2, maxStates: 24, maxDepth: 3, timeBudgetMs: 90_000, log: line => logs.push(line) })
  for (const heading of ["First page", "Second page", "Third page", "Slow destination", "Redirect destination", "Client route"])
    assert.ok(result.scenarios.some(s => s.title === heading), `missing ${heading}: ${JSON.stringify(result.stats)}\n${logs.join("\n")}`)
  assert.equal(result.stats.failedReplays, 0)
  assert.ok(result.scenarios.every(s => s.replayViewport.width === 1280 && s.replayViewport.height === 900))
  assert.ok(result.scenarios.some(s => s.kind === "overlay" && s.title === "Destination dialog"))
})

test("unseen routes are explored before repeated shared-navigation links", { timeout: 20_000 }, async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html")
    const route = new URL(req.url, "http://fixture").pathname
    res.end(html(route === "/" ? `<h1>Home</h1>${Array.from({ length: 40 }, (_, i) => `<a href="/repeated">Repeated ${i}</a>`).join("")}<a href="/section">Section</a>` : route === "/section" ? '<h1>Section page</h1><a href="/deep">Deep</a>' : route === "/deep" ? '<h1>Deep page</h1>' : '<h1>Repeated page</h1>'))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  try {
    const result = await crawl({ baseUrl: `http://127.0.0.1:${server.address().port}`, concurrency: 1, maxStates: 4, timeBudgetMs: 8000 })
    assert.ok(result.scenarios.some(s => s.title === "Deep page"), JSON.stringify(result.stats))
    assert.equal(result.stats.failedReplays, 0)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test("a repeated link label cannot suppress new destination URLs after eight successful visits", { timeout: 45_000 }, async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html")
    const route = new URL(req.url, "http://fixture").pathname
    const index = route.split("/").pop()
    res.end(html(route === "/" ? `<h1>Catalog</h1>${Array.from({ length: 12 }, (_, i) => `<a href="/category/${i + 1}">Category ${i + 1}</a>`).join("")}` : route.startsWith("/category/") ? `<h1>Category ${index}</h1><a href="/detail/${index}">Explore</a>` : `<h1>Detail ${index}</h1>`))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  try {
    const result = await crawl({ baseUrl: `http://127.0.0.1:${server.address().port}`, concurrency: 1, maxStates: 25, maxDepth: 3, timeBudgetMs: 35_000 })
    assert.ok(result.scenarios.some(s => s.title === "Detail 12"), JSON.stringify(result.stats))
    assert.equal(result.stats.failedReplays, 0)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test("thumbnail and editable captures include the final destination, at desktop and mobile widths", { timeout: 90_000 }, async () => {
  const scenario = scenarios.find(s => s.id === "workflow")
  const manifest = await capture({ baseUrl: base, startPath: "/", scenarios: [scenario], outDir: path.join(root, "thumbs"), revision: "navigation", concurrency: 1 })
  assert.deepEqual(manifest.failed, {})
  assert.ok(fs.statSync(path.join(root, "thumbs/workflow.jpg")).size > 1000)
  const captures = await captureDesigns({ baseUrl: base, startPath: "/", scenario, widths: [1440, 390] })
  for (const capture of captures) {
    assert.match(JSON.stringify(capture.root), /Destination dialog/)
    assert.doesNotMatch(JSON.stringify(capture.root), /First page/)
  }
})

test("gallery modal receives destination readiness and remains interactive after navigation", { timeout: 45_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  try {
    await page.goto(base + "/inspect/?view=gallery")
    await page.getByRole("checkbox").first().click()
    await page.getByRole("button", { name: "Expand Completed workflow", exact: true }).click()
    const frame = page.getByRole("dialog").frameLocator(".screen-preview-entry:not([hidden]) iframe")
    await frame.locator('html[data-uix-status="ready"]').waitFor({ timeout: 25_000 })
    assert.equal(await frame.locator("#value").innerText(), "Alex")
    await frame.getByRole("button", { name: "Close", exact: true }).click()
    await frame.getByRole("button", { name: "Open dialog", exact: true }).click()
    assert.equal(await frame.locator("dialog").isVisible(), true)
    if (process.env.UIX_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.UIX_SCREENSHOT_DIR, "navigation-modal.png") })
  } catch (error) {
    for (const frame of page.frames()) console.log("navigation preview diagnostic", await frame.evaluate(() => ({ url: location.href, status: document.documentElement.getAttribute("data-uix-status"), replay: window.__uix?.replayStatus(), keys: Object.keys(sessionStorage).filter(key => key.startsWith("__uix:replay:v1")) })).catch(e => e.message))
    throw error
  } finally { await page.close() }
})

test("mobile-first captures and reset previews replay desktop-only navigation before resizing", { timeout: 50_000 }, async () => {
  const scenario = scenarios.find(s => s.id === "responsive")
  const captures = await captureDesigns({ baseUrl: base, startPath: "/", scenario, widths: [390, 1440] })
  assert.deepEqual(captures.map(c => c.width), [390, 1440])
  for (const capture of captures) assert.match(JSON.stringify(capture.root), /Second page/)
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  try {
    await page.goto(base + "/inspect/?view=gallery")
    await page.getByRole("checkbox").first().click()
    await page.getByRole("button", { name: "Expand Responsive destination", exact: true }).click()
    const frame = page.getByRole("dialog").frameLocator(".screen-preview-entry:not([hidden]) iframe")
    await frame.locator('html[data-uix-status="ready"]').waitFor()
    await page.getByRole("combobox", { name: "Preview viewport", exact: true }).click()
    await page.getByRole("option", { name: "Mobile", exact: true }).click()
    await page.getByRole("button", { name: "Reset state", exact: true }).click()
    await frame.locator('html[data-uix-status="ready"]').waitFor()
    await page.waitForFunction(() => document.querySelector('.screen-preview-entry:not([hidden]) iframe')?.contentWindow?.innerWidth === 390)
    assert.equal(await frame.locator("h1").innerText(), "Second page")
    assert.equal(await frame.locator("body").evaluate(() => innerHeight), 844)
  } finally { await page.close() }
})

test("static snapshots resume navigation without a live Explorer API", { timeout: 45_000 }, async () => {
  const out = path.join(root, "static")
  for (const [name, content] of [["index.html", first], ["second/index.html", second], ["third/index.html", third]]) {
    fs.mkdirSync(path.dirname(path.join(out, name)), { recursive: true })
    fs.writeFileSync(path.join(out, name), content)
  }
  snapshot({ root, dir: out, route: "/inspect", mode: "manual", scenarios, autoCapture: false })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://static")
    let file = path.join(out, url.pathname)
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html")
    if (!fs.existsSync(file)) return res.writeHead(404).end("missing")
    res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".json") ? "application/json" : "text/html")
    res.end(fs.readFileSync(file))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const page = await browser.newPage()
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}` + previewPath(scenarios.find(s => s.id === "workflow"), "/"))
    await page.locator('html[data-uix-status="ready"]').waitFor({ timeout: 25_000 })
    assert.equal(await page.locator("#value").innerText(), "Alex")
    assert.equal(await page.locator("dialog").isVisible(), true)
  } finally {
    await page.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

test("cancelling an in-flight crawl releases its browser work promptly", { timeout: 15_000 }, async () => {
  const controller = new AbortController()
  const started = Date.now()
  const result = await crawl({ baseUrl: base, concurrency: 2, signal: controller.signal, onState: () => setTimeout(() => controller.abort(), 100) })
  assert.equal(result.stats.stoppedBy, "cancelled")
  assert.ok(Date.now() - started < 10_000)
})

test("the crawl time budget interrupts an unresponsive document load", { timeout: 15_000 }, async () => {
  const server = http.createServer(() => {})
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  try {
    const started = Date.now()
    const result = await crawl({ baseUrl: `http://127.0.0.1:${server.address().port}`, concurrency: 1, timeBudgetMs: 1200 })
    assert.equal(result.stats.stoppedBy, "time-budget")
    assert.ok(Date.now() - started < 8000)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test("saved replay failures remain visible after reopening the Explorer", { timeout: 20_000 }, async () => {
  const file = path.join(root, ".ui-explorer/scenarios.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ version: 1, scenarios: [], stats: { states: 1, duplicates: 0, skipped: 0, failedReplays: 2, candidatesTried: 2, seconds: 1, stoppedBy: "complete" } }))
  const page = await browser.newPage()
  try {
    await page.goto(base + "/inspect/")
    assert.equal(await page.getByRole("status", { name: "Exploration incomplete" }).innerText(), "2 replay failures")
    fs.writeFileSync(file, JSON.stringify({ version: 1, scenarios: [], stats: { states: 1, duplicates: 0, skipped: 0, failedReplays: 0, candidatesTried: 2, seconds: 1, stoppedBy: "time-budget" } }))
    await page.reload()
    assert.equal(await page.getByRole("status", { name: "Exploration incomplete" }).innerText(), "Time limit reached")
  } finally { await page.close(); fs.unlinkSync(file) }
})
