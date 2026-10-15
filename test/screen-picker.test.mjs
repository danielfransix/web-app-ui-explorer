import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { chromium } from "playwright"
import { createServer } from "vite"
import uiExplorer from "../dist/node/vite.js"

const active = ".screen-preview-entry:not([hidden]) iframe"

test("reset state, selection-scoped searchable screen picker in modal and full-screen", { timeout: 90_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uix-picker-"))
  fs.writeFileSync(path.join(root, "index.html"), `<!doctype html><html><body><label>Name <input id="name"></label><script>document.documentElement.setAttribute('data-uix-status','ready')</script></body></html>`)
  const titles = ["Auth Login", "Auth Signup", "Auth Reset", "Billing Invoice", "Billing Plans"]
  const scenarios = titles.map((title, index) => ({ id: `screen-${index}`, title, group: title.split(" ")[0], source: "src/Home.tsx", url: `/?screen=${index}` }))
  const server = await createServer({ root, configFile: false, logLevel: "error", server: { host: "127.0.0.1", port: 0 }, plugins: [uiExplorer({ mode: "manual", autoCapture: false, scenarios })] })
  let browser
  try {
    await server.listen()
    const base = `http://127.0.0.1:${server.httpServer.address().port}`
    browser = await chromium.launch({ args: ["--no-sandbox"] })
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(`${base}/__explorer/?view=gallery`)
    await page.getByRole("checkbox").first().click()
    await page.getByRole("textbox", { name: "Search screen states" }).fill("Auth")
    await page.getByRole("button", { name: "Expand Auth Login", exact: true }).click()
    const dialog = page.getByRole("dialog")
    const frame = dialog.frameLocator(active)
    await frame.locator('html[data-uix-status="ready"]').waitFor()

    // Reset state in the modal clears the preview's state.
    await frame.getByRole("textbox", { name: "Name" }).fill("typed")
    await dialog.getByRole("button", { name: "Reset state", exact: true }).click()
    await frame.locator('html[data-uix-status="ready"]').waitFor()
    assert.equal(await frame.getByRole("textbox", { name: "Name" }).inputValue(), "")

    // The modal picker lists only the current selection and is searchable.
    const picker = dialog.getByRole("combobox", { name: "Jump to a screen state" })
    await picker.click()
    assert.deepEqual(await page.getByRole("option").allInnerTexts(), ["Auth · Auth Login", "Auth · Auth Signup", "Auth · Auth Reset"])
    await picker.fill("sign")
    assert.deepEqual(await page.getByRole("option").allInnerTexts(), ["Auth · Auth Signup"])
    await picker.fill("zzz")
    assert.equal(await page.getByRole("option").count(), 0)
    assert.ok(await page.getByText("No matching screens").isVisible())
    await picker.fill("reset")
    await page.getByRole("option", { name: /Auth Reset/ }).click()
    await page.waitForFunction(() => document.querySelector(".modal-shell [role=dialog], [role=dialog]")?.textContent?.includes("3 of 3"))
    assert.equal(await picker.inputValue(), "Auth · Auth Reset")

    // Filtering the picker did not change the selection (still 3 screens).
    assert.equal(await page.getByRole("button", { name: "Expand Billing Plans" }).count(), 0)

    // Full-screen: same scoped, searchable picker; reset in header.
    await dialog.getByRole("button", { name: "Open live UI" }).click()
    const full = page.getByRole("combobox", { name: "Jump to a screen state" })
    await full.click()
    assert.deepEqual(await page.getByRole("option").allInnerTexts(), ["Auth · Auth Login", "Auth · Auth Signup", "Auth · Auth Reset"])
    await full.fill("login")
    await page.getByRole("option", { name: /Auth Login/ }).click()
    await page.waitForFunction(() => new URLSearchParams(location.search).get("scenario") === "screen-0")
    assert.ok(await page.getByRole("button", { name: "Next screen state" }).isEnabled())
    assert.ok(await page.getByRole("button", { name: "Previous screen state" }).isDisabled())
    await page.keyboard.press("Escape")
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
