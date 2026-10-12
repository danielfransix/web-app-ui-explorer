import { useEffect } from "react"

// Controls that use the arrow keys themselves keep them: text entry, sliders, radio groups, tabs, menus.
const OWNS_ARROWS =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="slider"], [role="radiogroup"], [role="radio"], [role="tablist"], [role="tab"], [role="listbox"], [role="menu"], [role="spinbutton"]'

// Left and Right do what the previous/next buttons do. Pass undefined for an end that is not available.
export default function useArrowKeys({
  onPrevious,
  onNext,
}: {
  onPrevious?: () => void
  onNext?: () => void
}) {
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      )
        return
      if (event.target instanceof Element && event.target.closest(OWNS_ARROWS))
        return
      const action = event.key === "ArrowLeft" ? onPrevious : onNext
      if (!action) return
      event.preventDefault()
      action()
    }
    // Capture phase: a dialog or popup further down must not swallow the key before it is seen here.
    document.addEventListener("keydown", handle, true)
    return () => document.removeEventListener("keydown", handle, true)
  }, [onPrevious, onNext])
}
