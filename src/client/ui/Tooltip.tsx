import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip"
import type { ReactElement } from "react"
import usePopupContainer from "./usePopupContainer"

// A short label for a control that has no visible text, shown on hover and keyboard focus.
export default function Tooltip({
  label,
  side = "top",
  children,
}: {
  label: string
  side?: "top" | "bottom"
  children: ReactElement<Record<string, unknown>>
}) {
  const { container, triggerRef } = usePopupContainer()
  return (
    <BaseTooltip.Provider delay={400} closeDelay={0}>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger ref={triggerRef} render={children} />
        <BaseTooltip.Portal container={container}>
          <BaseTooltip.Positioner side={side} sideOffset={8} collisionPadding={8} className="uix-tooltip-positioner">
            <BaseTooltip.Popup role="tooltip" className="tooltip-label">
              {label}
            </BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </BaseTooltip.Provider>
  )
}
