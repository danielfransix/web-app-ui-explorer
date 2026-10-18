import clipboard from "clipboardy"
import type { ExportPlan } from "../shared/plan"

/** Only Explorer exports cross the bridge; unrelated clipboard contents never leave this process. */
export async function readClipboardDesign(readText: () => Promise<string> = () => clipboard.read()): Promise<{ uixDesignExport: 1; plan: ExportPlan }> {
  const text = await readText()
  if (Buffer.byteLength(text, "utf8") > 32 * 1024 * 1024) throw new Error("The copied export exceeds 32 MB. Copy fewer widths at once.")
  const invalid = () => new Error("Copy a screen from UI Explorer first. The clipboard does not contain a design export.")
  let value: { uixDesignExport?: number; plan?: ExportPlan }
  try { value = JSON.parse(text) } catch { throw invalid() }
  if (value?.uixDesignExport !== 1 || !Array.isArray(value.plan?.components) || !Array.isArray(value.plan?.frames) || !value.plan.frames.length)
    throw invalid()
  if (value.plan.frames.some((frame) => typeof frame.scenarioId !== "string" || !Number.isInteger(frame.width) || frame.width < 1 || frame.width > 7680 || !frame.node))
    throw invalid()
  return { uixDesignExport: 1, plan: value.plan }
}
