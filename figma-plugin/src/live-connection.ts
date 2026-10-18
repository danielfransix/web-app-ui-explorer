import type { BridgeCommand, BridgeResult } from "../../src/shared/bridge"

type Command = { id: string; command: BridgeCommand }
type Options = {
  url: string; token: string; clientId: string
  command: (message: Command) => void
  presence: (clients: { name: string }[]) => void
  state: (state: "connected" | "reconnecting", message: string) => void
  review: (commands: { id: string; phase: string }[]) => void
  context: () => unknown
  execution: (state: { runId: string | null; commands: { id: string }[]; needsReview: unknown[] }) => void
}

/** Retain results until acknowledged. Delivered commands are never automatically replayed. */
export class LiveConnection {
  private socket?: WebSocket
  private timer?: ReturnType<typeof setTimeout>
  private closed = false
  private attempts = 0
  private active = new Set<string>()
  private results = new Map<string, BridgeResult>()
  private received = new Set<string>()
  constructor(private options: Options) {}
  connect(): void {
    if (this.closed) return
    const url = new URL("/socket", this.options.url); url.protocol = "ws:"
    const socket = this.socket = new WebSocket(url)
    const handshake = setTimeout(() => socket.close(), 5000)
    socket.onopen = () => socket.send(JSON.stringify({ type: "hello", token: this.options.token, clientId: this.options.clientId, activeIds: [...this.active], context: this.options.context() }))
    socket.onerror = () => { /* onclose handles retry without exposing credentials. */ }
    socket.onmessage = event => {
      if (this.closed || socket !== this.socket) return
      try {
        const message = JSON.parse(event.data)
        if (message.type === "ready") {
          clearTimeout(handshake); this.attempts = 0
          this.options.state("connected", "Live connection ready.")
          this.options.presence(message.clients ?? []); this.options.review(message.needsReview ?? [])
          this.options.execution(message)
          for (const [id, result] of this.results) this.send({ type: "result", id, result })
          const unknown = (message.commands ?? []).filter((command: { id: string; delivered: boolean }) => command.delivered && !this.received.has(command.id))
          if (unknown.length) this.options.review(unknown)
        } else if (message.type === "command") {
          if (typeof message.id !== "string" || !message.command) return
          if (this.results.has(message.id)) { this.send({ type: "result", id: message.id, result: this.results.get(message.id) }); return }
          if (this.received.has(message.id)) return
          this.received.add(message.id); this.active.add(message.id)
          this.send({ type: "progress", id: message.id, phase: "Received by plugin" })
          this.options.command(message)
        } else if (message.type === "result-ack") {
          this.results.delete(message.id); this.active.delete(message.id)
          if (!message.accepted) this.options.review([{ id: message.id, phase: "The bridge no longer has this command. Inspect its outcome in Figma." }])
          // Keep only a bounded duplicate-delivery history; acknowledged commands are not replayed.
          if (this.received.size > 512) for (const id of this.received) if (!this.active.has(id) && !this.results.has(id)) { this.received.delete(id); break }
        } else if (message.type === "presence") {
          this.options.presence(message.clients ?? []); this.options.review(message.needsReview ?? [])
          this.options.execution(message)
        }
      } catch { socket.close(4400, "Invalid bridge message") }
    }
    socket.onclose = event => {
      clearTimeout(handshake)
      if (this.closed || socket !== this.socket) return
      if (event.code === 4401) {
        this.options.state("reconnecting", "Pairing was rejected. Load a current import code.")
        return
      }
      this.options.state("reconnecting", event.code === 4409 ? "Another plugin is connected. Retrying automatically when it closes." : "Connection interrupted. Reconnecting; commands will not be replayed.")
      this.timer = setTimeout(() => this.connect(), Math.min(5000, 250 * 2 ** this.attempts++))
    }
  }
  private send(message: unknown): void { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)) }
  result(id: string, result: BridgeResult): void {
    this.active.delete(id); this.results.set(id, result)
    this.send({ type: "result", id, result })
  }
  progress(id: string, phase: string): void { this.send({ type: "progress", id, phase }) }
  close(): void { this.closed = true; clearTimeout(this.timer); this.socket?.close(1000, "Disconnected by user") }
}
