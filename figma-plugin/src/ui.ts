import type { BridgeCommand, Placement, ImportProgress, FigmaConnectionContext } from "../../src/shared/bridge"
import { parseImportCode, type ImportSummary } from "../../src/shared/handoff"
import { initializeDropdowns, focusDropdown } from "./dropdown"
import { LiveConnection } from "./live-connection"
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const status = el<HTMLParagraphElement>("status")
const build = el<HTMLButtonElement>("build"), pasted = el<HTMLButtonElement>("build-pasted")
const clipboardBuild = el<HTMLButtonElement>("build-clipboard")
const report = el<HTMLUListElement>("report")
const payload = el<HTMLTextAreaElement>("payload")
const pasteImport = el<HTMLDetailsElement>("paste-import")
let localBusy = false
let sourceMode: "local" | "clipboard" = "local"
let prepared: ImportSummary | undefined
let loading = false
let connectionEpoch = 0
let activeJob: string | undefined
let startingLocal = false
let agentRun: string | undefined
let agentEndId: string | undefined
let agentResult: { report: string[]; warnings: string[]; conflicts: string[]; error?: string; coverage?: { missing: unknown[]; unexpected: unknown[] } } = { report: [], warnings: [], conflicts: [] }
const commandKinds = new Map<string, BridgeCommand["type"]>()
function show(text: string, error = false) {
  el("status-text").textContent = text
  status.dataset.tone = error ? "error" : "neutral"
  status.dataset.busy = String(!error && /^(Reading clipboard|Building)/.test(text))
}
function syncDestination() {
  const mode = el<HTMLSelectElement>("placement").value
  el("destination-field").hidden = !["page", "section"].includes(mode)
  const label = mode === "section" ? "Section name" : "Page name"
  el("destination-label").textContent = label
  el<HTMLInputElement>("destination").placeholder = label
}
el<HTMLSelectElement>("placement").addEventListener("change", syncDestination)
syncDestination()
function placement(): Placement {
  const mode = el<HTMLSelectElement>("placement").value as Placement["mode"]
  const name = el<HTMLInputElement>("destination").value.trim()
  if (!mode) { focusDropdown("placement"); el("placement-trigger").scrollIntoView({ block: "center" }); throw new Error("Choose where the frames should go.") }
  if (["page", "section"].includes(mode) && !name) { el<HTMLInputElement>("destination").focus(); throw new Error("Enter a destination page or section name.") }
  return { mode, name: name || undefined }
}
function readLibraries() {
  const input = el<HTMLTextAreaElement>("libraries"), text = input.value.trim()
  if (!text) return undefined
  try { return JSON.parse(text) }
  catch { el<HTMLDetailsElement>("library-controls").open = true; input.focus(); throw new Error("Library mappings must contain valid JSON.") }
}
async function submit(raw: string) {
  try {
    const target = placement()
    if (!raw.trim()) throw new Error("Paste the design copied from UI Explorer first.")
    const parsed = JSON.parse(raw)
    if (parsed?.uixDesignExport !== 1 || !parsed.plan) throw new Error("Copy a screen from UI Explorer first.")
    const libraries = readLibraries()
    if (connection) await request("/busy", { active: true })
    localBusy = true; build.disabled = pasted.disabled = clipboardBuild.disabled = true; updatePreview(); show("Building…")
    parent.postMessage({ pluginMessage: { type: "build", plan: parsed.plan, placement: target, libraries } }, "*")
  } catch (error) { show(String(error instanceof Error ? error.message : error), true) }
}
build.addEventListener("click", async () => {
  if (!localBusy) await startLocalImport()
})
clipboardBuild.addEventListener("click", async () => {
  if (localBusy) return
  try { placement() } catch (error) {
    show(error instanceof Error ? error.message : String(error), true)
    focusDropdown("placement")
    return
  }
  let raw: string | undefined
  if (typeof navigator.clipboard?.readText === "function") {
    try { raw = await navigator.clipboard.readText() } catch { /* Use the connected native provider when the host denies browser clipboard access. */ }
  }
  if (raw === undefined && !connection) {
    el<HTMLDetailsElement>("bridge-controls").open = true
    el<HTMLInputElement>("bridge-url").focus()
    show("Connect the local bridge below to enable Build from clipboard in this Figma window.", true)
    return
  }
  try {
    show("Reading clipboard…")
    build.disabled = pasted.disabled = clipboardBuild.disabled = true
    await submit(raw ?? JSON.stringify(await request("/clipboard", {})))
  } catch (error) { show(error instanceof Error ? error.message : String(error), true) }
  finally { if (!localBusy) { pasted.disabled = clipboardBuild.disabled = false; updatePreview() } }
})
pasted.addEventListener("click", () => { if (!localBusy) void submit(payload.value) })
document.addEventListener("paste", (event) => {
  if (localBusy || loading) return
  const target = event.target
  const handoff = event.clipboardData?.getData("text/plain")?.trim()
  if (handoff?.startsWith("UIX1:") && (!(target instanceof Element) || target.id === "import-code" || !target.closest("input, textarea, [contenteditable]"))) {
    event.preventDefault(); el<HTMLButtonElement>("mode-local").click()
    el<HTMLInputElement>("import-code").value = handoff; void loadImport(); return
  }
  if (target instanceof Element && target !== payload && target.closest("input, textarea, select, [contenteditable]")) return
  const raw = event.clipboardData?.getData("text/plain")
  if (!raw) return
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.uixDesignExport !== 1 || !Array.isArray(parsed.plan?.frames)) return
    event.preventDefault()
    if (sourceMode === "local") el<HTMLButtonElement>("mode-clipboard").click()
    pasteImport.open = true
    payload.value = raw
    payload.focus()
    show(`Design pasted: ${parsed.plan.frames.length} frame(s). Click Build pasted export.`)
  } catch { /* Leave ordinary text pastes to the focused control. */ }
})
el<HTMLFormElement>("register-form").addEventListener("submit", (event) => {
  event.preventDefault()
  parent.postMessage({ pluginMessage: { type: "register-library", componentId: el<HTMLInputElement>("register-id").value.trim() } }, "*")
})
let connection: { url: string; token: string } | undefined
let rememberedConnection: { url: string; token: string; requestId?: string } | undefined
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let figmaContext: FigmaConnectionContext | undefined
let pollTimer: ReturnType<typeof setTimeout> | undefined
let pollErrors = 0
let liveConnection: LiveConnection | undefined
let liveReady = true
let needsReview = false
const clientId = Math.random().toString(36).slice(2) + Date.now().toString(36)
const bridgeStatus = el<HTMLParagraphElement>("bridge-status")
function setConnectionState(state: "connected" | "connecting" | "disconnected") {
  const badge = el("connection-state")
  badge.dataset.state = state
  el("connection-state-label").textContent = state === "connected" ? "Connected" : state === "connecting" ? "Connecting…" : "Not connected"
  const mcp = el("mcp-status")
  mcp.hidden = state !== "connected"
  mcp.dataset.state = "unknown"
  mcp.textContent = "Checking MCP connection…"
}
async function refreshMcpStatus(epoch: number) {
  const mcp = el("mcp-status")
  try {
    const body = await request("/agents") as { clients?: { name: string }[] }
    if (epoch !== connectionEpoch) return
    if (!Array.isArray(body.clients)) throw new Error("MCP status unavailable")
    mcp.dataset.state = body.clients.length ? "connected" : "disconnected"
    mcp.textContent = body.clients.length ? "MCP connected: " + body.clients.map(client => client.name).join(", ") : "MCP: No client connected"
  } catch {
    if (epoch !== connectionEpoch) return
    mcp.dataset.state = "unknown"
    mcp.textContent = "MCP status unavailable. Update and restart UI Explorer."
  }
}
function showPresence(clients: { name: string }[]) {
  const mcp = el("mcp-status")
  mcp.hidden = false; mcp.dataset.state = clients.length ? "connected" : "disconnected"
  mcp.textContent = clients.length ? "MCP connected: " + clients.map(client => client.name).join(", ") : "MCP: No client connected"
}
function receiveCommand({ id, command }: { id: string; command: BridgeCommand }) {
  commandKinds.set(id, command.type)
  if (command.type === "begin-export" && !activeJob && !startingLocal) {
    agentRun = command.runId; agentResult = { report: [], warnings: [], conflicts: [] }
    setImportBusy(true); el("cancel").hidden = true; el<HTMLProgressElement>("import-progress").removeAttribute("value")
    show("MCP import running. Preparing captures…"); status.dataset.busy = "true"
  }
  if (command.type === "end-export" && agentRun) agentEndId = id
  parent.postMessage({ pluginMessage: { ...command, requestId: id } }, "*")
}
async function request(route: string, body?: unknown) {
  if (!connection) throw new Error("Bridge disconnected")
  const response = await fetch(connection.url + route, { method: body === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + connection.token, "Content-Type": "application/json", "X-UIX-Client": clientId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(route === "/agents" ? 4000 : route === "/poll" || route === "/imports/current" || route === "/result" ? 300000 : 15000) })
  const result = await response.json()
  if (!response.ok) throw Object.assign(new Error(result.error || "Bridge HTTP " + response.status), { status: response.status })
  return result
}
async function poll() {
  const epoch = connectionEpoch
  try {
    const commands = liveConnection ? [] : await request("/poll") as { id: string; command: BridgeCommand }[]
    if (epoch !== connectionEpoch) return
    for (const { id, command } of commands) {
      receiveCommand({ id, command })
    }
    if (activeJob) await pollJob()
    if (!liveConnection) await refreshMcpStatus(epoch)
    if (epoch !== connectionEpoch) return
    pollErrors = 0
    pollTimer = setTimeout(() => void poll(), liveConnection ? 1000 : commands.length ? 25 : activeJob || agentRun ? 250 : 750)
  } catch (error) {
    if (epoch !== connectionEpoch) return
    if (liveConnection) { bridgeStatus.textContent = "Live connection active; retrying import status."; pollTimer = setTimeout(() => void poll(), 1000); return }
    if (connection && ![401, 409].includes((error as { status?: number }).status ?? 0)) {
      pollErrors++
      el("mcp-status").dataset.state = "unknown"
      el("mcp-status").textContent = "MCP status unavailable. Reconnecting to UI Explorer…"
      bridgeStatus.textContent = "Connection interrupted. Retrying…"
      show("Connection interrupted. Retrying the same import; do not start another run.", true)
      pollTimer = setTimeout(() => void poll(), Math.min(5000, 500 * pollErrors))
      return
    }
    connection = undefined; el("connect-label").textContent = "Connect bridge"
    setConnectionState("disconnected")
    bridgeStatus.textContent = "Disconnected: " + String(error)
    if (activeJob || agentRun) { activeJob = agentRun = undefined; setImportBusy(false); show("Connection lost. Reconnect to inspect the import before retrying.", true) }
    updatePreview()
    if (rememberedConnection) retryRestore(rememberedConnection)
  }
}
async function connectBridge(next: { url: string; token: string }) {
  clearTimeout(reconnectTimer); rememberedConnection = next
  const epoch = ++connectionEpoch; clearTimeout(pollTimer)
  liveConnection?.close(); liveConnection = undefined; liveReady = true
  if (connection && (connection.url !== next.url || connection.token !== next.token)) await request("/disconnect", {}).catch(() => {})
  connection = next; setConnectionState("connecting")
  try {
    const handshake = await request("/connect", {})
    if (epoch !== connectionEpoch) throw new DOMException("Connection changed", "AbortError")
    parent.postMessage({ pluginMessage: { type: "save-connection", connection: next } }, "*")
    parent.postMessage({ pluginMessage: { type: "connection-context" } }, "*")
    if (figmaContext) void request("/connection/context", { context: figmaContext }).catch(() => {})
    setConnectionState("connected"); el("connect-label").textContent = "Disconnect bridge"
    el("handoff-feedback").hidden = true
    bridgeStatus.textContent = "Connected. Build from clipboard is ready."
    if (handshake.websocket?.protocol === 1) {
      liveReady = false
      liveConnection = new LiveConnection({ ...next, clientId, command: receiveCommand, presence: showPresence, context: () => figmaContext,
        state: (state, message) => { if (epoch !== connectionEpoch) return; liveReady = state === "connected"; setConnectionState(liveReady ? "connected" : "connecting"); bridgeStatus.textContent = message; updatePreview() },
        review: commands => { needsReview = commands.length > 0; if (needsReview) show("An interrupted command needs review in Figma before another import.", true); updatePreview() },
        execution: state => { if (agentRun && !state.runId && !state.commands?.length && !state.needsReview?.length) { agentRun = agentEndId = undefined; setImportBusy(false); show("The previous import session ended. Check Figma before starting another import.", true) } },
      })
      liveConnection.connect()
    }
    const previous = await request("/imports/current").catch(() => null)
    if (epoch !== connectionEpoch) throw new DOMException("Connection changed", "AbortError")
    if (previous?.state === "running") { activeJob = previous.id; setImportBusy(true) }
    void poll()
  } catch (error) {
    if (epoch !== connectionEpoch) throw new DOMException("Connection changed", "AbortError")
    connection = undefined; setConnectionState("disconnected")
    if ((error as { status?: number }).status === 409) retryRestore(next)
    throw error
  }
}
el<HTMLButtonElement>("connect").addEventListener("click", async () => {
  try {
    if (connection) {
      void request("/disconnect", {}).catch(() => {}); connectionEpoch++; clearTimeout(pollTimer)
      connection = undefined; prepared = undefined; activeJob = agentRun = undefined
      liveConnection?.close(); liveConnection = undefined
      rememberedConnection = undefined; clearTimeout(reconnectTimer)
      parent.postMessage({ pluginMessage: { type: "forget-connection" } }, "*")
      setImportBusy(false); setConnectionState("disconnected"); bridgeStatus.textContent = "Disconnected"; el("connect-label").textContent = "Connect bridge"; updatePreview(); return
    }
    const url = new URL(el<HTMLInputElement>("bridge-url").value.trim())
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || !url.hash.slice(1)) throw new Error("Paste the full local bridge connection URL, including the part after #. For a normal import, use an import code from UI Explorer.")
    await connectBridge({ url: url.origin, token: url.hash.slice(1) }); updatePreview()
  } catch (error) { if ((error as Error).name === "AbortError") return; el("connect-label").textContent = "Connect bridge"; bridgeStatus.textContent = String(error) }
})
window.addEventListener("message", (event) => {
  const message = event.data?.pluginMessage
  if (message?.type === "host-yield") {
    parent.postMessage({ pluginMessage: { type: "host-yield", id: message.id } }, "*")
    return
  }
  if (message?.type === "command-progress" && message.requestId) {
    liveConnection?.progress(message.requestId, message.phase)
    if (agentRun || activeJob) show(message.phase)
    return
  }
  if (message?.type === "connection-bootstrap" || message?.type === "connection-context") {
    figmaContext = message.context
    const target = el("figma-destination")
    if (figmaContext) {
      target.hidden = false; target.textContent = `Figma file: ${figmaContext.documentName} · Page: ${figmaContext.pageName}`
      if (connection) void request("/connection/context", { context: figmaContext }).catch(() => {})
    }
    if (message.type === "connection-bootstrap" && !connection && !loading && message.connection) void restoreConnection(message.connection)
    return
  }
  if (!message || message.type !== "result") return
  if (message.requestId && !connection) return
  if (message.requestId && connection) {
    if (liveConnection) liveConnection.result(message.requestId, message)
    else void request("/result", { id: message.requestId, result: message }).catch((error) => { bridgeStatus.textContent = String(error) })
  }
  const kind = commandKinds.get(message.requestId)
  commandKinds.delete(message.requestId)
  if (message.requestId && activeJob) return
  if (message.requestId && agentRun) {
    agentResult.report.push(...message.report ?? []); agentResult.warnings.push(...message.warnings ?? []); agentResult.conflicts.push(...message.conflicts ?? [])
    if (message.error) agentResult.error = message.error
    if (kind === "verify" && message.coverage) {
      agentResult.coverage ??= { missing: [], unexpected: [] }
      agentResult.coverage.missing.push(...message.coverage.missing); agentResult.coverage.unexpected.push(...message.coverage.unexpected)
    }
    if (message.requestId === agentEndId) {
      agentRun = agentEndId = undefined; setImportBusy(false)
      window.dispatchEvent(new MessageEvent("message", { data: { pluginMessage: { type: "result", ...agentResult } } }))
    } else { show("MCP import running. Capturing screens and importing layers…"); status.dataset.busy = "true" }
    return
  }
  if (!message.requestId) { localBusy = false; build.disabled = pasted.disabled = clipboardBuild.disabled = false }
  if (!message.requestId && connection) void request("/busy", { active: false }).catch(() => {})
  const lines = [...message.report ?? [], ...message.warnings ?? [], ...message.conflicts ?? []]
  if (message.coverage?.missing?.length) lines.push("Missing: " + JSON.stringify(message.coverage.missing))
  if (message.coverage?.unexpected?.length) lines.push("Unexpected or orphaned: " + JSON.stringify(message.coverage.unexpected))
  report.replaceChildren(...lines.map((text: string) => { const item = document.createElement("li"); item.textContent = text; return item }))
  const results = el<HTMLDetailsElement>("results")
  results.hidden = lines.length === 0
  results.open = true
  if (!message.requestId && lines.length) results.scrollIntoView({ block: "nearest" })
  el("result-count").textContent = String(lines.length)
  const incomplete = !!message.coverage?.missing?.length || !!message.coverage?.unexpected?.length
  show(message.error || (incomplete ? "Coverage differs from the request. Review import results." : message.conflicts?.length ? "Finished with conflicts left untouched." : "Build completed. Review the results below."), !!message.error || !!message.conflicts?.length || incomplete)
  if (!message.error && !message.conflicts?.length && !incomplete) status.dataset.tone = "success"
  updatePreview()
})

function updatePreview() {
  const local = sourceMode === "local", ready = !!prepared && !!connection
  el("handoff-source").hidden = !local || !!prepared
  el("request-summary").hidden = !local || !prepared
  el("configuration").hidden = local && !ready
  el("clipboard-methods").hidden = local
  el("library-controls").hidden = local && !ready
  el("container-field").hidden = !local
  el("layout-section").hidden = !local || !prepared || prepared.frameCount <= 1
  el("columns-field").hidden = el<HTMLSelectElement>("layout").value !== "grid"
  el("connection-intro").hidden = !!connection
  el("build").hidden = !local || !ready && !localBusy
  el("import-preview").hidden = !local || !ready && !localBusy
  build.disabled = !liveReady || needsReview || localBusy || loading || local && !ready
  pasted.disabled = clipboardBuild.disabled = !liveReady || needsReview || localBusy || loading
  el<HTMLButtonElement>("load-import").disabled = localBusy || loading || !el<HTMLInputElement>("import-code").value.trim()
  el<HTMLInputElement>("import-code").disabled = localBusy || loading
  el("load-label").textContent = loading ? "Loading import…" : "Load import"
  el<HTMLButtonElement>("connect").disabled = loading
  el<HTMLButtonElement>("change-request").disabled = localBusy || loading
  el("gap-summary").textContent = el<HTMLInputElement>("gap").value + " px"
  el("import-preview").textContent = local && prepared ? `${prepared.screenCount} screens & states × ${prepared.widths.length} widths = ${prepared.frameCount} frames` : "Build the design copied from UI Explorer."
  for (const name of ["local", "clipboard"]) el<HTMLButtonElement>("mode-" + name).disabled = localBusy || loading
}
async function loadImport(restoring = false) {
  if (localBusy || loading) return
  prepared = undefined; loading = true; updatePreview()
  const feedback = el("handoff-feedback"); feedback.hidden = false; feedback.dataset.tone = "neutral"; feedback.textContent = "Connecting to your prepared import…"
  try {
    const code = parseImportCode(el<HTMLInputElement>("import-code").value)
    await connectBridge(code)
    const summary = await request("/handoffs/" + code.requestId) as ImportSummary
    if (summary.id !== code.requestId || !Array.isArray(summary.widths) || !Number.isInteger(summary.frameCount) || summary.frameCount < 1) throw new Error("This import request is invalid. Prepare a new code in UI Explorer.")
    prepared = summary
    await request("/handoff/loaded", { id: summary.id }).catch(() => {})
    parent.postMessage({ pluginMessage: { type: "save-connection", connection: { ...connection, requestId: summary.id } } }, "*")
    el("request-project").textContent = summary.project
    el("request-count").textContent = `${summary.screenCount} screens & states · ${summary.frameCount} frames`
    el("request-widths").textContent = "Viewport widths: " + summary.widths.join(", ") + " px"
    el("request-structure").textContent = summary.createComponents === false ? "Regular editable layers · No components or instances" : "Reusable components and instances"
    el<HTMLDetailsElement>("bridge-controls").open = false
    document.querySelector("main")!.scrollTop = 0
    show("Import loaded. Choose the destination and arrangement, then build.")
  } catch (error) {
    if ((error as Error).name === "AbortError") return
    if (restoring && connection && (error as { status?: number }).status === 410) {
      feedback.hidden = true; el<HTMLInputElement>("import-code").value = ""
      parent.postMessage({ pluginMessage: { type: "save-connection", connection } }, "*")
      show("Reconnected to your local project. The previous selection expired. Prepare a selection in UI Explorer or ask your connected agent to import.")
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    feedback.hidden = false
    feedback.dataset.tone = "error"
    feedback.textContent = (error as { status?: number }).status === 401 ? "This code belongs to an earlier UI Explorer session. Copy a new code from Build in Figma." : /fetch|network|Failed to fetch/i.test(message) ? "UI Explorer is unavailable. Keep it running and copy a new code from Build in Figma." : message
    show(feedback.textContent, true)
  } finally { loading = false; updatePreview() }
}
async function restoreConnection(saved: { url: string; token: string; requestId?: string }) {
  try {
    const url = new URL(saved.url)
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) || url.username || url.password || typeof saved.token !== "string") return
    el<HTMLInputElement>("bridge-url").value = `${url.origin}/#${saved.token}`
    if (saved.requestId) {
      el<HTMLInputElement>("import-code").value = `UIX1:${url.port}:${saved.token}:${saved.requestId}`
      await loadImport(true)
    } else {
      await connectBridge({ url: url.origin, token: saved.token }); updatePreview()
      show("Reconnected to your paired local project. Prepare a selection in UI Explorer or ask your connected agent to import.")
    }
  } catch (error) {
    if ((error as Error).name === "AbortError") return
    bridgeStatus.textContent = "Your paired project is unavailable. Start UI Explorer, or use a new import code to pair another session."
    setConnectionState("disconnected")
  }
  if (!connection) retryRestore(saved)
}
function retryRestore(saved: { url: string; token: string; requestId?: string }) {
  clearTimeout(reconnectTimer)
  const epoch = connectionEpoch, input = el<HTMLInputElement>("import-code").value
  reconnectTimer = setTimeout(() => {
    if (epoch === connectionEpoch && !connection && !loading && !localBusy && el<HTMLInputElement>("import-code").value === input) void restoreConnection(saved)
  }, 2500)
}
function setImportBusy(busy: boolean) {
  localBusy = busy
  document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>("main input, main select, main textarea, main button, .source-tabs button").forEach(input => { input.disabled = busy })
  el<HTMLButtonElement>("connect").disabled = false
  el("cancel").hidden = !busy; el<HTMLButtonElement>("cancel").disabled = false
  el("import-progress").hidden = !busy
  pasted.disabled = busy
  updatePreview()
}
async function startLocalImport() {
  if (!connection) { show("Load an import code from UI Explorer to reconnect.", true); return }
  try {
    if (!prepared || prepared.expiresAt <= Date.now()) throw new Error("This import code has expired. Prepare a new code in UI Explorer.")
    const target = placement(), container = el<HTMLInputElement>("container-name").value.trim()
    if (!container) throw new Error("Enter a name for the import section.")
    const singleFrame = prepared.frameCount === 1
    const mode = singleFrame ? "horizontal" : el<HTMLSelectElement>("layout").value as "grid" | "horizontal", columns = singleFrame ? 1 : Number(el<HTMLInputElement>("columns").value), gap = singleFrame ? 80 : Number(el<HTMLInputElement>("gap").value)
    if (mode === "grid" && (!Number.isInteger(columns) || columns < 1 || columns > 20)) { el<HTMLInputElement>("columns").focus(); throw new Error("Choose 1–20 grid columns.") }
    if (!Number.isInteger(gap) || gap < 0 || gap > 1000) { el<HTMLDetailsElement>("layout-options").open = true; el<HTMLInputElement>("gap").focus(); throw new Error("Choose spacing between 0 and 1000 px.") }
    const input = { requestId: prepared.id, placement: { ...target, container }, layout: { mode, columns, gap }, libraries: readLibraries() }
    setImportBusy(true); el<HTMLProgressElement>("import-progress").removeAttribute("value"); show("Starting local import…")
    startingLocal = true
    const job = await request("/imports", input); activeJob = job.id
    el("results").hidden = true
  } catch (error) { setImportBusy(false); show(error instanceof Error ? error.message : String(error), true) }
  finally { startingLocal = false }
}
async function pollJob() {
  const job = await request("/imports/current") as { id: string; state: string; progress: ImportProgress; result?: Record<string, unknown>; error?: string } | null
  if (!job || job.id !== activeJob) { activeJob = undefined; setImportBusy(false); show("The local import session ended. Check Figma before starting another import.", true); return }
  const progress = el<HTMLProgressElement>("import-progress")
  progress.max = Math.max(1, job.progress.total); progress.value = job.progress.completed
  show(job.progress.message); status.dataset.busy = String(job.state === "running")
  if (job.state === "running") return
  activeJob = undefined; setImportBusy(false)
  window.dispatchEvent(new MessageEvent("message", { data: { pluginMessage: { type: "result", ...job.result, error: job.error } } }))
  if (job.state === "cancelled") show(job.error ?? "Import cancelled. Frames already created remain on the canvas.")
}
el<HTMLButtonElement>("cancel").addEventListener("click", async () => {
  if (!activeJob) return
  try { el<HTMLButtonElement>("cancel").disabled = true; await request("/imports/cancel", { id: activeJob }); show("Cancelling import… Frames already created will remain.") }
  catch (error) { show(String(error), true); el<HTMLButtonElement>("cancel").disabled = false }
})
for (const mode of ["local", "clipboard"] as const) el("mode-" + mode).addEventListener("click", () => {
  if (localBusy || loading) return
  sourceMode = mode
  for (const name of ["local", "clipboard"]) el("mode-" + name).setAttribute("aria-pressed", String(mode === name))
  show(mode === "local" ? "Paste an import code prepared in UI Explorer." : "Choose a destination, then build from clipboard or paste the export manually.")
  updatePreview()
  document.querySelector("main")!.scrollTop = 0
})
el("load-import").addEventListener("click", () => void loadImport())
el("import-code").addEventListener("input", updatePreview)
el("import-code").addEventListener("keydown", event => { if ((event as KeyboardEvent).key === "Enter") void loadImport() })
el("change-request").addEventListener("click", () => { prepared = undefined; updatePreview(); el<HTMLInputElement>("import-code").focus(); el<HTMLInputElement>("import-code").select() })
el("layout").addEventListener("change", updatePreview)
for (const event of ["input", "change"]) el("configuration").addEventListener(event, updatePreview)
initializeDropdowns()
updatePreview()
parent.postMessage({ pluginMessage: { type: "connection-bootstrap" } }, "*")
