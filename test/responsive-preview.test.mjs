import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { chromium } from "playwright"
import { createServer } from "vite"
import uiExplorer from "../dist/node/vite.js"

const active = ".screen-preview-entry:not([hidden]) iframe"
const presets = [
  ["Widescreen", 1920, 1080, "widescreen"],
  ["Desktop", 1440, 900, "desktop"],
  ["Tablet", 768, 1024, "tablet"],
  ["Mobile", 390, 844, "mobile"],
]

async function choose(page, label) {
  await page.getByRole("combobox", { name: "Preview viewport", exact: true }).click()
  await page.getByRole("option", { name: label, exact: true }).click()
}

async function metrics(frame) {
  return frame.locator("body").evaluate(() => ({
    width: innerWidth, height: innerHeight,
    breakpoint: getComputedStyle(document.querySelector("#breakpoint"), "::after").content.replaceAll('"', ''),
    font: getComputedStyle(document.querySelector("#probe")).fontSize,
    identity: performance.timeOrigin,
  }))
}

test("interactive previews use real 1:1 viewports, responsive presets and persistent controls across both sizes", { timeout: 90_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uix-responsive-"))
  fs.writeFileSync(path.join(root, "index.html"), `<!doctype html><html><head><style>
    body { margin: 0; font: 16px Arial; background: #f4f7fb; }
    header { padding: 24px; background: #0048ff; color: white; }
    main { display: grid; grid-template-columns: 240px 1fr; min-height: 600px; }
    nav { padding: 24px; background: #e5ebf7; }
    section { padding: 24px; }
    #probe { width: 120px; height: 32px; font-size: 16px; }
    #breakpoint::after { content: 'widescreen'; }
    @media (max-width: 1599px) { #breakpoint::after { content: 'desktop'; } }
    @media (max-width: 1023px) { #breakpoint::after { content: 'tablet'; } main { grid-template-columns: 160px 1fr; } }
    @media (max-width: 599px) { #breakpoint::after { content: 'mobile'; } main { display: block; } nav { display: none; } }
    </style></head><body><header>Responsive fixture</header><main><nav>Navigation</nav><section>
    <h1 id="breakpoint">Layout: </h1><p>Normal text stays 16px at every viewport size.</p>
    <label>Name <input id="name" placeholder="Enter a name"></label><p id="probe">Fixed-size text</p>
    </section></main><script>document.documentElement.setAttribute('data-uix-status','ready')</script></body></html>`)
  const scenarios = [0, 1].map((index) => ({ id: `screen-${index}`, title: `Screen ${index}`, group: "Screens", source: "src/Home.tsx", url: `/?screen=${index}` }))
  const server = await createServer({ root, configFile: false, logLevel: "error", server: { host: "127.0.0.1", port: 0 }, plugins: [uiExplorer({ mode: "manual", autoCapture: false, scenarios })] })
  let browser
  try {
    await server.listen()
    const base = `http://127.0.0.1:${server.httpServer.address().port}`
    browser = await chromium.launch({ args: ["--no-sandbox"] })
    const page = await browser.newPage({ viewport: { width: 2260, height: 1400 } })
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(`${base}/__explorer/?view=gallery`)
    await page.getByRole("checkbox").first().click()
    await page.getByRole("button", { name: "Expand Screen 0", exact: true }).click()
    const dialog = page.getByRole("dialog")
    const frame = dialog.frameLocator(active)
    await frame.locator('html[data-uix-status="ready"]').waitFor()
    const initial = await metrics(frame)
    assert.ok(initial.width > 1920, "Fit window gives the website the actual large viewport, not a scaled 1280px canvas")
    assert.equal(initial.font, "16px")
    await page.waitForFunction(() => {
      const iframe = document.querySelector('.screen-preview-entry:not([hidden]) iframe')
      return document.querySelector('[aria-label="Preview viewport dimensions"]')?.textContent === `${iframe?.contentWindow?.innerWidth} × ${iframe?.contentWindow?.innerHeight}`
    })
    const iframe = dialog.locator(active)
    const box = await iframe.boundingBox()
    assert.ok(Math.abs(box.width - initial.width) < 1, "one iframe CSS pixel is one explorer CSS pixel")
    assert.equal(await iframe.evaluate((element) => getComputedStyle(element).transform), "none")
    const alignment = await page.getByRole("combobox", { name: "Preview viewport", exact: true }).evaluate((trigger) => {
      const middle = (element) => { const box = element.getBoundingClientRect(); return box.y + box.height / 2 }
      return { trigger: middle(trigger), value: middle(trigger.querySelector(".control-select__value")), icon: middle(trigger.parentElement.querySelector(":scope > svg")), label: middle(document.querySelector(".design-viewport-label")) }
    })
    for (const part of ["value", "icon", "label"]) assert.ok(Math.abs(alignment.trigger - alignment[part]) < 1, `${part} is vertically centered with the picker`)
    let identity = initial.identity
    await frame.getByRole("textbox", { name: "Name", exact: true }).fill("Kept while resizing")
    const beforeArrow = page.url()
    await page.getByRole("combobox", { name: "Preview viewport", exact: true }).focus()
    await page.keyboard.press("ArrowRight")
    assert.equal(page.url(), beforeArrow, "viewport controls own their arrow keys")
    for (const [label, width, height, breakpoint] of presets) {
      await choose(page, label)
      await page.waitForFunction(({ width, height }) => {
        const iframe = document.querySelector('.screen-preview-entry:not([hidden]) iframe')
        return iframe?.contentWindow?.innerWidth === width && iframe?.contentWindow?.innerHeight === height
      }, { width, height })
      const actual = await metrics(frame)
      assert.equal(actual.width, width)
      assert.equal(actual.height, height)
      assert.equal(actual.breakpoint, breakpoint, `${label} triggers the host's real CSS media queries`)
      assert.equal(actual.font, "16px")
      assert.equal(actual.identity, identity, "viewport selection does not reload the app")
      const rendered = await iframe.boundingBox()
      assert.equal(rendered.width, width)
      assert.equal(rendered.height, height)
      assert.equal(await frame.getByRole("textbox", { name: "Name", exact: true }).inputValue(), "Kept while resizing")
      if (process.env.UIX_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.UIX_SCREENSHOT_DIR, `responsive-${label.toLowerCase()}.png`) })
    }
    await choose(page, "Custom width")
    const custom = page.getByRole("spinbutton", { name: "Custom viewport width", exact: true })
    const apply = page.getByRole("button", { name: "Apply", exact: true })
    for (const [width, breakpoint] of [[550, "mobile"], [850, "tablet"], [1300, "desktop"], [2100, "widescreen"]]) {
      await custom.fill(String(width))
      await apply.click()
      await page.waitForFunction((width) => document.querySelector('.screen-preview-entry:not([hidden]) iframe')?.contentWindow?.innerWidth === width, width)
      const actual = await metrics(frame)
      assert.equal(actual.width, width)
      assert.equal(actual.breakpoint, breakpoint)
      assert.equal(actual.identity, identity)
      assert.equal(actual.font, "16px")
      assert.equal((await iframe.boundingBox()).width, width)
      assert.equal(await frame.getByRole("textbox", { name: "Name", exact: true }).inputValue(), "Kept while resizing")
    }
    for (const invalid of ["", "0", "-20", "7681", "390.5"]) {
      await custom.fill(invalid)
      await apply.click()
      assert.match(await page.getByRole("alert").innerText(), /whole-number width/)
      assert.equal((await metrics(frame)).width, 2100, "invalid input never resizes or reloads the app")
    }
    await custom.fill("875")
    const customUrl = page.url()
    await custom.press("ArrowRight")
    assert.equal(page.url(), customUrl, "custom input owns navigation keys")
    await custom.press("Enter")
    await page.waitForFunction(() => document.querySelector('.screen-preview-entry:not([hidden]) iframe')?.contentWindow?.innerWidth === 875)
    const beforeResizeHeight = (await metrics(frame)).height
    await page.setViewportSize({ width: 2260, height: 1500 })
    await page.waitForFunction((height) => document.querySelector('.screen-preview-entry:not([hidden]) iframe')?.contentWindow?.innerHeight > height, beforeResizeHeight)
    assert.equal((await metrics(frame)).width, 875, "custom width stays fixed while height follows the window")
    await page.getByRole("button", { name: "Open live UI", exact: true }).click()
    await page.getByRole("button", { name: "Back to preview", exact: true }).waitFor()
    assert.equal((await metrics(frame)).width, 875)
    assert.equal((await metrics(frame)).identity, identity)
    await page.getByRole("button", { name: "Back to preview", exact: true }).click()
    await page.getByRole("button", { name: "Close", exact: true }).click()
    await page.getByRole("button", { name: "Expand Screen 0", exact: true }).click()
    await frame.locator('html[data-uix-status="ready"]').waitFor()
    assert.equal((await metrics(frame)).width, 875, "custom width survives closing and reopening")
    await page.reload()
    await frame.locator('html[data-uix-status="ready"]').waitFor()
    assert.equal((await metrics(frame)).width, 875, "custom width survives session reload")
    await choose(page, "Mobile")
    identity = (await metrics(frame)).identity
    await frame.getByRole("textbox", { name: "Name", exact: true }).fill("Kept while resizing")
    await page.getByRole("button", { name: "Open live UI", exact: true }).click()
    await page.getByRole("button", { name: "Back to preview", exact: true }).waitFor()
    assert.match(await page.getByRole("combobox", { name: "Preview viewport", exact: true }).innerText(), /Mobile/)
    assert.equal((await metrics(frame)).identity, identity)
    assert.equal((await metrics(frame)).width, 390)
    await choose(page, "Tablet")
    assert.equal((await metrics(frame)).width, 768)
    await page.goBack()
    await page.getByRole("button", { name: "Open live UI", exact: true }).waitFor()
    assert.equal((await metrics(frame)).width, 768, "Back retains the viewport selection")
    assert.equal((await metrics(frame)).identity, identity)
    const modal = await dialog.boundingBox()
    assert.equal(modal.x, 16)
    assert.equal(modal.y, 16)
    await page.getByRole("button", { name: "Next preview", exact: true }).click()
    await frame.locator('html[data-uix-status="ready"]').waitFor()
    assert.equal((await metrics(frame)).width, 768, "screen stepping retains the viewport")
    await page.getByRole("button", { name: "Previous preview", exact: true }).click()
    assert.equal((await metrics(frame)).identity, identity, "resizing does not defeat the visited-screen cache")
    await page.setViewportSize({ width: 1280, height: 720 })
    await choose(page, "Widescreen")
    assert.equal((await metrics(frame)).width, 1920)
    const scroller = dialog.locator('.screen-preview-entry:not([hidden])')
    assert.ok(await scroller.evaluate((element) => element.scrollWidth > element.clientWidth && element.scrollHeight > element.clientHeight), "oversized presets scroll instead of zooming")
    assert.equal((await iframe.boundingBox()).width, 1920)
    await choose(page, "Fit window")
    const fitted = await metrics(frame)
    assert.ok(fitted.width < 1280 && fitted.width > 1100)
    assert.equal((await iframe.boundingBox()).width, fitted.width)
    assert.equal(fitted.font, "16px")
    await page.waitForFunction(() => {
      const iframe = document.querySelector('.screen-preview-entry:not([hidden]) iframe')
      return document.querySelector('[aria-label="Preview viewport dimensions"]')?.textContent === `${iframe?.contentWindow?.innerWidth} × ${iframe?.contentWindow?.innerHeight}`
    })
    await choose(page, "Mobile")
    await page.getByRole("button", { name: "Open live UI", exact: true }).click()
    await page.getByRole("button", { name: "Reset state", exact: true }).click()
    await frame.locator('html[data-uix-status="ready"]').waitFor()
    assert.equal((await metrics(frame)).width, 390, "Reset state does not reset the viewport preference")
    assert.equal(await frame.getByRole("textbox", { name: "Name", exact: true }).inputValue(), "")
    assert.notEqual((await metrics(frame)).identity, identity)
    await page.reload()
    await frame.locator('html[data-uix-status="ready"]').waitFor()
    assert.equal((await metrics(frame)).width, 390, "the viewport preference is restored for this browser session")
    await page.getByRole("button", { name: "Back to preview", exact: true }).click()
    await page.getByRole("button", { name: "Close", exact: true }).click()
    await page.getByRole("button", { name: "Expand Screen 0", exact: true }).click()
    await frame.locator('html[data-uix-status="ready"]').waitFor()
    assert.equal((await metrics(frame)).width, 390, "reopening keeps the viewport preference")
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
