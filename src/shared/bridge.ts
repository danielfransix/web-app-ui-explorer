import type { ExportPlan } from "./plan"
import type { CoveragePair } from "./verify"

export type FigmaConnectionContext = { documentName: string; pageId: string; pageName: string }

export type Placement = { mode: "current-page" | "page" | "section" | "per-folder"; name?: string; nodeId?: string; container?: string }
export type ImportLayout = { mode: "horizontal" | "grid"; columns?: number; gap?: number }
export type ImportRequest = { folder?: string; group?: string; ids?: string[]; widths: number[]; labels?: Record<number, string>; createComponents?: boolean; placement: Placement; layout?: ImportLayout; libraries?: LibraryConfig }
export type ImportProgress = { phase: "capturing" | "components" | "frames" | "verifying" | "completed" | "cancelled" | "failed"; completed: number; total: number; message: string }
export type LibraryConfig = {
  components?: Record<string, { key: string; set?: boolean }>
  paintStyleKeys?: string[]
  textStyleKeys?: string[]
}
export type BridgeCommand =
  | { type: "build"; plan: ExportPlan; placement: Placement; libraries?: LibraryConfig; runId?: string; componentScope?: { componentId: string; variants: { name: string; contentHash: string }[] }[] }
  | { type: "begin-export"; runId: string; placement?: Placement; folders?: string[]; createComponents?: boolean; deferComponentBaseline?: boolean }
  | { type: "end-export"; runId: string }
  | { type: "verify"; expected: CoveragePair[]; placement: Placement; runId?: string }
  | { type: "arrange"; expected: CoveragePair[]; placement: Placement; layout: ImportLayout; runId?: string }
  | { type: "render"; scenarioId: string; width: number; placement: Placement }
  | { type: "repair-component-names"; names: Record<string, string> }
export type BridgeResult = { report?: string[]; conflicts?: string[]; warnings?: string[]; coverage?: { missing: CoveragePair[]; unexpected: CoveragePair[] }; render?: { nodeId: string; bounds?: { x: number; y: number; width: number; height: number }; parentId?: string; pngBase64: string }; error?: string }
