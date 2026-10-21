import fs from "node:fs"
import path from "node:path"
import guidance from "../../docs/agent-orchestration.md"

export const ORCHESTRATION_GUIDANCE = guidance.trim()
const START = "<!-- ui-explorer:orchestration:start -->"
const END = "<!-- ui-explorer:orchestration:end -->"
const AGENT_POINTER = `## UI Explorer and Figma orchestration

Before coordinating UI Explorer and Figma, read the [tool guide](https://github.com/danielfransix/web-app-ui-explorer/blob/main/docs/agent-orchestration.md) or the installed package's \`docs/agent-orchestration.md\`.
Follow this repository's own startup and memory instructions.`

/** Update only the section owned by Explorer; preserve the project's other agent instructions. */
export function installAgentGuidance(root: string, log: (line: string) => void): void {
  const file = path.join(root, "AGENTS.md")
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
  const start = existing.indexOf(START), end = existing.indexOf(END)
  if ((start < 0) !== (end < 0) || (start >= 0 && (end < start || existing.indexOf(START, start + START.length) >= 0 || existing.indexOf(END, end + END.length) >= 0))) {
    throw new Error("AGENTS.md has an incomplete or repeated UI Explorer guidance section. Fix its markers before updating it; the file was left unchanged.")
  }
  const block = `${START}\n${AGENT_POINTER}\n${END}`
  const next = start < 0
    ? `${existing}${existing ? existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n" : ""}${block}\n`
    : existing.slice(0, start) + block + existing.slice(end + END.length)
  if (next === existing) { log("UI Explorer orchestration guidance in AGENTS.md is already current."); return }
  fs.writeFileSync(file, next)
  log("Updated UI Explorer orchestration guidance in AGENTS.md; other instructions were preserved.")
}
