import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"
import { build as viteBuild, createServer as createViteServer } from "vite"
import { copyFixture, runContract, serveFolder, temp } from "./contract.mjs"

// The explorer's standalone server against real dev servers, with no explorer plugin or setting in any of them.
// Bundlers that need a download to run (webpack, Create React App, Parcel, Rsbuild, Next.js) are in the on-demand
// matrix (npm run test:matrix); these three run from this repository's own dependencies.
const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, "fixtures/bundled-app")

test("Vite, with no explorer plugin: pages, hot reload socket, crawl, capture, replay, source edits and a production snapshot", { timeout: 600_000 }, async () => {
  const root = copyFixture(fixture)
  const server = await createViteServer({ root, configFile: false, logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false }, clearScreen: false })
  await server.listen()
  try {
    const result = await runContract({
      name: "Vite",
      target: `http://127.0.0.1:${server.httpServer.address().port}`,
      root,
      edit: "src/main.js",
      live: "websocket",
      build: async () => {
        await viteBuild({ root, configFile: false, logLevel: "error", build: { outDir: "dist", emptyOutDir: true } })
        return path.join(root, "dist")
      },
    })
    console.log(`Vite: ${result.states} states, ${result.thumbnails} thumbnails`)
  } finally {
    await server.close()
  }
})

test("esbuild's own dev server, which cannot be extended: everything works through the proxy", { timeout: 600_000 }, async () => {
  const root = copyFixture(fixture)
  const www = path.join(root, "www")
  fs.mkdirSync(www)
  fs.writeFileSync(path.join(www, "index.html"), fs.readFileSync(path.join(root, "index.html"), "utf8").replace("/src/main.js", "/assets/main.js"))
  const context = await esbuild.context({ entryPoints: [path.join(root, "src/main.js")], bundle: true, outdir: path.join(www, "assets"), format: "esm", logLevel: "silent" })
  await context.watch()
  const { port } = await context.serve({ servedir: www, host: "127.0.0.1", port: 0 })
  try {
    const result = await runContract({
      name: "esbuild",
      target: `http://127.0.0.1:${port}`,
      root,
      edit: "src/main.js",
      live: "sse",
      build: async () => {
        const out = path.join(root, "out")
        await esbuild.build({ entryPoints: [path.join(root, "src/main.js")], bundle: true, minify: true, outdir: path.join(out, "assets"), format: "esm", logLevel: "silent" })
        fs.copyFileSync(path.join(www, "index.html"), path.join(out, "index.html"))
        return out
      },
    })
    console.log(`esbuild: ${result.states} states, ${result.thumbnails} thumbnails`)
  } finally {
    await context.dispose()
  }
})

test("a hand-written Node server with no build step at all", { timeout: 600_000 }, async () => {
  // The least a dev server can be: it serves files from disk. No bundler, no HMR.
  const root = copyFixture(fixture)
  const dev = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x")
    const file = path.join(root, url.pathname === "/" ? "index.html" : url.pathname)
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end("nope")
    res.setHeader("Content-Type", file.endsWith(".html") ? "text/html" : "text/javascript")
    res.end(fs.readFileSync(file))
  })
  await new Promise((resolve) => dev.listen(0, "127.0.0.1", resolve))
  try {
    const result = await runContract({ name: "plain Node", target: `http://127.0.0.1:${dev.address().port}`, root, edit: "src/main.js", live: "none", build: async () => root })
    console.log(`plain Node: ${result.states} states, ${result.thumbnails} thumbnails`)
  } finally {
    dev.closeAllConnections()
    dev.close()
  }
})

test("a snapshot keeps working when the app is hosted under a path prefix", { timeout: 120_000 }, async () => {
  // A host serving the app at /design-app/ : the explorer, its data and the runtime must all be found there.
  const { snapshot } = await import("../dist/node/index.js")
  const root = copyFixture(fixture)
  const out = temp("uix-prefix-")
  const prefix = "design-app"
  fs.mkdirSync(path.join(out, prefix, "assets"), { recursive: true })
  fs.copyFileSync(path.join(root, "index.html"), path.join(out, prefix, "index.html"))
  await esbuild.build({ entryPoints: [path.join(root, "src/main.js")], bundle: true, outdir: path.join(out, prefix, "assets"), format: "esm", logLevel: "silent" })
  fs.writeFileSync(path.join(out, prefix, "index.html"), fs.readFileSync(path.join(out, prefix, "index.html"), "utf8").replace("/src/main.js", `/${prefix}/assets/main.js`))
  fs.mkdirSync(path.join(root, ".ui-explorer"), { recursive: true })
  const scenario = { id: "settings", title: "Settings", group: "Settings", actions: [{ kind: "click", selector: "button", text: "Settings" }], startPath: `/${prefix}/` }
  fs.writeFileSync(path.join(root, ".ui-explorer/scenarios.json"), JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), baseUrl: "x", startPath: `/${prefix}/`, scenarios: [scenario] }))
  const result = snapshot({ dir: path.join(out, prefix), root, base: `/${prefix}`, startPath: `/${prefix}/` })
  const html = fs.readFileSync(path.join(out, prefix, "index.html"), "utf8")
  if (!html.includes(`src="/${prefix}/__explorer/runtime.js"`)) throw new Error(`the runtime tag does not carry the prefix: ${html.slice(0, 300)}`)
  const stateFile = JSON.parse(fs.readFileSync(path.join(out, prefix, "__explorer/api/state.json"), "utf8"))
  if (stateFile.route !== `/${prefix}/__explorer`) throw new Error(`route is ${stateFile.route}`)
  if (!result.tagged.includes("index.html")) throw new Error("index.html was not tagged")
  const staticServer = await serveFolder(out)
  const { chromium } = await import("playwright")
  const browser = await chromium.launch({ args: ["--no-sandbox"] })
  try {
    const page = await browser.newPage()
    await page.goto(`${staticServer.url}/${prefix}/__explorer/`)
    // The scenario's own folder is listed, so the data was found under the prefix.
    await page.waitForFunction(() => /Other\n1\nSettings\n1/.test(document.body.innerText), undefined, { timeout: 30_000 })
    const replay = await browser.newPage()
    await replay.goto(`${staticServer.url}/${prefix}/?__uix=settings&__uix_embed=1`)
    await replay.waitForFunction(() => document.documentElement.hasAttribute("data-uix-status"), undefined, { timeout: 30_000 })
    const status = await replay.evaluate(() => document.documentElement.getAttribute("data-uix-status"))
    if (status !== "ready") throw new Error(`replay status: ${status}`)
  } finally {
    await browser.close()
    await staticServer.close()
  }
})
