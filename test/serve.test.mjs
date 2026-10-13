import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import zlib from "node:zlib"
import { serve } from "../dist/node/index.js"

// The standalone server against an upstream written by hand, so each behaviour of the proxy is checked on its own:
// no bundler is involved here. The bundler matrix (bundlers.test.mjs) checks the same server against real ones.

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>Upstream</title></head><body><h1>Hello</h1></body></html>'
const BINARY = crypto.randomBytes(70_000)
const temp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "uix-serve-")))

/** An upstream "dev server" whose behaviour covers what real ones do. */
function startUpstream({ tls } = {}) {
  const seen = { explorerHits: 0, upgrades: [] }
  const handler = (req, res) => {
    const url = new URL(req.url, "http://x")
    if (url.pathname.startsWith("/__explorer")) seen.explorerHits++
    switch (url.pathname) {
      case "/":
        res.setHeader("Content-Type", "text/html; charset=utf-8")
        return res.end(PAGE)
      case "/gzip":
        res.setHeader("Content-Type", "text/html; charset=utf-8")
        res.setHeader("Content-Encoding", "gzip")
        return res.end(zlib.gzipSync(PAGE))
      case "/brotli":
        res.setHeader("Content-Type", "text/html; charset=utf-8")
        res.setHeader("Content-Encoding", "br")
        return res.end(zlib.brotliCompressSync(PAGE))
      case "/chunked-html":
        res.setHeader("Content-Type", "text/html")
        res.write(PAGE.slice(0, 40))
        return setTimeout(() => res.end(PAGE.slice(40)), 50)
      case "/latin1":
        res.setHeader("Content-Type", "text/html; charset=iso-8859-1")
        return res.end(Buffer.from("<html><head></head><body>caf\xe9</body></html>", "latin1"))
      case "/fragment":
        res.setHeader("Content-Type", "text/html")
        return res.end("<li>one</li><li>two</li>")
      case "/json":
        res.setHeader("Content-Type", "application/json")
        return res.end('{"ok":true}')
      case "/binary":
        res.setHeader("Content-Type", "application/octet-stream")
        return res.end(BINARY)
      case "/missing":
        res.statusCode = 404
        res.setHeader("Content-Type", "text/html")
        return res.end("<html><body>not here</body></html>")
      case "/redirect":
        res.statusCode = 302
        res.setHeader("Location", `${tls ? "https" : "http"}://${req.headers.host}/landing`)
        return res.end()
      case "/cookie":
        res.setHeader("Set-Cookie", ["sid=1; Path=/; Domain=localhost; Secure; SameSite=None", "theme=dark; Path=/"])
        return res.end("ok")
      case "/echo": {
        const chunks = []
        req.on("data", (chunk) => chunks.push(chunk))
        return req.on("end", () => {
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") }))
        })
      }
      case "/stream":
        res.setHeader("Content-Type", "text/event-stream")
        res.write("data: first\n\n")
        return setTimeout(() => res.end("data: second\n\n"), 600)
      case "/etag":
        res.setHeader("ETag", '"v1"')
        res.setHeader("Content-Type", "text/html")
        return req.headers["if-none-match"] === '"v1"' ? ((res.statusCode = 304), res.end()) : res.end(PAGE)
      default:
        res.statusCode = 404
        return res.end("nope")
    }
  }
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler)
  // A WebSocket-style upgrade: agree, then echo every byte. A path of /refuse is declined with a 400.
  server.on("upgrade", (req, socket) => {
    seen.upgrades.push({ url: req.url, headers: req.headers })
    if (req.url === "/refuse") {
      socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
      return
    }
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Upstream: yes\r\n\r\n")
    socket.on("data", (chunk) => socket.write(chunk))
    socket.on("error", () => {})
  })
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const sockets = new Set()
      server.on("connection", (socket) => (sockets.add(socket), socket.on("close", () => sockets.delete(socket))))
      resolve({
        seen,
        port: server.address().port,
        origin: `${tls ? "https" : "http"}://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => (sockets.forEach((socket) => socket.destroy()), server.close(() => done()))),
      })
    }),
  )
}

/** A request with full control of the headers (fetch refuses to set Host or Origin). */
function request(base, pathAndQuery, { method = "GET", headers = {}, body } = {}) {
  const url = new URL(pathAndQuery, base)
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, (res) => {
      const chunks = []
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on("error", reject)
    req.end(body)
  })
}
const text = (response) => response.body.toString("utf8")

async function withServe(options, run) {
  const upstream = options.upstream ?? (await startUpstream())
  const root = temp()
  fs.mkdirSync(path.join(root, "src"))
  fs.writeFileSync(path.join(root, "src/App.tsx"), "export default () => <h1>Hello</h1>")
  const running = await serve({ target: upstream.origin, port: 0, root, ...options.serve })
  try {
    await run({ proxy: running.url, upstream, root, running })
  } finally {
    await running.close()
    if (!options.upstream) await upstream.close()
  }
}

test("pages get the runtime tag once, plain or compressed, and everything else passes through unchanged", async () => {
  await withServe({}, async ({ proxy }) => {
    for (const route of ["/", "/gzip", "/brotli", "/chunked-html"]) {
      const response = await request(proxy, route, { headers: { accept: "text/html", "accept-encoding": "gzip, br" } })
      assert.equal(response.status, 200, route)
      const html = text(response)
      assert.equal((html.match(/__explorer\/runtime\.js/g) ?? []).length, 1, `${route} is tagged exactly once`)
      assert.ok(html.includes("<h1>Hello</h1>"), `${route} keeps its content`)
      assert.ok(!response.headers["content-encoding"], `${route} is served plain after rewriting`)
      assert.equal(Number(response.headers["content-length"]), response.body.length, `${route} has the right length`)
      // The charset declaration still comes before the tag.
      assert.ok(html.indexOf("<meta") < html.indexOf("<script"), `${route} keeps charset first`)
    }
    // Not a page, so not touched: JSON, binary data of any length, a partial, and a page in another charset.
    assert.equal(text(await request(proxy, "/json")), '{"ok":true}')
    assert.ok((await request(proxy, "/binary")).body.equals(BINARY), "binary bytes are identical")
    assert.equal(text(await request(proxy, "/fragment", { headers: { accept: "text/html" } })), "<li>one</li><li>two</li>")
    const latin = await request(proxy, "/latin1", { headers: { accept: "text/html" } })
    assert.ok(latin.body.equals(Buffer.from("<html><head></head><body>caf\xe9</body></html>", "latin1")), "a non-UTF-8 page is not re-encoded")
    // Error pages are pages too, and keep their status.
    const missing = await request(proxy, "/missing", { headers: { accept: "text/html" } })
    assert.equal(missing.status, 404)
    assert.match(text(missing), /__explorer\/runtime\.js/)
  })
})

test("a cached page is requested again in full, never answered with an empty 304", async () => {
  await withServe({}, async ({ proxy }) => {
    const response = await request(proxy, "/etag", { headers: { accept: "text/html", "if-none-match": '"v1"' } })
    assert.equal(response.status, 200)
    assert.match(text(response), /runtime\.js/)
  })
})

test("the target sees itself as the origin, and redirects and cookies come back through the proxy", async () => {
  await withServe({}, async ({ proxy, upstream }) => {
    const proxyHost = new URL(proxy).host
    const echoed = JSON.parse(
      text(
        await request(proxy, "/echo?a=1", {
          method: "POST",
          headers: { origin: proxy, referer: `${proxy}/page`, "content-type": "application/json", "x-custom": "kept" },
          body: '{"hello":"world"}',
        }),
      ),
    )
    assert.equal(echoed.method, "POST")
    assert.equal(echoed.body, '{"hello":"world"}')
    assert.equal(echoed.headers.host, new URL(upstream.origin).host)
    assert.equal(echoed.headers.origin, upstream.origin)
    assert.equal(echoed.headers.referer, `${upstream.origin}/page`)
    assert.equal(echoed.headers["x-custom"], "kept")
    assert.notEqual(echoed.headers.host, proxyHost)

    const redirect = await request(proxy, "/redirect")
    assert.equal(redirect.status, 302)
    assert.equal(redirect.headers.location, `${proxy}/landing`)

    const cookies = (await request(proxy, "/cookie")).headers["set-cookie"]
    assert.deepEqual(cookies, ["sid=1; Path=/; SameSite=Lax", "theme=dark; Path=/"])
  })
})

test("a streamed response reaches the browser as it is written", async () => {
  await withServe({}, async ({ proxy }) => {
    const started = Date.now()
    const firstChunkAfter = await new Promise((resolve, reject) => {
      http
        .get(`${proxy}/stream`, (res) => {
          res.once("data", () => {
            resolve(Date.now() - started)
            res.destroy()
          })
        })
        .on("error", reject)
    })
    assert.ok(firstChunkAfter < 450, `the first chunk waited ${firstChunkAfter}ms for the whole response`)
  })
})

test("WebSocket upgrades are tunnelled both ways, with the target's own origin and host", async () => {
  await withServe({}, async ({ proxy, upstream }) => {
    const url = new URL(proxy)
    const reply = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: "/socket?token=1",
        headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "abc", Origin: proxy },
      })
      req.on("upgrade", (res, socket) => {
        assert.equal(res.statusCode, 101)
        assert.equal(res.headers["x-upstream"], "yes", "the target's own headers come through")
        socket.write("ping-from-browser")
        socket.once("data", (chunk) => {
          socket.destroy()
          resolve(chunk.toString())
        })
      })
      req.on("error", reject)
      req.end()
    })
    assert.equal(reply, "ping-from-browser")
    const upgrade = upstream.seen.upgrades.at(-1)
    assert.equal(upgrade.url, "/socket?token=1")
    assert.equal(upgrade.headers.origin, upstream.origin)
    assert.equal(upgrade.headers.host, new URL(upstream.origin).host)

    // A refused upgrade is passed on as the target's answer.
    const refused = await request(proxy, "/refuse", { headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "abc" } })
    assert.equal(refused.status, 400)
  })
})

test("the explorer's own route is answered here and never forwarded", async () => {
  await withServe({}, async ({ proxy, upstream }) => {
    const page = await request(proxy, "/__explorer/")
    assert.equal(page.status, 200)
    assert.match(text(page), /<div id="root">/)
    const runtime = text(await request(proxy, "/__explorer/runtime.js"))
    // The route constants ride at the top of the script, so the page needs no inline script.
    assert.match(runtime, /^window\.__UIX_ROUTE="\/__explorer\/";/)
    assert.doesNotMatch(runtime.split("\n")[0], /__UIX_STATIC/)
    const state = JSON.parse(text(await request(proxy, "/__explorer/api/state")))
    assert.deepEqual(state.scenarios, [])
    assert.ok(state.sources.some((source) => source.endsWith("src/App.tsx")))
    assert.equal(upstream.seen.explorerHits, 0)
    // Tagged pages carry a plain src tag only.
    const html = text(await request(proxy, "/", { headers: { accept: "text/html" } }))
    assert.match(html, /<script src="\/__explorer\/runtime\.js"><\/script>/)
    assert.doesNotMatch(html, /window\.__UIX/)
  })
})

test("a dev server that is down gets a clear page, and the proxy recovers when it returns", async () => {
  const upstream = await startUpstream()
  const port = upstream.port
  await withServe({ upstream: { ...upstream, origin: upstream.origin } }, async ({ proxy }) => {
    await upstream.close()
    const asPage = await request(proxy, "/", { headers: { accept: "text/html" } })
    assert.equal(asPage.status, 502)
    assert.match(asPage.headers["content-type"], /text\/html/)
    assert.match(text(asPage), /Can't reach http:\/\/127\.0\.0\.1:\d+/)
    const asData = await request(proxy, "/json", { headers: { accept: "application/json" } })
    assert.equal(asData.status, 502)
    assert.match(text(asData), /Cannot reach/)
    // Back up on the same port: the next request works without restarting the proxy.
    const again = http.createServer((req, res) => res.end("back"))
    await new Promise((resolve) => again.listen(port, "127.0.0.1", resolve))
    try {
      assert.equal(text(await request(proxy, "/anything")), "back")
    } finally {
      again.closeAllConnections()
      await new Promise((resolve) => again.close(resolve))
    }
  })
})

test("a foreign Host header and a cross-site write are refused", async () => {
  await withServe({}, async ({ proxy }) => {
    // DNS rebinding: a page on another domain resolving to this machine sends its own name as the Host.
    const rebinding = await request(proxy, "/__explorer/api/state", { headers: { host: "evil.example" } })
    assert.equal(rebinding.status, 403)
    assert.equal((await request(proxy, "/", { headers: { host: "evil.example" } })).status, 403)
    const url = new URL(proxy)
    assert.equal((await request(proxy, "/__explorer/api/state", { headers: { host: `localhost:${url.port}` } })).status, 200)

    // A write started by another site is refused; the explorer's own page may write.
    const foreign = await request(proxy, "/__explorer/api/crawl", { method: "DELETE", headers: { origin: "http://evil.example" } })
    assert.equal(foreign.status, 403)
    const marked = await request(proxy, "/__explorer/api/crawl", { method: "DELETE", headers: { "sec-fetch-site": "cross-site" } })
    assert.equal(marked.status, 403)
    const own = await request(proxy, "/__explorer/api/crawl", { method: "DELETE", headers: { origin: proxy } })
    assert.equal(own.status, 200)
  })
})

test("extra host names can be allowed, and a server open to the network accepts any", async () => {
  await withServe({ serve: { allowedHosts: ["design.test"] } }, async ({ proxy }) => {
    assert.equal((await request(proxy, "/json", { headers: { host: "design.test" } })).status, 200)
    assert.equal((await request(proxy, "/json", { headers: { host: "other.test" } })).status, 403)
  })
  await withServe({ serve: { host: "0.0.0.0" } }, async ({ running }) => {
    assert.equal((await request(`http://127.0.0.1:${running.port}`, "/json", { headers: { host: "anything.test" } })).status, 200)
  })
})

test("editing a source file changes the revision the explorer reports", async () => {
  await withServe({}, async ({ proxy, root }) => {
    const revision = async () => JSON.parse(text(await request(proxy, "/__explorer/api/state"))).revision
    const before = await revision()
    fs.writeFileSync(path.join(root, "src/App.tsx"), "export default () => <h1>Changed</h1>")
    for (let i = 0; i < 40 && (await revision()) === before; i++) await new Promise((resolve) => setTimeout(resolve, 100))
    assert.notEqual(await revision(), before)
    // A new file is listed, a stylesheet counts, and a test file does not.
    const sources = async () => JSON.parse(text(await request(proxy, "/__explorer/api/state"))).sources
    fs.writeFileSync(path.join(root, "src/Extra.tsx"), "export default () => <p>Extra</p>")
    for (let i = 0; i < 40 && !(await sources()).some((file) => file.endsWith("Extra.tsx")); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok((await sources()).some((file) => file.endsWith("src/Extra.tsx")))
  })
})

test("a port that is taken is reported in plain words", async () => {
  const taken = net.createServer().listen(0, "127.0.0.1")
  await new Promise((resolve) => taken.once("listening", resolve))
  try {
    await assert.rejects(serve({ target: "http://127.0.0.1:1", port: taken.address().port, root: temp() }), /already in use/)
  } finally {
    taken.close()
  }
})

test("starting before the dev server is up waits for it when asked", async () => {
  const free = net.createServer().listen(0, "127.0.0.1")
  await new Promise((resolve) => free.once("listening", resolve))
  const port = free.address().port
  await new Promise((resolve) => free.close(resolve))
  const lines = []
  const late = http.createServer((req, res) => res.end("up"))
  setTimeout(() => late.listen(port, "127.0.0.1"), 900)
  const started = Date.now()
  const running = await serve({ target: `http://127.0.0.1:${port}`, port: 0, root: temp(), wait: 10, log: (line) => lines.push(line) })
  try {
    assert.ok(Date.now() - started >= 800, "it waited")
    assert.ok(lines.some((line) => /Waiting for/.test(line)))
    assert.ok(!lines.some((line) => /Warning/.test(line)))
    assert.equal(text(await request(running.url, "/")), "up")
  } finally {
    await running.close()
    late.closeAllConnections()
    late.close()
  }
  // Without waiting it starts anyway and says so.
  const lines2 = []
  const unreachable = await serve({ target: "http://127.0.0.1:1", port: 0, root: temp(), log: (line) => lines2.push(line) })
  try {
    assert.ok(lines2.some((line) => /not answering yet/.test(line)))
  } finally {
    await unreachable.close()
  }
})

test("an https dev server with a self-signed certificate works with --insecure and is refused without it", async (t) => {
  const dir = temp()
  const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "key.pem", "-out", "cert.pem", "-days", "2", "-subj", "/CN=localhost"], { cwd: dir, stdio: "ignore", env: { ...process.env, MSYS_NO_PATHCONV: "1" } })
  if (made.status !== 0) return t.skip("openssl is not available")
  const tls = { key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) }
  const upstream = await startUpstream({ tls })
  try {
    await withServe({ upstream, serve: { insecure: true } }, async ({ proxy }) => {
      const page = await request(proxy, "/", { headers: { accept: "text/html" } })
      assert.equal(page.status, 200)
      assert.match(text(page), /runtime\.js/)
      // The redirect points at the https target and comes back as the plain-http proxy address.
      assert.equal((await request(proxy, "/redirect")).headers.location, `${proxy}/landing`)
    })
    await withServe({ upstream }, async ({ proxy }) => {
      assert.equal((await request(proxy, "/", { headers: { accept: "text/html" } })).status, 502)
    })
  } finally {
    await upstream.close()
  }
})
