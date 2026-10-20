import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { spawnDevServer } from "../dist/node/index.js"

// The whole point of owning the process tree is that stopping the dev server doesn't leave a grandchild running —
// npm/yarn/pnpm scripts commonly spawn further children (npm -> react-scripts -> webpack-dev-server), and a plain
// child.kill() on the immediate process is exactly what orphaned a background task during manual testing of this
// feature's motivating incident.

const temp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "uix-spawn-")))

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

test("stopping a spawned dev server kills its whole process tree, not just the immediate child", async () => {
  const root = temp()
  const pidFile = path.join(root, "pids.json")
  fs.writeFileSync(
    path.join(root, "parent.mjs"),
    `
import { spawn } from "node:child_process"
import fs from "node:fs"
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, child: child.pid }))
setInterval(() => {}, 1000)
`,
  )

  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, "parent.mjs"))}`
  const dev = spawnDevServer(command, root, () => {})

  assert.ok(await waitUntil(() => fs.existsSync(pidFile), 5000), "the child never wrote its pid file")
  const { parent, child } = JSON.parse(fs.readFileSync(pidFile, "utf8"))
  assert.ok(isAlive(parent), "the parent process should be running before stop()")
  assert.ok(isAlive(child), "the grandchild process should be running before stop()")

  await dev.stop()

  assert.ok(await waitUntil(() => !isAlive(parent), 5000), "the parent process should be gone after stop()")
  assert.ok(await waitUntil(() => !isAlive(child), 5000), "the grandchild process should also be gone after stop() — this is the orphan this feature exists to prevent")
})

test("stop() is a no-op if called twice", async () => {
  const root = temp()
  const dev = spawnDevServer(`${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`, root, () => {})
  await dev.stop()
  await dev.stop()
})
