import { execFile, spawn } from "node:child_process"

export type SpawnedDevServer = {
  /** Resolves once the process (and, where the platform allows it, its whole tree) has been asked to stop. */
  stop(): Promise<void>
}

/**
 * Starts a dev-server command a person has just seen and approved, and owns its full process tree so stopping it
 * never leaves orphans behind — npm/yarn/pnpm scripts commonly spawn further children (npm -> react-scripts ->
 * webpack-dev-server), and killing only the immediate child leaves the rest running.
 */
export function spawnDevServer(command: string, cwd: string, log: (line: string) => void): SpawnedDevServer {
  const child = spawn(command, {
    cwd,
    shell: true,
    stdio: "inherit",
    // POSIX: its own process group, so the whole tree can be killed by signalling the group. Windows has no
    // equivalent of process groups here; cleanup instead walks the tree with taskkill (see stop()).
    detached: process.platform !== "win32",
  })

  let stopped = false
  child.on("exit", (code, signal) => {
    if (stopped) return
    log(`"${command}" exited${code !== null ? ` with code ${code}` : signal ? ` (${signal})` : ""}.`)
  })

  async function stop(): Promise<void> {
    if (stopped || child.pid === undefined) return
    stopped = true
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => resolve()))
      return
    }
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {
      child.kill("SIGTERM")
    }
  }

  return { stop }
}
