import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { spawn } from "node:child_process"
import { ensureScreenIdentities, projectIdentity, createExplorer } from "../dist/node/index.js"

const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), "uix-identities-"))
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

test("generated UUIDs survive names, folders, order, removal/reappearance and shared clones", () => {
  const root = temporary(), clone = temporary()
  try {
    const one = { id: "one", title: "Same", group: "Group", source: "src/App.tsx" }, two = { ...one, id: "two" }
    const first = ensureScreenIdentities(root, [one, two])
    for (const id of Object.values(first.screens)) assert.match(id, uuid)
    assert.notEqual(first.screens.one, first.screens.two)
    const file = path.join(root, "ui-explorer.ids.json"), before = fs.readFileSync(file, "utf8")
    assert.deepEqual(ensureScreenIdentities(root, [{ ...two, title: "Renamed", source: "new/Folder.tsx" }, one]), first)
    assert.equal(fs.readFileSync(file, "utf8"), before)
    ensureScreenIdentities(root, [two])
    assert.deepEqual(ensureScreenIdentities(root, [one, two]), first, "retired UUIDs are never recycled")
    fs.copyFileSync(file, path.join(clone, "ui-explorer.ids.json"))
    assert.deepEqual(ensureScreenIdentities(clone, [one, two]), first)
    assert.notEqual(projectIdentity(root), projectIdentity(clone), "checkout binding remains local even when screen IDs are shared")
    const explorer = createExplorer({ root, options: { mode: "manual", scenarios: [one, two], autoCapture: false } })
    assert.deepEqual(explorer.state().identities, first)
    assert.deepEqual(JSON.parse(explorer.snapshotFiles().get("__explorer/api/state.json")).identities, first)
    void explorer.dispose()
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(clone, { recursive: true, force: true }) }
})

test("crawler recipe anchors survive renamed/reordered slugs without assigning another screen's identity", () => {
  const root = temporary()
  try {
    const base = { id: "same-title", title: "Same title", group: "App", origin: "crawled", actions: [] }
    const next = { ...base, id: "same-title-2", actions: [{ kind: "click", selector: "a", text: "Continue" }] }
    const first = ensureScreenIdentities(root, [base, next], "/app")
    const updated = ensureScreenIdentities(root, [{ ...next, id: "same-title" }, { ...base, id: "renamed" }], "/app")
    assert.equal(updated.screens["same-title"], first.screens["same-title-2"])
    assert.equal(updated.screens.renamed, first.screens["same-title"])
    const changed = ensureScreenIdentities(root, [{ ...base, actions: [{ kind: "click", selector: "button", text: "Different" }] }], "/app")
    assert.notEqual(changed.screens[base.id], first.screens[base.id])
    const manual = ensureScreenIdentities(root, [{ ...base, origin: "manual", identityKey: "stable/login" }])
    const renamed = ensureScreenIdentities(root, [{ ...base, id: "new-key", origin: "manual", identityKey: "stable/login" }])
    assert.equal(manual.screens[base.id], renamed.screens["new-key"])
    const original = ensureScreenIdentities(root, ["registered"])
    const migrated = ensureScreenIdentities(root, [{ id: "registered", title: "Registered", group: "App", identityKey: "stable/registered" }])
    assert.equal(original.screens.registered, migrated.screens.registered)
    assert.equal(ensureScreenIdentities(root, [{ id: "renamed", title: "Registered", group: "App", identityKey: "stable/registered" }]).screens.renamed, original.screens.registered)
    assert.throws(() => ensureScreenIdentities(root, [{ ...base, identityKey: "same" }, { ...next, identityKey: "same" }]), /same identityKey/)
    const duplicate = ensureScreenIdentities(root, [base, { ...base, id: "distinct" }])
    assert.notEqual(duplicate.screens[base.id], duplicate.screens.distinct)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("10,000-screen registry remains stable and concurrent processes never lose or duplicate assignments", { timeout: 30000 }, async () => {
  const root = temporary()
  try {
    const names = Array.from({ length: 10000 }, (_, i) => `screen-${i}`)
    const first = ensureScreenIdentities(root, names)
    assert.equal(new Set(Object.values(first.screens)).size, 10000)
    assert.deepEqual(ensureScreenIdentities(root, names.toReversed()), first)
    const module = new URL("../dist/node/index.js", import.meta.url).href
    await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", `import {ensureScreenIdentities} from ${JSON.stringify(module)}; ensureScreenIdentities(process.argv[1], Array.from({length:500},(_,i)=>'parallel-'+process.argv[2]+'-'+i))`, root, String(index)], { stdio: ["ignore", "ignore", "pipe"] })
      let error = ""; child.stderr.on("data", data => { error += data }); child.on("error", reject)
      child.on("exit", code => code === 0 ? resolve() : reject(new Error(error)))
    })))
    const saved = JSON.parse(fs.readFileSync(path.join(root, "ui-explorer.ids.json"), "utf8"))
    assert.equal(Object.keys(saved.screens).length, 12000)
    assert.equal(new Set(Object.values(saved.screens)).size, 12000)
    assert.deepEqual(ensureScreenIdentities(root, names), first)
    saved.screens["scenario:screen-1"] = saved.screens["scenario:screen-0"]
    const corrupted = JSON.stringify(saved)
    fs.writeFileSync(path.join(root, "ui-explorer.ids.json"), corrupted)
    assert.throws(() => ensureScreenIdentities(root, names), /duplicate IDs/)
    assert.equal(fs.readFileSync(path.join(root, "ui-explorer.ids.json"), "utf8"), corrupted, "invalid identity data is never silently regenerated")
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
