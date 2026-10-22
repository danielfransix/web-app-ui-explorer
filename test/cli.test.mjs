import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { serve } from "../dist/node/index.js"
import { copyFixture, temp } from "./contract.mjs"

// The command line as a person uses it: init, serve (from flags and from the config file), snapshot, crawl, capture.
const here = path.dirname(fileURLToPath(import.meta.url))
const cli = path.join(here, "../dist/node/cli.js")
const fixture = path.join(here, "fixtures/bundled-app")

const run = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", ...options })

// A command that talks to a server living in this same process must not block the event loop that serves it.
const runAsync = (args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], options)
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("close", (status) => resolve({ status, stdout, stderr }))
  })

function devServer(root) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x")
    const file = path.join(root, url.pathname === "/" ? "index.html" : url.pathname)
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end("nope")
    res.setHeader("Content-Type", file.endsWith(".html") ? "text/html" : "text/javascript")
    res.end(fs.readFileSync(file))
  })
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: server.address().port, close: () => (server.closeAllConnections(), server.close()) }),
    ),
  )
}

/** Starts `serve` as a child process and resolves with its address once it says it is running. */
function startServe(args, options = {}) {
  const child = spawn(process.execPath, [cli, "serve", ...args], { ...options, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not start:\n${output}`)), 20_000)
    const onData = (chunk) => {
      output += chunk
      const match = /Your app:\s+(http:\/\/\S+?)\/\n/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolve({ url: match[1], output: () => output, stop: () => new Promise((done) => (child.once("exit", done), child.kill())) })
      }
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    child.once("exit", (code) => reject(new Error(`serve exited early (${code}):\n${output}`)))
  })
}

test("help lists every command, and mistakes exit with a message instead of a stack trace", () => {
  const help = run(["help"])
  assert.equal(help.status, 0)
  for (const command of ["init", "agents", "serve", "snapshot", "crawl", "capture"]) assert.match(help.stdout, new RegExp(`web-app-ui-explorer ${command}`))
  assert.match(help.stdout, /any bundler/i)

  const unknown = run(["frobnicate"])
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /Unknown command: frobnicate/)

  const noUrl = run(["serve"], { cwd: temp() })
  assert.equal(noUrl.status, 2)
  assert.match(noUrl.stderr, /Missing --url/)

  const noDir = run(["snapshot"], { cwd: temp() })
  assert.equal(noDir.status, 2)
  assert.match(noDir.stderr, /Missing --dir/)

  const missingBuild = run(["snapshot", "--dir", "build"], { cwd: temp() })
  assert.equal(missingBuild.status, 1)
  assert.match(missingBuild.stderr, /Build folder not found/)
  assert.doesNotMatch(missingBuild.stderr, /\n\s+at /)

  const badBase = run(["snapshot", "--dir", ".", "--base", "app"], { cwd: temp() })
  assert.equal(badBase.status, 1)
  assert.match(badBase.stderr, /--base must start with a slash/)
})

test("agents installs portable guidance, preserves project instructions and updates only its owned section", () => {
  const root = temp()
  const file = path.join(root, "AGENTS.md")
  const original = "# Project rules\r\n\r\nKeep our existing instructions.\r\n"
  fs.writeFileSync(file, original)
  const first = run(["agents", "--root", root])
  assert.equal(first.status, 0, first.stderr)
  const installed = fs.readFileSync(file, "utf8")
  assert.ok(installed.startsWith(original))
  // The installed section is a short pointer to the guide, not the guide copied in full.
  assert.match(installed, /https:\/\/github\.com\/danielfransix\/web-app-ui-explorer\/blob\/main\/docs\/agent-orchestration\.md/, "the installed rules point to the packaged guide")
  assert.doesNotMatch(installed, /explorer_inspect_screen/, "the guide is linked, not copied in full")
  assert.deepEqual(fs.readdirSync(root), ["AGENTS.md"], "guidance installation does not alter app setup")
  assert.equal(run(["agents", "--root", root]).status, 0)
  assert.equal(fs.readFileSync(file, "utf8"), installed, "repeated setup is idempotent")

  const start = "<!-- ui-explorer:orchestration:start -->"
  const end = "<!-- ui-explorer:orchestration:end -->"
  const suffix = "\r\n## More project rules\r\nPreserve these too.\r\n"
  fs.writeFileSync(file, original + start + "\nOld guidance\n" + end + suffix)
  assert.equal(run(["agents", "--root", root]).status, 0)
  const updated = fs.readFileSync(file, "utf8")
  assert.ok(updated.startsWith(original)); assert.ok(updated.endsWith(suffix))
  assert.match(updated, /https:\/\/github\.com\/danielfransix\/web-app-ui-explorer\/blob\/main\/docs\/agent-orchestration\.md/)
  assert.ok(!updated.includes("Old guidance"))

  for (const malformed of [start, end, end + start, start + end + start + end]) {
    fs.writeFileSync(file, original + malformed)
    const result = run(["agents", "--root", root])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /file was left unchanged/)
    assert.equal(fs.readFileSync(file, "utf8"), original + malformed)
  }
  const empty = temp()
  assert.equal(run(["agents", "--root", empty]).status, 0)
  assert.match(fs.readFileSync(path.join(empty, "AGENTS.md"), "utf8"), /https:\/\/github\.com\/danielfransix\/web-app-ui-explorer\/blob\/main\/docs\/agent-orchestration\.md/)
})

test("init in a Create React App project, then serve from the config it wrote", { timeout: 60_000 }, async () => {
  const root = copyFixture(fixture)
  const dev = await devServer(root)
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "cra-like", scripts: {}, dependencies: { "react-scripts": "5.0.1" } }))
    const init = run(["init"], { cwd: root })
    assert.equal(init.status, 0, init.stderr)
    assert.match(init.stdout, /Create React App/)
    assert.match(init.stdout, /npm run explorer/)
    // The person points the config at their dev server, exactly as the message says.
    const config = fs.readFileSync(path.join(root, "ui-explorer.config.mjs"), "utf8").replace("http://localhost:3000", `http://127.0.0.1:${dev.port}`)
    fs.writeFileSync(path.join(root, "ui-explorer.config.mjs"), config)

    const serve = await startServe(["--port", "0"], { cwd: root })
    try {
      assert.match(serve.output(), /Using ui-explorer\.config\.mjs/)
      const page = await (await fetch(`${serve.url}/`, { headers: { accept: "text/html" } })).text()
      assert.match(page, /__explorer\/runtime\.js/)
      assert.equal((await fetch(`${serve.url}/__explorer/api/state`)).status, 200)
    } finally {
      await serve.stop()
    }
  } finally {
    dev.close()
  }
})

test("serve takes a bare port, flags beat the config file, and --deny and --src reach the explorer", { timeout: 60_000 }, async () => {
  const root = copyFixture(fixture)
  fs.mkdirSync(path.join(root, "other"))
  fs.writeFileSync(path.join(root, "other/Page.tsx"), "export default () => <h1>Other</h1>")
  const dev = await devServer(root)
  fs.writeFileSync(path.join(root, "ui-explorer.config.json"), JSON.stringify({ serve: { url: "http://localhost:1" }, sources: ["src"] }))
  try {
    const serve = await startServe(["--url", String(dev.port), "--port", "0", "--src", "other", "--deny", "delete"], { cwd: root })
    try {
      const state = await (await fetch(`${serve.url}/__explorer/api/state`)).json()
      assert.ok(state.sources.some((file) => file.endsWith("other/Page.tsx")), "the --src folder replaces the config's")
      assert.ok(!state.sources.some((file) => file.endsWith("src/main.js")))
      assert.match(await (await fetch(`${serve.url}/`, { headers: { accept: "text/html" } })).text(), /Bundled demo app/)
    } finally {
      await serve.stop()
    }
  } finally {
    dev.close()
  }
})

test("crawl and capture from the command line, then snapshot the result", { timeout: 300_000 }, async () => {
  const root = copyFixture(fixture)
  const dev = await devServer(root)
  try {
    const url = `http://127.0.0.1:${dev.port}`
    const crawl = await runAsync(["crawl", "--url", url, "--root", root, "--out", path.join(root, ".ui-explorer/scenarios.json"), "--max-states", "30", "--concurrency", "2"], { cwd: root })
    assert.equal(crawl.status, 0, crawl.stdout + crawl.stderr)
    assert.match(crawl.stdout, /Found \d+ states/)
    const scenarios = JSON.parse(fs.readFileSync(path.join(root, ".ui-explorer/scenarios.json"), "utf8"))
    for (const wanted of ["Welcome", "Settings", "Reports", "Help centre"]) assert.ok(scenarios.scenarios.some((scenario) => scenario.title === wanted), wanted)
    // The sources were traced from the project root given on the command line.
    assert.ok(scenarios.scenarios.some((scenario) => scenario.source?.startsWith("src/")))

    // Thumbnails are taken from the pages the explorer serves, so capture points at the explorer, not the bare dev server.
    const explorer = await serve({ target: url, root, port: 0 })
    const capture = await runAsync(["capture", "--url", explorer.url, "--root", root, "--dir", path.join(root, ".ui-explorer")], { cwd: root })
    assert.equal(capture.status, 0, capture.stdout + capture.stderr)
    await explorer.close()
    assert.match(capture.stdout, /Captured \d+ thumbnails, 0 failed/)

    const build = path.join(root, "build")
    fs.mkdirSync(build)
    fs.copyFileSync(path.join(root, "index.html"), path.join(build, "index.html"))
    fs.mkdirSync(path.join(build, "nested"))
    fs.writeFileSync(path.join(build, "nested/page.html"), "<!doctype html><html><head><title>n</title></head><body>n</body></html>")
    fs.writeFileSync(path.join(build, "fragment.html"), "<li>partial</li>")
    const snap = run(["snapshot", "--dir", "build"], { cwd: root })
    assert.equal(snap.status, 0, snap.stderr)
    assert.match(snap.stdout, /tagged 2 HTML file/)
    assert.match(fs.readFileSync(path.join(build, "index.html"), "utf8"), /<script src="\/__explorer\/runtime\.js">/)
    assert.match(fs.readFileSync(path.join(build, "nested/page.html"), "utf8"), /runtime\.js/)
    assert.equal(fs.readFileSync(path.join(build, "fragment.html"), "utf8"), "<li>partial</li>", "a partial is left alone")
    assert.ok(fs.existsSync(path.join(build, "__explorer/index.html")))
    assert.ok(fs.readdirSync(path.join(build, "__explorer/thumbnails")).some((name) => name.endsWith(".jpg")), "thumbnails travel with the snapshot")
    // Taking a second snapshot is safe: nothing is tagged twice, and the old copy is replaced.
    const again = run(["snapshot", "--dir", "build"], { cwd: root })
    assert.equal(again.status, 0)
    assert.equal((fs.readFileSync(path.join(build, "index.html"), "utf8").match(/runtime\.js/g) ?? []).length, 1)
    // An explicit list of files limits what is tagged.
    fs.writeFileSync(path.join(build, "nested/page.html"), "<!doctype html><html><head></head></html>")
    const only = run(["snapshot", "--dir", "build", "--html", "nested/page.html"], { cwd: root })
    assert.equal(only.status, 0)
    assert.match(fs.readFileSync(path.join(build, "nested/page.html"), "utf8"), /runtime\.js/)
  } finally {
    dev.close()
  }
})
