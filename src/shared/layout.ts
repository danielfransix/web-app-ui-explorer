import type { ImportLayout } from "./bridge"

export function framePositions(sizes: { width: number; height: number }[], layout: ImportLayout, padding = 40) {
  const columns = layout.mode === "horizontal" ? Math.max(1, sizes.length) : layout.columns ?? 3
  const gap = layout.gap ?? 80
  if (!["horizontal", "grid"].includes(layout.mode) || !Number.isInteger(columns) || columns < 1 || columns > (layout.mode === "horizontal" ? Infinity : 20) || !Number.isInteger(gap) || gap < 0 || gap > 1000) throw new Error("Invalid import layout.")
  const widths: number[] = [], heights: number[] = []
  sizes.forEach((size, i) => { widths[i % columns] = Math.max(widths[i % columns] ?? 0, size.width); heights[Math.floor(i / columns)] = Math.max(heights[Math.floor(i / columns)] ?? 0, size.height) })
  return sizes.map((_, i) => ({ x: padding + widths.slice(0, i % columns).reduce((sum, w) => sum + w + gap, 0), y: padding + heights.slice(0, Math.floor(i / columns)).reduce((sum, h) => sum + h + gap, 0) }))
}
