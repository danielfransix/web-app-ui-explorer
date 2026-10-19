import { hashString } from "../shared/hash"
import { PREVIEW_PARAM, STATUS_ATTRIBUTE, type PreviewMessage } from "../shared/preview"
import { replayController, replayId, takeContinuation } from "./replay"
import type {
  Action,
  AutofillResult,
  Candidate,
  ComponentRef,
  DesignFill,
  DesignNode,
  DesignShadow,
  DesignStroke,
  ReplayResult,
  Snapshot,
  UixRuntime,
} from "../shared/types"

// Runs inside the app being explored. It is the one place that decides how a recipe step finds its
// element, so a crawled recipe replays the same way in the crawler, the thumbnails and the previews.
// Vanilla DOM only: it must work in any front-end.

const normalized = (text: string | null | undefined) =>
  (text ?? "").replace(/\s+/g, " ").trim()

const CHROME_PARAMS = /^(__uix|scenario|preview-embed)/

// ---- Visibility -----------------------------------------------------------------------------------

function isVisible(element: Element): boolean {
  if (element.closest("[hidden],[inert]")) return false
  if (!element.getClientRects().length) return false
  const style = getComputedStyle(element)
  return style.visibility !== "hidden" && style.display !== "none"
}

const isHiddenFromUsers = (element: Element) =>
  !isVisible(element) || !!element.closest('[aria-hidden="true"]')

// ---- Finding elements by recipe step --------------------------------------------------------------

function matches(action: Action): Element[] {
  let found: Element[]
  try {
    found = Array.from(document.querySelectorAll(action.selector)).filter(isVisible)
  } catch {
    return []
  }
  if (action.kind === "fill" || !action.text) return found
  const text = action.text
  return found.filter((element) => {
    const own = normalized(element.textContent)
    return action.prefix ? own.startsWith(text) : own === text
  })
}

function resolve(action: Action): Element | null {
  return matches(action)[0] ?? null
}

// ---- Acting on elements ---------------------------------------------------------------------------

function pressElement(element: HTMLElement, pointer?: boolean) {
  if (!pointer) {
    element.click()
    return
  }
  // Some libraries open menus on pointer events rather than on click.
  const rect = element.getBoundingClientRect()
  const init = {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
  }
  element.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerType: "mouse" }))
  element.dispatchEvent(new MouseEvent("mousedown", init))
  element.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerType: "mouse" }))
  element.dispatchEvent(new MouseEvent("mouseup", init))
  element.click()
}

function setValue(element: Element, value: string) {
  if (element instanceof HTMLSelectElement) {
    element.value = value
    element.dispatchEvent(new Event("input", { bubbles: true }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
    return
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    // The native setter bypasses the value tracking that frameworks use to ignore programmatic changes.
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value)
    element.dispatchEvent(new Event("input", { bubbles: true }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
    return
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    element.focus()
    element.textContent = value
    element.dispatchEvent(new Event("input", { bubbles: true }))
    return
  }
  throw new Error("The fill target is not a text control")
}

function perform(action: Action, element: Element) {
  if (action.kind === "click") pressElement(element as HTMLElement, action.pointer)
  else setValue(element, action.value)
}

// ---- Waiting --------------------------------------------------------------------------------------

// "Settled" has to mean more than "the DOM is quiet right now": a click can start a timer that changes the
// screen a moment later. The runtime is injected before the app runs, so it can see short timers, requests
// and animations that are still pending.
const SHORT_TIMER_MS = 1500
let pendingTimers = 0
let pendingRequests = 0
// Captured before tracking is installed: the runtime's own polling must not count as pending work.
const rawSetTimeout = window.setTimeout.bind(window)

function trackWork() {
  const timers = new Map<number, true>()
  const nativeSetTimeout = window.setTimeout.bind(window)
  const nativeClearTimeout = window.clearTimeout.bind(window)
  window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (typeof handler !== "function" || (delay ?? 0) > SHORT_TIMER_MS)
      return nativeSetTimeout(handler as TimerHandler, delay, ...args)
    let id = 0
    id = nativeSetTimeout(() => {
      if (timers.delete(id)) pendingTimers--
      handler(...args)
    }, delay) as unknown as number
    timers.set(id, true)
    pendingTimers++
    return id
  }) as typeof window.setTimeout
  window.clearTimeout = ((id?: number) => {
    if (id !== undefined && timers.delete(id)) pendingTimers--
    nativeClearTimeout(id)
  }) as typeof window.clearTimeout
  const nativeFetch = window.fetch?.bind(window)
  if (nativeFetch) {
    window.fetch = ((...args: Parameters<typeof fetch>) => {
      pendingRequests++
      return nativeFetch(...args).finally(() => {
        pendingRequests--
      })
    }) as typeof fetch
  }
  const nativeSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest["send"]>) {
    pendingRequests++
    this.addEventListener("loadend", () => {
      pendingRequests--
    }, { once: true })
    return nativeSend.apply(this, args)
  }
}

// The runtime is loaded into the app on every page in development, but it only takes over when the page is
// opened as a preview (or by a crawler). Everywhere else it adds one keyboard shortcut.
const previewId = new URLSearchParams(location.search).get(PREVIEW_PARAM)
// A crawler may have installed the runtime already; the copy the app injects must not run a second time.
const ALREADY = !!window.__uix
const continuation = ALREADY ? undefined : takeContinuation()
if (continuation) {
  window.__UIX_ROUTE = continuation.endpoint
  window.__UIX_STATIC = continuation.static
}
const ACTIVE = !ALREADY && (continuation !== undefined || previewId !== null || (window as unknown as { __UIX_FORCE?: boolean }).__UIX_FORCE === true)
if (ACTIVE) trackWork()
// The injected runtime precedes the host's scripts. Track completed async scripts/styles so preview
// readiness can wait for hydration without also waiting for unrelated images or embedded media.
const completedResources = new WeakSet<EventTarget>()
if (ACTIVE) {
  const completed = (event: Event) => {
    if (event.target instanceof HTMLScriptElement || event.target instanceof HTMLLinkElement)
      completedResources.add(event.target)
  }
  document.addEventListener("load", completed, true)
  document.addEventListener("error", completed, true)
}

function runningAnimations() {
  // Endless animations (spinners, shimmer) are decoration, not a screen that is still changing.
  return document
    .getAnimations()
    .filter(
      (animation) =>
        animation.playState === "running" &&
        animation.effect?.getComputedTiming().iterations !== Infinity,
    ).length
}

const busy = () => pendingTimers > 0 || pendingRequests > 0 || runningAnimations() > 0

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

/** Resolves once the page has stopped changing and nothing short is still pending, or after `maxMs`. */
function settle(quietMs = 150, maxMs = 2500): Promise<void> {
  return new Promise((done) => {
    let lastChange = performance.now()
    const start = lastChange
    const observer = new MutationObserver(() => {
      lastChange = performance.now()
    })
    // Structure and text changes only: attribute churn (animations, focus rings) would never go quiet.
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["hidden", "open", "aria-expanded", "aria-hidden", "data-open", "data-closed", "data-state"],
    })
    const check = () => {
      const now = performance.now()
      if (now - start >= maxMs || (now - lastChange >= quietMs && !busy())) {
        observer.disconnect()
        void frame().then(frame).then(done)
        return
      }
      rawSetTimeout(check, 30)
    }
    check()
  })
}

async function waitFor(action: Action, timeoutMs: number): Promise<Element | null> {
  const start = performance.now()
  for (;;) {
    const found = resolve(action)
    if (found) return found
    if (performance.now() - start > timeoutMs) return null
    await frame()
  }
}

// ---- Building recipe steps for elements -----------------------------------------------------------

// Generated ids (React, Radix, Base UI ...) change between loads, so they make poor selectors.
const UNSTABLE_ID = /^(?:[:«]|_?r_|react-|radix-|headlessui-|base-ui-|mui-|ember|ng-|\d)|\d{4,}/i
const stableId = (id: string) => !!id && id.length < 60 && !UNSTABLE_ID.test(id)
const escapeAttribute = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')

function structuralPath(element: Element): string {
  const parts: string[] = []
  let node: Element | null = element
  while (node && node !== document.body && node !== document.documentElement) {
    if (stableId(node.id)) {
      parts.unshift(`#${CSS.escape(node.id)}`)
      break
    }
    const parent: Element | null = node.parentElement
    const tag = node.tagName.toLowerCase()
    const same = parent
      ? Array.from(parent.children).filter((child) => child.tagName === node!.tagName)
      : [node]
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag)
    node = parent
  }
  return parts.join(" > ")
}

type Selection = { selector: string; text?: string; prefix?: boolean }

function selectionsFor(element: Element, kind: "click" | "fill"): Selection[] {
  const tag = element.tagName.toLowerCase()
  const role = element.getAttribute("role")
  const base = role && role !== "button" && role !== "link" ? `[role="${role}"]` : tag
  const found: Selection[] = []
  if (stableId(element.id)) found.push({ selector: `#${CSS.escape(element.id)}` })
  for (const attribute of ["data-testid", "data-test", "data-cy", "data-qa"]) {
    const value = element.getAttribute(attribute)
    if (value) found.push({ selector: `[${attribute}="${escapeAttribute(value)}"]` })
  }
  const label = element.getAttribute("aria-label")
  if (label) found.push({ selector: `${tag}[aria-label="${escapeAttribute(label)}"]` })
  const name = element.getAttribute("name")
  if (name && /^(input|select|textarea)$/.test(tag))
    found.push({ selector: `${tag}[name="${escapeAttribute(name)}"]` })
  const placeholder = element.getAttribute("placeholder")
  if (placeholder) found.push({ selector: `${tag}[placeholder="${escapeAttribute(placeholder)}"]` })
  if (kind === "click") {
    const text = normalized(element.textContent)
    if (text) {
      const long = text.length > 60
      const shown = long ? text.slice(0, 50) : text
      found.push({ selector: base, text: shown, prefix: long || undefined })
      if (base !== tag) found.push({ selector: tag, text: shown, prefix: long || undefined })
    }
  }
  found.push({ selector: structuralPath(element) })
  return found
}

function actionFor(
  element: Element,
  kind: "click" | "fill",
  value = "",
  pointer?: boolean,
): Action | null {
  for (const selection of selectionsFor(element, kind)) {
    const action: Action =
      kind === "click"
        ? { kind: "click", ...selection, ...(pointer ? { pointer: true } : {}) }
        : { kind: "fill", selector: selection.selector, value }
    if (resolve(action) === element) return action
  }
  return null
}

// ---- What a person would call things --------------------------------------------------------------

function labelOf(element: Element): string {
  const own =
    element.getAttribute("aria-label") ||
    normalized(element.textContent) ||
    element.getAttribute("title") ||
    element.getAttribute("placeholder") ||
    ""
  if (own) return own.length > 80 ? `${own.slice(0, 77)}…` : own
  if (element instanceof HTMLInputElement) {
    const associated = normalized(element.labels?.[0]?.textContent)
    if (associated) return associated
  }
  return element.id || element.tagName.toLowerCase()
}

const roleOf = (element: Element) =>
  element.getAttribute("role") ||
  (element instanceof HTMLAnchorElement
    ? "link"
    : element instanceof HTMLInputElement
      ? element.type
      : element.tagName.toLowerCase())

// ---- Layers: dialogs and the page behind them -----------------------------------------------------

function visibleDialogs(): Element[] {
  const all = Array.from(
    document.querySelectorAll(
      '[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]',
    ),
  ).filter(isVisible)
  return all.filter((dialog) => !all.some((other) => other !== dialog && other.contains(dialog)))
}

/** The dialog that blocks the page behind it, if any. */
function blockingDialog(): Element | null {
  const blocking = visibleDialogs().filter(
    (dialog) =>
      dialog.getAttribute("aria-modal") === "true" ||
      dialog.getAttribute("role") === "alertdialog" ||
      (dialog instanceof HTMLDialogElement && dialog.matches(":modal")),
  )
  return blocking[blocking.length - 1] ?? null
}

function dialogName(dialog: Element): string {
  const label = dialog.getAttribute("aria-label")
  if (label) return normalized(label)
  const ids = (dialog.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)
  const named = normalized(ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" "))
  if (named) return named
  const heading = dialog.querySelector('h1,h2,h3,[role="heading"],strong')
  if (heading) return normalized(heading.textContent)
  return normalized(dialog.textContent).slice(0, 40)
}

// ---- Snapshot -------------------------------------------------------------------------------------

function visibleText(root: Element): string {
  const parts: string[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement
    if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName)) continue
    if (isHiddenFromUsers(parent)) continue
    const text = node.textContent
    if (text && text.trim()) parts.push(text)
  }
  return parts.join(" ")
}

const tokensOf = (text: string) =>
  Array.from(
    new Set(
      text
        .toLowerCase()
        // Numbers vary between loads (counts, times) and would make the same state look new.
        .replace(/\d+/g, "#")
        .match(/[\p{L}#][\p{L}#'’-]*/gu) ?? [],
    ),
  ).sort()

function snapshot(): Snapshot {
  const dialogs = visibleDialogs()
  const layer = blockingDialog() ?? document.body
  const params = new URLSearchParams(location.search)
  for (const key of Array.from(params.keys())) if (CHROME_PARAMS.test(key)) params.delete(key)
  const query = params.toString()
  const headings = Array.from(
    document.querySelectorAll('h1,h2,[role="heading"][aria-level="1"],[role="heading"][aria-level="2"]'),
  )
    .filter((heading) => isVisible(heading) && !dialogs.some((dialog) => dialog.contains(heading)))
    .map((heading) => normalized(heading.textContent))
    .filter(Boolean)
  const selected = Array.from(
    document.querySelectorAll(
      '[aria-selected="true"],[aria-checked="true"],[aria-pressed="true"],input:checked',
    ),
  )
    .filter((control) => isVisible(control))
    .map((control) => labelOf(control))
    .filter(Boolean)
    .sort()
  return {
    url: `${location.pathname}${query ? `?${query}` : ""}${location.hash}`,
    title: document.title,
    headings: Array.from(new Set(headings)),
    dialogs: dialogs.map(dialogName),
    menus: Array.from(document.querySelectorAll('[role="menu"]')).filter(isVisible).length,
    selected: Array.from(new Set(selected)),
    listbox: Array.from(document.querySelectorAll('[role="listbox"]')).some(isVisible),
    tokens: tokensOf(visibleText(layer)),
  }
}

// ---- Cross-framework component detection -----------------------------------------------------------
// "This subtree is component X, defined at this file" read from the running app itself, so component
// identity is a codebase fact, not a shape guessed at inside a design file. Every detector here reads an
// internal/dev-mode hook (documented as such where it isn't an official API) and is tried in roughly the
// order of how stable that hook is expected to be. Frameworks with no reliable hook fall through to
// `undefined`, which the caller treats as "no component reuse for this subtree" - never a hard failure.

function componentRef(
  framework: ComponentRef["framework"],
  name: string,
  sourceFile?: string,
  sourceLine?: number,
): ComponentRef {
  const id = hashString(sourceFile ? `${sourceFile}#${name}` : `${framework}:${name}`)
  return { id, name, sourceFile, sourceLine, framework }
}

// React attaches a fiber reference under a key shaped like `__reactFiber$<id>` directly on the DOM node
// (an internal, not a public API - the key suffix changes per React build, so it's found by prefix).
function detectReact(element: Element): ComponentRef | undefined {
  const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"))
  if (!key) return undefined
  type Fiber = {
    type?: { displayName?: string; name?: string }
    _debugSource?: { fileName?: string; lineNumber?: number }
    return?: Fiber | null
  }
  let fiber: Fiber | null | undefined = (element as unknown as Record<string, Fiber>)[key]
  while (fiber) {
    if (typeof fiber.type === "function" || (fiber.type && typeof fiber.type === "object")) {
      const name = fiber.type?.displayName ?? fiber.type?.name
      if (name) return componentRef("react", name, fiber._debugSource?.fileName, fiber._debugSource?.lineNumber)
    }
    fiber = fiber.return
  }
  return undefined
}

// Vue 3 attaches the owning component instance directly under `__vueParentComponent` in development -
// also internal, not a public API.
function detectVue(element: Element): ComponentRef | undefined {
  type VueInstance = { type?: { name?: string; __name?: string; __file?: string }; parent?: VueInstance | null }
  let instance: VueInstance | null | undefined = (element as unknown as { __vueParentComponent?: VueInstance })
    .__vueParentComponent
  while (instance) {
    const name = instance.type?.name ?? instance.type?.__name
    if (name) return componentRef("vue", name, instance.type?.__file)
    instance = instance.parent
  }
  return undefined
}

// Angular DevTools' own debugging entry point - the most official of these, since it's a documented
// debugging helper rather than an internal implementation detail.
function detectAngular(element: Element): ComponentRef | undefined {
  const ng = (window as unknown as { ng?: { getComponent?: (el: Element) => unknown } }).ng
  const instance = ng?.getComponent?.(element)
  const name = (instance as { constructor?: { name?: string } } | undefined)?.constructor?.name
  return name && name !== "Object" ? componentRef("angular", name) : undefined
}

// A custom element's tag name is its component identity, directly, through the standard registry - a web
// platform standard, not a framework internal, and the most stable detector here.
function detectWebComponent(element: Element): ComponentRef | undefined {
  const tag = element.tagName.toLowerCase()
  if (!tag.includes("-")) return undefined
  const ctor = customElements.get(tag)
  if (!ctor) return undefined
  return componentRef("web-component", ctor.name || tag)
}

// Svelte attaches file/line/column metadata under `__svelte_meta.loc` in development (the same data its
// own official inspector tool uses) - a location, not a component name, so the file's basename stands in
// for a human-readable name until something resolves it further.
function detectSvelte(element: Element): ComponentRef | undefined {
  const loc = (element as unknown as { __svelte_meta?: { loc?: { file?: string; line?: number } } }).__svelte_meta
    ?.loc
  if (!loc?.file) return undefined
  const name = loc.file.split("/").pop() ?? loc.file
  return componentRef("svelte", name, loc.file, loc.line)
}

// Astro's scoped-style hash (`data-astro-cid-*`) is a documented styling feature, not an internal, but it
// only identifies "which Astro component scope", not a human name or file - resolving that further needs
// the build output, which isn't reachable from inside the running page.
function detectAstro(element: Element): ComponentRef | undefined {
  const match = Array.from(element.attributes).find((attribute) => attribute.name.startsWith("data-astro-cid-"))
  if (!match) return undefined
  const hash = match.name.slice("data-astro-cid-".length)
  return componentRef("astro", hash)
}

const DETECTORS = [detectReact, detectVue, detectAngular, detectWebComponent, detectSvelte, detectAstro]

function detectComponent(element: Element): ComponentRef | undefined {
  for (const detector of DETECTORS) {
    const found = detector(element)
    if (found) return found
  }
  return undefined
}

// ---- Design capture ---------------------------------------------------------------------------------
// Walks a rendered subtree into a structured node tree close enough to Figma's own model (frames, text,
// fills, strokes) to be rebuilt as real editable layers. Deliberately skips what the DOM can't give a
// straight, unambiguous answer for (gradients, mixed per-side borders, non-uniform corner radii) rather
// than guessing.

const SKIP_DESIGN_TAG = /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/

function parseColor(value: string): string | undefined {
  if (!value || value === "transparent") return undefined
  value = normalizeColor(value)
  const match = value.match(/rgba?\(([^)]+)\)/)
  if (!match) return value
  const alpha = Number(match[1].split(",")[3]?.trim() ?? "1")
  return alpha === 0 ? undefined : value
}

function parsePx(value: string | undefined): number | undefined {
  const match = value?.match(/^(-?[\d.]+(?:e[+-]?\d+)?)px$/i)
  return match ? Number(match[1]) : undefined
}

/** Splits a comma-separated CSS value without splitting inside a function's parentheses. */
function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ""
  for (const char of value) {
    if (char === "(") depth++
    if (char === ")") depth--
    if (char === "," && depth === 0) {
      parts.push(current.trim())
      current = ""
    } else current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

// A color/text style that already exists as a design token should resolve to it, not be redrawn as a
// disconnected value - so a later system can link to the matching Figma style instead of a raw fill.
// The browser's own color parser normalises both the candidate token value and the resolved value to the
// same representation (rgb()), rather than this code trying to parse every CSS color syntax itself.
let colorProbe: HTMLDivElement | undefined
const normalizedColors = new Map<string, string>()
const tokenColors = new Map<string, string>()
function normalizeColor(value: string): string {
  const cached = normalizedColors.get(value)
  if (cached) return cached
  if (!colorProbe) {
    colorProbe = document.createElement("div")
    colorProbe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;top:-9999px"
    document.documentElement.appendChild(colorProbe)
  }
  colorProbe.style.color = ""
  colorProbe.style.color = value
  const resolved = getComputedStyle(colorProbe).color
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const context = canvas.getContext("2d", { willReadFrequently: true })!
  context.fillStyle = resolved
  context.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
  const result = a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a / 255})`
  normalizedColors.set(value, result)
  return result
}

function cssVariableNameFor(element: Element, resolvedColor: string): string | undefined {
  const style = getComputedStyle(element)
  const cached = tokenColors.get(resolvedColor)
  if (cached && normalizeColor(style.getPropertyValue(cached).trim()) === resolvedColor) return cached
  for (let index = 0; index < style.length; index++) {
    const prop = style[index]
    if (!prop.startsWith("--")) continue
    const raw = style.getPropertyValue(prop).trim()
    if (raw && CSS.supports("color", raw) && normalizeColor(raw) === resolvedColor) { tokenColors.set(resolvedColor, prop); return prop }
  }
  return undefined
}

function readFills(style: CSSStyleDeclaration, element: Element): DesignFill[] {
  const fills: DesignFill[] = []
  const color = parseColor(style.backgroundColor)
  if (color) fills.push({ type: "solid", color, token: cssVariableNameFor(element, color) })
  const image = style.backgroundImage
  const url = image && image !== "none" ? image.match(/url\((['"]?)(.*?)\1\)/) : null
  if (url) fills.push({ type: "image", src: url[2] })
  return fills
}

const BORDER_SIDES = ["Top", "Right", "Bottom", "Left"] as const

function readStroke(style: CSSStyleDeclaration, element: Element): DesignStroke | undefined {
  const styles = BORDER_SIDES.map((side) => style.getPropertyValue(`border-${side.toLowerCase()}-style`))
  const widths = BORDER_SIDES.map((side, index) => styles[index] === "none" ? 0 : parsePx(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) ?? 0)
  const colors = BORDER_SIDES.map((side) => style.getPropertyValue(`border-${side.toLowerCase()}-color`))
  const activeColors = colors.filter((_, index) => widths[index] > 0)
  if (!activeColors.length || !activeColors.every((value) => value === activeColors[0])) return undefined
  const width = Math.max(...widths)
  const color = parseColor(activeColors[0])
  if (!width || !color) return undefined
  return { color, width, token: cssVariableNameFor(element, color),
    ...(!widths.every((value) => value === width) ? { widths: { top: widths[0], right: widths[1], bottom: widths[2], left: widths[3] } } : {}) }
}

const RADIUS_CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"]

function readRadius(style: CSSStyleDeclaration): number | undefined {
  const values = RADIUS_CORNERS.map((corner) => {
    const value = style.getPropertyValue(`border-${corner}-radius`)
    return value.includes("infinity") ? 9999 : Math.min(9999, parsePx(value) ?? 0)
  })
  // Non-uniform corners are a known gap in this first pass.
  return values.every((value) => value === values[0]) ? values[0] || undefined : undefined
}

function readShadows(value: string): DesignShadow[] | undefined {
  if (!value || value === "none") return undefined
  const shadows = splitTopLevel(value)
    .map((shadow): DesignShadow | undefined => {
      if (/\binset\b/.test(shadow)) return undefined // drop shadows have no clean Figma-node equivalent
      const color = shadow.match(/rgba?\([^)]+\)/)?.[0]
      const lengths = color ? shadow.replace(color, "") : shadow
      const [x, y, blur = 0, spread = 0] = lengths.trim().split(/\s+/).map((part) => parsePx(part) ?? NaN)
      if (!color || !Number.isFinite(x) || !Number.isFinite(y)) return undefined
      return { x, y, blur, spread, color }
    })
    .filter((shadow): shadow is DesignShadow => !!shadow)
  return shadows.length ? shadows : undefined
}

/** An element with no element children (ignoring skipped tags) is where text is read from, as one leaf. */
function isTextLeaf(element: Element): boolean {
  return !Array.from(element.children).some((child) => !SKIP_DESIGN_TAG.test(child.tagName))
}

function walkDesign(
  element: Element,
  originX: number,
  originY: number,
  parentComponent?: ComponentRef,
): DesignNode | undefined {
  if (SKIP_DESIGN_TAG.test(element.tagName) || element.closest("[hidden]")) return undefined
  const rect = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return undefined
  // Visually clipped accessibility labels and hidden form mirrors are not canvas content.
  if ((rect.width <= 1 && rect.height <= 1) && (style.clipPath !== "none" || style.clip !== "auto" || style.overflow === "hidden")) return undefined
  const detected = detectComponent(element)
  const isBoundary = !!detected && detected.id !== parentComponent?.id
  const effectiveComponent = isBoundary ? detected : parentComponent
  // Absolutely positioned descendants can be visible inside a zero-height positioning container.
  // Preserve those bounds just as for display:contents, unless overflow really clips them away.
  if ((rect.width <= 0 || rect.height <= 0) && (style.display === "contents" || (style.overflowX === "visible" && style.overflowY === "visible"))) {
    const children = Array.from(element.children).map((child) => walkDesign(child, originX, originY, effectiveComponent))
      .filter((node): node is DesignNode => !!node)
    if (!children.length) return undefined
    const x = Math.min(...children.map((child) => child.rect.x)), y = Math.min(...children.map((child) => child.rect.y))
    return { tag: element.tagName.toLowerCase(), rect: { x, y,
      width: Math.max(...children.map((child) => child.rect.x + child.rect.width)) - x,
      height: Math.max(...children.map((child) => child.rect.y + child.rect.height)) - y }, fills: [], children, component: isBoundary ? detected : undefined }
  }
  if (rect.width <= 0 || rect.height <= 0) return undefined
  const opacity = Number(style.opacity)
  // Only tag the node where a component's identity first differs from its parent's - the component's own
  // root in the DOM - not every descendant already covered by that same tag.
  const node: DesignNode = {
    tag: element.tagName.toLowerCase(),
    rect: { x: rect.left - originX, y: rect.top - originY, width: rect.width, height: rect.height },
    fills: readFills(style, element),
    stroke: readStroke(style, element),
    radius: readRadius(style),
    shadow: readShadows(style.boxShadow),
    opacity: Number.isFinite(opacity) && opacity < 1 ? opacity : undefined,
    clipsContent: /hidden|clip|auto|scroll/.test(style.overflowX + " " + style.overflowY) || undefined,
    component: isBoundary ? detected : undefined,
    children: [],
  }
  if (element instanceof SVGSVGElement) {
    const clone = element.cloneNode(true) as SVGSVGElement
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg")
    clone.setAttribute("width", String(rect.width)); clone.setAttribute("height", String(rect.height))
    clone.style.width = rect.width + "px"; clone.style.height = rect.height + "px"
    clone.setAttribute("color", parseColor(style.color) ?? "rgb(0, 0, 0)")
    const originals = [element, ...Array.from(element.querySelectorAll("*"))]
    const copies = [clone, ...Array.from(clone.querySelectorAll("*"))]
    originals.forEach((original, index) => {
      const computed = getComputedStyle(original)
      for (const prop of ["fill", "stroke", "stroke-width", "opacity", "color"]) {
        const value = computed.getPropertyValue(prop)
        const resolved = (prop === "fill" || prop === "stroke" || prop === "color") && value !== "none" ? parseColor(value) ?? "none" : value
        copies[index].setAttribute(prop, resolved)
        if (copies[index] instanceof SVGElement) (copies[index] as SVGElement).style.setProperty(prop, resolved)
      }
    })
    node.svg = clone.outerHTML
    return node
  }
  if (element instanceof HTMLImageElement && element.currentSrc) node.fills.push({ type: "image", src: element.currentSrc })
  if (element instanceof HTMLCanvasElement) {
    try { node.fills.push({ type: "image", src: element.toDataURL() }) } catch { /* Tainted canvases cannot be read. */ }
  }
  if (isTextLeaf(element)) {
    const content = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? (element.type === "password" ? "•".repeat(element.value.length) : element.value || element.placeholder)
      : normalized(element.textContent)
    if (content) {
      const color = parseColor(style.color) ?? "rgb(0, 0, 0)"
      // Superscripts often have line-height:0 while their glyphs still paint above the baseline.
      // Use a positive drawing box instead of dividing by zero and serializing NaN coordinates.
      const measuredLineHeight = parsePx(style.lineHeight)
      const lineHeight = measuredLineHeight && measuredLineHeight > 0 ? measuredLineHeight : (parsePx(style.fontSize) ?? 16) * 1.2
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        const left = (parsePx(style.borderLeftWidth) ?? 0) + (parsePx(style.paddingLeft) ?? 0)
        const right = (parsePx(style.borderRightWidth) ?? 0) + (parsePx(style.paddingRight) ?? 0)
        const top = element instanceof HTMLTextAreaElement ? (parsePx(style.borderTopWidth) ?? 0) + (parsePx(style.paddingTop) ?? 0) : (rect.height - lineHeight) / 2
        node.textRect = { x: node.rect.x + left, y: node.rect.y + top, width: Math.max(1, rect.width - left - right), height: lineHeight }
      } else {
        const range = document.createRange(); range.selectNodeContents(element)
        const box = range.getBoundingClientRect()
        if (box.width > 0 && box.height > 0) {
          const lines = Math.max(1, Math.round(box.height / lineHeight))
          const height = lines * lineHeight
          node.textRect = { x: box.x - originX, y: box.y - originY - (height - box.height) / 2, width: box.width, height }
        }
      }
      node.text = {
        content,
        fontFamily: style.fontFamily,
        fontSize: parsePx(style.fontSize) ?? 16,
        fontWeight: Number(style.fontWeight) || 400,
        lineHeight: measuredLineHeight === 0 ? lineHeight : measuredLineHeight ?? "normal",
        letterSpacing: style.letterSpacing === "normal" ? "normal" : parsePx(style.letterSpacing) ?? "normal",
        color,
        colorToken: cssVariableNameFor(element, color),
        align: style.textAlign,
      }
    }
    return node
  }
  for (const child of Array.from(element.childNodes)) {
    if (child instanceof Element) {
      const childNode = walkDesign(child, originX, originY, effectiveComponent)
      if (childNode) node.children.push(childNode)
    } else if (child.nodeType === Node.TEXT_NODE && normalized(child.textContent)) {
      const range = document.createRange(); range.selectNodeContents(child)
      const box = range.getBoundingClientRect()
      if (box.width > 0 && box.height > 0) node.children.push({ tag: "#text", rect: { x: box.x - originX, y: box.y - originY, width: box.width, height: box.height }, fills: [], children: [],
        text: { content: normalized(child.textContent), fontFamily: style.fontFamily, fontSize: parsePx(style.fontSize) ?? 16, fontWeight: Number(style.fontWeight) || 400,
          lineHeight: parsePx(style.lineHeight) ?? "normal", letterSpacing: parsePx(style.letterSpacing) ?? "normal", color: parseColor(style.color) ?? "rgb(0, 0, 0)", align: style.textAlign } })
    }
  }
  return node
}

function captureDesign(options: { root?: Element } = {}): DesignNode | null {
  normalizedColors.clear(); tokenColors.clear()
  const root = options.root ?? document.body
  const origin = root.getBoundingClientRect()
  if (options.root) return walkDesign(root, origin.left, origin.top) ?? null
  const body = walkDesign(root, 0, 0)
  if (!body) return null
  // Capture the visible viewport. Offscreen editable layers can remain under this clipped frame,
  // while fixed navigation/footer layers keep the same coordinates as the preview.
  return { tag: "viewport", rect: { x: 0, y: 0, width: innerWidth, height: innerHeight },
    fills: [{ type: "solid", color: parseColor(getComputedStyle(document.documentElement).backgroundColor) ?? "rgb(255, 255, 255)" }], clipsContent: true, children: [body] }
}

// ---- Candidates -----------------------------------------------------------------------------------

const CLICKABLE = [
  "button",
  "a[href]",
  "summary",
  'input[type="checkbox"]',
  'input[type="radio"]',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="radio"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="link"]',
  '[role="treeitem"]',
].join(",")

const PRIMARY = /^(continue|next|save|submit|finish|done|apply|create|confirm|generate|activate|publish|send|start|get started|review|proceed|ok|yes|add)\b/i
const DEFAULT_DENY = ["sign ?out", "log ?out", "logout"]

function isDisabled(element: Element) {
  return (
    (element as HTMLButtonElement).disabled === true ||
    element.getAttribute("aria-disabled") === "true" ||
    !!element.closest("fieldset:disabled")
  )
}

function isUsable(element: Element, modal: Element | null): boolean {
  if (isHiddenFromUsers(element) || isDisabled(element)) return false
  if (modal && !modal.contains(element)) return false
  const rect = element.getBoundingClientRect()
  const inside =
    rect.width > 0 &&
    rect.height > 0 &&
    rect.left >= 0 &&
    rect.top >= 0 &&
    rect.right <= innerWidth &&
    rect.bottom <= innerHeight
  if (inside) {
    // Something drawn on top (a drawer, an overlay) means the element cannot be reached right now.
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    if (top && !element.contains(top) && !top.contains(element)) return false
  }
  return true
}

function isInternalLink(element: Element): boolean {
  if (!(element instanceof HTMLAnchorElement)) return true
  const href = element.getAttribute("href") ?? ""
  if (!href || href.startsWith("#") || /^(mailto:|tel:|javascript:)/i.test(href)) return false
  if (element.target === "_blank" || element.hasAttribute("download")) return false
  try {
    return new URL(element.href, location.href).origin === location.origin
  } catch {
    return false
  }
}

function candidates(options: { deny?: string[] } = {}): Candidate[] {
  const deny = (options.deny ?? DEFAULT_DENY).map((pattern) => new RegExp(pattern, "i"))
  const modal = blockingDialog()
  const usable = Array.from(document.querySelectorAll(CLICKABLE)).filter((element) =>
    isUsable(element, modal),
  )
  // A button inside a link (or a radio inside its label) is one control, not two.
  const innermost = usable.filter(
    (element) => !usable.some((other) => other !== element && element.contains(other)),
  )
  const seen = new Set<string>()
  const found: Candidate[] = []
  for (const element of innermost) {
    const label = labelOf(element)
    if (deny.some((pattern) => pattern.test(label))) continue
    if (!isInternalLink(element)) continue
    const action = actionFor(element, "click")
    if (!action) continue
    const key = JSON.stringify(action)
    if (seen.has(key)) continue
    seen.add(key)
    const url = element instanceof HTMLAnchorElement ? new URL(element.href, location.href) : undefined
    found.push({ action, label, role: roleOf(element), primary: PRIMARY.test(label),
      ...(url ? { destination: `${url.pathname}${url.search}${url.hash}` } : {}) })
  }
  // Native dropdowns: one candidate per choice.
  for (const select of Array.from(document.querySelectorAll("select")).filter((element) =>
    isUsable(element, modal),
  )) {
    for (const option of Array.from(select.options)) {
      if (option.disabled || !option.value || option.selected) continue
      const action = actionFor(select, "fill", option.value)
      if (!action) break
      found.push({
        action,
        label: `${labelOf(select)}: ${normalized(option.textContent)}`,
        role: "option",
        primary: false,
      })
    }
  }
  return found
}

/** The choices of the dropdown that is open right now. */
function popupOptions(): Candidate[] {
  const found: Candidate[] = []
  const seen = new Set<string>()
  for (const option of Array.from(document.querySelectorAll('[role="option"]'))) {
    if (!isVisible(option) || isDisabled(option)) continue
    const text = normalized(option.textContent)
    if (!text || seen.has(text)) continue
    const action: Action = { kind: "click", selector: '[role="option"]', text }
    if (resolve(action) !== option) continue
    seen.add(text)
    found.push({ action, label: text, role: "option", primary: false })
  }
  return found
}

// ---- Autofill -------------------------------------------------------------------------------------

function fieldHint(element: Element): string {
  const input = element as HTMLInputElement
  const label = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    ? normalized(element.labels?.[0]?.textContent)
    : ""
  return [
    input.type,
    input.name,
    element.id,
    element.getAttribute("aria-label"),
    element.getAttribute("placeholder"),
    label,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function guessValue(element: Element): string {
  const hint = fieldHint(element)
  const input = element as HTMLInputElement
  const limit = input.maxLength > 0 ? input.maxLength : 0
  const fit = (value: string) => (limit ? value.slice(0, limit) : value)
  if (/e-?mail/.test(hint)) return fit("alex.morgan@example.com")
  if (/\b(tel|phone|mobile)\b/.test(hint)) return fit("5551234567")
  if (/\b(url|website|link)\b/.test(hint)) return fit("https://example.com")
  if (input.type === "number" || /\b(number|quantity|count|target|salary|amount|age)\b/.test(hint))
    return input.min || "3"
  if (input.type === "date") return "2030-01-15"
  if (input.type === "time") return "09:00"
  if (input.type === "password") return fit("Passw0rd!123")
  if (/first.?name/.test(hint)) return fit("Alex")
  if (/(last.?name|surname)/.test(hint)) return fit("Morgan")
  if (/name/.test(hint)) return fit("Alex Morgan")
  if (/(title|role|position|job)/.test(hint)) return fit("Platform Designer")
  if (/company|organi[sz]ation/.test(hint)) return fit("Acme Inc")
  if (/(city|location|address)/.test(hint)) return fit("Lagos")
  return fit(element instanceof HTMLTextAreaElement ? "Sample text for this field." : "Sample")
}

const SKIP_INPUT = /^(hidden|checkbox|radio|file|submit|button|reset|image|range|color)$/

// While a dialog blocks the page, only its fields matter.
const scope = (): ParentNode => blockingDialog() ?? document

function emptyTextFields(): Element[] {
  return Array.from(
    scope().querySelectorAll(
      'input, textarea, [contenteditable=""], [contenteditable="true"]',
    ),
  ).filter((element) => {
    if (isHiddenFromUsers(element) || isDisabled(element)) return false
    if (element instanceof HTMLInputElement) {
      if (SKIP_INPUT.test(element.type) || element.readOnly) return false
      return !element.value
    }
    if (element instanceof HTMLTextAreaElement) return !element.value && !element.readOnly
    return !normalized(element.textContent)
  })
}

function placeholderDropdowns(): Element[] {
  return Array.from(
    scope().querySelectorAll('[role="combobox"],[aria-haspopup="listbox"]'),
  ).filter((element) => {
    if (isHiddenFromUsers(element) || isDisabled(element)) return false
    if (element.getAttribute("data-placeholder") === "true") return true
    return /^(choose|select|pick)\b/i.test(normalized(element.textContent))
  })
}

function unchosenRadios(): Element[] {
  const groups = Array.from(scope().querySelectorAll('[role="radiogroup"]'))
  const found: Element[] = []
  for (const group of groups) {
    if (isHiddenFromUsers(group)) continue
    const radios = Array.from(group.querySelectorAll('[role="radio"],input[type="radio"]')).filter(
      (radio) => !isHiddenFromUsers(radio) && !isDisabled(radio),
    )
    const checked = radios.some(
      (radio) =>
        radio.getAttribute("aria-checked") === "true" ||
        (radio instanceof HTMLInputElement && radio.checked),
    )
    if (!checked && radios[0]) found.push(radios[0])
  }
  return found
}

/** Fills every empty field and makes a first choice in every empty dropdown and radio group. */
async function autofill(): Promise<AutofillResult> {
  const actions: Action[] = []
  const done = new Set<string>()
  const remember = (action: Action) => {
    actions.push(action)
    done.add(JSON.stringify(action))
  }
  for (let round = 0; round < 40; round++) {
    const field = emptyTextFields().find((element) => {
      const action = actionFor(element, "fill", guessValue(element))
      return action && !done.has(JSON.stringify(action))
    })
    if (!field) break
    const action = actionFor(field, "fill", guessValue(field))!
    perform(action, field)
    remember(action)
    await settle(60, 400)
  }
  for (let round = 0; round < 20; round++) {
    const trigger = placeholderDropdowns().find((element) => {
      const action = actionFor(element, "click")
      return action && !done.has(JSON.stringify(action))
    })
    if (!trigger) break
    let open = actionFor(trigger, "click")!
    pressElement(trigger as HTMLElement)
    await settle(80, 600)
    if (!popupOptions().length) {
      // Try the way a pointer would open it.
      const pointer = actionFor(trigger, "click", "", true)
      if (pointer) {
        open = pointer
        pressElement(trigger as HTMLElement, true)
        await settle(80, 600)
      }
    }
    done.add(JSON.stringify(open))
    const first = popupOptions().find((option) => !/^(choose|select|none)\b/i.test(option.label))
    if (!first) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      await settle(60, 400)
      continue
    }
    const option = resolve(first.action)
    if (!option) continue
    pressElement(option as HTMLElement)
    actions.push(open, first.action)
    await settle(80, 600)
  }
  for (let round = 0; round < 20; round++) {
    const radio = unchosenRadios().find((element) => {
      const action = actionFor(element, "click")
      return action && !done.has(JSON.stringify(action))
    })
    if (!radio) break
    const action = actionFor(radio, "click")!
    pressElement(radio as HTMLElement)
    remember(action)
    await settle(60, 400)
  }
  return { actions, filled: actions.length }
}

// ---- Preview pages ----------------------------------------------------------------------------------

declare global {
  interface Window {
    __uix?: UixRuntime
    __UIX_ROUTE?: string
    __UIX_STATIC?: boolean
  }
}

const route = () => window.__UIX_ROUTE ?? "/__explorer/"

function post(message: PreviewMessage) {
  if (window.parent !== window) window.parent.postMessage(message, location.origin)
}

function report(id: string, error?: string) {
  document.documentElement.setAttribute(STATUS_ATTRIBUTE, error ? `error: ${error}` : "ready")
  post(error ? { type: "uix:error", id, message: error } : { type: "uix:ready", id })
}

async function waitForContent(timeoutMs: number) {
  const start = performance.now()
  while (performance.now() - start < timeoutMs) {
    if (document.body && normalized(document.body.innerText).length > 0) return true
    await frame()
  }
  return false
}

/** Wait for the parser, scripts and styles, not images/media that do not gate interaction. */
function loaded(timeoutMs: number): Promise<void> {
  if (document.readyState === "complete") return Promise.resolve()
  return new Promise((resolve) => {
    let timeout: number
    const done = () => {
      window.clearTimeout(timeout)
      document.removeEventListener("DOMContentLoaded", check)
      document.removeEventListener("load", check, true)
      document.removeEventListener("error", check, true)
      resolve()
    }
    const check = () => {
      if (document.readyState === "loading") return
      const pendingScript = Array.from(document.scripts).some((script) =>
        script.src && script.async && !completedResources.has(script) &&
        (!script.type || /^(module|(?:text|application)\/(?:java|ecma)script)$/i.test(script.type)),
      )
      const pendingStyle = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
        .some((link) => !link.disabled && !link.sheet && !completedResources.has(link) &&
          (!link.media || matchMedia(link.media).matches))
      if (!pendingScript && !pendingStyle) done()
    }
    document.addEventListener("DOMContentLoaded", check)
    document.addEventListener("load", check, true)
    document.addEventListener("error", check, true)
    timeout = rawSetTimeout(done, timeoutMs)
    check()
  })
}

const controller = replayController({
  resolve: waitFor, perform, settle,
  ready: async () => {
    if (!(await waitForContent(20_000))) throw new Error("The page stayed empty")
    await loaded(20_000)
    await settle(150, 3000)
  },
  report, endpoint: route, isStatic: () => !!window.__UIX_STATIC,
})
const replay = controller.replay

/** Opened as `?__uix=<id>`: fetch once; document continuations carry the remaining recipe. */
async function runPreview(id: string) {
  try {
    const response = await fetch(`${route()}api/scenario/${encodeURIComponent(id)}${window.__UIX_STATIC ? ".json" : ""}`)
    if (!response.ok) throw new Error(`Unknown scenario "${id}"`)
    const scenario = (await response.json()) as { actions?: Action[] }
    controller.start(replayId(), scenario.actions ?? [], {}, id)
  } catch (error) {
    report(id, error instanceof Error ? error.message : "The preview failed to start")
  }
}

// ---- Public surface ------------------------------------------------------------------------------

const runtime: UixRuntime = {
  version: 1,
  replay,
  startReplay: controller.start,
  replayStatus: controller.status,
  cancelReplay: controller.cancel,
  settle: (quietMs, maxMs) => settle(quietMs, maxMs),
  snapshot,
  candidates,
  popupOptions,
  autofill,
  resolve,
  captureDesign,
}

// Alt+Shift+E: from the app, open the explorer; inside a preview, ask the explorer to come back.
// (Ctrl+Shift+G was dropped: several browsers use it for "find previous".) Matched on the physical key, because
// Option+Shift+E types a different character on a Mac.
if (!ALREADY)
  document.addEventListener(
    "keydown",
    (event) => {
      if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || event.code !== "KeyE") return
      event.preventDefault()
      event.stopPropagation()
      if (window.parent !== window) post({ type: "uix:gallery" })
      else location.href = route()
    },
    true,
  )

// A small floating button that opens the explorer. It can be dragged out of the way; where it was dropped
// is deliberately not remembered, so a refresh puts it back in the bottom-left corner.
function mountLauncher() {
  const host = document.createElement("div")
  host.setAttribute("data-uix-launcher", "")
  host.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000"
  const root = host.attachShadow({ mode: "open" })
  root.innerHTML = `
    <style>
      button { all: unset; box-sizing: border-box; position: fixed; left: 16px; bottom: 16px; width: 40px; height: 40px;
        display: flex; align-items: center; justify-content: center; border-radius: 9999px; background: #0f172a; color: #fff;
        box-shadow: 0 4px 12px rgb(0 0 0 / .25); cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
      button:hover { background: #1e293b; }
      button:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
      button[data-dragging] { cursor: grabbing; box-shadow: 0 8px 20px rgb(0 0 0 / .35); }
    </style>
    <button type="button" aria-label="Open UI Explorer" title="Open UI Explorer (Alt+Shift+E). Drag to move.">
      <svg width="20" height="20" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
        <path d="M104,40H56A16,16,0,0,0,40,56v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V56A16,16,0,0,0,104,40Zm0,64H56V56h48Zm96-64H152a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V56A16,16,0,0,0,200,40Zm0,64H152V56h48Zm-96,32H56a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V152A16,16,0,0,0,104,136Zm0,64H56V152h48Zm96-64H152a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V152A16,16,0,0,0,200,136Zm0,64H152V152h48Z"/>
      </svg>
    </button>`
  const button = root.querySelector("button")!
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), Math.max(max, 0))
  const place = (left: number, top: number) => {
    button.style.bottom = "auto"
    button.style.left = `${clamp(left, window.innerWidth - button.offsetWidth)}px`
    button.style.top = `${clamp(top, window.innerHeight - button.offsetHeight)}px`
  }
  let drag: { x: number; y: number; left: number; top: number; moved: boolean } | null = null
  button.addEventListener("pointerdown", (event) => {
    const box = button.getBoundingClientRect()
    drag = { x: event.clientX, y: event.clientY, left: box.left, top: box.top, moved: false }
    button.setPointerCapture(event.pointerId)
  })
  button.addEventListener("pointermove", (event) => {
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    // A few pixels of jitter is still a click.
    if (!drag.moved && Math.hypot(dx, dy) < 5) return
    drag.moved = true
    button.setAttribute("data-dragging", "")
    place(drag.left + dx, drag.top + dy)
  })
  const finish = () => {
    button.removeAttribute("data-dragging")
    // The click that follows a drag must not navigate; keep the flag until that click has been seen.
    if (drag?.moved) setTimeout(() => (drag = null), 0)
    else drag = null
  }
  button.addEventListener("pointerup", finish)
  button.addEventListener("pointercancel", finish)
  button.addEventListener("click", (event) => {
    if (drag?.moved) {
      event.preventDefault()
      return
    }
    location.href = route()
  })
  // Keep a moved button reachable when the window shrinks.
  window.addEventListener("resize", () => {
    if (button.style.top) place(button.getBoundingClientRect().left, button.getBoundingClientRect().top)
  })
  document.documentElement.appendChild(host)
}

// Only on the app itself: never inside a preview frame, a crawl, or a page opened for a thumbnail.
if (!ALREADY && !ACTIVE && window.parent === window && ![...new URLSearchParams(location.search).keys()].some((key) => CHROME_PARAMS.test(key))) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountLauncher, { once: true })
  else mountLauncher()
}

if (ACTIVE) {
  window.__uix = runtime
  if (continuation) {
    controller.resume(continuation)
  } else if (previewId) {
    const start = () => void runPreview(previewId)
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true })
    else start()
  }
}
