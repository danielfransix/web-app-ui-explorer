import type { Plugin } from "vite"
import { createExplorer, type Explorer } from "./core/explorer"
import type { UiExplorerOptions } from "./options"

export type { UiExplorerOptions } from "./options"

// The Vite entry point onto the explorer core. It is optional: `web-app-ui-explorer serve` works with Vite like
// any other dev server. The plugin only adds what Vite can do better, running on the app's own origin and starting
// with its dev server. Everything else lives in the core.
export default function uiExplorer(options: UiExplorerOptions = {}): Plugin {
  let explorer: Explorer
  let building = false
  // Where the app is hosted ("" at the domain root); production builds may live under a prefix.
  let basePrefix = ""

  return {
    name: "ui-explorer",

    configResolved(config) {
      building = config.command === "build"
      basePrefix = /^\.?\/?$/.test(config.base) || config.base.startsWith(".") ? "" : config.base.replace(/\/+$/, "")
      explorer = createExplorer({ root: config.root, options })
    },

    transformIndexHtml() {
      // Loaded on every page in development (and in builds that ship the explorer); it only takes over for
      // preview pages and crawls.
      if (building && !options.static) return
      return [{ tag: "script", attrs: { src: explorer.runtimeSrc(building ? basePrefix : "") }, injectTo: "head-prepend" }]
    },

    // A production build carries a read-only snapshot of the explorer: no server, so no exploring or capturing.
    generateBundle() {
      if (!building || !options.static) return
      for (const [fileName, source] of explorer.snapshotFiles(basePrefix)) this.emitFile({ type: "asset", fileName, source })
    },

    configureServer(server) {
      server.watcher.add(explorer.outDir)
      for (const dir of explorer.sourceDirs) server.watcher.add(dir)
      server.watcher.on("change", (file) => explorer.invalidate(file, false))
      server.watcher.on("add", (file) => explorer.invalidate(file, true))
      server.watcher.on("unlink", (file) => explorer.invalidate(file, true))
      server.httpServer?.on("close", () => explorer.dispose())
      server.middlewares.use((req, res, next) => void explorer.handle(req, res, next))
    },
  }
}
