export const IMPORT_SERVER_UPDATE = "Restart your app's dev server to enable Figma imports, then refresh UI Explorer. The running server is older than this interface."

/** API errors may be plain text (including older servers' 404 responses). */
export async function readApiJson<T>(response: Response, fallback: string): Promise<T> {
  let body: any
  try { body = await response.json() }
  catch {
    if ([404, 405].includes(response.status)) throw new Error(IMPORT_SERVER_UPDATE)
    throw new Error(response.ok ? "UI Explorer returned an unreadable response. Refresh the page and try again." : `${fallback} (HTTP ${response.status}).`)
  }
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : [404, 405].includes(response.status) ? IMPORT_SERVER_UPDATE : `${fallback} (HTTP ${response.status}).`)
  return body as T
}
