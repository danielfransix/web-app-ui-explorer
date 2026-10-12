import { defineConfig } from "tsup"

export default defineConfig([
  // Node side: the CLI, the crawler and the Vite plugin.
  {
    entry: {
      "node/cli": "src/node/cli.ts",
      "node/index": "src/node/index.ts",
      "node/vite": "src/node/vite.ts",
    },
    format: ["esm"],
    platform: "node",
    target: "node20",
    dts: { entry: { "node/index": "src/node/index.ts", "node/vite": "src/node/vite.ts" } },
    clean: false,
    sourcemap: true,
    external: ["playwright", "vite"],
  },
  // Browser side: injected into the host app and into crawler pages. One self-contained script, no imports at runtime.
  {
    entry: { "runtime/runtime": "src/runtime/index.ts" },
    format: ["iife"],
    globalName: "__uixRuntime",
    platform: "browser",
    target: "es2020",
    minify: false,
    sourcemap: false,
    clean: false,
    outExtension: () => ({ js: ".js" }),
  },
])
