import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { serve } from "../dist/node/index.js"

/** A raw POST with a Host header fetch() won't let us override, to simulate a tab on a different loopback alias. */
function postWithHost(port, routePath, host, body, cookie) {
  return new Promise((resolve, reject) => {
    const json = Buffer.from(JSON.stringify(body))
    const headers = { Host: host, "Content-Type": "application/json", "Content-Length": json.length }
    if (cookie) headers.Cookie = cookie
    const req = http.request({ host: "127.0.0.1", port, path: routePath, method: "POST", headers }, (res) => {
      res.resume()
      res.on("end", () => resolve(res.statusCode))
    })
    req.on("error", reject)
    req.end(json)
  })
}

// The server-side half of the Explorer UI's "Log in" flow: POST /api/login reads the request's own Cookie
// header (sent automatically on a same-origin request, including httpOnly cookies — unlike document.cookie)
// plus whatever localStorage entries the client read, writes them as a storage state file, and immediately
// re-explores with it. No browser is launched here at all.

const temp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "uix-login-api-")))

test("POST /api/login saves the request's cookies and body localStorage, then re-explores", { timeout: 60_000 }, async () => {
  const upstream = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8")
    res.end("<!doctype html><html><body><h1>Dashboard</h1></body></html>")
  })
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const root = temp()
  let running
  try {
    running = await serve({ root, target: `http://127.0.0.1:${upstream.address().port}`, port: 0, autoCapture: false })
    const response = await fetch(`${running.url}${running.explorer.route}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "session=abc123; theme=dark" },
      body: JSON.stringify({ localStorage: { token: "xyz" } }),
    })
    assert.equal(response.status, 202)

    const savedPath = path.join(root, ".ui-explorer", "auth.json")
    assert.ok(fs.existsSync(savedPath), "expected a storage state file to be written")
    const saved = JSON.parse(fs.readFileSync(savedPath, "utf8"))
    assert.deepEqual(
      saved.cookies.map((c) => [c.name, c.value]).sort(),
      [["session", "abc123"], ["theme", "dark"]],
    )
    assert.equal(saved.origins[0]?.localStorage[0]?.name, "token")

    // Saving a session re-explores automatically — no separate "click Explore" needed.
    const deadline = Date.now() + 15_000
    let sawCrawl = false
    while (Date.now() < deadline) {
      if (running.explorer.state().jobs.crawl.status !== "idle") {
        sawCrawl = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(sawCrawl, "expected saving the session to trigger a crawl")
  } finally {
    await running?.close()
    upstream.closeAllConnections()
    await new Promise((resolve) => upstream.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("a session saved from a \"localhost\" tab still applies to a crawl triggered against \"127.0.0.1\" — same server, different loopback alias", { timeout: 30_000 }, async () => {
  const upstream = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8")
    res.end("<!doctype html><html><body><h1>Dashboard</h1></body></html>")
  })
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const root = temp()
  let running
  try {
    running = await serve({ root, target: `http://127.0.0.1:${upstream.address().port}`, port: 0, autoCapture: false })
    const port = running.port
    const status = await postWithHost(port, `${running.explorer.route}/api/login`, `localhost:${port}`, { localStorage: { token: "xyz" } }, "session=abc123")
    assert.equal(status, 202)

    const saved = JSON.parse(fs.readFileSync(path.join(root, ".ui-explorer", "auth.json"), "utf8"))
    assert.equal(saved.origins[0]?.origin, `http://127.0.0.1:${port}`, "localhost and 127.0.0.1 must resolve to the one origin crawl will also use")
  } finally {
    await running?.close()
    upstream.closeAllConnections()
    await new Promise((resolve) => upstream.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
