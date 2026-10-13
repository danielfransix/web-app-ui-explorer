// Adding the explorer's runtime tag to an app's HTML, and the other small text rewrites a proxy needs.

const DOCUMENT = /<!doctype|<html[\s>]|<head[\s>]/i
const HEAD_OPEN = /<head(\s[^>]*)?>/i
const HTML_OPEN = /<html(\s[^>]*)?>/i
const DOCTYPE = /<!doctype[^>]*>/i
const META_CHARSET = /^\s*<meta[^>]*charset[^>]*>/i

/**
 * Puts `tag` first in the document's head. Fragments (an htmx partial, an HTML snippet an API returns) are left
 * alone, and a page that already has the tag is returned unchanged.
 */
export function injectIntoHtml(html: string, tag: string): string {
  if (!DOCUMENT.test(html)) return html
  const marker = /src="([^"]+)"/.exec(tag)?.[1]
  if (marker && html.includes(marker)) return html

  const head = HEAD_OPEN.exec(html)
  if (head) {
    let at = head.index + head[0].length
    // A charset declaration has to stay within the first bytes of the document, so the tag goes after it.
    const charset = META_CHARSET.exec(html.slice(at, at + 400))
    if (charset) at += charset[0].length
    return html.slice(0, at) + tag + html.slice(at)
  }
  const open = HTML_OPEN.exec(html)
  if (open) {
    const at = open.index + open[0].length
    return `${html.slice(0, at)}<head>${tag}</head>${html.slice(at)}`
  }
  const doctype = DOCTYPE.exec(html)
  if (doctype) {
    const at = doctype.index + doctype[0].length
    return html.slice(0, at) + tag + html.slice(at)
  }
  return tag + html
}

/** The charset a Content-Type header declares, lower-cased, or undefined when there is none. */
export function charsetOf(contentType: string | undefined): string | undefined {
  return /charset=("?)([^";\s]+)\1/i.exec(contentType ?? "")?.[2]?.toLowerCase()
}

/** Rewrites a redirect that points at the proxied server so it points back at the proxy. */
export function rewriteLocation(location: string, targetOrigin: string, proxyOrigin: string): string {
  return location.startsWith(targetOrigin) ? proxyOrigin + location.slice(targetOrigin.length) : location
}

/**
 * Makes a Set-Cookie value work on the proxy: the cookie belongs to whatever host the browser is on, and a
 * Secure cookie from an https target would never be stored over plain http.
 */
export function rewriteCookie(cookie: string, proxyIsHttps: boolean): string {
  let value = cookie.replace(/;\s*domain=[^;]*/i, "")
  if (!proxyIsHttps) {
    value = value.replace(/;\s*secure(?=;|$)/i, "")
    // SameSite=None is only accepted together with Secure.
    value = value.replace(/;\s*samesite=none/i, "; SameSite=Lax")
  }
  return value
}
