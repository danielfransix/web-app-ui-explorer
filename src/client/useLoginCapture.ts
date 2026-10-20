import { useEffect, useRef, useState } from "react"
import type { Scenario } from "../shared/types"
import { checkLoginPage, saveSession } from "./data"

// Logging in happens in a real browser tab the person already owns — their saved passwords, passkeys and 2FA
// all work there, unlike a fresh automated browser profile. The new tab is the same origin as this page (the
// proxy fronts everything on one origin), opened without "noopener", so this page keeps a direct handle to it
// and can watch its document for a password field appearing, then clearing — the same structural signal
// Explorer uses to notice a login wall in the first place.
//
// That signal only means the credentials step is done, not that login itself is finished: an app with a
// follow-up step (pick an organisation, a 2FA code, an account switcher) keeps writing its real auth tokens
// after the password field is long gone, and a tab closed the moment the field clears captures whatever was
// in storage at that instant — which, for a multi-step flow, is nothing useful. So this only ever updates a
// status for the person to see; it never saves or closes the tab by itself. Saving happens only when they say
// they're done, which is also the point of asking in the first place rather than guessing.
//
// Whether the attempt actually changed anything is judged server-side, by checking this one screen before the
// tab opens and again once the person says they're done (see checkLoginPage/saveSession and ../node/login-check
// for why one page, not a whole crawl, is what gets compared).

const POLL_MS = 500
const CLEAR_DEBOUNCE_MS = 2000

function hasVisiblePasswordField(doc: Document): boolean {
  return Array.from(doc.querySelectorAll('input[type="password"]')).some((el) => (el as HTMLElement).offsetParent !== null)
}

export function useLoginCapture() {
  const [watching, setWatching] = useState<Scenario | null>(null)
  const [pastPassword, setPastPassword] = useState(false)
  const [saving, setSaving] = useState(false)
  const windowRef = useRef<Window | null>(null)
  const checkUrlRef = useRef<string | undefined>(undefined)
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const clearPoll = () => {
    if (pollRef.current !== undefined) clearInterval(pollRef.current)
    pollRef.current = undefined
  }
  useEffect(() => clearPoll, [])

  async function finish() {
    if (saving) return
    setSaving(true)
    clearPoll()
    try {
      await saveSession(checkUrlRef.current)
      windowRef.current?.close()
    } finally {
      setSaving(false)
      setWatching(null)
      setPastPassword(false)
      windowRef.current = null
      checkUrlRef.current = undefined
    }
  }

  function cancel() {
    clearPoll()
    windowRef.current?.close()
    windowRef.current = null
    checkUrlRef.current = undefined
    setWatching(null)
    setPastPassword(false)
  }

  function start(scenario: Scenario, startPath: string) {
    const url = new URL(scenario.startPath ?? startPath, location.origin).toString()
    // window.open must happen synchronously in the click handler, or it risks the popup blocker — the "before"
    // check runs after, while the person is busy typing credentials anyway.
    const target = window.open(url, "_blank")
    windowRef.current = target
    checkUrlRef.current = url
    void checkLoginPage(url).catch(() => {})
    setWatching(scenario)
    setPastPassword(false)
    if (!target) return
    let sawPasswordField = false
    let clearSince: number | undefined
    pollRef.current = setInterval(() => {
      if (target.closed) {
        clearPoll()
        windowRef.current = null
        setWatching(null)
        setPastPassword(false)
        return
      }
      try {
        if (hasVisiblePasswordField(target.document)) {
          sawPasswordField = true
          clearSince = undefined
        } else if (sawPasswordField) {
          clearSince ??= Date.now()
          // A status update only, not an auto-finish: a follow-up step (pick an org, a 2FA code) can keep
          // writing real auth data well after the password field is gone, so only the person saying they're
          // actually done is trustworthy enough to save and close the tab.
          if (Date.now() - clearSince >= CLEAR_DEBOUNCE_MS) setPastPassword(true)
        }
      } catch {
        // Briefly cross-origin, e.g. mid redirect through an identity provider — try again next tick.
      }
    }, POLL_MS)
  }

  return { watching, pastPassword, saving, start, finish, cancel }
}
