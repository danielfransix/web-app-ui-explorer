import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createServer } from "vite"
import uiExplorer from "../dist/node/vite.js"

test("POST /api/design captures a scenario at the requested widths and returns a plan with named breakpoints", { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uix-design-api-"))
  fs.writeFileSync(
    path.join(root, "index.html"),
    `<!doctype html><html><body><h1>Hello Design</h1></body></html>`,
  )
  const scenario = { id: "screen-0", title: "Screen 0", group: "Screens", source: "src/Home.tsx", actions: [] }
  const server = await createServer({
    root, configFile: false, logLevel: "error", server: { host: "127.0.0.1", port: 0 },
    plugins: [uiExplorer({ mode: "manual", autoCapture: false, scenarios: [scenario] })],
  })
  try {
    await server.listen()
    const base = `http://127.0.0.1:${server.httpServer.address().port}`

    const missing = await fetch(`${base}/__explorer/api/design`, { method: "POST", body: JSON.stringify({ id: "nope", widths: [1440] }) })
    assert.equal(missing.status, 404)

    const noWidths = await fetch(`${base}/__explorer/api/design`, { method: "POST", body: JSON.stringify({ id: "screen-0", widths: [] }) })
    assert.equal(noWidths.status, 400)

    const response = await fetch(`${base}/__explorer/api/design`, {
      method: "POST",
      body: JSON.stringify({ id: "screen-0", widths: [1440, 768] }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.version, 1)
    assert.equal(body.plan.frames.length, 2)
    assert.deepEqual(body.plan.frames.map((frame) => frame.width).sort((a, b) => a - b), [768, 1440])
    const heading = JSON.stringify(body.plan.frames[0].node)
    assert.match(heading, /Hello Design/)
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
