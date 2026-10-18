import type { ComponentRef, DesignCapture, DesignNode } from "./types"
import { hashString } from "./hash"

// The pure half of the component & variant system: given a set of captures (already tagged with
// component boundaries by the runtime), decide what Figma should end up with - which components need a
// master (and with which variants), and which occurrences are just instances of one, with their own text
// overrides. None of this touches the Figma Plugin API; it only decides what to ask it to do, which is
// what makes it something that can be unit-tested without Figma.
//
// Text overrides stop at nested component boundaries; each nested instance owns its own overrides.

export type ComponentVariant = {
  /** e.g. "Breakpoint=Desktop" - the master draw actually used for this variant. */
  variantName: string
  node: DesignNode
  scenarioId: string
  width: number
}

export type ComponentInstance = {
  scenarioId: string
  width: number
  variantName: string
  /** Path (from the component's own root) -> override text, for leaves that differ from that variant's master. */
  textOverrides: Record<string, string>
}

export type ComponentPlan = {
  componentId: string
  name: string
  framework: ComponentRef["framework"]
  sourceFile?: string
  /** One master draw per distinct variant actually captured - never a speculative, uncaptured combination. */
  variants: ComponentVariant[]
  /** Every occurrence, including each variant's own defining one. */
  instances: ComponentInstance[]
}

export type FramePlan = { scenarioId: string; width: number; node: DesignNode; folder?: string }

export type ExportPlan = {
  createComponents?: boolean
  components: ComponentPlan[]
  frames: FramePlan[]
  warnings?: string[]
}

function textMap(node: DesignNode, path = "."): Record<string, string> {
  const map: Record<string, string> = {}
  if (node.text) map[path] = node.text.content
  node.children.forEach((child, index) => { if (!child.component) Object.assign(map, textMap(child, `${path}/${index}`)) })
  return map
}

function variantNameFor(width: number, widthLabels: Record<number, string>): string {
  return `Breakpoint=${widthLabels[width] ?? width}`
}

/** Dependencies first, shared by the batch sender and the Figma interpreter. */
export function orderComponents(components: ComponentPlan[]): ComponentPlan[] {
  const result: ComponentPlan[] = [], seen = new Set<string>()
  const byId = new Map(components.map((component) => [component.componentId, component]))
  function visit(component: ComponentPlan) {
    if (seen.has(component.componentId)) return
    seen.add(component.componentId)
    function descend(node: DesignNode) { for (const child of node.children) { const dependency = child.component && byId.get(child.component.id); if (dependency) visit(dependency); descend(child) } }
    component.variants.forEach((variant) => descend(variant.node)); result.push(component)
  }
  components.forEach(visit)
  return result
}

/**
 * Builds the plan for one export run. `widthLabels` maps a captured width to a human breakpoint name
 * (e.g. `{ 1440: "Desktop" }`); a width with no entry falls back to its raw pixel value as the name.
 */
export function buildPlan(captures: DesignCapture[], widthLabels: Record<number, string> = {}, options: { createComponents?: boolean } = {}): ExportPlan {
  // Do not mutate the source captures; plans carry occurrence-specific variant names.
  captures = JSON.parse(JSON.stringify(captures)) as DesignCapture[]
  if (options.createComponents === false) return {
    createComponents: false,
    components: [],
    frames: captures.map(capture => ({ scenarioId: capture.scenarioId, width: capture.width, node: capture.root })),
    warnings: Array.from(new Set(captures.flatMap(capture => capture.warnings ?? []))),
  }
  const components = new Map<string, ComponentPlan>()
  const masterTextByVariant = new Map<string, Record<string, string>>()
  function appearance(node: DesignNode, parent?: DesignNode): unknown {
    return { ...node, componentVariant: undefined, rect: { x: parent ? node.rect.x - parent.rect.x : 0, y: parent ? node.rect.y - parent.rect.y : 0, width: node.rect.width, height: node.rect.height },
      textRect: node.textRect ? { ...node.textRect, x: node.textRect.x - node.rect.x, y: node.textRect.y - node.rect.y } : undefined,
      text: node.text ? { ...node.text, content: undefined } : undefined, children: node.children.map((child) => appearance(child, node)) }
  }
  const appearances = new Map<string, Set<string>>()
  const collect = (node: DesignNode, width: number) => {
    if (node.component) {
      const key = `${node.component.id}::${width}`
      const values = appearances.get(key) ?? new Set<string>()
      values.add(hashString(JSON.stringify(appearance(node))))
      appearances.set(key, values)
    }
    node.children.forEach((child) => collect(child, width))
  }
  captures.forEach((capture) => collect(capture.root, capture.width))

  const visit = (node: DesignNode, scenarioId: string, width: number) => {
    if (node.component) {
      const baseName = variantNameFor(width, widthLabels)
      const variantName = appearances.get(`${node.component.id}::${width}`)!.size > 1
        ? `${baseName}, State=${hashString(JSON.stringify(appearance(node)))}` : baseName
      node.componentVariant = variantName
      const variantKey = `${node.component.id}::${variantName}`
      let plan = components.get(node.component.id)
      if (!plan) {
        plan = {
          componentId: node.component.id,
          name: node.component.name,
          framework: node.component.framework,
          sourceFile: node.component.sourceFile,
          variants: [],
          instances: [],
        }
        components.set(node.component.id, plan)
      }
      const overrides: Record<string, string> = {}
      const master = masterTextByVariant.get(variantKey)
      if (!master) {
        plan.variants.push({ variantName, node, scenarioId, width })
        masterTextByVariant.set(variantKey, textMap(node))
      } else {
        const mine = textMap(node)
        for (const [path, text] of Object.entries(mine)) if (master[path] !== text) overrides[path] = text
      }
      plan.instances.push({ scenarioId, width, variantName, textOverrides: overrides })
    }
    for (const child of node.children) visit(child, scenarioId, width)
  }

  for (const capture of captures) visit(capture.root, capture.scenarioId, capture.width)

  return {
    components: Array.from(components.values()),
    frames: captures.map((capture) => ({ scenarioId: capture.scenarioId, width: capture.width, node: capture.root })),
    warnings: Array.from(new Set(captures.flatMap((capture) => capture.warnings ?? []))),
  }
}
