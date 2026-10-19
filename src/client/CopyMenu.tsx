import { useState, type FormEvent } from "react"
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown"
import { Plus } from "@phosphor-icons/react/dist/csr/Plus"
import { TrashSimple } from "@phosphor-icons/react/dist/csr/TrashSimple"
import { addCustomWidth, removeCustomWidth, useCustomWidths } from "./customWidths"
import { Button, Checkbox, ContextPanel, Disclosure, DisclosurePanel, DisclosureTrigger, Input, Tooltip } from "./ui"
import ComponentCreationSetting from "./ComponentCreationSetting"
import { isCustomWidth, VIEWPORTS } from "./viewports"
import { readApiJson } from "./apiResponse"
import type { ExportPlan } from "../shared/plan"

// The manual, no-agent path onto a Figma canvas: capture one screen at every checked width in a single
// pass and put the result on the clipboard as a structured plan - not a flattened picture - for the
// companion Figma plugin to turn into real layers. A multi-select checklist rather than a one-shot action
// menu, since copying several custom dimensions at once is the whole point of having more than one.

export const DESIGN_CLIPBOARD_MARKER = "uixDesignExport"

type Status = "idle" | "busy" | "done" | "error"

type Props = {
  scenarioId: string
  /** The width currently being previewed, if any - offered as "current view". */
  currentWidth?: number
}

const DEFAULTS = (["desktop", "tablet", "mobile"] as const).map((id) => ({
  id,
  label: VIEWPORTS[id].label,
  width: VIEWPORTS[id].size.width,
}))

export default function CopyMenu({ scenarioId, currentWidth }: Props) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<Status>("idle")
  const [error, setError] = useState<string>()
  // Nothing is pre-checked: currentWidth is 0 until the preview's ResizeObserver takes its first
  // measurement, so seeding this from the prop at mount would silently stay empty - explicit beats an
  // initializer racing a value that isn't stable yet.
  const [checked, setChecked] = useState<Set<string>>(() => new Set())
  const [newLabel, setNewLabel] = useState("")
  const [newWidth, setNewWidth] = useState("")
  const [createComponents, setCreateComponents] = useState(true)
  const customWidths = useCustomWidths()

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function addCustom(event: FormEvent) {
    event.preventDefault()
    const width = Number(newWidth)
    if (!isCustomWidth(width)) {
      setError("Enter a whole-number width from 1 to 7680 pixels.")
      return
    }
    setError(undefined)
    const entry = addCustomWidth(newLabel.trim() || `${width}px`, width)
    setChecked((prev) => new Set(prev).add(entry.id))
    setNewLabel("")
    setNewWidth("")
  }

  const selectionCount = resolveSelection().widths.length

  function resolveSelection(): { widths: number[]; labels: Record<number, string> } {
    const widths: number[] = []
    const labels: Record<number, string> = {}
    if (checked.has("current") && currentWidth) widths.push(currentWidth)
    for (const preset of DEFAULTS) if (checked.has(preset.id)) widths.push(preset.width)
    for (const custom of customWidths)
      if (checked.has(custom.id)) {
        widths.push(custom.width)
        labels[custom.width] = custom.label
      }
    return { widths: Array.from(new Set(widths)), labels }
  }

  async function run() {
    const { widths, labels } = resolveSelection()
    if (!widths.length) return
    setOpen(false)
    setStatus("busy")
    setError(undefined)
    try {
      const response = await fetch("api/design", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: scenarioId, widths, labels, createComponents }),
      })
      const body = await readApiJson<{ plan: ExportPlan }>(response, "Could not build the design")
      if (!createComponents && body.plan?.createComponents !== false) throw Error('Restart your app’s dev server and refresh UI Explorer to copy without components.')
      await navigator.clipboard.writeText(JSON.stringify({ [DESIGN_CLIPBOARD_MARKER]: 1, plan: body.plan }))
      setStatus("done")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Copy failed")
      setStatus("error")
    }
    setTimeout(() => setStatus("idle"), 2500)
  }

  const label =
    status === "busy" ? "Copying…" : status === "done" ? "Copied" : status === "error" ? "Copy failed" : "Copy"

  return (
    <div className="design-copy-menu">
      <ContextPanel label="Copy settings" open={open} onOpenChange={setOpen} className="design-copy-menu__panel"
        trigger={<Button variant="outline" size="sm" disabled={status === "busy"} rightIcon={<CaretDown size={14} aria-hidden="true" />}>{label}</Button>}>
          <h3 className="modal-section-title">Copy settings</h3>
          <div className="design-copy-menu__list" role="group" aria-label="Widths to copy">
            {!!currentWidth && (
              <label className="design-copy-menu__row">
                <Checkbox checked={checked.has("current")} onChange={() => toggle("current")} />
                Current view ({currentWidth}px)
              </label>
            )}
            <div className="design-copy-menu__divider">Defaults</div>
            {DEFAULTS.map((preset) => (
              <label key={preset.id} className="design-copy-menu__row">
                <Checkbox checked={checked.has(preset.id)} onChange={() => toggle(preset.id)} />
                {preset.label} ({preset.width}px)
              </label>
            ))}
            {customWidths.length > 0 && (
              <>
                <div className="design-copy-menu__divider">Custom</div>
                {customWidths.map((custom) => (
                  <div key={custom.id} className="design-copy-menu__row design-copy-menu__row--custom">
                    <label>
                      <Checkbox checked={checked.has(custom.id)} onChange={() => toggle(custom.id)} />
                      {custom.label} ({custom.width}px)
                    </label>
                    <Tooltip label={`Remove ${custom.label} (${custom.width}px)`}>
                    <Button
                      variant="ghost" size="icon"
                      className="design-copy-menu__remove"
                      aria-label={`Remove ${custom.label} (${custom.width}px)`}
                      onClick={() => { removeCustomWidth(custom.id); setChecked((prev) => { const next = new Set(prev); next.delete(custom.id); return next }) }}
                    >
                      <TrashSimple size={16} aria-hidden="true" />
                    </Button>
                    </Tooltip>
                  </div>
                ))}
              </>
            )}
          </div>
          <Disclosure className="design-copy-menu__custom">
            <DisclosureTrigger variant="ghost" size="sm" rightIcon={<CaretDown size={14} aria-hidden="true" />}>Add custom size</DisclosureTrigger>
            <DisclosurePanel>
              <form className="design-copy-menu__add" onSubmit={addCustom}>
                <label className="modal-field">Name<Input aria-label="Custom size name" placeholder="e.g. Laptop" value={newLabel} onChange={(event) => { setNewLabel(event.target.value); setError(undefined) }} /></label>
                <label className="modal-field">Width<Input aria-label="Custom size width in pixels" placeholder="e.g. 1366" inputMode="numeric" value={newWidth} onChange={(event) => { setNewWidth(event.target.value); setError(undefined) }} /></label>
                <Tooltip label="Add custom size"><Button type="submit" variant="outline" size="icon" aria-label="Add"><Plus size={16} aria-hidden="true" /></Button></Tooltip>
              </form>
            </DisclosurePanel>
          </Disclosure>
          {error && <p role="alert">{error}</p>}
          <ComponentCreationSetting value={createComponents} onChange={setCreateComponents} />
          <Button variant="default" size="sm" className="design-copy-menu__action" disabled={selectionCount === 0 || status === "busy"} onClick={run}>
            {status === "busy" ? "Copying…" : `Copy selected (${selectionCount})`}
          </Button>
      </ContextPanel>
      {!open && error && <p role="alert">{error}</p>}
    </div>
  )
}
