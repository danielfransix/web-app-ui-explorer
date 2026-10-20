import { useState } from "react"
import type { Scenario } from "../shared/types"
import { submitAutoLogin } from "./data"

// Submits credentials once to a server-side login+explore run (see ../node/auto-login and
// core/explorer.ts's autoLoginAndExplore): the same browser session that logs in is handed straight to the
// crawl, so there's nothing to watch or confirm client-side for the headless case — the server responds as
// soon as the attempt has started, and everything after that (did it work, what it found) shows up the same
// way any other explore does: the usual job status, and the Logs panel for the blow-by-blow. The visible
// option opens a real window on the person's own machine; this page still can't see into it (different
// browser process entirely), so the signal stays the same either way.

export function useAutoLogin() {
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  async function start(scenario: Scenario, startPath: string, username: string, password: string, headless: boolean) {
    const url = new URL(scenario.startPath ?? startPath, location.origin).toString()
    setStarting(true)
    setError(undefined)
    try {
      const result = await submitAutoLogin(url, username, password, headless)
      if (result.error) setError(result.error)
    } catch {
      setError("Could not reach the explorer server to start automatic login.")
    } finally {
      setStarting(false)
    }
  }

  return { starting, error, start }
}
