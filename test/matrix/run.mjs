// The on-demand bundler matrix: the same contract (test/contract.mjs) against bundlers that have to be downloaded.
//
//   npm run test:matrix                  every bundler below
//   npm run test:matrix -- cra next      only these
//
// Each bundler is installed once into a cache folder in the system temp directory and reused on later runs. The
// explorer is never configured in any of them: only `serve` runs, in front of the bundler's own dev server.
import { spawn, spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runContract } from "../contract.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const app = fs.readFileSync(path.join(here, "../fixtures/react-app/App.jsx"), "utf8")
// The long form of the path: a short 8.3 name (DANIEL~1) makes Node's file watcher abort on Windows.
const cache = path.join(fs.realpathSync.native(os.tmpdir()), "uix-matrix")

const rootDiv = '<div id="root"></div>'
const index = (extra = "") => `import { createRoot } from "react-dom/client"\nimport App from "./App"\n${extra}createRoot(document.getElementById("root")).render(<App />)\n`

/** What each bundler needs: packages, files, how to start its dev server and how to build. */
const BUNDLERS = {
  webpack: {
    label: "webpack (webpack-dev-server)",
    install: ["--legacy-peer-deps"],
    dependencies: { react: "18.3.1", "react-dom": "18.3.1", webpack: "^5", "webpack-cli": "^6", "webpack-dev-server": "^5", "html-webpack-plugin": "^5", "babel-loader": "^10", "@babel/core": "^7", "@babel/preset-env": "^7", "@babel/preset-react": "^7" },
    files: {
      "public/index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>webpack app</title></head><body>${rootDiv}</body></html>`,
      "src/App.jsx": app,
      "src/index.jsx": index(),
      "webpack.config.cjs": `const HtmlWebpackPlugin = require("html-webpack-plugin")
module.exports = (env, argv) => ({
  entry: "./src/index.jsx",
  output: { path: __dirname + "/dist", filename: "[name].js", publicPath: "/", clean: true },
  resolve: { extensions: [".js", ".jsx"] },
  module: { rules: [{ test: /\\.jsx?$/, exclude: /node_modules/, use: { loader: "babel-loader", options: { presets: ["@babel/preset-env", ["@babel/preset-react", { runtime: "automatic" }]] } } }] },
  plugins: [new HtmlWebpackPlugin({ template: "./public/index.html" })],
  devServer: { host: "127.0.0.1", hot: true, historyApiFallback: true },
  devtool: argv.mode === "production" ? false : "eval-source-map",
})
`,
    },
    start: (port) => ({ script: "node_modules/webpack-cli/bin/cli.js", args: ["serve", "--mode", "development", "--port", String(port)] }),
    build: { script: "node_modules/webpack-cli/bin/cli.js", args: ["--mode", "production"], out: "dist" },
    edit: "src/App.jsx",
  },
  cra: {
    label: "Create React App (react-scripts 5)",
    install: ["--legacy-peer-deps"],
    // ajv 8 is pinned because react-scripts 5 does not declare it and npm otherwise hoists the wrong major (a known CRA 5 install issue).
    dependencies: { react: "18.3.1", "react-dom": "18.3.1", "react-scripts": "5.0.1", ajv: "^8" },
    extraPackage: { browserslist: { production: [">0.2%", "not dead"], development: ["last 1 chrome version"] } },
    files: {
      "public/index.html": `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><title>CRA app</title></head><body>${rootDiv}</body></html>`,
      "src/App.js": app,
      "src/index.js": index(),
    },
    env: { BROWSER: "none", CI: "false", DISABLE_ESLINT_PLUGIN: "true", HOST: "127.0.0.1", GENERATE_SOURCEMAP: "false" },
    start: (port) => ({ script: "node_modules/react-scripts/bin/react-scripts.js", args: ["start"], env: { PORT: String(port) } }),
    build: { script: "node_modules/react-scripts/bin/react-scripts.js", args: ["build"], out: "build" },
    edit: "src/App.js",
  },
  parcel: {
    label: "Parcel 2",
    install: [],
    dependencies: { react: "18.3.1", "react-dom": "18.3.1", parcel: "^2" },
    files: {
      "src/index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Parcel app</title></head><body>${rootDiv}<script type="module" src="./index.jsx"></script></body></html>`,
      "src/App.jsx": app,
      "src/index.jsx": index(),
    },
    start: (port) => ({ script: "node_modules/parcel/lib/bin.js", args: ["serve", "src/index.html", "--port", String(port), "--host", "127.0.0.1", "--no-cache", "--no-autoinstall", "--dist-dir", ".parcel-dev"] }),
    build: { script: "node_modules/parcel/lib/bin.js", args: ["build", "src/index.html", "--no-cache", "--dist-dir", "dist", "--public-url", "./"], out: "dist" },
    edit: "src/App.jsx",
  },
  rsbuild: {
    label: "Rsbuild (Rspack)",
    install: [],
    dependencies: { react: "18.3.1", "react-dom": "18.3.1", "@rsbuild/core": "^1", "@rsbuild/plugin-react": "^1" },
    files: {
      "rsbuild.config.mjs": `import { defineConfig } from "@rsbuild/core"
import { pluginReact } from "@rsbuild/plugin-react"
export default defineConfig({ plugins: [pluginReact()], source: { entry: { index: "./src/index.jsx" } }, html: { title: "Rsbuild app" }, server: { host: "127.0.0.1" } })
`,
      "src/App.jsx": app,
      "src/index.jsx": index(),
    },
    start: (port) => ({ script: "node_modules/@rsbuild/core/bin/rsbuild.js", args: ["dev", "--port", String(port)] }),
    build: { script: "node_modules/@rsbuild/core/bin/rsbuild.js", args: ["build"], out: "dist" },
    edit: "src/App.jsx",
  },
  next: {
    label: "Next.js (App Router)",
    install: [],
    dependencies: { react: "19", "react-dom": "19", next: "^16" },
    env: { NEXT_TELEMETRY_DISABLED: "1" },
    files: {
      "next.config.mjs": `export default { output: "export" }\n`,
      "app/layout.jsx": `export const metadata = { title: "Next app" }\nexport default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  )\n}\n`,
      "app/page.jsx": `import App from "../src/App"\nexport default function Page() {\n  return <App />\n}\n`,
      "src/App.jsx": `"use client"\n${app}`,
    },
    start: (port) => ({ script: "node_modules/next/dist/bin/next", args: ["dev", "-p", String(port), "-H", "127.0.0.1"] }),
    build: { script: "node_modules/next/dist/bin/next", args: ["build"], out: "out" },
    edit: "src/App.jsx",
  },
}

const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" })
  else {
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      child.kill("SIGKILL")
    }
  }
}

function install(name, recipe) {
  const dir = path.join(cache, name)
  fs.mkdirSync(dir, { recursive: true })
  const pkg = { name: `uix-matrix-${name}`, private: true, version: "0.0.0", dependencies: recipe.dependencies, ...recipe.extraPackage }
  const key = crypto.createHash("sha1").update(JSON.stringify([pkg, recipe.install])).digest("hex")
  const marker = path.join(dir, "node_modules/.uix-installed")
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === key) return dir
  fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true })
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2))
  console.log(`  installing ${Object.keys(recipe.dependencies).join(", ")} ...`)
  const result = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", ...recipe.install], { cwd: dir, encoding: "utf8", shell: process.platform === "win32" })
  if (result.status !== 0) throw new Error(`npm install failed:\n${result.stdout}\n${result.stderr}`)
  fs.writeFileSync(marker, key)
  return dir
}

function writeProject(dir, recipe) {
  for (const folder of ["src", "app", "public", "dist", "build", "out", ".next", ".parcel-dev", ".parcel-cache", ".ui-explorer"]) fs.rmSync(path.join(dir, folder), { recursive: true, force: true })
  for (const [file, content] of Object.entries(recipe.files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), content)
  }
}

function start(dir, spec, env) {
  let output = ""
  const child = spawn(process.execPath, [path.join(dir, spec.script), ...spec.args], {
    cwd: dir,
    env: { ...process.env, ...env, ...spec.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  })
  child.stdout.on("data", (chunk) => (output += chunk))
  child.stderr.on("data", (chunk) => (output += chunk))
  return { child, output: () => output }
}

async function waitForServer(url, running, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (running.child.exitCode !== null) throw new Error(`the dev server exited (${running.child.exitCode}):\n${running.output().slice(-2000)}`)
    try {
      const response = await fetch(url, { headers: { accept: "text/html" } })
      if (response.status === 200) return
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`the dev server did not answer within ${timeoutMs / 1000}s:\n${running.output().slice(-2000)}`)
}

async function runOne(name) {
  const recipe = BUNDLERS[name]
  const dir = install(name, recipe)
  writeProject(dir, recipe)
  const port = await freePort()
  const dev = start(dir, recipe.start(port), recipe.env)
  try {
    const target = `http://127.0.0.1:${port}`
    await waitForServer(`${target}/`, dev, 240_000)
    return await runContract({
      name: recipe.label,
      target,
      root: dir,
      edit: recipe.edit,
      live: "websocket",
      build: async () => {
        const build = start(dir, recipe.build, recipe.env)
        const code = await new Promise((resolve) => build.child.on("close", resolve))
        if (code !== 0) throw new Error(`the production build failed:\n${build.output().slice(-2000)}`)
        return path.join(dir, recipe.build.out)
      },
    })
  } catch (error) {
    error.message = `${error.message}\n--- dev server output ---\n${dev.output().slice(-1500)}`
    throw error
  } finally {
    killTree(dev.child)
  }
}

const wanted = process.argv.slice(2)
const names = wanted.length ? wanted : Object.keys(BUNDLERS)
for (const name of names) if (!BUNDLERS[name]) (console.error(`Unknown bundler "${name}". Choose from: ${Object.keys(BUNDLERS).join(", ")}`), process.exit(2))

const results = []
for (const name of names) {
  console.log(`\n== ${BUNDLERS[name].label}`)
  const started = Date.now()
  try {
    const result = await runOne(name)
    results.push({ name, ok: true, detail: `${result.states} states, ${result.thumbnails} thumbnails`, seconds: Math.round((Date.now() - started) / 1000) })
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    results.push({ name, ok: false, detail: String(error instanceof Error ? error.message : error).split("\n")[0], seconds: Math.round((Date.now() - started) / 1000) })
  }
}
console.log("\nResults")
for (const result of results) console.log(`  ${result.ok ? "PASS" : "FAIL"}  ${BUNDLERS[result.name].label.padEnd(34)} ${String(result.seconds).padStart(4)}s  ${result.detail}`)
process.exit(results.every((result) => result.ok) ? 0 : 1)
