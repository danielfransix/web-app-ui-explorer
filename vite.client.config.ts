import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"

// The explorer's own page, built once and served by the plugin from dist/client. It never goes through the
// host app's build, so it does not depend on the host's React, Tailwind or aliases.
export default defineConfig({
  root: path.resolve(__dirname, "src/client"),
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(__dirname, "dist/client"),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
})
