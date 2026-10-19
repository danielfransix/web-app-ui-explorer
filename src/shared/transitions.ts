import type { Action, Candidate, Scenario, Transition, TransitionStep } from "./types"

export type ConnectionDescription = {
  label: string
  from: string
  to: string
  steps: TransitionStep[]
  description?: string
  evidence: "captured" | "provided" | "recipe" | "unknown"
}

export const candidateStep = (candidate: Candidate): TransitionStep => ({
  type: candidate.role === "option" ? "select" : candidate.action.kind,
  label: candidate.label,
  role: candidate.role,
})

// Only plain target selectors establish semantics. A class name or ancestor is not evidence of a role.
function selectorRole(selector: string): string | undefined {
  const native = /^(button|a|input|textarea|select)(?:[#.][\w-]+|\[[^\]]+\])*$/.exec(selector.trim())?.[1]
  if (native) return ({ a: "link", textarea: "textbox" } as Record<string, string>)[native] ?? native
  return /^\[role=["']?([\w-]+)["']?\](?:\[[^\]]+\])*$/.exec(selector.trim())?.[1]
}

export function recipeStep(action: Action): TransitionStep {
  const role = selectorRole(action.selector)
  return { type: role === "select" || role === "option" ? "select" : action.kind,
    label: action.kind === "click" ? action.text : undefined, role }
}

export function describeConnection(edge: Transition, source?: Scenario, target?: Scenario): ConnectionDescription {
  const provided = edge.details ?? (target?.parent === edge.source ? target.transition : undefined)
  let steps = (Array.isArray(provided?.steps) ? provided.steps : []).filter(step => step && typeof step === "object").map(step => ({
    type: typeof step.type === "string" && step.type.trim() ? step.type : "unknown",
    ...(typeof step.label === "string" ? { label: step.label } : {}),
    ...(typeof step.role === "string" ? { role: step.role } : {}),
    ...(typeof step.description === "string" ? { description: step.description } : {}),
  })) as TransitionStep[]
  let evidence: ConnectionDescription["evidence"] = provided ? (target?.origin === "crawled" && !edge.details ? "captured" : "provided") : "unknown"
  // Recipes start at a fresh page. Only a verified source prefix identifies the relative steps.
  if (!provided && source?.actions && target?.actions && target.actions.length > source.actions.length &&
      source.actions.every((action, index) => JSON.stringify(action) === JSON.stringify(target.actions![index]))) {
    steps = target.actions.slice(source.actions.length).map(recipeStep)
    evidence = "recipe"
  }
  const label = (typeof edge.label === "string" ? edge.label.trim() : "") || steps.at(-1)?.label?.trim() ||
    (steps.at(-1)?.type === "automatic" ? "Automatic transition" : steps.length ? actionName(steps.at(-1)!.type) : "View connection")
  return { label, from: source?.title || edge.source, to: target?.title || edge.target,
    steps, description: typeof provided?.description === "string" ? provided.description : undefined, evidence }
}

export function actionName(type: string): string {
  return ({ click: "Click", fill: "Fill in", select: "Select", hover: "Hover", key: "Press key", submit: "Submit", automatic: "Automatic", unknown: "Interaction" } as Record<string, string>)[type] || type.replace(/[_-]+/g, " ").replace(/^./, c => c.toUpperCase()) || "Interaction"
}

export function controlName(role?: string): string {
  if (!role) return "Control type not recorded"
  if (/^(div|span|svg|path|label|li|p|h[1-6])$/.test(role)) return "Interactive element"
  return ({ a: "Link", link: "Link", button: "Button", textbox: "Text field", input: "Field", text: "Text field", email: "Email field", password: "Password field", textarea: "Text field", select: "Dropdown", option: "Option", menuitem: "Menu item", checkbox: "Checkbox", radio: "Radio option", tab: "Tab", switch: "Switch" } as Record<string, string>)[role] || role.replace(/[_-]+/g, " ").replace(/^./, c => c.toUpperCase())
}

/** Explicit connections own their pair; retain distinct parallel declarations and their evidence. */
export function canvasConnections(scenarios: Scenario[], declared: Transition[]): Transition[] {
  const ids = new Set(scenarios.map(s => s.id))
  const explicit = declared.filter(edge => ids.has(edge.source) && ids.has(edge.target))
  const pairs = new Set(explicit.map(edge => JSON.stringify([edge.source, edge.target])))
  const parents = scenarios.filter(s => s.parent && ids.has(s.parent) && !pairs.has(JSON.stringify([s.parent, s.id])))
    .map(s => ({ source: s.parent!, target: s.id, label: s.trigger }))
  const seen = new Set<string>()
  return [...parents, ...explicit].filter(edge => {
    const key = JSON.stringify(edge)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
