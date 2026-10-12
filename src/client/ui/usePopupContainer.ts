import { useCallback, useState } from "react"

// Keep popup portals inside the active dialog's accessibility and focus boundary.
export default function usePopupContainer() {
  const [container, setContainer] = useState<HTMLElement | undefined>(undefined)
  const triggerRef = useCallback((element: HTMLElement | null) => {
    setContainer(element?.closest<HTMLElement>('[aria-modal="true"]') ?? undefined)
  }, [])
  return { container, triggerRef }
}
