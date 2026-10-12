import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import {
  affectsPreviews,
  computeRevision,
  guessSources,
  init,
  listSources,
  previewPath,
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

test("init says what to do when there is no Vite config", () => {
  const lines = []
  assert.equal(init(temp(), (line) => lines.push(line)), false)
  assert.match(lines.join("\n"), /plugins: \[uiExplorer\(\)\]/)
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
