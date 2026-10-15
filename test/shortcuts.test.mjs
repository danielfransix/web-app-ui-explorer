import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { chromium } from "playwright"
import { createServer } from "vite"
import uiExplorer from "../dist/node/vite.js"

test("keyboard shortcuts: search, view toggle and refresh follow the current selection", { timeout: 90_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uix-keys-"))
  fs.writeFileSync(path.join(root, "index.html"), `<!doctype html><html><body>ok<script>document.documentElement.setAttribute('data-uix-status','ready')</script></body></html>`)
  const scenarios = ["Auth Login", "Auth Signup", "Billing Plans"].map((title, index) => ({ id: `s${index}`, title, group: title.split(" ")[0], source: "src/Home.tsx", url: `/?s=${index}` }))
  const server = await createServer({ root, configFile: false, logLevel: "error", server: { host: "127.0.0.1", port: 0 }, plugins: [uiExplorer({ mode: "manual", autoCapture: false, scenarios })] })
  let browser
  try {
    await server.listen()
    const base = `http://127.0.0.1:${server.httpServer.address().port}`
    browser = await chromium.launch({ args: ["--no-sandbox"] })
    const page = await browser.newPage({ viewport: { width: 1500, height: 900 } })
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(`${base}/__explorer/?view=gallery`)
    await page.getByRole("checkbox").first().click()
    const search = page.getByRole("textbox", { name: "Search screen states" })
    assert.match(await search.getAttribute("placeholder"), /\//)

    await page.locator("body").click({ position: { x: 700, y: 30 } })
    await page.keyboard.press("/")
    assert.ok(await search.evaluate((el) => el === document.activeElement), "/ focuses search")
    await page.keyboard.type("auth/ ")
    assert.equal(await search.inputValue(), "auth/ ", "typing / inside the field is plain text")
    await page.keyboard.press("Escape")
    assert.equal(await search.inputValue(), "", "Escape clears search first")
    await page.keyboard.press("Escape")
    assert.ok(await search.evaluate((el) => el !== document.activeElement), "second Escape leaves the field")
    await page.keyboard.press("Control+k")
    assert.ok(await search.evaluate((el) => el === document.activeElement), "Ctrl+K focuses search")
    await search.fill("Auth")
    await page.keyboard.press("Escape"); await page.keyboard.press("Escape")

    // Refresh covers only the screens in the current selection and search.
    await search.fill("Auth")
    const request = page.waitForRequest((r) => r.url().includes("api/capture") && r.method() === "POST")
    await page.locator("body").click({ position: { x: 700, y: 30 } })
    await page.keyboard.press("Alt+Shift+KeyR")
    assert.deepEqual(JSON.parse((await request).postData()).only.sort(), ["s0", "s1"])

    await page.keyboard.press("Alt+Shift+KeyV")
    await page.waitForFunction(() => new URLSearchParams(location.search).get("view") === "canvas")
    await page.keyboard.press("Alt+Shift+KeyV")
    await page.waitForFunction(() => new URLSearchParams(location.search).get("view") === "gallery")

    // Metrics: no leading divider, so the first figure lines up with the heading.
    await page.getByRole("button", { name: "Workspace overview" }).click()
    const lefts = await page.evaluate(() => {
      const first = document.querySelector(".design-workbench-metrics div")
      const heading = [...document.querySelectorAll("h2")].find((h) => h.textContent === "Workspace overview")
      return { border: getComputedStyle(first).borderLeftWidth, metric: first.getBoundingClientRect().left, heading: heading.getBoundingClientRect().left }
    })
    assert.equal(lefts.border, "0px")
    assert.ok(Math.abs(lefts.metric - lefts.heading) < 1, JSON.stringify(lefts))
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
