import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import uiExplorer from '../dist/node/vite.js'

async function fixture(run) {
  fs.mkdirSync('.ui-explorer', { recursive: true })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uix-ui-principles-'))
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>UI review fixture</h1>')
  const scenario = { id: 'home', title: 'Hiring home', group: 'Hiring', source: 'src/screens/Home.tsx', actions: [] }
  const server = await createServer({ root, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [uiExplorer({ mode: 'manual', autoCapture: false, scenarios: [scenario] })] })
  let browser
  try {
    await server.listen()
    browser = await chromium.launch()
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    context.setDefaultTimeout(8000)
    const page = await context.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__explorer/`)
    await page.getByRole('checkbox').first().check()
    await run(page)
    assert.deepEqual(errors, [], 'Explorer controls produce no browser errors')
  } finally {
    await browser?.close()
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function balancedCopy(page, field, button) {
  await field.scrollIntoViewIfNeeded()
  const geometry = await button.evaluate(node => {
    const box = node.getBoundingClientRect(), field = node.parentElement.querySelector('input'), bounds = field.getBoundingClientRect(), icon = node.querySelector('svg').getBoundingClientRect()
    return { width: box.width, height: box.height, top: box.top - bounds.top, bottom: bounds.bottom - box.bottom, right: bounds.right - box.right, iconX: icon.left + icon.width / 2 - box.left - box.width / 2, iconY: icon.top + icon.height / 2 - box.top - box.height / 2, textPadding: parseFloat(getComputedStyle(field).paddingRight), inside: bounds.left >= 0 && bounds.right <= innerWidth }
  })
  assert.equal(geometry.width, 40)
  assert.equal(geometry.height, 40)
  assert.ok(geometry.inside)
  assert.ok(Math.max(geometry.top, geometry.bottom, geometry.right) - Math.min(geometry.top, geometry.bottom, geometry.right) < .6, `balanced copy target: ${JSON.stringify(geometry)}`)
  assert.ok(Math.abs(geometry.iconX) < .6 && Math.abs(geometry.iconY) < .6)
  assert.ok(geometry.textPadding > geometry.width + geometry.right, 'value cannot run under the icon')
  const before = await button.boundingBox()
  await button.hover()
  await page.getByRole('tooltip').waitFor()
  assert.deepEqual(await button.boundingBox(), before, 'hover never shifts the action')
  await page.mouse.move(0, 0)
  await field.focus()
  await field.press('Tab')
  assert.ok(await button.evaluate(node => node === document.activeElement), 'Tab reaches the copy action after its field')
  await page.getByRole('tooltip').waitFor()
}

async function flatComponentChoice(container) {
  assert.ok(await container.locator('.design-component-option').evaluate(node => {
    const group = node.querySelector('[role="radiogroup"]'), label = node.querySelector('.design-component-option__title')
    const style = getComputedStyle(node)
    return group.parentElement === node && label.parentElement === node && parseFloat(style.borderLeftWidth) === 0 && parseFloat(style.borderRightWidth) === 0
  }), 'component choices use one shared layout, without an extra wrapper or card')
}

test('copy fields keep icon actions attached, balanced and keyboard accessible at narrow and wide widths', { timeout: 60_000 }, async () => {
  await fixture(async page => {
    // Fixed fixture values keep screenshots free of real pairing credentials.
    const code = 'UIX1:5198:example_import_code_for_UI_review:example_selection'
    await page.route('**/api/figma/imports', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code, summary: { screenCount: 1, frameCount: 1, widths: [1440], createComponents: true } }) }))
    await page.getByRole('checkbox', { name: 'Select Hiring home for Figma', exact: true }).check()
    await page.getByRole('button', { name: 'Build in Figma', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Build in Figma', exact: true })
    await flatComponentChoice(dialog)
    await dialog.getByRole('button', { name: 'Prepare 1 frame', exact: true }).click()
    const field = dialog.getByRole('textbox', { name: 'Import code', exact: true })
    const copy = dialog.getByRole('button', { name: 'Copy import code', exact: true })
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await balancedCopy(page, field, copy)
      assert.equal(await field.inputValue(), code)
      assert.equal(await dialog.locator('.modal-master-body').evaluate(node => node.scrollWidth <= node.clientWidth), true)
      await page.mouse.move(0, 0)
      await field.focus()
      await page.screenshot({ path: `.ui-explorer/ui-review-import-code-${width}.png` })
    }
    await copy.focus()
    await page.keyboard.press('Enter')
    const copied = dialog.getByRole('button', { name: 'Copied import code', exact: true })
    await copied.waitFor()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), code)
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('Clipboard denied') } })
    await copied.click()
    await dialog.getByRole('alert').waitFor()
    assert.equal(await field.inputValue(), code)
    assert.equal(await field.evaluate(node => node === document.activeElement && node.selectionEnd - node.selectionStart === node.value.length), true, 'failure keeps the value selected for manual copying')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()

    await page.route('**/api/figma/connection', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ connectionUrl: 'http://localhost:5198/#example_connection_for_UI_review' }) }))
    await page.getByRole('button', { name: 'Workspace overview', exact: true }).click()
    await page.getByRole('button', { name: 'Figma connection', exact: true }).click()
    const url = page.getByRole('textbox', { name: 'Bridge connection URL', exact: true })
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await balancedCopy(page, url, page.getByRole('button', { name: 'Copy connection URL', exact: true }))
      const attached = await url.evaluate(node => {
        const parent = node.closest('.design-figma-connection'), trigger = parent.querySelector('button'), body = parent.querySelector('.design-figma-connection__body')
        return Math.abs(trigger.getBoundingClientRect().bottom - body.getBoundingClientRect().top) < 1
      })
      assert.ok(attached, 'connection settings remain attached to their disclosure')
      await page.mouse.move(0, 0)
      await url.focus()
      await page.screenshot({ path: `.ui-explorer/ui-review-connection-${width}.png` })
    }
  })
})

test('copy settings disclose custom fields, fit small windows and dismiss without closing the preview', { timeout: 60_000 }, async () => {
  await fixture(async page => {
    assert.equal(await page.getByRole('button', { name: 'Gallery', exact: true }).getAttribute('aria-pressed'), 'true')
    assert.equal(await page.getByRole('button', { name: 'Canvas', exact: true }).getAttribute('aria-pressed'), 'false')
    await page.getByRole('button', { name: 'Expand Hiring home', exact: true }).click()
    const preview = page.getByRole('dialog', { name: 'Hiring home', exact: true })
    const trigger = preview.locator('.design-copy-menu > button')
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await trigger.click()
      const popup = page.getByRole('dialog', { name: 'Copy settings', exact: true })
      await flatComponentChoice(popup)
      assert.equal(await popup.getByRole('textbox', { name: 'Custom size name', exact: true }).isVisible(), false)
      await popup.getByRole('button', { name: 'Add custom size', exact: true }).click()
      await popup.getByRole('textbox', { name: 'Custom size width in pixels', exact: true }).fill('7681')
      await popup.getByRole('button', { name: 'Add', exact: true }).click()
      assert.match(await popup.getByRole('alert').innerText(), /whole-number width/)
      assert.ok(await popup.evaluate(node => { const b = node.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight && node.scrollWidth <= node.clientWidth }), 'copy settings stay inside the viewport')
      await popup.getByRole('checkbox', { name: /Desktop/ }).check()
      await page.screenshot({ path: `.ui-explorer/ui-review-copy-settings-${width}.png` })
      await popup.getByRole('button', { name: 'Add custom size', exact: true }).click()
      await page.keyboard.press('Escape')
      await popup.waitFor({ state: 'hidden' })
      assert.ok(await preview.isVisible(), 'Escape closes the settings before the preview')
      assert.ok(await trigger.evaluate(node => node === document.activeElement), 'focus returns to the Copy trigger')
      await trigger.click()
      assert.equal(await popup.getByRole('checkbox', { name: /Desktop/ }).isChecked(), true)
      await popup.getByRole('checkbox', { name: /Desktop/ }).uncheck()
      await page.keyboard.press('Escape')
    }
    await preview.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'Canvas', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: 'Canvas', exact: true }).getAttribute('aria-pressed'), 'true')
    await page.getByRole('button', { name: 'Zoom out', exact: true }).focus()
    await page.keyboard.press('Tab')
    await page.getByRole('tooltip', { name: 'Zoom in', exact: true }).waitFor()
  })
})

test('issue copy failures give a visible recovery instruction instead of an unhandled rejection', { timeout: 60_000 }, async () => {
  await fixture(async page => {
    await page.route('**/api/state', async route => {
      const response = await route.fetch(), body = await response.json()
      body.thumbnails = { revision: body.revision, capturedAt: new Date().toISOString(), items: {}, failed: { home: 'The preview could not be captured.' } }
      await route.fulfill({ response, json: body })
    })
    await page.reload()
    await page.getByRole('button', { name: '1 failed', exact: true }).click()
    const issues = page.getByRole('dialog', { name: 'Issues', exact: true })
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('Clipboard denied') } })
    await issues.getByRole('button', { name: 'Copy screen', exact: true }).click()
    assert.match(await issues.getByRole('alert').innerText(), /Select the value and copy/)
    assert.ok((await issues.locator('code').first().innerText()).endsWith('/src/screens/Home.tsx'))
  })
})
