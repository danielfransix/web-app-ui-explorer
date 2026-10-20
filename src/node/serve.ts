import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import path from "node:path"
import type { Duplex } from "node:stream"
import zlib from "node:zlib"
import { createExplorer, type Explorer } from "./core/explorer"
import { findAlternateCandidate, suggestDevScripts, waitForReachable } from "./dev-target-discovery"
import { charsetOf, injectIntoHtml, rewriteCookie, rewriteLocation } from "./html"
import { chooseOne, confirm, isInteractive } from "./interactive-prompt"
import type { UiExplorerOptions } from "./options"
import { spawnDevServer, type SpawnedDevServer } from "./spawn-dev-server"
import { watchSources } from "./watch"

// `serve` puts the explorer in front of any dev server. The browser talks to this server; it answers the explorer's
// own route, adds the runtime to HTML pages and forwards everything else (WebSockets included) to the target.
// Nothing here knows which bundler the target is, so any tool that serves HTTP works.

export type ServeOptions = UiExplorerOptions & {
  /** Address of the dev server to put the explorer in front of, for example http://localhost:3000. */
  target: string
  /** Port to listen on. 0 picks a free one. Default 5199. */
  port?: number
  /** Interface to listen on. Default 127.0.0.1. */
  host?: string
  /** Project root. Default: the current folder. */
  root?: string
  /** Seconds to wait for the target to start answering before listening. Default 0. */
  wait?: number
  /**
   * When the target still isn't reachable after waiting, and this is running in a real terminal: offer to use a
   * detected alternative or spawn the dev server, showing exactly what was found or what will run before asking.
   * Ignored outside a TTY (CI, scripts, a non-interactive agent invocation) — those always fall back to the
   * existing "can't reach" behavior. Default false, so programmatic callers of `serve()` see no change.
   */
  interactiveDiscovery?: boolean
  /** Accept a self-signed certificate from an https target. */
  insecure?: boolean
  /** Extra Host header values to accept, for reaching the proxy by name. */
  allowedHosts?: string[]
  log?: (line: string) => void
}

export type RunningServe = {
  url: string
  port: number
  host: string
  explorer: Explorer
  close(): Promise<void>
}

/** Accepts `3000`, `localhost:3000` and full addresses. */
export function normaliseTarget(value: string): string {
  if (/^\d+$/.test(value)) return `http://localhost:${value}`
  if (!/^[a-z]+:\/\//i.test(value)) return `http://${value}`
  return value
}

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade"]
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return ""
  if (hostHeader.startsWith("[")) return hostHeader.slice(0, hostHeader.indexOf("]") + 1).toLowerCase()
  return hostHeader.split(":")[0].toLowerCase()
}

function tryConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    socket.setTimeout(1500)
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    const fail = () => {
      socket.destroy()
      resolve(false)
    }
    socket.once("error", fail)
    socket.once("timeout", fail)
  })
}

const badGateway = (target: string, message: string, html: boolean) =>
  html
    ? `<!doctype html><meta charset="utf-8"><title>Waiting for your app</title><body style="font-family:system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 24px;line-height:1.5"><h1 style="font-size:20px">Can't reach ${target.replace(/</g, "&lt;")}</h1><p>The explorer is running, but your dev server is not answering. Start it, then reload this page.</p><p style="color:#666">${message.replace(/</g, "&lt;")}</p></body>`
    : `Cannot reach ${target}: ${message}`

/** Describes what's at the unreachable target, if anything was found, and whether the person acted on it. */
async function recoverUnreachableTarget(args: {
  root: string
  configuredOrigin: string
  log: (line: string) => void
}): Promise<{ url: string } | { server: SpawnedDevServer; command: string } | undefined> {
  const { root, configuredOrigin, log } = args
  const configuredPort = Number(new URL(configuredOrigin).port) || 80

  const alternate = await findAlternateCandidate(root, configuredPort)
  if (alternate) {
    const owner = alternate.cwd ? ` running from ${alternate.cwd}` : alternate.commandLine ? ` (${alternate.commandLine})` : ""
    const titled = alternate.title ? `, titled "${alternate.title}"` : ""
    const useIt = await confirm(`Nothing is answering at ${configuredOrigin}. Something is answering at ${alternate.url}${titled}${owner}. Use it for this session?`)
    if (useIt) return { url: alternate.url }
  }

  const scripts = suggestDevScripts(root)
  if (scripts.length === 1) {
    const [choice] = scripts
    const run = await confirm(`No dev server detected at ${configuredOrigin}. Run "${choice.command}" now?`)
    if (run) return { server: spawnDevServer(choice.command, root, log), command: choice.command }
  } else if (scripts.length > 1) {
    const index = await chooseOne(`No dev server detected at ${configuredOrigin}. Run one of these now?`, scripts.map((s) => s.command))
    if (index !== undefined) {
      const choice = scripts[index]
      return { server: spawnDevServer(choice.command, root, log), command: choice.command }
    }
  }
  return undefined
}

export async function serve(config: ServeOptions): Promise<RunningServe> {
  const log = config.log ?? (() => {})
  // The long form of the path: on Windows a short 8.3 name makes Node's recursive file watcher abort the process.
  const root = fs.realpathSync.native(path.resolve(config.root ?? "."))

  // Resolve the effective target before anything downstream treats it as fixed: a discovered alternative or a
  // freshly spawned dev server both need to be known before the proxy's address, agent and headers are derived.
  let targetAddress = normaliseTarget(config.target)
  let spawnedDevServer: SpawnedDevServer | undefined
  {
    const probe = new URL(targetAddress)
    const probePort = Number(probe.port) || (probe.protocol === "https:" ? 443 : 80)
    const deadline = Date.now() + (config.wait ?? 0) * 1000
    let reachable = await tryConnect(probe.hostname, probePort)
    while (!reachable && Date.now() < deadline) {
      log(`Waiting for ${probe.origin} ...`)
      await new Promise((resolve) => setTimeout(resolve, 500))
      reachable = await tryConnect(probe.hostname, probePort)
    }
    if (!reachable && config.interactiveDiscovery && isInteractive()) {
      const recovered = await recoverUnreachableTarget({ root, configuredOrigin: probe.origin, log })
      if (recovered && "url" in recovered) {
        targetAddress = recovered.url
        reachable = true
      } else if (recovered) {
        spawnedDevServer = recovered.server
        log(`Waiting for ${probe.origin} ...`)
        reachable = await waitForReachable(probe.hostname, probePort, 30)
        if (!reachable) log(`Warning: started "${recovered.command}", but ${probe.origin} is still not answering.`)
      }
    }
    if (!reachable) log(`Warning: ${probe.origin} is not answering yet. The proxy shows a notice until it does.`)
  }

  const target = new URL(targetAddress)
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error(`The target must be an http or https address, got "${config.target}".`)
  const targetOrigin = target.origin
  const targetPort = Number(target.port) || (target.protocol === "https:" ? 443 : 80)
  const targetHostname = target.hostname.replace(/^\[|\]$/g, "")
  const transport = target.protocol === "https:" ? https : http
  const agent = new (target.protocol === "https:" ? https.Agent : http.Agent)({
    keepAlive: true,
    ...(target.protocol === "https:" ? { rejectUnauthorized: !config.insecure } : {}),
  } as http.AgentOptions)

  const {
    target: _target,
    port: _port,
    host: _host,
    root: _root,
    wait: _wait,
    insecure: _insecure,
    allowedHosts: _allowed,
    log: _log,
    interactiveDiscovery: _interactiveDiscovery,
    ...options
  } = config
  const listenHost = config.host ?? "127.0.0.1"
  // A server reachable only from this machine must not answer to a foreign name: a web page could otherwise point
  // its own domain at 127.0.0.1 and talk to the explorer (DNS rebinding).
  const strictHosts = LOOPBACK.has(listenHost) || LOOPBACK.has(`[${listenHost}]`)
  const explorer = createExplorer({ root, options, loopbackOnly: strictHosts })

  const allowed = new Set([...LOOPBACK, ...(config.allowedHosts ?? []).map((host) => host.toLowerCase())])
  const hostAllowed = (hostHeader: string | undefined) => !strictHosts || allowed.has(hostnameOf(hostHeader))

  const proxyOriginOf = (req: http.IncomingMessage) => `http://${req.headers.host ?? "localhost"}`

  // Headers for the target: it sees itself as the origin of every request, whatever address the browser used.
  function upstreamHeaders(req: http.IncomingMessage, wantsHtml: boolean): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = { ...req.headers }
    const proxyOrigin = proxyOriginOf(req)
    headers.host = target.host
    if (typeof headers.origin === "string" && headers.origin === proxyOrigin) headers.origin = targetOrigin
    if (typeof headers.referer === "string" && headers.referer.startsWith(proxyOrigin)) headers.referer = targetOrigin + headers.referer.slice(proxyOrigin.length)
    if (wantsHtml) {
      // A page is rewritten here, so ask for it plain and never answer "not modified" with a body-less 304.
      delete headers["accept-encoding"]
      delete headers["if-none-match"]
      delete headers["if-modified-since"]
    }
    return headers
  }

  function respondHtmlBody(res: http.ServerResponse, upstream: http.IncomingMessage, headers: http.IncomingHttpHeaders, body: Buffer) {
    const encoding = String(headers["content-encoding"] ?? "").toLowerCase()
    const done = (decoded: Buffer) => {
      const text = decoded.toString("utf8")
      const injected = Buffer.from(injectIntoHtml(text, explorer.runtimeTag()), "utf8")
      const out = cleanHeaders(headers)
      delete out["content-encoding"]
      delete out["transfer-encoding"]
      out["content-length"] = String(injected.length)
      res.writeHead(upstream.statusCode ?? 200, out)
      res.end(injected)
    }
    const passthrough = () => {
      const out = cleanHeaders(headers)
      out["content-length"] = String(body.length)
      delete out["transfer-encoding"]
      res.writeHead(upstream.statusCode ?? 200, out)
      res.end(body)
    }
    if (!encoding || encoding === "identity") return done(body)
    const decoder = encoding === "gzip" || encoding === "x-gzip" ? zlib.gunzip : encoding === "br" ? zlib.brotliDecompress : encoding === "deflate" ? zlib.inflate : undefined
    if (!decoder) return passthrough()
    decoder(body, (error, decoded) => (error ? passthrough() : done(decoded)))
  }

  function cleanHeaders(headers: http.IncomingHttpHeaders, req?: http.IncomingMessage): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = { ...headers }
    for (const name of HOP_BY_HOP) delete out[name]
    if (req) {
      const proxyOrigin = proxyOriginOf(req)
      if (typeof out.location === "string") out.location = rewriteLocation(out.location, targetOrigin, proxyOrigin)
      if (Array.isArray(out["set-cookie"])) out["set-cookie"] = out["set-cookie"].map((cookie) => rewriteCookie(cookie, false))
    }
    return out
  }

  function forward(req: http.IncomingMessage, res: http.ServerResponse) {
    const accept = String(req.headers.accept ?? "")
    const wantsHtml = accept.includes("text/html")
    const upstreamReq = transport.request(
      { hostname: targetHostname, port: targetPort, method: req.method, path: req.url, headers: upstreamHeaders(req, wantsHtml), agent },
      (upstream) => {
        const headers = upstream.headers
        const type = String(headers["content-type"] ?? "")
        const status = upstream.statusCode ?? 200
        const isHtml = /text\/html/i.test(type) && req.method !== "HEAD" && status !== 204 && status !== 304
        const charset = charsetOf(type)
        const rewritable = isHtml && (!charset || charset === "utf-8" || charset === "utf8")
        const rewritten = cleanHeaders(headers, req)
        if (!rewritable) {
          res.writeHead(status, rewritten)
          upstream.pipe(res)
          return
        }
        const chunks: Buffer[] = []
        upstream.on("data", (chunk: Buffer) => chunks.push(chunk))
        upstream.on("end", () => respondHtmlBody(res, upstream, { ...rewritten } as http.IncomingHttpHeaders, Buffer.concat(chunks)))
        upstream.on("error", () => res.destroy())
      },
    )
    upstreamReq.on("error", (error) => {
      if (res.headersSent) return res.destroy()
      res.writeHead(502, { "Content-Type": wantsHtml ? "text/html; charset=utf-8" : "text/plain; charset=utf-8", "Cache-Control": "no-store" })
      res.end(badGateway(targetOrigin, error.message, wantsHtml))
    })
    req.on("aborted", () => upstreamReq.destroy())
    req.pipe(upstreamReq)
  }

  const server = http.createServer((req, res) => {
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" })
      return res.end(`Host "${req.headers.host}" is not allowed. Use localhost, or pass --allowed-host.`)
    }
    void explorer.handle(req, res, () => forward(req, res))
  })

  // WebSockets (hot reload) are tunnelled byte for byte once the target agrees to the upgrade.
  server.on("upgrade", (req, socket: Duplex, head) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname
    if (!hostAllowed(req.headers.host) || explorer.owns(pathname)) return socket.destroy()
    const upstreamReq = transport.request({
      hostname: targetHostname,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req, false),
      agent: false,
      ...(target.protocol === "https:" ? { rejectUnauthorized: !config.insecure } : {}),
    })
    upstreamReq.on("upgrade", (upstream, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${upstream.statusCode} ${upstream.statusMessage}`]
      for (let i = 0; i < upstream.rawHeaders.length; i += 2) lines.push(`${upstream.rawHeaders[i]}: ${upstream.rawHeaders[i + 1]}`)
      socket.write(`${lines.join("\r\n")}\r\n\r\n`)
      if (upstreamHead.length) socket.write(upstreamHead)
      if (head.length) upstreamSocket.write(head)
      upstreamSocket.pipe(socket).pipe(upstreamSocket)
      const closeBoth = () => {
        socket.destroy()
        upstreamSocket.destroy()
      }
      socket.on("error", closeBoth)
      upstreamSocket.on("error", closeBoth)
      socket.on("close", closeBoth)
      upstreamSocket.on("close", closeBoth)
    })
    // The target refused the upgrade: pass its answer on and close.
    upstreamReq.on("response", (upstream) => {
      const lines = [`HTTP/1.1 ${upstream.statusCode} ${upstream.statusMessage}`]
      for (let i = 0; i < upstream.rawHeaders.length; i += 2) lines.push(`${upstream.rawHeaders[i]}: ${upstream.rawHeaders[i + 1]}`)
      socket.write(`${lines.join("\r\n")}\r\n\r\n`)
      upstream.pipe(socket)
    })
    upstreamReq.on("error", () => socket.destroy())
    socket.on("error", () => upstreamReq.destroy())
    upstreamReq.end()
  })

  const sockets = new Set<net.Socket>()
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(config.port ?? 5199, listenHost, () => resolve())
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") throw new Error(`Port ${config.port ?? 5199} is already in use. Pass --port to pick another.`)
    throw error
  })
  const address = server.address() as net.AddressInfo
  const shownHost = listenHost === "0.0.0.0" || listenHost === "::" ? "localhost" : listenHost.includes(":") ? `[${listenHost}]` : listenHost

  fs.mkdirSync(explorer.outDir, { recursive: true })
  const watcher = watchSources([...explorer.sourceDirs, explorer.outDir], (file, structural) => explorer.invalidate(file, structural))

  return {
    url: `http://${shownHost}:${address.port}`,
    port: address.port,
    host: listenHost,
    explorer,
    async close() {
      watcher.close()
      await explorer.dispose()
      agent.destroy()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await spawnedDevServer?.stop()
    },
  }
}
