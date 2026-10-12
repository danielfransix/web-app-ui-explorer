import type { Scenario } from "../shared/types"

export type FolderRule = {
  path: string
  selected: boolean
}
export type FolderNode = {
  path: string
  label: string
  children: FolderNode[]
  leafPaths: string[]
}
const beneath = (path: string, parent: string) =>
  path === parent || path.startsWith(`${parent}/`)
export function pathSelected(path: string, rules: FolderRule[]) {
  // The most specific (longest) matching rule wins; one pass instead of filter + sort.
  let best: FolderRule | undefined
  for (const rule of rules) {
    if (beneath(path, rule.path) && (!best || rule.path.length > best.path.length)) best = rule
  }
  return best?.selected ?? false
}
export function toggleFolder(rules: FolderRule[], node: FolderNode) {
  const all =
    node.leafPaths.length > 0 &&
    node.leafPaths.every((path) => pathSelected(path, rules))
  return [
    ...rules.filter((rule) => !beneath(rule.path, node.path)),
    { path: node.path, selected: !all },
  ]
}
// Folder paths are stable source paths, but people browse by name: "RoleDetails.tsx" reads as "Role details".
export function folderLabel(segment: string) {
  if (/\s/.test(segment)) return segment
  const words = segment
    .replace(/\.(tsx?|jsx?)$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
// "web-app/src/screens/RoleDetails.tsx" -> "Web app › Screens › Role details". The src folder is
// an implementation detail and is not shown.
export function folderCrumb(path: string) {
  return path
    .split("/")
    .filter((segment) => segment && segment !== "src")
    .map(folderLabel)
    .join(" › ")
}
// Every scenario leaves the explorer's API with a source path (a stand-in folder when no file matched).
export const scenarioSource = (scenario: Scenario) => scenario.source ?? scenario.group

export function scenarioFolder(scenario: Scenario) {
  return `${scenarioSource(scenario)}/${
    scenario.parent ? "States and overlays" : "Base screens"
  }`
}
export function buildFolderTree(sources: string[], scenarios: Scenario[]) {
  const root: FolderNode = {
    path: "",
    label: "Workspace",
    children: [],
    leafPaths: [],
  }
  const paths = [...new Set([...sources, ...scenarios.map(scenarioFolder)])]
  for (const path of paths) {
    let current = root
    const segments = path.split("/")
    segments.forEach((label, index) => {
      const key = segments.slice(0, index + 1).join("/")
      let child = current.children.find((item) => item.path === key)
      if (!child) {
        child = { path: key, label, children: [], leafPaths: [] }
        current.children.push(child)
      }
      current = child
    })
  }
  function finish(node: FolderNode): string[] {
    node.children.sort(
      (a, b) =>
        Number(b.children.length > 0) - Number(a.children.length > 0) ||
        a.label.localeCompare(b.label),
    )
    node.leafPaths = node.children.length
      ? node.children.flatMap(finish)
      : [node.path]
    return node.leafPaths
  }
  finish(root)
  return root
}
