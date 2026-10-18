import { hashString } from "./hash"
import type { DesignCapture } from "./types"

// Idempotency and verification: the two things that make re-running this system safe. Both are pure -
// no Figma, no browser - because the actual node tagging/comparison happens inside the Figma plugin
// (the only place a "has this already been built, and does it still look like what we built" check can
// run), but what counts as "the same content" and what counts as "fully covered" needs to be one
// implementation both the plugin and anything reporting on it agree on.

/** Excludes `capturedAt`: a timestamp changing on every run would defeat skip-on-no-change entirely. */
export function hashCapture(capture: DesignCapture): string {
  return hashString(JSON.stringify(capture.root))
}

export type CoveragePair = { scenarioId: string; width: number }

function keyOf(pair: CoveragePair): string {
  return `${pair.scenarioId}@${pair.width}`
}

export type CoverageReport = {
  /** Expected but not found in Figma - the run is incomplete for these. */
  missing: CoveragePair[]
  /** Found in Figma but not expected for this scope/width request - likely stale or out of scope. */
  unexpected: CoveragePair[]
}

/**
 * "Done" is the set of (scenario, width) pairs the current scope/width request implies - never a bare
 * count, which can hide a partial run (e.g. every scenario built at desktop but not at mobile).
 */
export function diffCoverage(expected: CoveragePair[], actual: CoveragePair[]): CoverageReport {
  const actualKeys = new Set(actual.map(keyOf))
  const expectedKeys = new Set(expected.map(keyOf))
  return {
    missing: expected.filter((pair) => !actualKeys.has(keyOf(pair))),
    unexpected: actual.filter((pair) => !expectedKeys.has(keyOf(pair))),
  }
}
