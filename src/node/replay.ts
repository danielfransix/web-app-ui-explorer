import crypto from "node:crypto"
import type { Page } from "playwright"
import type { Action, ReplayOptions, ReplayResult, UixRuntime } from "../shared/types"

/** Observe a job rather than awaiting JavaScript that belongs to a document about to unload. */
export async function replayPage(page: Page, actions: Action[], options: ReplayOptions = {}): Promise<ReplayResult> {
  const id = crypto.randomUUID()
  await page.evaluate(({ id, actions, options }) => (window as Window & { __uix?: UixRuntime }).__uix!.startReplay(id, actions, options), { id, actions, options })
  const handle = await page.waitForFunction(id => {
    const state = (window as Window & { __uix?: UixRuntime }).__uix?.replayStatus()
    return state?.id === id && state.result ? state.result : false
  }, id, { timeout: Math.min(300_000, 25_000 + Math.max(1, actions.length) * (options.timeoutMs ?? 8000)) })
  try { return await handle.jsonValue() as ReplayResult }
  finally { await handle.dispose() }
}
