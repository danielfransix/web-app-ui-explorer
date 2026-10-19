import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"

export function canonicalDirectory(root: string): string {
  const resolved = fs.realpathSync(path.resolve(root))
  if (!fs.statSync(resolved).isDirectory()) throw new Error("The project root must be a directory.")
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/** Checkout-local and stable across source edits/restarts. Moving a checkout changes its identity. */
export function projectIdentity(root: string): string {
  return createHash("sha256").update(canonicalDirectory(root)).digest("hex").slice(0, 32)
}

export function assertProjectDirectory(root: string, cwd = process.cwd()) {
  if (canonicalDirectory(root) !== canonicalDirectory(cwd))
    throw new Error("UI Explorer MCP is project-local: its working directory must equal --root. Install it in this project's configuration with `ui-explorer mcp install --client vscode` or `--client codex`; do not reuse a global server for another project.")
}

export function assertWorkspaceRoots(root: string, roots: { uri: string }[]) {
  const project = canonicalDirectory(root)
  // A workspace may contain a nested app. A root inside another app is not authority for its parent.
  const matches = roots.some(({ uri }) => {
    try {
      if (!uri.startsWith("file:")) return false
      const workspace = canonicalDirectory(fileURLToPath(uri))
      const relative = path.relative(workspace, project)
      return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    } catch { return false }
  })
  if (!matches) throw new Error("The MCP client's workspace roots do not contain this project. Use the MCP configuration installed in the active project; no operation was performed.")
}
