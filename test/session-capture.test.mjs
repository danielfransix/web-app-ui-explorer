import assert from "node:assert/strict"
import test from "node:test"
import { buildStorageState } from "../dist/node/index.js"

// Building a Playwright-shaped storage state from what a captured browser session actually gives us: a raw
// Cookie header (name=value pairs only — the attributes a Set-Cookie would have carried are gone by the time a
// server reads it back) and whatever localStorage entries were read client-side.

test("parses a Cookie header into individual cookies scoped to the given origin", () => {
  const state = buildStorageState({ cookieHeader: "session=abc123; theme=dark", origin: "http://127.0.0.1:5201" })
  assert.deepEqual(
    state.cookies.map((c) => [c.name, c.value]).sort(),
    [["session", "abc123"], ["theme", "dark"]],
  )
  for (const cookie of state.cookies) {
    assert.equal(cookie.domain, "127.0.0.1")
    assert.equal(cookie.path, "/")
    assert.equal(cookie.expires, -1, "a session cookie, not a fixed expiry nobody actually knows")
  }
})

test("an absent cookie header produces no cookies, not an error", () => {
  const state = buildStorageState({ origin: "http://127.0.0.1:5201" })
  assert.deepEqual(state.cookies, [])
})

test("localStorage entries are scoped under the captured origin, and omitted entirely when there are none", () => {
  const withEntries = buildStorageState({ origin: "http://127.0.0.1:5201", localStorage: { token: "xyz", flag: "1" } })
  assert.deepEqual(withEntries.origins, [
    { origin: "http://127.0.0.1:5201", localStorage: [{ name: "token", value: "xyz" }, { name: "flag", value: "1" }] },
  ])
  const withoutEntries = buildStorageState({ origin: "http://127.0.0.1:5201", localStorage: {} })
  assert.deepEqual(withoutEntries.origins, [])
})

test("a cookie value containing an equals sign is kept whole, not truncated at the first one", () => {
  const state = buildStorageState({ cookieHeader: "token=abc=def==", origin: "http://127.0.0.1:5201" })
  assert.deepEqual(state.cookies[0], { name: "token", value: "abc=def==", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" })
})
