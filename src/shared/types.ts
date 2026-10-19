// Shapes shared by the browser runtime, the crawler and the explorer. Plain data only, so a scenarios
// file can be read, edited, diffed and committed like any other source file.

/** One step of a recipe. Replayed from a fresh page load, in order. */
export type Action =
  | {
      kind: "click"
      /** CSS selector. The first *visible* match whose text fits wins. */
      selector: string
      /** Exact text of the element (whitespace-normalised), or its start when `prefix` is set. */
      text?: string
      prefix?: boolean
      /** Send the full pointer sequence instead of a plain click, for libraries that listen to pointer events. */
      pointer?: boolean
    }
  | {
      kind: "fill"
      selector: string
      value: string
    }

/** A named, repeatable state of the app: where it starts and the steps that reach it. */
export type Scenario = {
  id: string
  title: string
  /** The screen this state belongs to. States share their base screen's group. */
  group: string
  description?: string
  /** The state this one was reached from. Becomes an edge on the canvas. */
  parent?: string
  /** Steps replayed from `startPath` to reach this state. Empty for a base screen. */
  actions?: Action[]
  /** The control pressed to get here from the parent. Labels the edge on the canvas. */
  trigger?: string
  /** How this state differs from its parent. */
  kind?: "screen" | "navigation" | "overlay" | "variant"
  /** Where the preview starts. Defaults to the file's `startPath`. */
  startPath?: string
  /** Viewport used to discover the recipe. Reach its state at this size before responsive resizing. */
  replayViewport?: { width: number; height: number }
  /** A complete preview URL for hosts that render scenarios themselves. Overrides the recipe route. */
  url?: string
  /** Best-guess source file (repo-relative). Used to place the state in the source explorer. */
  source?: string
  /** Hash of what the state looks like, used to recognise it again. */
  fingerprint?: string
  /** Where the scenario came from. Set by the explorer, not written by hand. */
  origin?: "crawled" | "manual"
  /** Set by hand to keep a state out of the explorer. */
  hidden?: boolean
}

/** A connection between two screens that is not a parent link, for example "Continue". */
export type Transition = { source: string; target: string; label?: string }

export type ScenariosFile = {
  version: 1
  generatedAt: string
  baseUrl: string
  startPath: string
  stats?: CrawlStats
  scenarios: Scenario[]
  transitions?: Transition[]
}

export type CrawlStats = {
  states: number
  duplicates: number
  /** Attempts skipped because the control had never led anywhere new. */
  skipped: number
  failedReplays: number
  candidatesTried: number
  seconds: number
  stoppedBy?: "complete" | "max-states" | "time-budget" | "cancelled"
}

/** What the page looked like at a moment, reduced to what a person would notice. */
export type Snapshot = {
  url: string
  title: string
  headings: string[]
  dialogs: string[]
  menus: number
  /** Controls that are on, selected or checked. */
  selected: string[]
  /** True when a listbox (an open dropdown) is showing. */
  listbox: boolean
  /** Lower-cased, number-free words of the visible text of the top layer. */
  tokens: string[]
}

/** An element the crawler could act on, with the recipe step that would act on it. */
export type Candidate = {
  action: Action
  label: string
  role: string
  /** Same-origin link destination, used to prioritise pages not yet visited. */
  destination?: string
  /** Looks like it moves a flow forward (Continue, Save, Next ...). */
  primary: boolean
}

export type ReplayResult =
  | { ok: true }
  | { ok: false; step: number; message: string }

export type ReplayOptions = { timeoutMs?: number; settleMs?: number }
export type ReplayStatus = { id: string; step: number; result?: ReplayResult }

export type AutofillResult = { actions: Action[]; filled: number }

/** The browser runtime's public surface, available as `window.__uix`. */
export type UixRuntime = {
  version: number
  replay(actions: Action[], options?: ReplayOptions): Promise<ReplayResult>
  /** Starts a job whose status can be observed again after a document navigation. */
  startReplay(id: string, actions: Action[], options?: ReplayOptions): void
  replayStatus(): ReplayStatus | undefined
  cancelReplay(): void
  settle(quietMs?: number, maxMs?: number): Promise<void>
  snapshot(): Snapshot
  candidates(options?: { deny?: string[] }): Candidate[]
  popupOptions(): Candidate[]
  autofill(): Promise<AutofillResult>
  resolve(action: Action): Element | null
  captureDesign(options?: { root?: Element }): DesignNode | null
}

// ---- Design capture ---------------------------------------------------------------------------------
// A structured description of a rendered subtree, close enough to Figma's own node model (frames, text,
// fills, strokes) that it can be rebuilt as real editable layers rather than a flattened picture of one.
// Deliberately leaves out anything the DOM can't give a straight answer for (gradients, mixed per-side
// borders, non-uniform corner radii) rather than guessing - those are known, documented limitations of
// this first pass, not oversights.

export type DesignFill =
  | { type: "solid"; color: string; /** The CSS custom property this value traced back to, if any. */ token?: string }
  | { type: "image"; src: string }

export type DesignStroke = { color: string; width: number; token?: string; widths?: { top:number; right:number; bottom:number; left:number } }

export type DesignShadow = { x: number; y: number; blur: number; spread: number; color: string }

export type DesignText = {
  content: string
  fontFamily: string
  fontSize: number
  fontWeight: number
  /** In px, or "normal" when the browser reports a keyword rather than a resolved length. */
  lineHeight: number | "normal"
  letterSpacing: number | "normal"
  color: string
  /** The CSS custom property `color` traced back to, if any. */
  colorToken?: string
  align: string
}

/** Filled in by the component-detection system; absent until that system runs. */
export type ComponentRef = {
  /** Stable across runs: derived from sourceFile+name (or framework+name when no file is recoverable). */
  id: string
  name: string
  sourceFile?: string
  sourceLine?: number
  framework: "react" | "vue" | "angular" | "web-component" | "svelte" | "astro"
}

export type DesignNode = {
  tag: string
  /** Serialized SVG, kept as editable vectors by the Figma interpreter. */
  svg?: string
  /** Assigned by the planner for this exact captured visual variant. */
  componentVariant?: string
  /** Relative to the capture root's own top-left corner, not the page. */
  rect: { x: number; y: number; width: number; height: number }
  fills: DesignFill[]
  stroke?: DesignStroke
  radius?: number
  shadow?: DesignShadow[]
  /** Only present below 1 - most nodes are fully opaque. */
  opacity?: number
  /** Browser overflow clips descendants to this box. */
  clipsContent?: boolean
  /** Actual text layout box, including padding/alignment inside controls, in capture coordinates. */
  textRect?: { x: number; y: number; width: number; height: number }
  /** Present on leaf nodes (no element children) that have visible text. */
  text?: DesignText
  component?: ComponentRef
  children: DesignNode[]
}

/** One width's capture of one scenario - the unit every other system in the Figma export plan addresses. */
export type DesignCapture = {
  scenarioId: string
  width: number
  height: number
  capturedAt: string
  root: DesignNode
  warnings?: string[]
}
