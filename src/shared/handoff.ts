export type ImportSelection = { ids: string[]; widths: number[]; labels?: Record<number, string>; createComponents?: boolean }
export type ImportSummary = {
  id: string; project: string; screenCount: number; widths: number[]; frameCount: number
  screens: { id: string; title: string; source?: string; group?: string; folder?: string }[]; expiresAt: number
  createComponents?: boolean
}

/** A local-only address and session credential; never accepts arbitrary hosts or URLs. */
export function parseImportCode(raw: string) {
  const match = /^UIX1:(\d{1,5}):([A-Za-z0-9_-]{22,64}):([A-Za-z0-9_-]{16,64})$/.exec(raw.trim())
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw new Error('Paste an import code copied from Build in Figma in UI Explorer.')
  return { url: `http://localhost:${Number(match[1])}`, token: match[2], requestId: match[3] }
}
