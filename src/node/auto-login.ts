import { chromium, type Browser, type BrowserContext, type Page } from "playwright"

// Fills and submits a login form once, with credentials the person typed into Explorer's own UI for this run
// only (never written to disk, never logged). Runs headless, and the same browser session that logs in is
// handed straight to the crawl afterward (see crawl.ts's `context` option) — nothing is ever exported or
// re-imported, so there's nothing that can go stale between logging in and exploring.
//
// This only ever finishes unattended for apps where credentials alone complete login: an app with a step
// beyond the password field (an org picker, a 2FA code) leaves this stuck with no human able to see or finish
// it. That's a real, known limit, not silently papered over — the explorer's own needsLogin detection, run
// against whatever this session actually reached, will say so plainly rather than looking like it worked when
// it didn't. The manual "open a tab myself" flow remains the supervised fallback for that case.
//
// A fresh Playwright profile, not the person's own browser, so this only ever makes sense for a dedicated
// low-privilege account: there are no saved passkeys or trusted-device history here, and an app with such
// protections on top of a password stops at exactly the point those kick in, same as any other automated
// client would. One attempt only, never retried automatically — a wrong selector guess retried blindly risks
// tripping the backend's own failed-login protection, a worse outcome than just asking the person to finish
// by hand.

export type AttemptOutcome = "submitted" | "no-password-field-found"

// Honeypot fields some login forms include specifically to catch bots that fill every input on the page,
// whether or not it's visible, are skipped by only ever looking at visible ones.
const USERNAME_SELECTORS = [
  'input[autocomplete="username"]:visible',
  'input[autocomplete="email"]:visible',
  'input[type="email"]:visible',
  'input[name*="email" i]:visible',
  'input[name*="user" i]:visible',
  'input[id*="email" i]:visible',
  'input[id*="user" i]:visible',
]

async function findUsernameField(page: Page) {
  for (const selector of USERNAME_SELECTORS) {
    const locator = page.locator(selector).first()
    if (await locator.count().then((n) => n > 0).catch(() => false)) return locator
  }
  return undefined
}

function passwordField(page: Page) {
  return page.locator('input[type="password"]:visible').first()
}

async function hasPasswordField(page: Page): Promise<boolean> {
  return passwordField(page).count().then((n) => n > 0).catch(() => false)
}

async function findSubmitButton(page: Page) {
  const selectors = [
    'button[type="submit"]:visible',
    'input[type="submit"]:visible',
    'button:visible:has-text("Log in")',
    'button:visible:has-text("Sign in")',
    'button:visible:has-text("Login")',
    'button:visible:has-text("Continue")',
  ]
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if (await locator.count().then((n) => n > 0).catch(() => false)) return locator
  }
  return undefined
}

/**
 * Fills and submits a login form once. Handles both a single-page form (username and password together) and
 * a two-step one (a username/email step, then a separate password step) with a generic, best-effort approach:
 * no app-specific knowledge, no guarantee for shapes stranger than that.
 */
async function attemptLogin(page: Page, credentials: { username: string; password: string }): Promise<AttemptOutcome> {
  if (!(await hasPasswordField(page))) {
    const username = await findUsernameField(page)
    if (!username) return "no-password-field-found"
    await username.fill(credentials.username)
    await username.press("Enter")
    const appeared = await page
      .waitForFunction(() => document.querySelectorAll('input[type="password"]').length > 0, undefined, { timeout: 8000 })
      .then(() => true)
      .catch(() => false)
    if (!appeared) return "no-password-field-found"
  } else {
    const username = await findUsernameField(page)
    if (username) await username.fill(credentials.username)
  }
  const password = passwordField(page)
  await password.fill(credentials.password)
  // A brief settle: some forms gate the submit button behind async/debounced validation that a plain fill
  // doesn't wait for, so clicking immediately can hit a still-disabled button.
  await page.waitForTimeout(200)
  await password.press("Enter")
  // Enter alone doesn't submit every form (some only wire a click handler to the button, not a keyboard
  // submit) — if nothing changed, look for an actual submit control and click it too.
  await page.waitForTimeout(400)
  if (await hasPasswordField(page)) {
    const submit = await findSubmitButton(page)
    if (submit) await submit.click().catch(() => {})
  }
  return "submitted"
}

/**
 * Logs in and hands back the live browser/context for the caller to crawl with directly — no session map, no
 * polling, no human step, because the resulting crawl reuses this exact session rather than exporting it
 * anywhere. The caller owns the returned browser from here on: closing it is its responsibility once it's
 * done exploring.
 *
 * Headless by default (faster, and able to run the crawl's usual concurrent workers without a visible window
 * flashing through dozens of pages). Visible is a person's explicit choice — to supervise a first attempt, or
 * to finish whatever a generic selector couldn't reach — and the caller should prefer a lower crawl
 * concurrency with it, since several tabs racing through pages in one visible window isn't actually
 * something a person can follow.
 */
export async function runAutoLogin(url: string, credentials: { username: string; password: string }, headless = true): Promise<{ browser: Browser; context: BrowserContext; outcome: AttemptOutcome }> {
  const browser = await chromium.launch({ headless, args: ["--no-sandbox", "--disable-dev-shm-usage"] })
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(url, { waitUntil: "load", timeout: 20_000 }).catch(() => {})
    const outcome = await attemptLogin(page, credentials)
    if (headless) await page.close().catch(() => {})
    return { browser, context, outcome }
  } catch (error) {
    await browser.close().catch(() => {})
    throw error
  }
}
