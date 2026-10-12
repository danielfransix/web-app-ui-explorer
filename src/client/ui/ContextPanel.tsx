import { Popover } from "@base-ui/react/popover"
import type { ReactElement, ReactNode } from "react"
import usePopupContainer from "./usePopupContainer"

export default function ContextPanel({
  label,
  trigger,
  open,
  onOpenChange,
  children,
  className = "",
}: {
  label: string
  trigger: ReactElement
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
  className?: string
}) {
  const { container, triggerRef } = usePopupContainer()
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger ref={triggerRef} render={trigger} />
      <Popover.Portal container={container}>
        <Popover.Positioner
          align="end"
          side="bottom"
          sideOffset={4}
          collisionPadding={8}
          collisionAvoidance={{ side: "flip", align: "shift" }}
          className="uix-popup-positioner"
        >
          <Popover.Popup className={`${className} uix-popup`} aria-label={label}>
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
