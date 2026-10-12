// Runs the explorer from this repository's own build (run `npm run build` at the repo root first).
// In your own project you would import it from the package instead:
//   import uiExplorer from "@danielfransix/web-app-ui-explorer/vite"
import { defineConfig } from "vite"
import uiExplorer from "../../dist/node/vite.js"

export default defineConfig({
  plugins: [uiExplorer({ deny: ["delete account"] })],
  server: { port: 5190, strictPort: true },
})
