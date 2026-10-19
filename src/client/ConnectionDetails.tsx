import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Popover } from "@base-ui/react/popover"
import { X } from "@phosphor-icons/react/dist/csr/X"
import { PushPin } from "@phosphor-icons/react/dist/csr/PushPin"
import { actionName, controlName, type ConnectionDescription } from "../shared/transitions"
import type { TransitionStep } from "../shared/types"
import { Button } from "./ui"

type Selection = { edgeId: string; triggerId: string; pinned: boolean; rect?: DOMRect; anchor?: { getBoundingClientRect: () => DOMRect }; keyboard?: boolean }
const Inspector = createContext<{ prefix: string; pinnedId?: string; focus: (id: string, element: HTMLElement) => void }>({ prefix: "", focus: () => {} })

const pinnedAnchor = (rect: DOMRect) => ({ getBoundingClientRect: () => new DOMRect(
  Math.max(12, Math.min(window.innerWidth - 12, rect.x + rect.width / 2)),
  Math.max(12, Math.min(window.innerHeight - 12, rect.y + rect.height)), 0, 0,
) })

function ActionSummary({ step }: { step: TransitionStep }) {
  const control = step.role ? controlName(step.role).toLowerCase() : undefined
  const sentence = Boolean(control && ["click", "fill", "select", "hover", "submit"].includes(step.type))
  return <p className="design-connection-details__action">
    {step.type === "hover" ? "Hover over" : actionName(step.type)}
    {sentence ? " the " : step.label ? " " : ""}
    {step.label && <strong>“{step.label}”</strong>}
    {sentence ? <>{step.label ? " " : ""}{control}</> : step.type !== "automatic" && <span className="design-connection-details__control"> · {control ?? "control type not recorded"}</span>}
  </p>
}

export function ConnectionDetails({ connections, resetKey, children }: { connections: ReadonlyMap<string, ConnectionDescription>; resetKey: number; children: ReactNode }) {
  const prefix = useId()
  const [selection, setSelection] = useState<Selection | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const dismissedTrigger = useRef<string | null>(null)
  useEffect(() => {
    setSelection(current => {
      dismissedTrigger.current = current?.triggerId ?? null
      return null
    })
  }, [resetKey])
  const detail = selection ? connections.get(selection.edgeId) : undefined
  useEffect(() => {
    if (selection && !connections.has(selection.edgeId)) setSelection(null)
  }, [connections, selection])
  useEffect(() => {
    if (selection?.pinned && selection.keyboard) closeRef.current?.focus()
  }, [selection])
  useEffect(() => {
    // A virtualized label has no element observer. Refresh its stable virtual anchor on window resize.
    const resize = () => setSelection(current => current?.pinned && current.rect
      ? { ...current, anchor: pinnedAnchor(current.rect), keyboard: false } : current)
    window.addEventListener("resize", resize)
    return () => window.removeEventListener("resize", resize)
  }, [])

  function change(open: boolean, event: Popover.Root.ChangeEventDetails) {
    const press = event.reason === "trigger-press"
    if (open && event.reason === "trigger-focus" && event.trigger?.id === dismissedTrigger.current) {
      event.cancel()
      return
    }
    if (selection?.pinned && !press && event.reason !== "escape-key" && event.reason !== "close-press") {
      event.cancel()
      return
    }
    if (press || open) {
      const trigger = event.trigger
      const edgeId = trigger?.getAttribute("data-connection-id")
      if (!trigger || !edgeId || !connections.has(edgeId)) return
      dismissedTrigger.current = null
      // A click on an already hover-open trigger pins rather than toggles it shut.
      if (!open) event.cancel()
      const rect = trigger.getBoundingClientRect()
      setSelection({ edgeId, triggerId: trigger.id, pinned: press,
        rect: press ? rect : undefined, anchor: press ? pinnedAnchor(rect) : undefined,
        keyboard: press && (event.event instanceof KeyboardEvent || (event.event instanceof MouseEvent && event.event.detail === 0)) })
    } else {
      if (event.reason === "escape-key" || event.reason === "close-press") dismissedTrigger.current = selection?.triggerId ?? null
      setSelection(null)
    }
  }

  return (
    <Popover.Root open={Boolean(detail)} triggerId={selection?.triggerId ?? null} onOpenChange={change}>
      <Inspector.Provider value={{ prefix, pinnedId: selection?.pinned ? selection.edgeId : undefined,
        focus: (edgeId, element) => {
          if (!selection?.pinned && element.id !== dismissedTrigger.current) {
            dismissedTrigger.current = null
            setSelection({ edgeId, triggerId: element.id, pinned: false })
          }
        } }}>
        {children}
      </Inspector.Provider>
      <Popover.Portal>
        <Popover.Positioner anchor={selection?.anchor} side="bottom" align="center" sideOffset={10}
          collisionPadding={12} collisionAvoidance={{ side: "flip", align: "shift" }} className="uix-popup-positioner">
          <Popover.Popup className="design-connection-details uix-popup nodrag nopan" aria-label="Connection details" initialFocus={false}>
            {detail && <>
              <header className="design-connection-details__header">
                <Popover.Title>Connection details</Popover.Title>
                {selection?.pinned && <span className="design-connection-details__pinned"><PushPin size={14} />Pinned</span>}
                <Popover.Close render={<Button ref={closeRef} className="drawer-close" aria-label="Close connection details"><X size={18} /></Button>} />
              </header>
              <div className="design-connection-details__body">
              <p className="design-connection-details__label">{detail.label}</p>
              <dl className="design-connection-details__route"><dt>From</dt><dd>{detail.from}</dd><dt>To</dt><dd>{detail.to}</dd></dl>
              {detail.description && <p>{detail.description}</p>}
              {detail.steps.length ? <ol className="design-connection-details__steps" data-sequence={detail.steps.length > 1}>
                {detail.steps.map((step, index) => <li key={index}>
                  <ActionSummary step={step} />
                  {step.description && <p className="design-connection-details__step-description">{step.description}</p>}
                </li>)}
              </ol> : <p>The action type was not recorded for this connection.</p>}
              <p className="design-connection-details__note">{detail.evidence === "captured" ? "Recorded during exploration." : detail.evidence === "provided" ? "Provided by the project’s connection definition." : detail.evidence === "recipe" ? "From saved replay steps; control details may be incomplete." : "Add action details to this connection or explore again to record them."}</p>
              {!selection?.pinned && <p className="design-connection-details__hint">Click the label to keep this open.</p>}
              </div>
            </>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

export function ConnectionLabel({ id, detail, label, x, y }: { id: string; detail: ConnectionDescription; label: string; x: number; y: number }) {
  const inspector = useContext(Inspector)
  return <Popover.Trigger id={`${inspector.prefix}-${id}`} data-connection-id={id} openOnHover delay={300} closeDelay={160}
    onFocus={event => inspector.focus(id, event.currentTarget)}
    className="design-flow-edge-label react-flow__edge-text nodrag nopan" data-pinned={inspector.pinnedId === id}
    style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
    aria-label={`Connection from ${detail.from} to ${detail.to}: ${detail.label}`}>
    {label}
  </Popover.Trigger>
}
