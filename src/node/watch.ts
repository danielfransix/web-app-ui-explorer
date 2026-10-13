import fs from "node:fs"
import path from "node:path"

// Source changes for hosts that have no file events of their own (the standalone proxy). One recursive
// watcher per folder that exists; a rename means a file was added or removed.

const SKIP = /(^|[\\/])(node_modules|\.git)([\\/]|$)/

export function watchSources(dirs: string[], onChange: (file: string, structural: boolean) => void): { close(): void } {
  const watchers: fs.FSWatcher[] = []
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    try {
      const watcher = fs.watch(dir, { recursive: true }, (event, name) => {
        if (!name) return
        const file = path.join(dir, name.toString())
        if (SKIP.test(name.toString())) return
        onChange(file, event === "rename")
      })
      // A folder that disappears while watched must not take the server down.
      watcher.on("error", () => {})
      watchers.push(watcher)
    } catch {
      // A platform without recursive watching: the revision then only refreshes on restart.
    }
  }
  return {
    close() {
      for (const watcher of watchers) watcher.close()
    },
  }
}
