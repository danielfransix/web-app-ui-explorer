import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { crawl } from "../dist/node/index.js"

// The crawler against an app the tool was not built beside: a small framework-free single-page app. Nobody writes a
// scenario for it; every state below has to be found by exploring.
const here = path.dirname(fileURLToPath(import.meta.url))
const page = fs.readFileSync(path.join(here, "fixtures/demo/index.html"), "utf8")

function serve() {
  const server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    response.end(page)
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)))
}

test("explores screens, dialogs and dropdown choices without any scenarios written", { timeout: 180_000 }, async () => {
  const server = await serve()
  try {
    const { port } = server.address()
    const result = await crawl({ baseUrl: `http://127.0.0.1:${port}`, concurrency: 2, maxStates: 40, timeBudgetMs: 120_000 })
    const titles = result.scenarios.map((scenario) => scenario.title)
    for (const wanted of ["Welcome", "Settings", "Reports", "Help centre", "Weekly", "Monthly"])
      assert.ok(titles.includes(wanted), `expected a state titled "${wanted}"; found ${JSON.stringify(titles)}`)
    // Submitting the empty form shows its validation error: a state of its own.
    assert.ok(
      result.scenarios.some((scenario) => scenario.kind === "variant" && /save/i.test(scenario.title)),
      "expected the validation state after pressing Save",
    )
    // Every recipe starts from the root and has plain, replayable steps.
    for (const scenario of result.scenarios) {
      for (const action of scenario.actions ?? []) assert.ok(action.kind === "click" || action.kind === "fill")
    }
    // The dialog is an overlay of the home screen.
    const dialog = result.scenarios.find((scenario) => scenario.title === "Help centre")
    assert.equal(dialog?.kind, "overlay")
    assert.equal(result.scenarios.find((scenario) => scenario.id === dialog?.parent)?.title, "Welcome")
  } finally {
    server.close()
  }
})
