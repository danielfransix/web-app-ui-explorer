import assert from "node:assert/strict"
import test from "node:test"
import { buildPlan, diffCoverage, hashCapture } from "../dist/node/index.js"

// Pure logic - no Figma, no browser. These build synthetic DesignNode/DesignCapture objects directly
// rather than going through a real capture, since the point is to verify the planner's own decisions.

const leaf = (text, extra = {}) => ({
  tag: "span", rect: { x: 0, y: 0, width: 10, height: 10 }, fills: [], children: [],
  text: { content: text, fontFamily: "Arial", fontSize: 14, fontWeight: 400, lineHeight: "normal", letterSpacing: "normal", color: "rgb(0,0,0)", align: "left" },
  ...extra,
})
const frame = (children, extra = {}) => ({ tag: "div", rect: { x: 0, y: 0, width: 100, height: 40 }, fills: [], children, ...extra })
const component = (id, name = "Button") => ({ id, name, framework: "react" })

test("buildPlan can preserve captured editable layers without preparing component masters", () => {
  const captures = [{ scenarioId:"screen", width:1440, warnings:["Example warning"], root:frame([frame([leaf("Save")], { component:component("button") })]) }]
  const before = JSON.stringify(captures)
  const plan = buildPlan(captures, {}, {createComponents:false})
  assert.equal(plan.createComponents,false)
  assert.deepEqual(plan.components,[])
  assert.deepEqual(plan.frames[0].node,captures[0].root)
  assert.deepEqual(plan.warnings,["Example warning"])
  assert.equal(JSON.stringify(captures),before)
  assert.equal(buildPlan(captures).components.length,1,"default behavior still creates components")
})

test("buildPlan: the first occurrence of a component becomes its master variant; later ones become instances with text overrides", () => {
  const button1 = frame([leaf("Save")], { component: component("btn-1") })
  const button2 = frame([leaf("Cancel")], { component: component("btn-1") })
  const captures = [
    { scenarioId: "screen-a", width: 1440, capturedAt: "x", root: frame([button1]) },
    { scenarioId: "screen-b", width: 1440, capturedAt: "x", root: frame([button2]) },
  ]
  const plan = buildPlan(captures, { 1440: "Desktop" })
  assert.equal(plan.components.length, 1)
  const [btn] = plan.components
  assert.equal(btn.componentId, "btn-1")
  assert.equal(btn.variants.length, 1, "only one variant exists - both occurrences are the same breakpoint")
  assert.equal(btn.variants[0].variantName, "Breakpoint=Desktop")
  assert.equal(btn.instances.length, 2, "every occurrence is an instance, including the master's own")
  assert.deepEqual(btn.instances[0].textOverrides, {}, "the defining occurrence has no overrides against itself")
  assert.deepEqual(btn.instances[1].textOverrides, { "./0": "Cancel" }, "the second occurrence's differing text is an override, not a new component")
})

test("buildPlan: the same component at a different requested width becomes a second variant, not a duplicate component", () => {
  const desktop = frame([leaf("Save")], { component: component("btn-1") })
  const mobile = frame([leaf("Save")], { component: component("btn-1") })
  const captures = [
    { scenarioId: "screen-a", width: 1440, capturedAt: "x", root: frame([desktop]) },
    { scenarioId: "screen-a", width: 390, capturedAt: "x", root: frame([mobile]) },
  ]
  const plan = buildPlan(captures, { 1440: "Desktop", 390: "Mobile" })
  assert.equal(plan.components.length, 1)
  assert.deepEqual(plan.components[0].variants.map((v) => v.variantName).sort(), ["Breakpoint=Desktop", "Breakpoint=Mobile"])
  assert.equal(plan.components[0].instances.length, 2)
})

test("buildPlan: an uncaptured width/component combination is simply absent, never fabricated", () => {
  const captures = [{ scenarioId: "screen-a", width: 1440, capturedAt: "x", root: frame([leaf("No components here")]) }]
  const plan = buildPlan(captures)
  assert.deepEqual(plan.components, [])
  assert.equal(plan.frames.length, 1)
})

test("buildPlan: captured interaction states at the same width become separate variants with occurrence-specific names", () => {
  const plain = frame([leaf("Save")], { component: component("btn") })
  const danger = { ...plain, fills: [{ type: "solid", color: "rgb(255, 0, 0)" }] }
  const plan = buildPlan([
    { scenarioId: "a", width: 1440, root: frame([plain]) },
    { scenarioId: "b", width: 1440, root: frame([danger]) },
  ])
  assert.equal(plan.components[0].variants.length, 2)
  assert.notEqual(plan.frames[0].node.children[0].componentVariant, plan.frames[1].node.children[0].componentVariant)
  assert.equal(plain.componentVariant, undefined, "planning does not mutate original captures")
})

test("hashCapture: identical content hashes the same regardless of capturedAt; different content hashes differently", () => {
  const a = { scenarioId: "s", width: 1440, capturedAt: "2026-01-01T00:00:00Z", root: frame([leaf("Hello")]) }
  const b = { scenarioId: "s", width: 1440, capturedAt: "2026-06-01T00:00:00Z", root: frame([leaf("Hello")]) }
  const c = { scenarioId: "s", width: 1440, capturedAt: "2026-01-01T00:00:00Z", root: frame([leaf("Goodbye")]) }
  assert.equal(hashCapture(a), hashCapture(b), "capturedAt must not affect the hash, or re-runs could never skip unchanged screens")
  assert.notEqual(hashCapture(a), hashCapture(c))
})

test("diffCoverage: reports exactly what's missing and what's unexpected, not a bare count", () => {
  const expected = [{ scenarioId: "a", width: 1440 }, { scenarioId: "a", width: 390 }, { scenarioId: "b", width: 1440 }]
  const actual = [{ scenarioId: "a", width: 1440 }, { scenarioId: "c", width: 1440 }]
  const report = diffCoverage(expected, actual)
  assert.deepEqual(report.missing, [{ scenarioId: "a", width: 390 }, { scenarioId: "b", width: 1440 }])
  assert.deepEqual(report.unexpected, [{ scenarioId: "c", width: 1440 }])
})

test("diffCoverage: a fully covered scope reports nothing in either direction", () => {
  const pairs = [{ scenarioId: "a", width: 1440 }, { scenarioId: "a", width: 390 }]
  const report = diffCoverage(pairs, pairs)
  assert.deepEqual(report, { missing: [], unexpected: [] })
})
