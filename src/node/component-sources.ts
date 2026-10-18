import fs from "node:fs"
import path from "node:path"
import { listSources } from "./sources"
import { hashString } from "../shared/hash"
import type { DesignNode } from "../shared/types"

/** Resolve a runtime name only when the source inventory identifies exactly one declaring file. */
export function componentSourceResolver(root: string) {
  const names = new Map<string, Set<string>>()
  let project = path.basename(root)
  try { project = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name || project } catch { /* Package metadata is optional. */ }
  const add = (name: string, file: string) => { const files = names.get(name) ?? new Set<string>(); files.add(file); names.set(name, files) }
  for (const file of listSources(root, ["src"], true)) {
    const text = fs.readFileSync(path.join(root, file), "utf8")
    for (const match of text.matchAll(/\b(?:function|class|const|let|var)\s+([A-Z][\w$]*)\b/g)) add(match[1], file)
    if (/\.(vue|svelte|astro)$/.test(file)) add(path.basename(file), file)
  }
  return (node: DesignNode) => {
    function visit(node: DesignNode) {
      const component = node.component
      if (component) {
        const candidates = names.get(component.name)
        let file = component.sourceFile
        if (file && path.isAbsolute(file)) file = path.relative(root, file)
        if (!file && candidates?.size === 1) file = [...candidates][0]
        if (file && !file.startsWith("..") && !path.isAbsolute(file)) {
          component.sourceFile = file.replace(/\\/g, "/")
          component.id = hashString(`${project}:${component.framework}:${component.sourceFile}#${component.name}`)
        }
      }
      node.children.forEach(visit)
    }
    visit(node)
  }
}
