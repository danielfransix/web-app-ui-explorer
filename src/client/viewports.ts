// CSS viewport pixels, not device pixels or screenshot zoom. Fit window is intentionally fluid:
// enlarging a preview gives the host app more layout space without magnifying its controls.
export const VIEWPORTS = {
  custom: { label: "Custom width", size: undefined },
  fit: { label: "Fit window", size: undefined },
  widescreen: { label: "Widescreen", size: { width: 1920, height: 1080 } },
  desktop: { label: "Desktop", size: { width: 1440, height: 900 } },
  tablet: { label: "Tablet", size: { width: 768, height: 1024 } },
  mobile: { label: "Mobile", size: { width: 390, height: 844 } },
} as const

export type ViewportPreset = keyof typeof VIEWPORTS
export type ViewportSize = { width: number; height: number }
export const isViewportPreset = (value: unknown): value is ViewportPreset =>
  typeof value === "string" && Object.hasOwn(VIEWPORTS, value)

export const MIN_CUSTOM_WIDTH = 1
export const MAX_CUSTOM_WIDTH = 7680
export const DEFAULT_CUSTOM_WIDTH = 1024
export const isCustomWidth = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= MIN_CUSTOM_WIDTH && value <= MAX_CUSTOM_WIDTH
