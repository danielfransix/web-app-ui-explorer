import { useEffect, useId, useRef, useState } from "react"
import { Link } from "@phosphor-icons/react/dist/csr/Link"
import { Check } from "@phosphor-icons/react/dist/csr/Check"
import { Button, Input, Tooltip } from "./ui"

export default function CopyScreenId({ screenId }: { screenId: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "manual">("idle")
  const input = useRef<HTMLInputElement>(null), mounted = useRef(true)
  const messageId = useId()
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (status === "manual") { input.current?.focus(); input.current?.select() }
    if (status !== "copied") return
    const timer = setTimeout(() => setStatus("idle"), 2500)
    return () => clearTimeout(timer)
  }, [status])
  async function copy() {
    try {
      await navigator.clipboard.writeText(screenId)
      if (mounted.current) setStatus("copied")
    } catch { if (mounted.current) setStatus("manual") }
  }
  return <>
    <Tooltip label={status === "copied" ? "Screen ID copied" : "Copy screen ID for an agent"}>
      <Button variant="ghost" size="icon" aria-label="Copy screen ID" onClick={() => void copy()}>
        {status === "copied" ? <Check size={16} aria-hidden="true" /> : <Link size={16} aria-hidden="true" />}
      </Button>
    </Tooltip>
    <span className="sr-only" role="status">{status === "copied" ? "Screen ID copied. Paste it into your question." : ""}</span>
    {status === "manual" && <div className="design-screen-reference-fallback">
      <p id={messageId} role="alert">Clipboard access is unavailable. Copy the selected screen ID and paste it into your question.</p>
      <Input ref={input} className="control" aria-label="Screen ID" aria-describedby={messageId} value={screenId} readOnly onFocus={event => event.target.select()} />
    </div>}
  </>
}
