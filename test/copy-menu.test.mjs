import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { chromium } from "playwright"
import { createServer } from "vite"
import uiExplorer from "../dist/node/vite.js"

async function openLightbox(page, base) {
  await page.goto(`${base}/__explorer/?view=gallery`)
  await page.getByRole("checkbox").first().click()
  await page.getByRole("button", { name: "Expand Screen 0", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Screen 0", exact: true })
  const frame = dialog.frameLocator(".screen-preview-entry:not([hidden]) iframe")
  await frame.locator('html[data-uix-status="ready"]').waitFor()
  return dialog
}

async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uix-copy-menu-"))
  fs.writeFileSync(path.join(root, "index.html"), `<!doctype html><html><body><h1>Hello Design</h1></body></html>`)
  const scenarios = [{ id: "screen-0", title: "Screen 0", group: "Screens", source: "src/Home.tsx", actions: [] }]
  const server = await createServer({
    root, configFile: false, logLevel: "error", server: { host: "127.0.0.1", port: 0 },
    plugins: [uiExplorer({ mode: "manual", autoCapture: false, scenarios })],
  })
  let browser
  try {
    await server.listen()
    const base = `http://127.0.0.1:${server.httpServer.address().port}`
    browser = await chromium.launch({ args: ["--no-sandbox"] })
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] })
    const page = await context.newPage()
    await run({ page, base })
  } finally {
    await browser?.close()
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test("nothing is pre-checked, and the Copy control is a multi-select: checking several defaults copies all of them in one pass", { timeout: 60_000 }, async () => {
  await withServer(async ({ page, base }) => {
    const dialog = await openLightbox(page, base)
    const copyButton = dialog.locator(".design-copy-menu > button")
    await copyButton.click()
    await dialog.getByRole("button", { name: /^Copy selected \(0\)/ }).waitFor()
    assert.equal(await dialog.getByRole("button", { name: /^Copy selected/ }).isDisabled(), true, "nothing checked, nothing to copy yet")

    await dialog.getByRole("checkbox", { name: /Desktop/ }).click()
    await dialog.getByRole("checkbox", { name: /Mobile/ }).click()
    const components = dialog.getByRole("radiogroup", { name: "Create components?", exact: true })
    assert.equal(await components.getByRole("radio", { name: "Yes", exact: true }).isChecked(), true, "component creation stays enabled by default")
    await components.getByRole("radio", { name: "No", exact: true }).click()
    assert.equal(await components.getByRole("radio", { name: "No", exact: true }).isChecked(), true)
    assert.equal(await components.getByRole("radio", { name: "Yes", exact: true }).isChecked(), false)
    await dialog.getByRole("button", { name: /^Copy selected \(2\)/ }).click()
    await dialog.locator(".design-copy-menu button").first().filter({ hasText: "Copied" }).waitFor({ timeout: 15_000 })

    const clipboard = await page.evaluate(() => navigator.clipboard.readText())
    const parsed = JSON.parse(clipboard)
    assert.equal(parsed.uixDesignExport, 1)
    assert.equal(parsed.plan.frames.length, 2)
    assert.equal(parsed.plan.createComponents, false)
    assert.deepEqual(parsed.plan.components, [])
    const widths = parsed.plan.frames.map((f) => f.width).sort((a, b) => a - b)
    assert.deepEqual(widths, [390, 1440])
  })
})

test("adding a custom size checks it immediately, persists it across reopens, and carries its own label into the plan", { timeout: 60_000 }, async () => {
  await withServer(async ({ page, base }) => {
    const dialog = await openLightbox(page, base)
    const copyButton = dialog.locator(".design-copy-menu > button")
    await copyButton.click()
    await dialog.getByRole("button", { name: "Add custom size", exact: true }).click()
    await dialog.getByRole("textbox", { name: "Custom size name" }).fill("Laptop")
    await dialog.getByRole("textbox", { name: "Custom size width in pixels" }).fill("1366")
    await dialog.getByRole("button", { name: "Add", exact: true }).click()

    // The new entry appears under its own "Custom" group, already checked.
    const customCheckbox = dialog.getByRole("checkbox", { name: /Laptop \(1366px\)/ })
    await customCheckbox.waitFor()
    assert.equal(await customCheckbox.isChecked(), true)

    await dialog.getByRole("button", { name: /^Copy selected \(1\)/ }).click()
    await dialog.locator(".design-copy-menu button").first().filter({ hasText: "Copied" }).waitFor({ timeout: 15_000 })
    const parsed = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))
    assert.equal(parsed.plan.frames.length, 1)
    assert.equal(parsed.plan.frames[0].width, 1366)

    // Reopening the menu (same page) still shows it, under "Custom" - persisted via localStorage, not component state.
    await copyButton.click()
    await dialog.getByText("Laptop (1366px)").waitFor()

    // It also shows up as a one-click shortcut in the viewport picker, under its own "Custom" optgroup.
    const viewportPicker = dialog.getByRole("combobox", { name: "Preview viewport", exact: true })
    // The picker is a Base UI Select. Its options are rendered in a popup, not native option tags.
    await copyButton.click()
    await viewportPicker.click()
    await page.getByRole("option", { name: "Laptop (1366px)", exact: true }).click()
    assert.equal(await dialog.getByRole("spinbutton", { name: "Custom viewport width" }).inputValue(), "1366")
    await page.reload()
    await page.getByRole("combobox", { name: "Preview viewport", exact: true }).click()
    await page.getByRole("option", { name: "Laptop (1366px)", exact: true }).waitFor()
  })
})

test("a custom size can be removed, and no longer appears in either the Copy menu or the viewport picker", { timeout: 60_000 }, async () => {
  await withServer(async ({ page, base }) => {
    const dialog = await openLightbox(page, base)
    const copyButton = dialog.locator(".design-copy-menu > button")
    await copyButton.click()
    await dialog.getByRole("button", { name: "Add custom size", exact: true }).click()
    await dialog.getByRole("textbox", { name: "Custom size name" }).fill("Ultrawide")
    await dialog.getByRole("textbox", { name: "Custom size width in pixels" }).fill("3440")
    await dialog.getByRole("button", { name: "Add", exact: true }).click()
    await dialog.getByText("Ultrawide (3440px)").waitFor()

    await dialog.getByRole("button", { name: "Remove Ultrawide (3440px)" }).click()
    await assert.rejects(
      dialog.getByText("Ultrawide (3440px)").waitFor({ timeout: 1000 }),
      /Timeout/,
    )
  })
})
