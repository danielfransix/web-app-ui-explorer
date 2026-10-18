/// <reference types="@figma/plugin-typings" />
import { hashString } from "../../src/shared/hash"
import { orderComponents, type ExportPlan } from "../../src/shared/plan"
import type { DesignNode, DesignText } from "../../src/shared/types"
import { diffCoverage, type CoveragePair } from "../../src/shared/verify"
import type { BridgeCommand, LibraryConfig, Placement } from "../../src/shared/bridge"
import { framePositions } from "../../src/shared/layout"

const COMPONENTS_PAGE_NAME = "⚙️ UI Explorer Components"
const tag = (node: BaseNode, key: string, value: string) => node.setPluginData("uix:" + key, value)
const read = (node: BaseNode, key: string) => node.getPluginData("uix:" + key)
type Scope = PageNode | SectionNode
type ComponentIndex = Map<string, Map<string, ComponentNode>>
let sharedIndex: ComponentIndex = new Map()
const runBaselines = new Map<string, Map<string, boolean>>()
const runPages = new Map<string, PageNode>()
const runFonts = new Map<string, Font[]>()
const indexedRuns = new Set<string>()
const deferredBaselines = new Set<string>()
let warnings: string[] = []
let libraryPaints: PaintStyle[] = []
let libraryTexts: TextStyle[] = []
let fonts: Font[] = []
const loadedFonts = new Map<string, Promise<void>>()
const warn = (message: string) => { if (!warnings.includes(message)) warnings.push(message) }
let nextYield = 0
let yieldSequence = 0
const hostYields = new Map<number, () => void>()
let activeRequestId: string | undefined
let activePhase = "Executing in Figma", nextProgress = 0
function progress(phase: string) {
  activePhase = phase
  if (activeRequestId) figma.ui.postMessage({ type: "command-progress", requestId: activeRequestId, phase })
}
async function figmaOperation<T>(label: string, action: () => Promise<T>): Promise<T> {
  const previous = activePhase
  progress(label)
  try { return await action() }
  catch (error) { throw new Error(label + ": " + (error instanceof Error ? error.message : String(error))) }
  finally { progress(previous) }
}
async function yieldToHost() {
  if (Date.now() < nextYield) return
  // A UI message round trip yields without depending on sandbox timer scheduling.
  await new Promise<void>((resolve) => {
    const id = ++yieldSequence
    hostYields.set(id, resolve)
    figma.ui.postMessage({ type: "host-yield", id })
  })
  nextYield = Date.now() + 40
  if (Date.now() >= nextProgress) { nextProgress = Date.now() + 1000; progress(activePhase) }
}

function paint(css: string): SolidPaint {
  const values = css.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0]
  return { type: "SOLID", color: { r: values[0] / 255, g: values[1] / 255, b: values[2] / 255 }, opacity: values[3] ?? 1 }
}
function samePaint(a: Paint | undefined, b: SolidPaint) {
  return a?.type === "SOLID" && Math.abs(a.color.r - b.color.r) < 0.002 && Math.abs(a.color.g - b.color.g) < 0.002 &&
    Math.abs(a.color.b - b.color.b) < 0.002 && Math.abs((a.opacity ?? 1) - (b.opacity ?? 1)) < 0.002
}
const paintCache = new Map<string, PaintStyle>()
async function paintStyle(color: string, token?: string): Promise<PaintStyle> {
  const key = color + ":" + (token ?? "")
  const cached = paintCache.get(key)
  if (cached) return cached
  const value = paint(color)
  const existing = [...libraryPaints, ...await figmaOperation("Reading Figma color styles", () => figma.getLocalPaintStylesAsync())].find((style) => style.paints.length === 1 && samePaint(style.paints[0], value))
  const style = existing ?? figma.createPaintStyle()
  if (!existing) { style.name = token?.replace(/^--/, "").replace(/-/g, " ") ?? "Color " + color; style.paints = [value] }
  paintCache.set(key, style)
  return style
}
async function geometry(node: FrameNode | ComponentNode, source: DesignNode) {
  node.resize(Math.max(1, source.rect.width), Math.max(1, source.rect.height))
  node.clipsContent = source.clipsContent ?? false; node.opacity = source.opacity ?? 1; node.fills = []
  if (source.fills.length === 1 && source.fills[0].type === "solid") {
    const styleId = (await paintStyle(source.fills[0].color, source.fills[0].token)).id
    await figmaOperation("Applying Figma color style", () => node.setFillStyleIdAsync(styleId))
  } else {
    const fills: Paint[] = []
    for (const fill of source.fills) {
      if (fill.type === "solid") fills.push(paint(fill.color))
      else try {
        const base64 = fill.src.match(/^data:[^;]+;base64,(.*)$/)?.[1]
        const bytes = base64 ? figma.base64Decode(base64) : new Uint8Array(await (await fetch(fill.src)).arrayBuffer())
        fills.push({ type: "IMAGE", imageHash: figma.createImage(bytes).hash, scaleMode: "FILL" })
      } catch { warn("Image could not be imported: " + fill.src.slice(0, 100)) }
    }
    node.fills = fills
  }
  node.strokes = source.stroke ? [paint(source.stroke.color)] : []
  node.strokeWeight = source.stroke?.width ?? 0; node.cornerRadius = source.radius ?? 0
  node.strokeAlign = "INSIDE"
  node.strokeTopWeight = source.stroke?.widths?.top ?? source.stroke?.width ?? 0
  node.strokeRightWeight = source.stroke?.widths?.right ?? source.stroke?.width ?? 0
  node.strokeBottomWeight = source.stroke?.widths?.bottom ?? source.stroke?.width ?? 0
  node.strokeLeftWeight = source.stroke?.widths?.left ?? source.stroke?.width ?? 0
  node.effects = (source.shadow ?? []).map((shadow) => ({ type: "DROP_SHADOW", color: { ...paint(shadow.color).color, a: paint(shadow.color).opacity ?? 1 },
    offset: { x: shadow.x, y: shadow.y }, radius: shadow.blur, spread: shadow.spread, visible: true, blendMode: "NORMAL" }))
}
async function fontFor(text: DesignText): Promise<FontName> {
  const families = text.fontFamily.split(",").map((family) => family.trim().replace(/^["']|["']$/g, ""))
  const preferred = text.fontWeight >= 700 ? ["Bold", "SemiBold", "Semibold", "Regular"] : text.fontWeight >= 600 ? ["SemiBold", "Semibold", "Bold", "Regular"] : text.fontWeight >= 500 ? ["Medium", "Regular"] : ["Regular", "Book"]
  let match: Font | undefined
  for (const family of families) {
    const available = fonts.filter((font) => font.fontName.family.toLowerCase() === family.toLowerCase())
    match = preferred.map((style) => available.find((font) => font.fontName.style.replace(/[\s-]/g, "").toLowerCase() === style.toLowerCase())).find(Boolean) ?? available[0]
    if (match) break
  }
  if (!match) {
    match = fonts.find((font) => font.fontName.family === "Inter" && font.fontName.style === "Regular") ?? fonts[0]
    warn("Font " + families[0] + " is unavailable; using " + (match?.fontName.family ?? "Inter") + ".")
  }
  const font = match?.fontName ?? { family: "Inter", style: "Regular" }
  const key = JSON.stringify(font)
  let loading = loadedFonts.get(key)
  if (!loading) {
    loading = figmaOperation(`Loading font ${font.family} ${font.style}`, () => figma.loadFontAsync(font)).catch(error => { loadedFonts.delete(key); throw error })
    loadedFonts.set(key, loading)
  }
  await loading
  return font
}
const textCache = new Map<string, TextStyle>()
async function drawText(source: DesignNode): Promise<TextNode> {
  const value = source.text!, node = figma.createText(), font = await fontFor(value)
  const rect = source.textRect ?? source.rect
  node.fontName = font
  const lineHeight: LineHeight = value.lineHeight === "normal" ? { unit: "AUTO" } : { unit: "PIXELS", value: value.lineHeight }
  const letterSpacing: LetterSpacing = { unit: "PIXELS", value: value.letterSpacing === "normal" ? 0 : value.letterSpacing }
  const key = JSON.stringify([font, value.fontSize, lineHeight, letterSpacing])
  let style = textCache.get(key)
  if (!style) {
    style = [...libraryTexts, ...await figmaOperation("Reading Figma text styles", () => figma.getLocalTextStylesAsync())].find((item) => item.fontName.family === font.family && item.fontName.style === font.style &&
      item.fontSize === value.fontSize && JSON.stringify(item.lineHeight) === JSON.stringify(lineHeight) && JSON.stringify(item.letterSpacing) === JSON.stringify(letterSpacing))
    if (!style) {
      style = figma.createTextStyle(); style.name = font.family + "/" + font.style + "/" + value.fontSize
      style.fontName = font; style.fontSize = value.fontSize; style.lineHeight = lineHeight; style.letterSpacing = letterSpacing
    }
    textCache.set(key, style)
  }
  await figmaOperation("Applying Figma text style", () => node.setTextStyleIdAsync(style.id))
  node.characters = value.content
  node.textAlignHorizontal = /center/i.test(value.align) ? "CENTER" : /right|end/i.test(value.align) ? "RIGHT" : "LEFT"
  await node.setFillStyleIdAsync((await paintStyle(value.color, value.colorToken)).id)
  // Browser text ranges can round down a fraction of a glyph. Preserve a captured single line rather
  // than introducing a wrap because Figma's font metrics differ slightly from the browser's.
  node.textAutoResize = "WIDTH_AND_HEIGHT"
  const linePixels = typeof value.lineHeight === "number" ? value.lineHeight : value.fontSize * 1.4
  const width = rect.height <= linePixels * 1.4 ? Math.max(rect.width + 1, node.width) : rect.width
  node.resize(Math.max(1, width), Math.max(1, rect.height))
  node.textAutoResize = "HEIGHT"
  return node
}
function shape(source: DesignNode): string {
  return hashString(JSON.stringify([source.tag, !!source.text, !!source.svg, source.children.map(shape)]))
}
function drawSvg(source: DesignNode): FrameNode {
  const node = figma.createNodeFromSvg(source.svg!)
  if (node.width > 0 && Math.abs(node.width - source.rect.width) > 0.01) node.rescale(source.rect.width / node.width)
  node.resize(Math.max(1, source.rect.width), Math.max(1, source.rect.height))
  return node
}
async function ownText(node: SceneNode, source: DesignNode) {
  if (node.type === "TEXT" && source.text && node.characters !== source.text.content) {
    await Promise.all(node.getRangeAllFontNames(0, node.characters.length).map((font) => figma.loadFontAsync(font)))
    node.characters = source.text.content
  }
  if ("children" in node) {
    if (source.text && node.children[0]) await ownText(node.children[0], source)
    else for (let i = 0; i < source.children.length; i++) if (node.children[i]) await ownText(node.children[i], source.children[i])
  }
}
async function drawChild(source: DesignNode, index: ComponentIndex, parentRect: { x: number; y: number }): Promise<SceneNode> {
  await yieldToHost()
  let node: SceneNode | undefined
  if (source.component) {
    const master = index.get(source.component.id)?.get(source.componentVariant ?? "")
    if (master) {
      if (read(master, "shape") === shape(source)) {
        node = master.createInstance(); node.name = source.component.name
        node.resize(Math.max(1, source.rect.width), Math.max(1, source.rect.height)); await ownText(node, source)
      } else warn("Component " + source.component.name + " has incompatible library structure; captured layers were used instead.")
    }
  }
  if (!node && source.svg) node = drawSvg(source)
  if (!node && source.text && !source.component && !source.fills.length && !source.stroke) node = await drawText(source)
  if (!node) node = await drawRoot(source, index, "frame")
  const position = node.type === "TEXT" ? source.textRect ?? source.rect : source.rect
  node.x = position.x - parentRect.x; node.y = position.y - parentRect.y
  return node
}
async function drawRoot(source: DesignNode, index: ComponentIndex, kind: "component" | "frame"): Promise<ComponentNode | FrameNode> {
  const node = kind === "component" ? figma.createComponent() : figma.createFrame()
  node.name = source.component?.name ?? source.tag
  await geometry(node, source)
  if (source.text) {
    const text = await drawText(source); node.appendChild(text)
    text.x = (source.textRect?.x ?? source.rect.x) - source.rect.x
    text.y = (source.textRect?.y ?? source.rect.y) - source.rect.y
  } else if (source.svg) {
    const vector = drawSvg(source); node.appendChild(vector); vector.x = vector.y = 0
  } else for (const child of source.children) node.appendChild(await drawChild(child, index, source.rect))
  return node
}
function fingerprint(node: SceneNode, version = 3): string {
  function state(current: SceneNode, root: boolean): unknown {
    const record: Record<string, unknown> = {}
    for (const key of ["type", "name", "width", "height", "visible", "opacity", "rotation", "fills", "strokes", "strokeWeight", "cornerRadius", "clipsContent", "effects", "fillStyleId", "textStyleId", "fontName", "fontSize", "lineHeight", "letterSpacing", "characters", "componentProperties", "strokeAlign", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"]) {
      if (version < 2 && key === "clipsContent") continue
      if (version < 3 && (key === "strokeAlign" || /^stroke(Top|Right|Bottom|Left)Weight$/.test(key))) continue
      try {
        const value = (current as unknown as Record<string, unknown>)[key]
        if (value !== undefined && typeof value !== "symbol") record[key] = value
      } catch (error) {
        if (key !== "componentProperties") throw error
        record[key] = "unavailable"
        warn("Existing component properties could not be inspected; affected content is protected from replacement.")
      }
    }
    if (!root) { record.x = current.x; record.y = current.y }
    if ("children" in current) record.children = current.children.map((child) => state(child, false))
    return record
  }
  return hashString(JSON.stringify(state(node, true)))
}
function edited(node: SceneNode) { return !!read(node, "appliedHash") && read(node, "appliedHash") !== fingerprint(node, Number(read(node, "fingerprintVersion")) || 1) }
function stamp(node: SceneNode, hash: string) { tag(node, "contentHash", hash); tag(node, "appliedHash", fingerprint(node)); tag(node, "fingerprintVersion", "3") }
function nextX(scope: Scope): number { return Math.max(0, ...scope.children.map((node) => node.x + node.width + 80)) }
async function transplant(target: FrameNode | ComponentNode, draft: FrameNode | ComponentNode) {
  for (const child of [...target.children]) child.remove()
  target.resize(draft.width, draft.height)
  target.fills = draft.fills
  if (typeof draft.fillStyleId === "string" && draft.fillStyleId) await target.setFillStyleIdAsync(draft.fillStyleId)
  target.strokes = draft.strokes; target.strokeAlign = draft.strokeAlign
  target.strokeTopWeight = draft.strokeTopWeight; target.strokeRightWeight = draft.strokeRightWeight
  target.strokeBottomWeight = draft.strokeBottomWeight; target.strokeLeftWeight = draft.strokeLeftWeight
  target.cornerRadius = draft.cornerRadius; target.effects = draft.effects; target.opacity = draft.opacity; target.clipsContent = draft.clipsContent
  for (const child of [...draft.children]) target.appendChild(child)
  draft.remove()
}
async function componentsPage() {
  const existing = figma.root.children.find((page) => page.name === COMPONENTS_PAGE_NAME)
  if (existing) return existing
  const page = figma.createPage(); page.name = COMPONENTS_PAGE_NAME; return page
}
async function repairComponentNames(names: Record<string, string>, pagesLoaded = false) {
  if (!pagesLoaded) await figma.loadAllPagesAsync()
  const page = figma.root.children.find((node) => node.name === COMPONENTS_PAGE_NAME)
  if (!page) return { report: [], componentNames: [], remaining: [] }
  const holders = page.findAll(node => ["COMPONENT", "COMPONENT_SET"].includes(node.type) && !!read(node, "componentId") && node.parent?.type !== "COMPONENT_SET")
  const legacy = holders.filter(node => /^Breakpoint=/.test(node.name) && !(node as ComponentNode | ComponentSetNode).remote)
  for (const node of holders) { const name = names[read(node, "componentId")] || read(node, "componentName"); if (name) tag(node, "componentName", name) }
  if (!legacy.some(node => names[read(node, "componentId")] || read(node, "componentName"))) return { report: [], componentNames: [], remaining: legacy.map(node => node.id) }
  // Renaming a master may propagate its default name into existing instances. Preserve the edit
  // baseline only for content that was already unedited before this naming-only repair.
  const tracked = figma.root.findAll((node) => (node.type === "FRAME" || node.type === "COMPONENT") && !!read(node, "appliedHash")) as SceneNode[]
  const unedited = tracked.filter((node) => !edited(node))
  const componentNames: { id: string; previous: string; name: string }[] = []
  const remaining: string[] = []
  for (const node of page.findAll((node) => ["COMPONENT", "COMPONENT_SET"].includes(node.type) && !!read(node, "componentId") && node.parent?.type !== "COMPONENT_SET")) {
    if ((node as ComponentNode | ComponentSetNode).remote) continue
    const name = names[read(node, "componentId")] || read(node, "componentName")
    if (name) tag(node, "componentName", name)
    if (!/^Breakpoint=/.test(node.name)) continue
    if (!name) { remaining.push(node.id); continue }
    const previous = node.name; node.name = name
    componentNames.push({ id: node.id, previous, name })
  }
  if (componentNames.length) for (const node of unedited) stamp(node, read(node, "contentHash"))
  return { report: componentNames.map(({ previous, name }) => "Renamed component " + previous + " to " + name), componentNames, remaining }
}
function normalizeVariantNames(nodes: ComponentNode[], componentName: string) {
  const entries = nodes.map((node) => ({ node, values: Object.fromEntries(read(node, "variant").split(/,\s*/).filter(Boolean).map((part) => {
    const at = part.indexOf("="); return at < 0 ? ["State", part] : [part.slice(0, at).trim(), part.slice(at + 1).trim()]
  })) }))
  const keys = [...new Set(entries.flatMap(({ values }) => Object.keys(values)))]
  for (const { node, values } of entries) {
    if (!Object.keys(values).length) continue
    const name = keys.map((key) => key + "=" + (values[key] ?? "Default")).join(", ")
    // Single masters use the component's display name. Restore their variant name when promoted
    // into a set, and give every sibling the same property keys as new captured states arrive.
    if ([read(node, "variant"), read(node, "variantDisplayName"), componentName].includes(node.name)) {
      if (node.name === name) { tag(node, "variantDisplayName", name); continue }
      const unchanged = !edited(node)
      node.name = name; tag(node, "variantDisplayName", name)
      if (unchanged && read(node, "appliedHash")) stamp(node, read(node, "contentHash"))
    }
  }
}
async function components(plan: ExportPlan, page: PageNode, libraries: LibraryConfig, report: string[], conflicts: string[], runId?: string): Promise<ComponentIndex> {
  // Nested instances change when their dependency masters update below. Judge edits before those
  // writes so our own changes do not turn an unedited parent component into a false conflict.
  const editsBefore = runBaselines.get(runId ?? "") ?? new Map(page.findAll((node) => node.type === "COMPONENT" && !!read(node, "componentId")).map((node) => [node.id, edited(node as ComponentNode)]))
  const index: ComponentIndex = new Map(Array.from(sharedIndex, ([id, variants]) =>
    [id, new Map(Array.from(variants).filter(([, node]) => !node.removed))]))
  // Later batches can reference masters established by earlier batches without resending their trees.
  for (const holder of runId && indexedRuns.has(runId) ? [] : page.findAll((node) => node.type === "COMPONENT" && !!read(node, "componentId"))) {
    const variants = index.get(read(holder, "componentId")) ?? new Map<string, ComponentNode>()
    variants.set(read(holder, "variant") || holder.name, holder as ComponentNode)
    index.set(read(holder, "componentId"), variants)
  }
  if (runId) indexedRuns.add(runId)
  const registered = (await figma.clientStorage.getAsync("uix:libraries") ?? {}) as NonNullable<LibraryConfig["components"]>
  const mappings = { ...registered, ...libraries.components }
  for (const component of orderComponents(plan.components)) {
    progress("Building component: " + component.name)
    const mapping = mappings[component.componentId]
    let external: ComponentNode | ComponentSetNode | undefined
    if (mapping) try {
      external = mapping.set ? await figma.importComponentSetByKeyAsync(mapping.key) : await figma.importComponentByKeyAsync(mapping.key)
    } catch { warn("Published library component " + component.name + " is unavailable; trying the local Components page.") }
    const existing = external ?? page.findOne((node) => ["COMPONENT", "COMPONENT_SET"].includes(node.type) && read(node, "componentId") === component.componentId) as ComponentNode | ComponentSetNode | undefined
    const variants = index.get(component.componentId) ?? new Map<string, ComponentNode>()
    if (existing) for (const node of existing.type === "COMPONENT_SET" ? existing.children : [existing]) {
      if (node.type === "COMPONENT") variants.set(read(node, "variant") || node.name, node)
    }
    index.set(component.componentId, variants)
    const drafts: ComponentNode[] = [], updated: ComponentNode[] = []
    for (const [variantIndex, variant] of component.variants.entries()) {
      progress(`Building ${component.name}: ${variantIndex + 1} of ${component.variants.length}`)
      let prior = variants.get(variant.variantName)
      if (!prior && external?.type === "COMPONENT" && component.variants.length === 1) prior = external
      if (external) {
        if (prior) variants.set(variant.variantName, prior)
        else warn("Library " + component.name + " lacks " + variant.variantName + "; captured layers will be used.")
        continue
      }
      const hash = hashString(JSON.stringify(variant.node))
      if (prior && read(prior, "contentHash") === hash) continue
      if (prior && (runBaselines.get(runId ?? "")?.get(prior.id) ?? editsBefore.get(prior.id) ?? edited(prior))) { conflicts.push("Component " + component.name + " / " + variant.variantName + " was edited in Figma; left untouched."); variants.delete(variant.variantName); continue }
      const draft = await drawRoot(variant.node, index, "component") as ComponentNode
      const built = prior ?? draft
      if (prior) await figmaOperation(`Updating ${component.name}: ${variantIndex + 1} of ${component.variants.length}`, () => transplant(prior, draft))
      else drafts.push(built)
      built.name = existing?.type !== "COMPONENT_SET" && variants.size <= 1 && component.variants.length === 1 ? component.name : variant.variantName
      tag(built, "variant", variant.variantName); tag(built, "componentName", component.name); tag(built, "shape", shape(variant.node)); tag(built, "componentId", component.componentId)
      variants.set(variant.variantName, built)
      tag(built, "contentHash", hash); updated.push(built)
      report.push("Component " + component.name + " / " + variant.variantName)
    }
    if (!external && (existing?.type === "COMPONENT_SET" || variants.size > 1))
      normalizeVariantNames([...new Set(variants.values())], component.name)
    if (!external && drafts.length) {
      if (existing?.type === "COMPONENT_SET") {
        for (const draft of drafts) { const x = nextX(existing as unknown as Scope); existing.appendChild(draft); draft.x = x; draft.y = 0 }
      } else {
        const all = [...new Set(variants.values())], x = existing?.x ?? nextX(page), y = existing?.y ?? 0
        for (let i = 0, offset = 0; i < all.length; i++) { page.appendChild(all[i]); all[i].x = offset; all[i].y = 0; offset += all[i].width + 40 }
        const holder = all.length > 1 ? figma.combineAsVariants(all, page) : all[0]
        page.appendChild(holder); holder.name = component.name; holder.x = x; holder.y = y
        tag(holder, "componentId", component.componentId)
        tag(holder, "componentName", component.name)
      }
    }
    for (const node of updated) { progress(`Checking built ${component.name}: ${node.id}`); stamp(node, read(node, "contentHash")) }
  }
  sharedIndex = index
  return index
}
async function destination(placement: Placement, current: PageNode, folder?: string): Promise<Scope> {
  if (!placement) throw new Error("Choose where the frames should go before building.")
  if (placement.container) {
    const parent = await destination({ ...placement, container: undefined }, current, folder)
    const existing = parent.children.find(node => node.type === "SECTION" && read(node, "importSection") === placement.container)
    if (existing?.type === "SECTION") return existing
    const section = figma.createSection(), x = nextX(parent)
    parent.appendChild(section); section.name = placement.container; tag(section, "importSection", placement.container)
    section.x = x; section.y = 0
    return section
  }
  if (placement.mode === "current-page") return current
  if (placement.mode === "section") {
    const node = placement.nodeId ? await figma.getNodeByIdAsync(placement.nodeId) : current.findOne((node) => node.type === "SECTION" && node.name === placement.name)
    if (node?.type !== "SECTION") throw new Error("Choose an existing section by name or node ID.")
    return node
  }
  const name = placement.mode === "per-folder" ? folder || placement.name || "UI Explorer" : placement.name
  if (!name) throw new Error("A destination page name is required.")
  const existing = figma.root.children.find((page) => page.name === name)
  if (existing) return existing
  const page = figma.createPage(); page.name = name; return page
}
async function exportPages(message: Extract<BridgeCommand, { type: "begin-export" }>, current: PageNode): Promise<PageNode[]> {
  if (!message.placement) { await figma.loadAllPagesAsync(); return [...figma.root.children] }
  const pages = new Set<PageNode>(), placement = message.placement
  if (placement.mode === "current-page") pages.add(current)
  else if (placement.mode === "section") {
    if (!placement.nodeId) await current.loadAsync()
    const scope = await destination({ ...placement, container: undefined }, current)
    let page: BaseNode | null = scope
    while (page && page.type !== "PAGE") page = page.parent
    if (page?.type === "PAGE") pages.add(page)
  } else {
    const names = placement.mode === "per-folder" ? message.folders ?? [] : [placement.name]
    for (const name of names) { const page = figma.root.children.find(p => p.name === name); if (page) pages.add(page) }
  }
  if (message.createComponents !== false) {
    const library = figma.root.children.find(page => page.name === COMPONENTS_PAGE_NAME)
    if (library) pages.add(library)
  }
  await Promise.all([...pages].map(page => page.loadAsync()))
  return [...pages]
}
function coverage(scope: Scope): CoveragePair[] {
  return scope.findAll((node) => node.type === "FRAME" && !!read(node, "scenarioId"))
    .map((node) => ({ scenarioId: read(node, "scenarioId"), width: Number(read(node, "width")) }))
}
async function handleBuild(plan: ExportPlan, placement: Placement, libraries: LibraryConfig = {}, runId?: string, componentScope?: Extract<BridgeCommand, { type: "build" }>["componentScope"]) {
  if (!plan || !Array.isArray(plan.frames) || !Array.isArray(plan.components)) throw new Error("Invalid UI Explorer design plan.")
  if (!placement) throw new Error("Choose a destination before building.")
  progress("Loading Figma pages…")
  if (!runId || !runPages.has(runId)) await figma.loadAllPagesAsync()
  const current = runPages.get(runId ?? "") ?? figma.currentPage, scopes: Scope[] = []
  for (const frame of plan.frames) scopes.push(await destination(placement, current, frame.folder))
  const report: string[] = [], conflicts: string[] = []
  warnings = [...plan.warnings ?? []]; paintCache.clear(); textCache.clear(); libraryPaints = []; libraryTexts = []
  for (const key of [...libraries.paintStyleKeys ?? [], ...libraries.textStyleKeys ?? []]) try {
    const style = await figma.importStyleByKeyAsync(key)
    if (style.type === "PAINT") libraryPaints.push(style as PaintStyle)
    if (style.type === "TEXT") libraryTexts.push(style as TextStyle)
  } catch { warn("Published style " + key + " could not be imported.") }
  progress("Reading available fonts…")
  fonts = runId && runFonts.get(runId) || await figma.listAvailableFontsAsync()
  if (runId) runFonts.set(runId, fonts)
  if (runId && deferredBaselines.has(runId) && plan.components.length) {
    const scope = new Map(componentScope?.map(component => [component.componentId, new Map(component.variants.map(variant => [variant.name, variant.contentHash]))]))
    if (!scope.size || plan.components.some(component => component.variants.some(variant => scope.get(component.componentId)?.get(variant.variantName) !== hashString(JSON.stringify(variant.node))))) throw new Error("The first component batch must identify the complete component scope before writing.")
    const page = await componentsPage()
    const tracked = page.findAll(node => {
      if (node.type !== "COMPONENT") return false
      const expected = scope.get(read(node, "componentId"))?.get(read(node, "variant") || node.name)
      return !!expected && expected !== read(node, "contentHash")
    })
    const baseline = runBaselines.get(runId)!
    for (let i = 0; i < tracked.length; i++) {
      progress(`Checking component ${i + 1} of ${tracked.length}: ${tracked[i].name} (${tracked[i].id})`)
      baseline.set(tracked[i].id, edited(tracked[i] as SceneNode)); await yieldToHost()
    }
    deferredBaselines.delete(runId)
  }
  if (plan.createComponents !== false) report.push(...(await repairComponentNames(Object.fromEntries(plan.components.map((component) => [component.componentId, component.name])), true)).report)
  const old = plan.frames.map((frame, i) => scopes[i].findOne((node) => node.type === "FRAME" && read(node, "scenarioId") === frame.scenarioId && read(node, "width") === String(frame.width)) as FrameNode | undefined)
  const wasEdited = old.map((node) => node ? runBaselines.get(runId ?? "")?.get(node.id) ?? edited(node) : false)
  const index: ComponentIndex = plan.createComponents === false ? new Map() : await components(plan, await componentsPage(), libraries, report, conflicts, runId)
  for (let i = 0; i < plan.frames.length; i++) {
    progress("Building screen: " + plan.frames[i].scenarioId)
    const frame = plan.frames[i], prior = old[i], scope = scopes[i], hash = hashString(JSON.stringify(plan.createComponents === false ? { node: frame.node, createComponents: false } : frame.node))
    if (prior && read(prior, "contentHash") === hash) continue
    if (prior && wasEdited[i]) { conflicts.push(frame.scenarioId + " @ " + frame.width + "px was edited in Figma; left untouched."); continue }
    const draft = await drawRoot(frame.node, index, "frame") as FrameNode
    const built = prior ?? draft
    if (prior) await transplant(prior, draft)
    else { const x = nextX(scope); scope.appendChild(built); built.x = x; built.y = 0 }
    built.name = frame.scenarioId + " @ " + frame.width
    tag(built, "scenarioId", frame.scenarioId); tag(built, "width", String(frame.width)); stamp(built, hash)
    report.push("Frame " + built.name)
  }
  const expected = plan.frames.map(({ scenarioId, width }) => ({ scenarioId, width }))
  const actual = [...new Set(scopes)].flatMap(coverage)
  figma.notify(conflicts.length ? conflicts.length + " conflict(s) left untouched; see plugin panel." : "Built " + report.length + " node(s).")
  return { report, conflicts, warnings, coverage: diffCoverage(expected, actual) }
}
async function arrange(message: Extract<BridgeCommand, { type: "arrange" }>) {
  const scope = await destination(message.placement, runPages.get(message.runId ?? "") ?? figma.currentPage)
  const frames = message.expected.map(pair => scope.findOne(node => node.type === "FRAME" && read(node, "scenarioId") === pair.scenarioId && read(node, "width") === String(pair.width)) as FrameNode | null)
  if (frames.some(frame => !frame)) throw new Error("Some frames are missing; layout was not applied.")
  const nodes = frames as FrameNode[], positions = framePositions(nodes, message.layout)
  const conflicts: string[] = []
  nodes.forEach((node, i) => {
    const position = read(node, "layoutPosition")
    if (edited(node) || position && position !== JSON.stringify({ x: node.x, y: node.y })) { conflicts.push(node.name + " has manual edits or a moved position; layout left untouched."); return }
    node.x = positions[i].x; node.y = positions[i].y
    tag(node, "layoutPosition", JSON.stringify({ x: node.x, y: node.y }))
  })
  if (scope.type === "SECTION") scope.resizeWithoutConstraints(Math.max(100, ...scope.children.map(n => n.x + n.width + 40)), Math.max(100, ...scope.children.map(n => n.y + n.height + 40)))
  let page: BaseNode | null = scope
  while (page && page.type !== "PAGE") page = page.parent
  if (page === figma.currentPage) {
    const selection = scope.type === "SECTION" ? [scope] : nodes
    figma.currentPage.selection = selection
    figma.viewport.scrollAndZoomIntoView(selection)
  }
  return { report: ["Applied " + message.layout.mode + " layout to " + (nodes.length - conflicts.length) + " frames."], conflicts, warnings: [] }
}
async function registerLibrary(componentId: string) {
  await figma.loadAllPagesAsync()
  const selected = figma.currentPage.selection[0]
  const node = selected && ["COMPONENT", "COMPONENT_SET"].includes(selected.type) ? selected as ComponentNode | ComponentSetNode :
    figma.root.findOne((node) => ["COMPONENT", "COMPONENT_SET"].includes(node.type) && read(node, "componentId") === componentId) as ComponentNode | ComponentSetNode | undefined
  if (!node) throw new Error("Select a published component or component set first.")
  const id = componentId || read(node, "componentId")
  if (!id) throw new Error("Enter the stable component ID from the export plan.")
  const mappings = await figma.clientStorage.getAsync("uix:libraries") ?? {}
  mappings[id] = { key: node.key, set: node.type === "COMPONENT_SET" }
  await figma.clientStorage.setAsync("uix:libraries", mappings)
  return { report: ["Registered " + node.name + " as " + id + ". Publish it before importing in another file."], conflicts: [], warnings: [] }
}
let work = Promise.resolve()
const completedRequests = new Map<string, unknown>()
const queuedRequests = new Set<string>()
type ConnectionMessage = { type: "connection-bootstrap" | "connection-context" | "forget-connection" } | { type: "save-connection"; connection: { url: string; token: string; requestId?: string } }
const connectionContext = () => ({ documentName: figma.root.name || "Figma document", pageId: figma.currentPage.id, pageName: figma.currentPage.name })
figma.ui.onmessage = (message: (BridgeCommand | ConnectionMessage | { type: "host-yield"; id: number } | { type: "register-library"; componentId: string }) & { requestId?: string }) => {
  // Handle this outside the work queue: the current command is waiting for this acknowledgement.
  if (message.type === "host-yield") { const resume = hostYields.get(message.id); hostYields.delete(message.id); resume?.(); return }
  if (message.requestId) {
    const completed = completedRequests.get(message.requestId)
    if (completed) { figma.ui.postMessage(completed); return }
    if (queuedRequests.has(message.requestId)) return
    queuedRequests.add(message.requestId)
  }
  const reply = (result: unknown) => {
    if (message.requestId) {
      completedRequests.set(message.requestId, result); queuedRequests.delete(message.requestId)
      if (completedRequests.size > 512) completedRequests.delete(completedRequests.keys().next().value!)
    }
    figma.ui.postMessage(result)
  }
  work = work.then(async () => {
    activeRequestId = message.requestId
    try {
      if (message.type === "connection-bootstrap") { figma.ui.postMessage({ type: "connection-bootstrap", connection: await figma.clientStorage.getAsync("uix:connection"), context: connectionContext() }); return }
      if (message.type === "connection-context") { figma.ui.postMessage({ type: "connection-context", context: connectionContext() }); return }
      if (message.type === "save-connection") { await figma.clientStorage.setAsync("uix:connection", message.connection); return }
      if (message.type === "forget-connection") { await figma.clientStorage.setAsync("uix:connection", undefined); return }
      let result
      progress("Starting " + message.type)
      if (message.type === "build") result = await handleBuild(message.plan, message.placement, message.libraries, message.runId, message.componentScope)
      else if (message.type === "begin-export") {
        progress("Loading destination pages and component library…")
        const pages = await exportPages(message, figma.currentPage)
        // Component updates propagate into existing instances before later frame messages arrive.
        // Keep the edit decision from before those writes rather than treating our own updates as edits.
        runBaselines.clear()
        runPages.clear(); runFonts.clear(); deferredBaselines.clear(); runPages.set(message.runId, figma.currentPage)
        if (message.deferComponentBaseline) deferredBaselines.add(message.runId)
        sharedIndex = new Map(); indexedRuns.clear()
        const tracked = pages.flatMap(page => page.findAll((node) => (node.type === "FRAME" && !!read(node, "scenarioId")) || (!message.deferComponentBaseline && node.type === "COMPONENT" && !!read(node, "componentId"))))
        const baseline = new Map<string, boolean>()
        for (let i = 0; i < tracked.length; i++) {
          if (i % 20 === 0) progress(`Checking protected edits: ${i} of ${tracked.length}`)
          baseline.set(tracked[i].id, edited(tracked[i] as SceneNode)); await yieldToHost()
        }
        runBaselines.set(message.runId, baseline)
        result = { report: [], conflicts: [], warnings: [] }
      }
      else if (message.type === "end-export") { runBaselines.delete(message.runId); runPages.delete(message.runId); runFonts.delete(message.runId); indexedRuns.delete(message.runId); deferredBaselines.delete(message.runId); result = { report: [], conflicts: [], warnings: [] } }
      else if (message.type === "arrange") result = await arrange(message)
      else if (message.type === "register-library") result = await registerLibrary(message.componentId)
      else if (message.type === "repair-component-names") result = await repairComponentNames(message.names)
      else if (message.type === "verify") { if (!message.runId || !runPages.has(message.runId)) await figma.loadAllPagesAsync(); result = { coverage: diffCoverage(message.expected, coverage(await destination(message.placement, runPages.get(message.runId ?? "") ?? figma.currentPage))) } }
      else if (message.type === "render") {
        const scope = await destination(message.placement, figma.currentPage)
        const node = scope.findOne((node) => node.type === "FRAME" && read(node, "scenarioId") === message.scenarioId && read(node, "width") === String(message.width))
        if (node?.type !== "FRAME") throw new Error("No matching imported frame to render.")
        result = { render: { nodeId: node.id, bounds: { x: node.x, y: node.y, width: node.width, height: node.height }, parentId: node.parent?.id, pngBase64: figma.base64Encode(await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } })) } }
      }
      else throw new Error("Unknown plugin request")
      reply({ type: "result", requestId: message.requestId, ...result })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      figma.notify(text, { error: true }); reply({ type: "result", requestId: message.requestId, error: text })
    }
    finally { activeRequestId = undefined }
  })
}
figma.showUI(__html__, { width: 540, height: 820, themeColors: true })
figma.on("currentpagechange", () => figma.ui.postMessage({ type: "connection-context", context: connectionContext() }))
