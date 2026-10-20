import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import type { Snapshot, UixRuntime } from "../shared/types"

// Whether a login attempt actually changed anything, checked the way that holds up regardless of how many
// steps a given app's login takes (one field, or a password then an org picker then a 2FA code): load the
// exact screen the person picked, once before the attempt and once after, with whatever session is current
// each time, and compare that one page's own result. Comparing a whole crawl's before/after state would also
// pick up unrelated noise — timing, randomised content, a budget cutting one run shorter than the other —
// across potentially hundreds of states; comparing one page to itself has none of that, because the only
// thing that can differ between the two loads is the session.

type W = Window & { __uix?: UixRuntime }

function runtimeSource(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const candidate of ["runtime/runtime.js", "../runtime/runtime.js"]) {
    const file = path.resolve(here, candidate)
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8")
  }
  throw new Error("The browser runtime is missing from the package. Build it with `pnpm build`.")
}

export type PageCheck = Pick<Snapshot, "url" | "title" | "hasPasswordField">

/** One page's state, with whichever session (or none) is passed in. */
export async function checkPage(url: string, storageState: string | undefined): Promise<PageCheck> {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] })
  try {
    const context = await browser.newContext({ storageState })
    await context.addInitScript({ content: `window.__UIX_FORCE = true;\n${runtimeSource()}` })
    const page = await context.newPage()
    await page.goto(url, { waitUntil: "load", timeout: 20_000 }).catch(() => {})
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {})
    const snapshot = await page.evaluate(() => (window as unknown as W).__uix!.snapshot())
    return { url: snapshot.url, title: snapshot.title, hasPasswordField: snapshot.hasPasswordField }
  } finally {
    await browser.close().catch(() => {})
  }
}

export type LoginOutcome = "changed" | "unchanged"

/** "changed" only when something concrete differs: the password field cleared, or the URL moved somewhere
 *  new. A title change alone is too easily coincidental (a loading state, a notification count) to trust. */
export function compareLoginCheck(before: PageCheck, after: PageCheck): LoginOutcome {
  if (before.hasPasswordField && !after.hasPasswordField) return "changed"
  if (before.url !== after.url) return "changed"
  return "unchanged"
}
