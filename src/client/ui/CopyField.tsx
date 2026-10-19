import { useEffect, useId, useRef, useState } from "react"
import { Check } from "@phosphor-icons/react/dist/csr/Check"
import { Copy } from "@phosphor-icons/react/dist/csr/Copy"
import Button from "./Button"
import Input from "./Input"
import Tooltip from "./Tooltip"

/** Keep a read-only value and its copy action together, with manual copying available on failure. */
export default function CopyField({ id, label, value, copyLabel, copiedLabel, fallback, className = "" }: {
  id: string; label: string; value: string; copyLabel: string; copiedLabel: string; fallback: string; className?: string
}) {
  const [copied, setCopied] = useState(false), [error, setError] = useState("")
  const input = useRef<HTMLInputElement>(null), feedbackId = useId()
  useEffect(() => { setCopied(false); setError("") }, [value])
  const action = copied ? copiedLabel : copyLabel
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied(true); setError("") }
    catch {
      setCopied(false); setError(fallback)
      input.current?.focus(); input.current?.select()
    }
  }
  return <div className="modal-field copy-field-stack">
    <label className="modal-field-label" htmlFor={id}>{label}</label>
    <div className="copy-field">
      <Input id={id} ref={input} className={`control copy-field__input ${className}`} value={value} readOnly autoComplete="off" spellCheck={false}
        aria-describedby={error ? feedbackId : undefined} onFocus={event => event.target.select()} />
      <Tooltip label={action}>
        <Button className="copy-field__button" variant="ghost" size="icon" aria-label={action} onClick={() => void copy()}>
          {copied ? <Check size={18} aria-hidden="true" /> : <Copy size={18} aria-hidden="true" />}
        </Button>
      </Tooltip>
    </div>
    <span className="sr-only" role="status">{copied ? copiedLabel : ""}</span>
    {error && <p id={feedbackId} className="copy-field__error" role="alert">{error}</p>}
  </div>
}
