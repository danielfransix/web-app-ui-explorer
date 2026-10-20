import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fetchTitle, findAlternateCandidate, identifyPortOwner, isInteractive, suggestDevScripts, waitForReachable } from "../dist/node/index.js"

// Evidence-gathering for an unreachable serve target: what a person would need to judge whether something found
// nearby is actually their project, and what's offered when nothing is running at all. Every lookup here degrades
// to "no evidence" instead of throwing, so these tests mainly check that degradation holds, not that every OS
// branch succeeds (CI only runs on one platform at a time).

const temp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "uix-discovery-")))

function startServer(handler) {
  const server = http.createServer(handler)
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })))
}

test("fetchTitle reads a page's <title>, and gives up cleanly on anything else", async () => {
  const { server, port } = await startServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8")
    res.end('<!doctype html><html><head><title>  My App  </title></head><body></body></html>')
  })
  try {
    assert.equal(await fetchTitle(`http://127.0.0.1:${port}`), "My App")
  } finally {
    server.close()
  }

  // Nothing listening at all.
  assert.equal(await fetchTitle("http://127.0.0.1:1"), undefined)
})

test("fetchTitle returns undefined for a page without a title, not an error", async () => {
  const { server, port } = await startServer((req, res) => res.end("<html><body>no title here</body></html>"))
  try {
    assert.equal(await fetchTitle(`http://127.0.0.1:${port}`), undefined)
  } finally {
    server.close()
  }
})

test("waitForReachable resolves true as soon as something starts listening, false if it never does", async () => {
  assert.equal(await waitForReachable("127.0.0.1", 1, 0), false)

  const { server, port } = await startServer((req, res) => res.end("ok"))
  try {
    assert.equal(await waitForReachable("127.0.0.1", port, 1), true)
  } finally {
    server.close()
  }
})

test("findAlternateCandidate only looks at the detected bundler's own port, never a sweep of common ones", async () => {
  const root = temp()
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ devDependencies: { "react-scripts": "5.0.0" } }))

  // Nothing running anywhere: no candidate.
  assert.equal(await findAlternateCandidate(root, 3001), undefined)

  // Something running on a port other than the bundler's known default (3000 for CRA): still no candidate, because
  // the probe is intentionally narrow rather than a sweep that could match an unrelated project's server.
  const { server: unrelated, port: unrelatedPort } = await startServer((req, res) => res.end("unrelated"))
  try {
    assert.notEqual(unrelatedPort, 3000)
    assert.equal(await findAlternateCandidate(root, 3001), undefined)
  } finally {
    unrelated.close()
  }
})

test("findAlternateCandidate returns undefined when the bundler's default port is the configured one (nothing \"alternate\" about it)", async () => {
  const root = temp()
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ devDependencies: { "react-scripts": "5.0.0" } }))
  assert.equal(await findAlternateCandidate(root, 3000), undefined)
})

test("identifyPortOwner degrades to undefined instead of throwing when nothing is listening", async () => {
  assert.equal(await identifyPortOwner(1), undefined)
})

test("suggestDevScripts lists only recognised script names that are actually present, never a guess", () => {
  const root = temp()
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { start: "react-scripts start", build: "react-scripts build", "start:dev": "cross-env PORT=3001 react-scripts start" } }))
  const scripts = suggestDevScripts(root)
  assert.deepEqual(scripts.map((s) => s.name).sort(), ["start", "start:dev"])
  for (const script of scripts) assert.match(script.command, /^npm run /)
})

test("suggestDevScripts picks the right run prefix for pnpm and yarn projects", () => {
  const pnpmRoot = temp()
  fs.writeFileSync(path.join(pnpmRoot, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }))
  fs.writeFileSync(path.join(pnpmRoot, "pnpm-lock.yaml"), "")
  assert.equal(suggestDevScripts(pnpmRoot)[0].command, "pnpm run dev")

  const yarnRoot = temp()
  fs.writeFileSync(path.join(yarnRoot, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }))
  fs.writeFileSync(path.join(yarnRoot, "yarn.lock"), "")
  assert.equal(suggestDevScripts(yarnRoot)[0].command, "yarn run dev")
})

test("suggestDevScripts returns nothing for a project with no recognisable dev script, or no package.json at all", () => {
  const root = temp()
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { build: "tsc", test: "node --test" } }))
  assert.deepEqual(suggestDevScripts(root), [])
  assert.deepEqual(suggestDevScripts(temp()), [])
})

test("isInteractive is false under the test runner (no real terminal on both ends)", () => {
  assert.equal(isInteractive(), false)
})
