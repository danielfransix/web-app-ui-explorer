import fs from "node:fs"
import path from "node:path"

const CONFIGS = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"]
const IMPORT = `import uiExplorer from "@danielfransix/web-app-ui-explorer/vite"`

function packageManager(root: string) {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml")) || fs.existsSync(path.join(root, "pnpm-workspace.yaml")))
    return "pnpm add -D"
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn add -D"
  return "npm install -D"
}

/** Adds the plugin to the project's Vite config and keeps generated files out of git. Returns false if it could not. */
export function init(root: string, log: (line: string) => void): boolean {
  const configFile = CONFIGS.map((name) => path.join(root, name)).find((file) => fs.existsSync(file))
  if (!configFile) {
    log(`No Vite config found in ${root}.`)
    log("The explorer is a Vite plugin today. Add this to a Vite project's plugins:\n")
    log(`  ${IMPORT}\n  plugins: [uiExplorer()]`)
    return false
  }
  const name = path.basename(configFile)
  let source = fs.readFileSync(configFile, "utf8")
  if (source.includes("@danielfransix/web-app-ui-explorer")) {
    log(`${name} already uses the explorer.`)
  } else {
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
    source = withPlugin
    fs.writeFileSync(configFile, source)
    log(`Added the explorer to ${name}.`)
  }

  const gitignore = path.join(root, ".gitignore")
  const existing = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : ""
  if (!/^\.ui-explorer\/?$/m.test(existing)) {
    fs.writeFileSync(gitignore, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}\n# UI Explorer output (regenerated)\n.ui-explorer/\n`)
    log("Added .ui-explorer/ to .gitignore.")
  }

  log(`\nNext:\n  1. ${packageManager(root)} @danielfransix/web-app-ui-explorer   (if it is not installed yet)\n  2. Start your dev server and open /__explorer/\n  3. Press Explore. It finds your screens and states by itself.`)
  return true
}
