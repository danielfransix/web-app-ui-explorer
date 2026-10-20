import assert from "node:assert/strict"
import test from "node:test"
import { chooseOne, confirm, isInteractive } from "../dist/node/index.js"

// The test runner's stdin/stdout aren't a real TTY, so these always take the non-interactive path. That's exactly
// the behaviour CI and a non-interactive agent invocation need: never prompt, never hang waiting for input that
// will never come.

test("confirm never blocks outside a real terminal", async () => {
  assert.equal(isInteractive(), false)
  assert.equal(await confirm("Use it?"), false)
})

test("chooseOne never blocks outside a real terminal", async () => {
  assert.equal(await chooseOne("Run which?", ["npm run dev", "npm run start:dev"]), undefined)
})
