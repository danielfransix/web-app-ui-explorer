import { execFile } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { detectTool } from "./init"

// Evidence-gathering only: nothing here talks to the terminal or starts a process. Every lookup is best-effort —
// a missing tool, a sandboxed container or a permission error degrades to "no evidence" rather than throwing, so a
// caller can always fall back to a narrower signal (or none) instead of failing outright.

function tryConnect(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    socket.setTimeout(timeoutMs)
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

/** Polls until something answers on host:port, or the timeout elapses. */
export async function waitForReachable(host: string, port: number, timeoutSeconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000
  let reachable = await tryConnect(host, port)
  while (!reachable && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    reachable = await tryConnect(host, port)
  }
  return reachable
}

const TITLE_RE = /<title[^>]*>([^<]*)<\/title>/i

/** The root page's <title>, read from a bounded, time-limited fetch. Undefined for anything but a small, quick HTML response — never throws. */
export async function fetchTitle(origin: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(1500) })
    const reader = response.body?.getReader()
    if (!reader) return undefined
    let text = ""
    try {
      while (text.length < 8192) {
        const { done, value } = await reader.read()
        if (done) break
        text += Buffer.from(value).toString("utf8")
        const match = TITLE_RE.exec(text)
        if (match) return match[1].trim() || undefined
      }
      return undefined
    } finally {
      await reader.cancel().catch(() => {})
    }
  } catch {
    return undefined
  }
}

function execText(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 2000, windowsHide: true }, (error, stdout) => resolve(error ? undefined : stdout))
  })
}

export type PortOwner = { commandLine?: string; cwd?: string }

async function identifyWindows(port: number): Promise<PortOwner | undefined> {
  const netstat = await execText("netstat.exe", ["-ano", "-p", "tcp"])
  if (!netstat) return undefined
  const listening = new RegExp(`:${port}\\s+.*LISTENING`)
  const line = netstat.split(/\r?\n/).find((entry) => listening.test(entry))
  const pid = line?.trim().split(/\s+/).pop()
  if (!pid || !/^\d+$/.test(pid)) return undefined
  // Windows has no built-in way to read an arbitrary process's working directory; the command line is the best
  // available signal there.
  const info = await execText("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
  ])
  const commandLine = info?.trim()
  return commandLine ? { commandLine } : undefined
}

async function identifyMac(port: number): Promise<PortOwner | undefined> {
  const pidOut = await execText("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])
  const pid = pidOut?.trim().split(/\s+/)[0]
  if (!pid || !/^\d+$/.test(pid)) return undefined
  const cwdOut = await execText("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"])
  const cwdLine = cwdOut?.split(/\r?\n/).find((entry) => entry.startsWith("n"))
  const cwd = cwdLine?.slice(1).trim()
  return cwd ? { cwd } : undefined
}

/** Falls back to /proc directly when lsof isn't installed (common in minimal containers). */
function identifyLinuxViaProc(port: number): PortOwner | undefined {
  try {
    const hexPort = port.toString(16).padStart(4, "0").toUpperCase()
    const tcp = fs.readFileSync("/proc/net/tcp", "utf8")
    const line = tcp
      .split("\n")
      .slice(1)
      .find((entry) => entry.trim().split(/\s+/)[1]?.split(":")[1] === hexPort)
    const inode = line?.trim().split(/\s+/)[9]
    if (!inode || inode === "0") return undefined
    for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      try {
        const fds = fs.readdirSync(`/proc/${pid}/fd`)
        const owns = fds.some((fd) => {
          try {
            return fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`
          } catch {
            return false
          }
        })
        if (owns) return { cwd: fs.readlinkSync(`/proc/${pid}/cwd`) }
      } catch {
        continue
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

async function identifyLinux(port: number): Promise<PortOwner | undefined> {
  const pidOut = await execText("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])
  const pid = pidOut?.trim().split(/\s+/)[0]
  if (pid && /^\d+$/.test(pid)) {
    try {
      return { cwd: fs.readlinkSync(`/proc/${pid}/cwd`) }
    } catch {
      return undefined
    }
  }
  return identifyLinuxViaProc(port)
}

/** Which process owns a listening TCP port, and where it was launched from, when the platform allows finding out. */
export async function identifyPortOwner(port: number): Promise<PortOwner | undefined> {
  try {
    if (process.platform === "win32") return await identifyWindows(port)
    if (process.platform === "darwin") return await identifyMac(port)
    return await identifyLinux(port)
  } catch {
    return undefined
  }
}

export type Candidate = { url: string; port: number; title?: string; commandLine?: string; cwd?: string }

/**
 * Checks only the bundler's own usual port (a narrow, low-noise probe — not a sweep of common ports, which would
 * too easily match an unrelated project's server when several codebases run locally at once) and gathers whatever
 * evidence is available about whatever answers there.
 */
export async function findAlternateCandidate(root: string, configuredPort: number): Promise<Candidate | undefined> {
  const tool = detectTool(root)
  if (tool.port === configuredPort) return undefined
  if (!(await tryConnect("localhost", tool.port))) return undefined
  const url = `http://localhost:${tool.port}`
  const [title, owner] = await Promise.all([fetchTitle(url), identifyPortOwner(tool.port)])
  return { url, port: tool.port, title, ...owner }
}

export type DevScript = { name: string; command: string }

const LIKELY_DEV_SCRIPTS = ["dev", "start", "start:dev", "develop", "serve"]

function runner(root: string): string {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm run"
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn run"
  return "npm run"
}

/** Script names in package.json that plausibly start a dev server. Never guesses which one is right — only lists what's there, for a person to choose from. */
export function suggestDevScripts(root: string): DevScript[] {
  let scripts: Record<string, string> | undefined
  try {
    scripts = (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts
  } catch {
    return []
  }
  if (!scripts) return []
  const prefix = runner(root)
  return LIKELY_DEV_SCRIPTS.filter((name) => name in scripts!).map((name) => ({ name, command: `${prefix} ${name}` }))
}
