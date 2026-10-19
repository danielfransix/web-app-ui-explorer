/** A screen reference is an identifier, never an import credential or a replay recipe. */
export const isScreenId = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)

export function screenReference(projectId: string, screenId: string): string {
  return `uix-screen:v1:${projectId}:${screenId}`
}

export function resolveScreenReference(reference: string, projectId: string): string {
  const match = /^uix-screen:v1:([a-f0-9-]{36}):([a-f0-9-]{36})$/.exec(reference)
  if (!match || !isScreenId(match[1]) || !isScreenId(match[2])) throw new Error("Invalid screen reference. Copy it again from the screen preview.")
  if (match[1] !== projectId) throw new Error("This screen reference belongs to another project checkout. Connect that project's local MCP server.")
  return match[2]
}
