// `serve` puts the explorer on the same origin as the app it proxies, so the app's real login page is the
// explorer's own origin too. A person can open it in a plain browser tab — their own saved passwords, passkeys
// and 2FA all work normally there, unlike a fresh automated browser profile — and once they're logged in, any
// later same-origin request from any tab (including the Explorer's own) carries the resulting cookies, because
// cookies are scoped to the origin and the browser profile, not to one tab. A raw Cookie header also includes
// httpOnly cookies, which client-side `document.cookie` cannot see, so this captures the actual session cookie
// even when the app deliberately hides it from page scripts.

export type CapturedSession = {
  /** The request's raw Cookie header, read after the person has logged in elsewhere in the same browser. */
  cookieHeader?: string
  /** window.localStorage entries read from the Explorer's own page, same origin as the app. */
  localStorage?: Record<string, string>
  /** The origin cookies and storage apply to, for example http://127.0.0.1:5201. */
  origin: string
}

/** A Playwright storageState built from a captured browser session, for crawl/capture to replay. */
export function buildStorageState({ cookieHeader, localStorage, origin }: CapturedSession) {
  const host = new URL(origin).hostname
  const cookies = (cookieHeader ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=")
      const name = eq === -1 ? pair : pair.slice(0, eq)
      const value = eq === -1 ? "" : pair.slice(eq + 1)
      // Attributes a raw Cookie header never carries (domain, expiry, httpOnly...) are approximated for local
      // replay through the same proxy origin: a session cookie, scoped to this exact host, assumed httpOnly
      // since that's the common case for an auth cookie and it does not affect whether the browser sends it.
      return { name, value, domain: host, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" as const }
    })
  const entries = Object.entries(localStorage ?? {}).map(([name, value]) => ({ name, value }))
  return {
    cookies,
    origins: entries.length ? [{ origin, localStorage: entries }] : [],
  }
}
