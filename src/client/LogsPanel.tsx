import { useEffect, useRef, useState } from "react"
import { Check } from "@phosphor-icons/react/dist/csr/Check"
import { Link } from "@phosphor-icons/react/dist/csr/Link"
import { Button, Input } from "./ui"
import Modal from "./ui/Modal"
import { useLogs } from "./data"

// What crawl/capture/login actually did, as plain text, so it can be copied out and pasted elsewhere when a
// run looks stuck or its result is a surprise — not just left in whatever terminal `serve` happens to be
// running in.

export default function LogsPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const lines = useLogs()
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "manual">("idle")
  const scrollRef = useRef<HTMLPreElement>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [open, lines.length])

  useEffect(() => {
    if (copyStatus === "manual") {
      input.current?.focus()
      input.current?.select()
    }
    if (copyStatus !== "copied") return
    const timer = setTimeout(() => setCopyStatus("idle"), 2500)
    return () => clearTimeout(timer)
  }, [copyStatus])

  async function copy() {
    const text = lines.join("\n")
    try {
      await navigator.clipboard.writeText(text)
      setCopyStatus("copied")
    } catch {
      setCopyStatus("manual")
    }
  }

  return (
    <Modal
      open={open}
      title="Logs"
      size="wide"
      onClose={() => onOpenChange(false)}
      footer={
        <Button variant="outline" size="sm" leftIcon={copyStatus === "copied" ? <Check size={16} aria-hidden="true" /> : <Link size={16} aria-hidden="true" />} onClick={() => void copy()}>
          {copyStatus === "copied" ? "Copied" : "Copy all"}
        </Button>
      }
    >
      <p>What the last explore, capture or login actually did.</p>
      <pre ref={scrollRef} className="design-logs-output" aria-label="Explorer logs">
        {lines.length ? lines.join("\n") : "Nothing logged yet."}
      </pre>
      {copyStatus === "manual" && (
        <div className="design-screen-reference-fallback">
          <p role="alert">Clipboard access is unavailable. Copy the selected text and paste it elsewhere.</p>
          <Input ref={input} className="control" aria-label="Logs" readOnly value={lines.join("\n")} onFocus={(event) => event.target.select()} />
        </div>
      )}
    </Modal>
  )
}
