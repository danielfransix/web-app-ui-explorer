import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { WebSocketServer, WebSocket } from "ws"
import type { BridgeCommand, BridgeResult, FigmaConnectionContext } from "../shared/bridge"
import { readClipboardDesign } from "./clipboard"
import { exportScreens, importSchema, selectionSchema, projectCatalog, projectScenarios, selectScreens, type LocalProject } from "./local-import"
import type { ImportProgress } from "../shared/bridge"
import type { ImportSelection, ImportSummary } from "../shared/handoff"
import { parseImportCode } from "../shared/handoff"
import type { Scenario } from "../shared/types"

export type BridgeConnection = { url: string; token: string }
const connectionFile = (root: string) => path.join(root, ".ui-explorer", "bridge.json")

export async function startBridge(options: LocalProject & { port?: number; timeoutMs?: number; heartbeatMs?: number; agentTtlMs?: number; handoffTtlMs?: number; reconnectMs?: number; socketHeartbeatMs?: number; readClipboard?: () => Promise<string> }) {
  const pairingFile = path.join(options.root, ".ui-explorer", "pairing.json")
  let pairing: { token: string; port: number } | undefined
  try {
    const saved = JSON.parse(fs.readFileSync(pairingFile, "utf8"))
    if (/^[A-Za-z0-9_-]{32}$/.test(saved.token) && Number.isInteger(saved.port) && saved.port > 0 && saved.port <= 65535) pairing = saved
  } catch { /* First pairing for this local project. */ }
  const token = pairing?.token ?? randomBytes(24).toString("base64url")
  const agents = new Map<string, { id: string; name: string; lastSeen: number }>()
  const activeAgents = () => {
    for (const [id, agent] of agents) if (Date.now() - agent.lastSeen >= (options.agentTtlMs ?? 15000)) agents.delete(id)
    return Array.from(agents.values(), ({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }
  const handoffs = new Map<string, { selection: ImportSelection; scenarios: Scenario[]; summary: ImportSummary }>()
  const getHandoff = (id: string) => {
    const item = handoffs.get(id)
    if (!item || item.summary.expiresAt <= Date.now()) { handoffs.delete(id); throw new Error("This import code has expired or belongs to an earlier Explorer session. Create a new code in UI Explorer.") }
    return item
  }
  type Pending = { resolve: (result: BridgeResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; command: BridgeCommand; delivered: boolean; phase: string; createdAt: number }
  const pending = new Map<string, Pending>()
  const uncertain = new Map<string, { id: string; type: BridgeCommand["type"]; phase: string }>()
  const completed = new Set<string>()
  const ledgerFile = path.join(options.root, ".ui-explorer", "command-ledger.json")
  const running = new Set<string>()
  let liveSocket: WebSocket | undefined
  let socketOwner = "", reconnectUntil = 0, lastPong = 0
  let lastSocketClose: { code: number; reason: string; at: number } | null = null
  let socketFailureReason = ""
  const socketServer = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false })
  let queue: { id: string; command: BridgeCommand }[] = []
  let clientId = ""
  let context: FigmaConnectionContext | undefined
  let loadedHandoffId: string | undefined
  let lastSeen = 0
  let busyUntil = 0
  let job: { id: string; state: "running" | "completed" | "cancelled" | "failed"; progress: ImportProgress; result?: Awaited<ReturnType<typeof exportScreens>>; error?: string } | undefined
  let jobAbort: AbortController | undefined
  let jobWork: Promise<void> | undefined
  let startingImport = false
  let exportRun: string | undefined
  const connected = () => !!clientId && (socketOwner ? liveSocket?.readyState === WebSocket.OPEN : Date.now() - lastSeen < (options.heartbeatMs ?? 8000) || Date.now() < busyUntil)
  const ownedByAnother = (caller: string) => !!clientId && caller !== clientId && !!connected()
  const replaceClosedSession = (caller: string) => {
    if (!clientId || caller === clientId) return
    // A new UI cannot resume the old JavaScript execution. Retain delivered write outcomes for
    // review, rather than holding the reopened plugin behind the old session's reconnect grace.
    failPending("The previous plugin session closed. Inspect interrupted writes before importing again.")
    running.clear(); socketOwner = ""; reconnectUntil = 0; busyUntil = 0; context = undefined
  }
  const mutates = (command: BridgeCommand) => ["build", "arrange", "repair-component-names"].includes(command.type)
  try {
    const saved = JSON.parse(fs.readFileSync(ledgerFile, "utf8"))
    if (Array.isArray(saved)) for (const item of saved.slice(0, 512)) if (typeof item.id === "string" && ["build", "arrange", "repair-component-names"].includes(item.type) && typeof item.phase === "string") uncertain.set(item.id, { id: item.id, type: item.type, phase: item.phase })
  } catch { /* No interrupted writes recorded for this project. */ }
  const persistLedger = () => {
    const entries = new Map(uncertain)
    for (const [id, item] of pending) if (item.delivered && mutates(item.command)) entries.set(id, { id, type: item.command.type, phase: item.phase })
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true })
    fs.writeFileSync(ledgerFile, JSON.stringify([...entries.values()]), { mode: 0o600 })
  }
  const commandStatus = () => [...pending].map(([id, item]) => ({ id, type: item.command.type, phase: item.phase, delivered: item.delivered, createdAt: item.createdAt }))
  const sendSocket = (message: unknown) => { if (liveSocket?.readyState === WebSocket.OPEN) liveSocket.send(JSON.stringify(message)) }
  const publishState = () => sendSocket({ type: "presence", runId: exportRun ?? null, commands: commandStatus(), clients: activeAgents(), needsReview: [...uncertain.values()] })
  const flush = () => {
    if (liveSocket?.readyState !== WebSocket.OPEN) return
    for (const item of queue.splice(0)) {
      const entry = pending.get(item.id)
      if (!entry || entry.delivered) continue
      entry.delivered = true; entry.phase = "Delivered to plugin"
      persistLedger()
      sendSocket({ type: "command", ...item })
    }
  }
  const finishResult = (id: string, result: BridgeResult) => {
    const entry = pending.get(id), known = !!entry || uncertain.has(id) || completed.has(id)
    if (entry) { clearTimeout(entry.timer); pending.delete(id); entry.resolve(result) }
    uncertain.delete(id); running.delete(id)
    persistLedger()
    if (known) { completed.add(id); if (completed.size > 512) completed.delete(completed.values().next().value!) }
    if (!pending.size) busyUntil = 0
    return known
  }
  const failPending = (reason: string) => {
    jobAbort?.abort(new Error(reason))
    exportRun = undefined
    for (const [id, entry] of pending) {
      if (entry.delivered && mutates(entry.command)) uncertain.set(id, { id, type: entry.command.type, phase: entry.phase })
      clearTimeout(entry.timer); entry.reject(new Error(reason))
    }
    pending.clear(); queue = []
    persistLedger()
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-UIX-Client")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Private-Network", "true")
    res.setHeader("Cache-Control", "no-store")
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return }
    const supplied = Buffer.from(req.headers.authorization ?? "")
    const expected = Buffer.from(`Bearer ${token}`)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401).end(); return }
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value)) }
    let body: any = {}
    try {
      if (req.method === "POST") {
        const chunks: Buffer[] = []; let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > 32 * 1024 * 1024) { json({ error: "Payload exceeds 32 MB" }, 413); return }
          chunks.push(chunk)
        }
        body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
      }
      if (req.url === "/status") return json({ connected: connected(), transport: socketOwner ? "websocket" : clientId ? "http-polling" : null, responsive: socketOwner ? connected() && Date.now() - lastPong <= (options.socketHeartbeatMs ?? 5000) * 3 : connected(), lastSocketClose, reconnecting: !!socketOwner && !connected() && Date.now() < reconnectUntil, busy: Date.now() < busyUntil || pending.size > 0, pending: pending.size, commands: commandStatus(), needsReview: [...uncertain.values()], import: job ?? null, mcpClients: activeAgents(), destination: connected() ? context ?? null : null })
      if (req.url === "/commands/reviewed" && req.method === "POST") {
        if (!Array.isArray(body.ids) || !body.ids.length || body.reviewedInFigma !== true || body.ids.some((id: unknown) => typeof id !== "string" || !uncertain.has(id) || running.has(id))) return json({ error: "Review interrupted command IDs in Figma first. Commands still running cannot be cleared." }, 409)
        for (const id of body.ids) uncertain.delete(id)
        persistLedger()
        publishState()
        return json({ reviewed: body.ids })
      }
      // Prepared source metadata is available to authenticated agents before a plugin connects.
      // No plugin identity is required for this read, and it never claims the plugin connection.
      if (req.url?.startsWith("/handoffs/") && req.method === "GET") {
        try {
          const requested = req.url.slice("/handoffs/".length)
          const valid = [...handoffs.values()].filter(item => item.summary.expiresAt > Date.now())
          const loaded = valid.find(item => item.summary.id === loadedHandoffId)
          const id = requested === "current" ? loaded?.summary.id ?? (valid.length === 1 ? valid[0].summary.id : undefined) : requested
          if (!id) return json({ error: valid.length > 1 ? "Several imports are prepared. Supply the import code to identify the intended selection." : "Prepare a selection with Build in Figma in UI Explorer first." }, 409)
          return json(getHandoff(id).summary)
        } catch (error) { return json({ error: (error as Error).message }, 410) }
      }
      if (["/agents/heartbeat", "/agents/disconnect"].includes(req.url ?? "") && req.method === "POST") {
        if (typeof body.id !== "string" || !/^[\w-]{1,100}$/.test(body.id)) return json({ error: "Invalid MCP client id" }, 400)
        if (req.url === "/agents/disconnect") { agents.delete(body.id); publishState(); return json({ disconnected: true }) }
        if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100) return json({ error: "Invalid MCP client name" }, 400)
        activeAgents()
        if (!agents.has(body.id) && agents.size >= 32) return json({ error: "Too many MCP clients" }, 409)
        agents.set(body.id, { id: body.id, name: body.name.replace(/[\u0000-\u001f\u007f]/g, " ").trim() || "MCP client", lastSeen: Date.now() })
        publishState()
        return json({ connected: true })
      }
      const caller = String(req.headers["x-uix-client"] ?? "")
      if (req.url === "/connect" && req.method === "POST") {
        if (!caller) return json({ error: "Missing plugin client id" }, 400)
        if (ownedByAnother(caller)) return json({ error: "Another Figma plugin is connected. This plugin will retry when it closes." }, 409)
        replaceClosedSession(caller)
        if (caller !== clientId) busyUntil = 0
        clientId = caller; context = undefined; lastSeen = Date.now(); return json({ connected: true, websocket: { path: "/socket", protocol: 1 } })
      }
      if (req.url === "/command" && req.method === "POST") {
        if (startingImport || job?.state === "running") return json({ error: "A local import is already running. Wait or cancel it first." }, 409)
        return json(await dispatch(body.command))
      }
      if (req.url === "/disconnect" && req.method === "POST") {
        if (!clientId || caller !== clientId) return json({ error: "This plugin does not own the connection." }, 409)
        const oldSocket = liveSocket; liveSocket = undefined; socketOwner = ""; reconnectUntil = 0
        oldSocket?.close(1000, "Disconnected by user")
        clientId = ""; busyUntil = 0; failPending("Figma plugin disconnected; the batch did not complete."); return json({ disconnected: true })
      }
      if (!connected() || caller !== clientId) return json({ error: "Plugin disconnected; reconnect in Figma." }, 409)
      lastSeen = Date.now()
      if (req.url === "/connection/context" && req.method === "POST") {
        const value = body.context
        if (!value || ["documentName", "pageId", "pageName"].some(key => typeof value[key] !== "string" || !value[key].trim() || value[key].length > 300)) return json({ error: "Invalid Figma connection context" }, 400)
        context = { documentName: value.documentName, pageId: value.pageId, pageName: value.pageName }
        return json({ updated: true })
      }
      if (req.url === "/handoff/loaded" && req.method === "POST") {
        try { loadedHandoffId = getHandoff(body.id).summary.id; return json({ loaded: true }) }
        catch (error) { return json({ error: (error as Error).message }, 410) }
      }
      if (req.url === "/agents" && req.method === "GET") return json({ clients: activeAgents() })
      if (req.url === "/catalog" && req.method === "GET") return json(await projectCatalog(options))
      if (req.url === "/imports/current" && req.method === "GET") return json(job ?? null)
      if (req.url === "/imports/cancel" && req.method === "POST") {
        if (!job || body.id !== job.id) return json({ error: "Import job not found." }, 404)
        jobAbort?.abort(new Error("Import cancelled. Frames already created remain on the canvas."))
        return json({ cancelling: job.state === "running" })
      }
      if (req.url === "/imports" && req.method === "POST") {
        if (startingImport || exportRun || job?.state === "running" || pending.size || Date.now() < busyUntil) return json({ error: "Another import is running. Wait for it to finish." }, 409)
        startingImport = true
        try {
          const prepared = typeof body.requestId === "string" ? getHandoff(body.requestId) : undefined
          const input = importSchema.parse(prepared ? { placement: body.placement, layout: body.layout, libraries: body.libraries, ...prepared.selection } : body)
          const selected = prepared?.scenarios ?? selectScreens(await projectScenarios(options), input)
          if (!selected.length) throw new Error("No registered screens match this scope.")
          if (!options.baseUrl) throw new Error("Restart the bridge with --base-url <running-app-url> to capture local screens.")
          const active: NonNullable<typeof job> = { id: randomUUID(), state: "running", progress: { phase: "capturing", completed: 0, total: selected.length, message: "Starting import…" } }
          job = active; jobAbort = new AbortController()
          const signal = jobAbort.signal
          jobWork = exportScreens(options, input, dispatch, { selected, signal, progress: progress => { active.progress = progress } })
            .then(result => { active.result = result; active.state = "completed" })
            .catch(error => { active.state = signal.aborted ? "cancelled" : "failed"; active.error = signal.aborted ? String(signal.reason?.message ?? "Import cancelled.") : String(error instanceof Error ? error.message : error); active.progress = { ...active.progress, phase: active.state, message: active.error } })
            .finally(() => { jobAbort = undefined })
          return json({ id: active.id }, 202)
        } finally { startingImport = false }
      }
      if (req.url === "/busy" && req.method === "POST") {
        if (body.active && exportRun) return json({ error: "Another export is already running." }, 409)
        busyUntil = body.active ? Date.now() + (options.timeoutMs ?? 300_000) : 0; return json({ busy: !!body.active })
      }
      if (req.url === "/clipboard" && req.method === "POST") return json(await readClipboardDesign(options.readClipboard))
      if (req.url === "/poll") {
        if (liveSocket?.readyState === WebSocket.OPEN) return json([])
        const next = queue; queue = []
        for (const item of next) { const entry = pending.get(item.id); if (entry) { entry.delivered = true; entry.phase = "Delivered to plugin" } }
        if (next.length) persistLedger()
        if (next.length) busyUntil = Date.now() + (options.timeoutMs ?? 300_000)
        return json(next)
      }
      if (req.url === "/result" && req.method === "POST") {
        return json({ received: finishResult(body.id, body.result) })
      }
      json({ error: "Not found" }, 404)
    } catch (error) { json({ error: error instanceof Error ? error.message : String(error) }, 400) }
  })
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/socket" || socketServer.clients.size >= 32) { socket.destroy(); return }
    socketServer.handleUpgrade(req, socket, head, ws => {
      let authenticated = false
      const authTimer = setTimeout(() => ws.close(4401, "Authentication required"), 5000); authTimer.unref()
      ws.on("error", () => {})
      ws.on("pong", () => { if (ws === liveSocket) lastPong = lastSeen = Date.now() })
      ws.on("message", raw => {
        try {
          const message = JSON.parse(raw.toString())
          if (!authenticated) {
            const supplied = Buffer.from(typeof message.token === "string" ? message.token : "")
            const expected = Buffer.from(token)
            if (message.type !== "hello" || supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || typeof message.clientId !== "string" || !/^[\w-]{1,100}$/.test(message.clientId)) { ws.close(4401, "Invalid pairing"); return }
            if (ownedByAnother(message.clientId)) { ws.close(4409, "Another plugin is connected"); return }
            replaceClosedSession(message.clientId)
            authenticated = true; clearTimeout(authTimer)
            const previous = liveSocket
            liveSocket = ws; clientId = socketOwner = message.clientId; reconnectUntil = 0; lastPong = lastSeen = Date.now()
            socketFailureReason = ""
            if (message.context && ["documentName", "pageId", "pageName"].every(key => typeof message.context[key] === "string" && message.context[key].length > 0 && message.context[key].length <= 300)) context = { documentName: message.context.documentName, pageId: message.context.pageId, pageName: message.context.pageName }
            if (previous && previous !== ws) previous.close(1000, "Socket replaced")
            running.clear()
            if (Array.isArray(message.activeIds)) for (const id of message.activeIds) if (typeof id === "string") running.add(id)
            sendSocket({ type: "ready", runId: exportRun ?? null, commands: commandStatus(), needsReview: [...uncertain.values()], clients: activeAgents() })
            flush(); return
          }
          if (ws !== liveSocket) return
          lastSeen = Date.now()
          if (message.type === "result" && typeof message.id === "string" && message.result && typeof message.result === "object") sendSocket({ type: "result-ack", id: message.id, accepted: finishResult(message.id, message.result) })
          else if (message.type === "progress" && typeof message.id === "string") {
            const entry = pending.get(message.id)
            if (entry) { entry.phase = typeof message.phase === "string" ? message.phase.slice(0, 200) : "Executing in Figma"; running.add(message.id) }
          }
        } catch { ws.close(4400, "Invalid bridge message") }
      })
      ws.on("close", (code, reason) => {
        clearTimeout(authTimer)
        if (ws !== liveSocket) return
        lastSocketClose = { code, reason: socketFailureReason || reason.toString().slice(0, 200) || "Socket closed without a reason", at: Date.now() }
        liveSocket = undefined; reconnectUntil = Date.now() + (options.reconnectMs ?? 20000)
      })
    })
  })
  const dispatch = (command: BridgeCommand): Promise<BridgeResult> => {
    if (!connected() && !(socketOwner && Date.now() < reconnectUntil)) return Promise.reject(new Error("No Figma plugin connected. Open the target file, launch UI Explorer design import, and connect its bridge."))
    if (!command || !["build", "verify", "arrange", "render", "repair-component-names", "begin-export", "end-export"].includes(command.type)) return Promise.reject(new Error("Unknown bridge command"))
    if (uncertain.size && command.type === "end-export") { exportRun = undefined; return Promise.resolve({ warnings: ["An interrupted command needs review in Figma before another import."] }) }
    if (uncertain.size && !["verify", "render"].includes(command.type)) return Promise.reject(new Error("An interrupted command has an unknown outcome. Inspect Figma and review it before importing again."))
    if (command.type === "begin-export") {
      if (exportRun) return Promise.reject(new Error("Another export is already running."))
      exportRun = command.runId
    } else if (exportRun && (!("runId" in command) || command.runId !== exportRun)) return Promise.reject(new Error("Another export is already running."))
    const result = new Promise<BridgeResult>((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        const entry = pending.get(id)
        if (entry?.delivered && mutates(command)) uncertain.set(id, { id, type: command.type, phase: entry.phase })
        pending.delete(id); queue = queue.filter((item) => item.id !== id)
        persistLedger()
        reject(new Error(`Figma command timed out${entry ? " during " + entry.phase : ""}; inspect the plugin before retrying.`))
      }, options.timeoutMs ?? 300_000)
      pending.set(id, { resolve, reject, timer, command, delivered: false, phase: "Waiting for plugin", createdAt: Date.now() }); queue.push({ id, command }); flush()
    })
    return result.then(value => { if (command.type === "begin-export" && value.error) exportRun = undefined; return value }, error => { if (command.type === "begin-export") exportRun = undefined; throw error })
      .finally(() => { if (command.type === "end-export") exportRun = undefined })
  }
  const listen = (port: number) => new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off("listening", onListening); reject(error) }
    const onListening = () => { server.off("error", onError); resolve() }
    server.once("error", onError); server.once("listening", onListening); server.listen(port, "127.0.0.1")
  })
  const preferredPort = (!options.port && pairing?.port) || options.port || (options.port === 0 ? 0 : 5198)
  try { await listen(preferredPort) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || options.port) throw error
    await listen(0)
  }
  const connection = { url: `http://localhost:${(server.address() as { port: number }).port}`, token }
  fs.mkdirSync(path.dirname(connectionFile(options.root)), { recursive: true })
  fs.writeFileSync(pairingFile, JSON.stringify({ token, port: (server.address() as { port: number }).port }), { mode: 0o600 })
  fs.writeFileSync(connectionFile(options.root), JSON.stringify(connection), { mode: 0o600 })
  const socketHeartbeat = setInterval(() => {
    if (liveSocket?.readyState !== WebSocket.OPEN) return
    if (Date.now() - lastPong > (options.socketHeartbeatMs ?? 5000) * 3) {
      // Figma can pause the plugin UI while a native operation runs. Its command deadline still
      // bounds the wait; do not turn a temporary UI pause into a dropped write connection.
      if (pending.size) { publishState(); return }
      socketFailureReason = "Heartbeat expired while idle"; liveSocket.terminate(); return
    }
    liveSocket.ping(); publishState()
  }, options.socketHeartbeatMs ?? 5000)
  socketHeartbeat.unref()
  const monitor = setInterval(() => { if (clientId && !connected() && Date.now() >= reconnectUntil) { clientId = ""; socketOwner = ""; failPending("Figma plugin connection lost; command outcomes must be checked before retrying.") } }, Math.min(1000, options.reconnectMs ?? 1000))
  monitor.unref()
  return { ...connection, dispatch, prepareImport: (raw: ImportSelection, scenarios: Scenario[], project = path.basename(options.root)) => {
    if (!options.baseUrl) throw new Error("Open the running UI Explorer to prepare an import.")
    const selection = selectionSchema.parse(raw)
    const selected = selectScreens(scenarios, { ids: [...new Set(selection.ids)] })
    const id = randomBytes(12).toString("base64url"), widths = [...new Set(selection.widths)].sort((a, b) => b - a)
    const summary: ImportSummary = { id, project, screenCount: selected.length, widths, frameCount: selected.length * widths.length, screens: selected.map(({ id, title, source, group }) => ({ id, title, source, group, folder: source?.replace(/\\/g, "/").split("/").slice(0, -1).join("/") || group })), createComponents: selection.createComponents !== false, expiresAt: Date.now() + (options.handoffTtlMs ?? 60 * 60 * 1000) }
    for (const [key, item] of handoffs) if (item.summary.expiresAt <= Date.now()) handoffs.delete(key)
    if (handoffs.size >= 100) throw new Error("Too many prepared imports. Restart UI Explorer or wait for older codes to expire.")
    handoffs.set(id, structuredClone({ selection: { ...selection, ids: selected.map(s => s.id), widths }, scenarios: selected, summary }))
    return { code: `UIX1:${new URL(connection.url).port}:${token}:${id}`, summary }
  }, close: async () => {
    clearInterval(monitor); clearInterval(socketHeartbeat); agents.clear(); clientId = ""; socketOwner = ""; failPending("Bridge closed")
    for (const ws of socketServer.clients) ws.terminate()
    socketServer.close()
    await jobWork
    try { if (JSON.parse(fs.readFileSync(connectionFile(options.root), "utf8")).token === token) fs.unlinkSync(connectionFile(options.root)) } catch { /* Another bridge may have replaced the connection. */ }
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  } }
}

export function readBridgeConnection(root: string): BridgeConnection {
  try { return JSON.parse(fs.readFileSync(connectionFile(root), "utf8")) } catch { throw new Error("In UI Explorer, open Workspace overview > Figma connection, then paste its connection URL into the Figma plugin's Advanced connection. Keep Explorer and the plugin open.") }
}

/** Read a frozen source selection without claiming the Figma plugin's client identity. */
export async function readPreparedImport(root: string, code?: string): Promise<ImportSummary> {
  const connection = code ? parseImportCode(code) : readBridgeConnection(root)
  const id = "requestId" in connection ? connection.requestId : "current"
  let response: Response
  try {
    response = await fetch(`${connection.url}/handoffs/${encodeURIComponent(String(id))}`, {
      headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(5000), redirect: "error",
    })
  } catch { throw new Error("The local Explorer session is unavailable. Open UI Explorer and prepare the selection again.") }
  const result = await response.json() as ImportSummary & { error?: string }
  if (!response.ok) throw new Error(response.status === 401 ? "This import code belongs to an earlier Explorer session. Prepare a new code in UI Explorer." : result.error || `Prepared import HTTP ${response.status}`)
  if (!Array.isArray(result.screens) || !Array.isArray(result.widths) || result.expiresAt <= Date.now()) throw new Error("The prepared import is invalid or expired. Prepare a new code in UI Explorer.")
  return result
}

export async function reportMcpPresence(root: string, client: { id: string; name: string }, connected: boolean): Promise<void> {
  const connection = readBridgeConnection(root)
  const response = await fetch(connection.url + (connected ? "/agents/heartbeat" : "/agents/disconnect"), {
    method: "POST", headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(client), signal: AbortSignal.timeout(2500),
  })
  if (!response.ok) throw new Error(`MCP presence HTTP ${response.status}`)
  await response.arrayBuffer()
}
export async function sendToBridge(root: string, command?: BridgeCommand): Promise<any> {
  const connection = readBridgeConnection(root)
  const response = await fetch(`${connection.url}/${command ? "command" : "status"}`, {
    method: command ? "POST" : "GET", headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
    ...(command ? { body: JSON.stringify({ command }) } : {}), signal: AbortSignal.timeout(310_000),
  })
  const result = await response.json() as BridgeResult
  if (!response.ok || result.error) throw new Error(result.error ?? `Bridge HTTP ${response.status}`)
  return result
}
