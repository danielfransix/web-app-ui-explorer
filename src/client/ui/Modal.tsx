import { Dialog } from "@base-ui/react/dialog"
import { X } from "@phosphor-icons/react/dist/csr/X"
import { useId, type ReactNode } from "react"
import Button from "./Button"

type ModalProps = {
  open: boolean
  title: string
  variant?: "side" | "center"
  size?: "default" | "expanded" | "fullscreen"
  header?: ReactNode
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
}

export default function Modal({
  open,
  title,
  variant = "center",
  size = "default",
  onClose,
  footer,
  header,
  children,
}: ModalProps) {
  const titleId = useId()
  return (
    <Dialog.Root
      open={open}
      disablePointerDismissal
      onOpenChange={(next, details) => {
        if (!next) {
          details.cancel()
          onClose()
        }
      }}
    >
      <Dialog.Portal className={`modal-layer modal-layer--${variant}${size === "expanded" ? " modal-layer--expanded" : ""}`}>
        <Dialog.Backdrop
          forceRender
          render={<Button />}
          className="modal-backdrop"
          tabIndex={-1}
          aria-label={`Close ${title.toLowerCase()}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClose}
        />
        <Dialog.Popup
          tabIndex={-1}
          aria-modal="true"
          aria-labelledby={titleId}
          className={`modal-shell modal-shell--${variant}${size === "expanded" ? " modal-shell--expanded" : size === "fullscreen" ? " modal-shell--fullscreen" : ""}`}
        >
          {header ? (
            <>
              <Dialog.Title id={titleId} className="sr-only">{title}</Dialog.Title>
              {header}
            </>
          ) : (
            <header className="modal-master-header">
              <div className="modal-header-copy">
                <Dialog.Title id={titleId} className="modal-header-title">
                  {title}
                </Dialog.Title>
              </div>
              <Dialog.Close
                render={
                  <Button className="drawer-close" aria-label="Close">
                    <X size={20} aria-hidden="true" />
                  </Button>
                }
              />
            </header>
          )}
          <div className="modal-master-body">{children}</div>
          {footer && <footer className="modal-master-footer">{footer}</footer>}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
