import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import {
  affectsPreviews,
  charsetOf,
  computeRevision,
  defineConfig,
  detectTool,
  guessSources,
  init,
  injectIntoHtml,
  listSources,
  loadConfig,
  normaliseTarget,
  previewPath,
  rewriteCookie,
  rewriteLocation,
} from "../dist/node/index.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "uix-"))
const write = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), text)
}

// ---- Preview URLs -----------------------------------------------------------------------------------------

test("a recipe scenario previews as the app at its start path with the preview parameters", () => {
  assert.equal(previewPath({ id: "a b", title: "x", group: "g" }, "/"), "/?__uix=a%20b&__uix_embed=1")
  assert.equal(previewPath({ id: "x", title: "x", group: "g" }, "/app?tab=1"), "/app?tab=1&__uix=x&__uix_embed=1")
  assert.equal(previewPath({ id: "x", title: "x", group: "g", startPath: "/other" }, "/"), "/other?__uix=x&__uix_embed=1")
})

test("a scenario with its own url is previewed exactly there", () => {
  assert.equal(previewPath({ id: "x", title: "x", group: "g", url: "/?scenario=x" }, "/"), "/?scenario=x")
})

// ---- Revision --------------------------------------------------------------------------------------------

test("only files that can change what a preview shows count towards the revision", () => {
  assert.equal(affectsPreviews("src/screens/Home.tsx"), true)
  assert.equal(affectsPreviews("src/styles.css"), true)
  assert.equal(affectsPreviews("src/Home.stories.tsx"), false)
  assert.equal(affectsPreviews("src/Home.test.ts"), false)
  assert.equal(affectsPreviews("src/stories/Intro.tsx"), false)
  assert.equal(affectsPreviews(".ui-explorer/scenarios.json"), false)
  assert.equal(affectsPreviews("README.md"), false)
})

test("the revision is stable, changes with the source, and ignores line endings", () => {
  const root = temp()
  write(root, "src/App.tsx", "export default () => null\n")
  const first = computeRevision(root)
  assert.equal(computeRevision(root), first)
  write(root, "src/App.tsx", "export default () => null\r\n")
  assert.equal(computeRevision(root), first, "CRLF and LF hash the same")
  write(root, "src/App.tsx", "export default () => 1\n")
  assert.notEqual(computeRevision(root), first)
  write(root, "src/App.stories.tsx", "stories change nothing")
  const withStories = computeRevision(root)
  write(root, "src/App.stories.tsx", "still nothing")
  assert.equal(computeRevision(root), withStories)
})

// ---- Source files -------------------------------------------------------------------------------------------

test("listing sources skips tests, stories, declarations and build output", () => {
  const root = temp()
  write(root, "src/Home.tsx", "")
  write(root, "src/Home.test.tsx", "")
  write(root, "src/Home.stories.tsx", "")
  write(root, "src/types.d.ts", "")
  write(root, "src/util.ts", "")
  write(root, "node_modules/x/index.tsx", "")
  write(root, "dist/out.tsx", "")
  assert.deepEqual(listSources(root, ["src"]), ["src/Home.tsx", "src/util.ts"])
  assert.deepEqual(listSources(root, ["src"], false), ["src/Home.tsx"], "the tree lists only files that can render")
})

test("a state is traced to the file that renders what it shows", () => {
  const root = temp()
  write(root, "src/screens/Billing.tsx", `export default () => <main><h1>Billing</h1><button>Download invoice</button></main>`)
  write(root, "src/screens/Profile.tsx", `export default () => <main><h1>Profile</h1><button>Save profile</button></main>`)
  write(root, "src/components/Button.tsx", `export default ({ children }) => <button>{children}</button>`)
  const scenarios = [
    { id: "billing", title: "Billing", group: "Billing" },
    { id: "invoice", title: "Download invoice", group: "Billing", description: "Billing › Download invoice" },
    { id: "profile", title: "Profile", group: "Profile" },
  ]
  const snapshots = {
    billing: { headings: ["Billing"], dialogs: [] },
    invoice: { headings: ["Billing"], dialogs: [] },
    profile: { headings: ["Profile"], dialogs: [] },
  }
  const found = guessSources(root, scenarios, snapshots)
  assert.equal(found.billing, "src/screens/Billing.tsx")
  assert.equal(found.invoice, "src/screens/Billing.tsx")
  assert.equal(found.profile, "src/screens/Profile.tsx")
})

// ---- init ------------------------------------------------------------------------------------------------

test("init adds the plugin to a Vite config once and keeps generated files out of git", () => {
  const root = temp()
  write(root, "vite.config.ts", `import { defineConfig } from "vite"\nimport react from "@vitejs/plugin-react"\n\nexport default defineConfig({\n  plugins: [react()],\n})\n`)
  write(root, ".gitignore", "node_modules")
  const lines = []
  assert.equal(init(root, (line) => lines.push(line)), true)
  const config = fs.readFileSync(path.join(root, "vite.config.ts"), "utf8")
  assert.match(config, /import uiExplorer from "@danielfransix\/web-app-ui-explorer\/vite"/)
  assert.match(config, /plugins: \[\s*uiExplorer\(\),\s*react\(\)\]/)
  assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /^\.ui-explorer\/$/m)
  // Running it again changes nothing.
  assert.equal(init(root, () => {}), true)
  assert.equal(fs.readFileSync(path.join(root, "vite.config.ts"), "utf8"), config)
  assert.equal((fs.readFileSync(path.join(root, ".gitignore"), "utf8").match(/\.ui-explorer\//g) ?? []).length, 1)
})

test("init sets up the standalone server when there is no Vite config", () => {
  const root = temp()
  write(root, "package.json", JSON.stringify({ name: "cra-app", scripts: { start: "react-scripts start" }, dependencies: { "react-scripts": "5.0.1" } }, null, 2))
  const lines = []
  assert.equal(init(root, (line) => lines.push(line)), true)
  // The config points at the tool's usual port, there is an "explorer" script, and generated files stay out of git.
  const config = fs.readFileSync(path.join(root, "ui-explorer.config.mjs"), "utf8")
  assert.match(config, /url: "http:\/\/localhost:3000"/)
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  assert.equal(pkg.scripts.explorer, "web-app-ui-explorer serve")
  assert.equal(pkg.scripts.start, "react-scripts start")
  assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /^\.ui-explorer\/$/m)
  assert.match(lines.join("\n"), /npm run explorer/)
  // Running it again keeps what is there.
  fs.writeFileSync(path.join(root, "ui-explorer.config.mjs"), 'export default { serve: { url: "http://localhost:9999" } }\n')
  assert.equal(init(root, () => {}), true)
  assert.match(fs.readFileSync(path.join(root, "ui-explorer.config.mjs"), "utf8"), /9999/)
  assert.equal((fs.readFileSync(path.join(root, ".gitignore"), "utf8").match(/\.ui-explorer\//g) ?? []).length, 1)
})

test("init guesses each bundler's usual dev server port", () => {
  const cases = [
    [{ next: "16.0.0" }, "Next.js", 3000],
    [{ parcel: "2.0.0" }, "Parcel", 1234],
    [{ "webpack-dev-server": "5.0.0" }, "webpack", 8080],
    [{ "@angular/cli": "20.0.0" }, "Angular CLI", 4200],
    [{ "@rsbuild/core": "1.0.0" }, "Rsbuild", 3000],
    [{}, "your dev server", 3000],
  ]
  for (const [dependencies, name, port] of cases) {
    const root = temp()
    write(root, "package.json", JSON.stringify({ name: "x", devDependencies: dependencies }))
    assert.deepEqual(detectTool(root), { name, port })
  }
})

test("init can set up the standalone server in a Vite project, and says what to add when it cannot edit the Vite config", () => {
  const root = temp()
  write(root, "vite.config.ts", "export default {}\n")
  write(root, "package.json", JSON.stringify({ name: "v", devDependencies: { vite: "8.0.0" } }))
  assert.equal(init(root, () => {}, { mode: "serve" }), true)
  assert.match(fs.readFileSync(path.join(root, "ui-explorer.config.mjs"), "utf8"), /localhost:5173/)
  assert.equal(fs.readFileSync(path.join(root, "vite.config.ts"), "utf8"), "export default {}\n")
  const lines = []
  assert.equal(init(root, (line) => lines.push(line), { mode: "vite" }), false)
  assert.match(lines.join("\n"), /plugins: \[uiExplorer\(\)\]/)
  assert.equal(init(temp(), () => {}, { mode: "vite" }), false)
})

// ---- HTML and header rewriting (the proxy) ---------------------------------------------------------------

const TAG = '<script src="/__explorer/runtime.js"></script>'

test("the runtime tag goes first in the head, after a charset declaration", () => {
  assert.equal(injectIntoHtml("<!doctype html><html><head><title>x</title></head><body></body></html>", TAG), `<!doctype html><html><head>${TAG}<title>x</title></head><body></body></html>`)
  assert.equal(injectIntoHtml('<html><head><meta charset="utf-8"><title>x</title></head></html>', TAG), `<html><head><meta charset="utf-8">${TAG}<title>x</title></head></html>`)
  assert.equal(injectIntoHtml('<HEAD data-x="1"><title>x</title></HEAD>', TAG), `<HEAD data-x="1">${TAG}<title>x</title></HEAD>`)
})

test("a page without a head still gets the tag, and a fragment or a tagged page is left alone", () => {
  assert.equal(injectIntoHtml("<html><body>hi</body></html>", TAG), `<html><head>${TAG}</head><body>hi</body></html>`)
  assert.equal(injectIntoHtml("<!doctype html><p>hi</p>", TAG), `<!doctype html>${TAG}<p>hi</p>`)
  // An htmx-style partial must not receive a script.
  assert.equal(injectIntoHtml("<div>partial</div>", TAG), "<div>partial</div>")
  const tagged = `<html><head>${TAG}</head></html>`
  assert.equal(injectIntoHtml(tagged, TAG), tagged)
  // Under a base path the tag's address differs, and a page that already has it is still recognised.
  const based = '<script src="/app/__explorer/runtime.js"></script>'
  assert.equal(injectIntoHtml(`<html><head>${based}</head></html>`, based), `<html><head>${based}</head></html>`)
})

test("redirects, cookies and charsets are rewritten for the proxy", () => {
  assert.equal(rewriteLocation("http://localhost:3000/login?x=1", "http://localhost:3000", "http://127.0.0.1:5199"), "http://127.0.0.1:5199/login?x=1")
  assert.equal(rewriteLocation("/relative", "http://localhost:3000", "http://127.0.0.1:5199"), "/relative")
  assert.equal(rewriteLocation("https://elsewhere.test/", "http://localhost:3000", "http://127.0.0.1:5199"), "https://elsewhere.test/")
  assert.equal(rewriteCookie("sid=1; Path=/; Domain=localhost; HttpOnly", false), "sid=1; Path=/; HttpOnly")
  assert.equal(rewriteCookie("sid=1; Secure; SameSite=None", false), "sid=1; SameSite=Lax")
  assert.equal(rewriteCookie("sid=1; Secure; SameSite=None", true), "sid=1; Secure; SameSite=None")
  assert.equal(charsetOf("text/html; charset=UTF-8"), "utf-8")
  assert.equal(charsetOf('text/html; charset="iso-8859-1"'), "iso-8859-1")
  assert.equal(charsetOf("text/html"), undefined)
})

test("a target given as a bare port or host is understood", () => {
  assert.equal(normaliseTarget("3000"), "http://localhost:3000")
  assert.equal(normaliseTarget("localhost:8080"), "http://localhost:8080")
  assert.equal(normaliseTarget("https://app.test"), "https://app.test")
})

test("a config file is found, loaded and typed", async () => {
  const root = temp()
  assert.deepEqual(await loadConfig(root), { config: {} })
  write(root, "ui-explorer.config.json", JSON.stringify({ serve: { url: "http://localhost:1" }, deny: ["x"] }))
  assert.deepEqual((await loadConfig(root)).config, { serve: { url: "http://localhost:1" }, deny: ["x"] })
  write(root, "ui-explorer.config.mjs", "export default { maxStates: 7 }\n")
  // The .mjs file wins over .json, and an explicit path wins over both.
  assert.deepEqual((await loadConfig(root)).config, { maxStates: 7 })
  assert.deepEqual((await loadConfig(root, "ui-explorer.config.json")).config.deny, ["x"])
  await assert.rejects(loadConfig(root, "missing.mjs"), /not found/)
  assert.deepEqual(defineConfig({ startPath: "/a" }), { startPath: "/a" })
})

// ---- Folder model (client) --------------------------------------------------------------------------------

async function loadFolderModel() {
  const source = fs.readFileSync(path.join(here, "../src/client/folderModel.ts"), "utf8")
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)
}

test("the most specific folder rule wins, and a parent includes everything below it", async () => {
  const { pathSelected, toggleFolder, buildFolderTree } = await loadFolderModel()
  const scenarios = [
    { id: "a", title: "A", group: "g", source: "app/src/screens/Home.tsx" },
    { id: "b", title: "B", group: "g", source: "app/src/screens/Billing.tsx", parent: "a" },
  ]
  const tree = buildFolderTree(["app/src/screens/Home.tsx", "app/src/screens/Billing.tsx"], scenarios)
  const screens = tree.children[0].children[0].children[0]
  assert.equal(screens.label, "screens")
  const rules = toggleFolder([], screens)
  assert.ok(screens.leafPaths.every((leaf) => pathSelected(leaf, rules)), "selecting a parent selects every child")
  const home = screens.children.find((child) => child.label === "Home.tsx")
  const without = toggleFolder(rules, home)
  assert.ok(home.leafPaths.every((leaf) => !pathSelected(leaf, without)), "a child can be taken out again")
  assert.ok(pathSelected("app/src/screens/Billing.tsx/Base screens", without))
})

test("folders are named for people", async () => {
  const { folderLabel, folderCrumb } = await loadFolderModel()
  assert.equal(folderLabel("RoleDetails.tsx"), "Role details")
  assert.equal(folderLabel("hiring-pipeline"), "Hiring pipeline")
  assert.equal(folderCrumb("web-app/src/screens/RoleDetails.tsx"), "Web app › Screens › Role details")
})

test("folder counts match direct membership without confusing similarly named paths", async () => {
  const { folderCounts, scenarioFolder } = await loadFolderModel()
  const scenarios = [
    { id: "a", group: "g", source: "app/src/Home.tsx" },
    { id: "b", group: "g", source: "app/src/Home.tsx", parent: "a" },
    { id: "c", group: "g", source: "app/src/Home.tsx-extra" },
  ]
  const counts = folderCounts(scenarios)
  assert.equal(counts.get("app/src/Home.tsx"), 2)
  for (const [path, count] of counts) {
    assert.equal(count, scenarios.filter((s) => scenarioFolder(s) === path || scenarioFolder(s).startsWith(`${path}/`)).length)
  }
  assert.equal(folderCounts([]).size, 0)
})

test("responsive viewport presets are real CSS sizes and invalid session values fall back safely", async () => {
  const source = fs.readFileSync(path.join(here, "../src/client/viewports.ts"), "utf8")
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
  const { VIEWPORTS, isViewportPreset } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)
  assert.equal(VIEWPORTS.fit.size, undefined)
  assert.deepEqual(VIEWPORTS.widescreen.size, { width: 1920, height: 1080 })
  assert.deepEqual(VIEWPORTS.desktop.size, { width: 1440, height: 900 })
  assert.deepEqual(VIEWPORTS.tablet.size, { width: 768, height: 1024 })
  assert.deepEqual(VIEWPORTS.mobile.size, { width: 390, height: 844 })
  for (const name of Object.keys(VIEWPORTS)) assert.equal(isViewportPreset(name), true)
  for (const invalid of [undefined, null, "", "unknown", "__proto__", "constructor", {}, 1]) assert.equal(isViewportPreset(invalid), false)
})
