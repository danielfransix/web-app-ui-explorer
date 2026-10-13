import fs from "node:fs"
import path from "node:path"
import { CONFIG_FILES } from "./config"

const VITE_CONFIGS = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"]
const IMPORT = `import uiExplorer from "@danielfransix/web-app-ui-explorer/vite"`

// Each tool's usual dev-server address, used to pre-fill the config. A wrong guess only means editing one line.
const TOOLS: { dependency: string; name: string; port: number }[] = [
  { dependency: "react-scripts", name: "Create React App", port: 3000 },
  { dependency: "next", name: "Next.js", port: 3000 },
  { dependency: "@rsbuild/core", name: "Rsbuild", port: 3000 },
  { dependency: "nuxt", name: "Nuxt", port: 3000 },
  { dependency: "@angular/cli", name: "Angular CLI", port: 4200 },
  { dependency: "astro", name: "Astro", port: 4321 },
  { dependency: "parcel", name: "Parcel", port: 1234 },
  { dependency: "webpack-dev-server", name: "webpack", port: 8080 },
  { dependency: "@sveltejs/kit", name: "SvelteKit", port: 5173 },
  { dependency: "vite", name: "Vite", port: 5173 },
  { dependency: "esbuild", name: "esbuild", port: 8000 },
]

type PackageJson = { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

function readPackage(root: string): PackageJson | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson
  } catch {
    return undefined
  }
}

/** Which bundler the project uses, from its dependencies, and where its dev server usually listens. */
export function detectTool(root: string): { name: string; port: number } {
  const pkg = readPackage(root)
  const dependencies = { ...pkg?.dependencies, ...pkg?.devDependencies }
  const tool = TOOLS.find((candidate) => candidate.dependency in dependencies)
  return tool ? { name: tool.name, port: tool.port } : { name: "your dev server", port: 3000 }
}

function packageManager(root: string) {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml")) || fs.existsSync(path.join(root, "pnpm-workspace.yaml"))) return "pnpm add -D"
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn add -D"
  return "npm install -D"
}

function ignoreGeneratedFiles(root: string, log: (line: string) => void) {
  const gitignore = path.join(root, ".gitignore")
  const existing = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : ""
  if (/^\.ui-explorer\/?$/m.test(existing)) return
  fs.writeFileSync(gitignore, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}\n# UI Explorer output (regenerated)\n.ui-explorer/\n`)
  log("Added .ui-explorer/ to .gitignore.")
}

function addVitePlugin(configFile: string, log: (line: string) => void): boolean {
  const name = path.basename(configFile)
  const source = fs.readFileSync(configFile, "utf8")
  if (source.includes("@danielfransix/web-app-ui-explorer")) {
    log(`${name} already uses the explorer.`)
    return true
  }
  const imports = [...source.matchAll(/^import .*$/gm)]
  const last = imports[imports.length - 1]
  const withImport = last
    ? `${source.slice(0, last.index! + last[0].length)}\n${IMPORT}${source.slice(last.index! + last[0].length)}`
    : `${IMPORT}\n${source}`
  const withPlugin = withImport.replace(/plugins\s*:\s*\[/, (match) => `${match}\n      uiExplorer(),`)
  if (withPlugin === withImport) {
    log(`Could not find a plugins array in ${name}. Add this yourself:\n`)
    log(`  ${IMPORT}\n  plugins: [uiExplorer()]`)
    return false
  }
  fs.writeFileSync(configFile, withPlugin)
  log(`Added the explorer to ${name}.`)
  return true
}

function setUpServe(root: string, log: (line: string) => void): boolean {
  const tool = detectTool(root)
  const existing = CONFIG_FILES.find((name) => fs.existsSync(path.join(root, name)))
  if (existing) log(`${existing} already exists.`)
  else {
    fs.writeFileSync(
      path.join(root, "ui-explorer.config.mjs"),
      `// Settings for web-app-ui-explorer. Every option is optional; see the README for the full list.
export default {
  serve: {
    // The dev server the explorer sits in front of.
    url: "http://localhost:${tool.port}",
  },
}
`,
    )
    log(`Wrote ui-explorer.config.mjs for ${tool.name} (dev server at http://localhost:${tool.port}; change the url if yours differs).`)
  }

  const pkgFile = path.join(root, "package.json")
  const pkg = readPackage(root)
  if (pkg) {
    if (pkg.scripts?.explorer) log(`The "explorer" script already exists in package.json.`)
    else {
      const raw = fs.readFileSync(pkgFile, "utf8")
      const next = { ...JSON.parse(raw), scripts: { ...pkg.scripts, explorer: "web-app-ui-explorer serve" } }
      const indent = /^(\s+)"/m.exec(raw)?.[1] ?? "  "
      fs.writeFileSync(pkgFile, `${JSON.stringify(next, null, indent)}${raw.endsWith("\n") ? "\n" : ""}`)
      log(`Added an "explorer" script to package.json.`)
    }
  }
  return true
}

export type InitOptions = {
  /** `vite` adds the plugin to the Vite config; `serve` sets up the standalone server. Default: the plugin when there is a Vite config, else `serve`. */
  mode?: "vite" | "serve"
}

/** Sets a project up for the explorer and keeps generated files out of git. Returns false if it could not. */
export function init(root: string, log: (line: string) => void, options: InitOptions = {}): boolean {
  const viteConfig = VITE_CONFIGS.map((name) => path.join(root, name)).find((file) => fs.existsSync(file))
  const mode = options.mode ?? (viteConfig ? "vite" : "serve")
  if (mode === "vite") {
    if (!viteConfig) {
      log(`No Vite config found in ${root}. Run \`web-app-ui-explorer init --serve\` instead.`)
      return false
    }
    if (!addVitePlugin(viteConfig, log)) return false
    ignoreGeneratedFiles(root, log)
    log(`\nNext:\n  1. ${packageManager(root)} @danielfransix/web-app-ui-explorer   (if it is not installed yet)\n  2. Start your dev server and open /__explorer/\n  3. Press Explore. It finds your screens and states by itself.`)
    return true
  }
  setUpServe(root, log)
  ignoreGeneratedFiles(root, log)
  const run = fs.existsSync(path.join(root, "pnpm-lock.yaml")) ? "pnpm explorer" : fs.existsSync(path.join(root, "yarn.lock")) ? "yarn explorer" : "npm run explorer"
  log(`\nNext:\n  1. ${packageManager(root)} @danielfransix/web-app-ui-explorer   (if it is not installed yet)\n  2. Start your dev server as usual\n  3. In another terminal: ${run}\n  4. Open the address it prints, then /__explorer/, and press Explore.`)
  return true
}
