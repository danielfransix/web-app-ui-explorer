import { useState } from "react"
import { Check } from "@phosphor-icons/react/dist/csr/Check"
import { Copy } from "@phosphor-icons/react/dist/csr/Copy"
import { ArrowSquareOut } from "@phosphor-icons/react/dist/csr/ArrowSquareOut"
import { Button, Modal, Tooltip } from "./ui"
import { scenarioSource } from "./folderModel"
import type { Scenario } from "../shared/types"
import { isStatic, startCapture } from "./data"

export type Issue = {
  scenario: Scenario
  // "live": the preview failed to start in this session. "capture": the saved thumbnail capture failed.
  kind: "live" | "capture"
  reason: string
}

// Where a scenario's recipe lives: the screen it replays is in `scenarioSource`, the steps are here.
const recipeFile = (scenario: Scenario) =>
  scenario.origin === "manual" ? "your scenarios (ui-explorer options)" : ".ui-explorer/scenarios.json"

function CopyValue({ value, label, onError }: { value: string; label: string; onError: (message: string) => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <Tooltip label={copied ? "Copied" : label} side="bottom">
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value)
            setCopied(true); onError("")
            window.setTimeout(() => setCopied(false), 1200)
          } catch { setCopied(false); onError("Could not copy. Select the value and copy it with Ctrl+C (⌘C on Mac).") }
        }}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </Button>
    </Tooltip>
  )
}

function Where({ term, value, copy }: { term: string; value: string; copy?: string }) {
  const [copyError, setCopyError] = useState("")
  return (
    <div className="design-issue__where">
      <dt>{term}</dt>
      <dd>
        <div className="design-issue__value">
          <code>{value}</code>
          <CopyValue value={copy ?? value} label={`Copy ${term.toLowerCase()}`} onError={setCopyError} />
        </div>
        {copyError && <p className="copy-field__error" role="alert">{copyError}</p>}
      </dd>
    </div>
  )
}

// Everything needed to find a failure from the code: what went wrong, the screen file and the recipe.
export default function IssuesPanel({
  issues,
  stale,
  onClose,
  onOpenLive,
}: {
  issues: Issue[]
  stale: number
  onClose: () => void
  onOpenLive: (id: string) => void
}) {
  return (
    <Modal open variant="side" title="Issues" onClose={onClose}>
      {issues.length > 0 && (
        <ul className="design-issues" aria-label="Failed screens">
          {issues.map(({ scenario, kind, reason }) => (
            <li key={scenario.id} className="design-issue">
              <div className="design-issue__head">
                <h3 className="modal-section-title">{scenario.title}</h3>
                <span className="design-state-pill">
                  {kind === "live" ? "Preview" : "Capture"}
                </span>
              </div>
              <p className="design-issue__reason">{reason}</p>
              <dl>
                <Where term="Screen" value={scenarioSource(scenario)} />
                <Where
                  term="Recipe"
                  value={`${recipeFile(scenario)} · ${scenario.id}`}
                  copy={`id: "${scenario.id}"`}
                />
              </dl>
              <Button
                variant="outline"
                size="sm"
                leftIcon={<ArrowSquareOut size={16} />}
                onClick={() => onOpenLive(scenario.id)}
              >
                Open live UI
              </Button>
            </li>
          ))}
        </ul>
      )}
      {stale > 0 && !isStatic && (
        <section className="design-issue" aria-label="Out of date captures">
          <h3 className="modal-section-title">{stale} out of date</h3>
          <Button variant="outline" size="sm" onClick={() => void startCapture()}>
            Capture again
          </Button>
        </section>
      )}
    </Modal>
  )
}
