import { useRef, useState } from "react"
import { X } from "@phosphor-icons/react/dist/csr/X"
import type { Scenario } from "../shared/types"
import type { ImportSummary } from "../shared/handoff"
import { Button, Input, Modal, MultiSelect } from "./ui"
import { addCustomWidth, useCustomWidths } from "./customWidths"
import ExportScreenSelection from "./ExportScreenSelection"
import ComponentCreationSetting from "./ComponentCreationSetting"
import { isStatic, useExplorerState } from "./data"
import { IMPORT_SERVER_UPDATE, readApiJson } from "./apiResponse"

/** Selection and capture configuration stay in Explorer; Figma receives only an import code. */
export default function FigmaExport({ scenarios, reviewSelection = false }: { scenarios: Scenario[]; reviewSelection?: boolean }) {
  const [open, setOpen] = useState(false), [selected, setSelected] = useState<Set<string>>(new Set())
  const [widths, setWidths] = useState<Set<number>>(new Set([1440]))
  const [custom, setCustom] = useState(""), [customError, setCustomError] = useState("")
  const customInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState("")
  const [prepared, setPrepared] = useState<{ code: string; summary: ImportSummary }>()
  const [copied, setCopied] = useState(false)
  const [createComponents, setCreateComponents] = useState(true)
  const savedWidths = useCustomWidths()
  const serverReady = useExplorerState()?.capabilities?.figmaImports === 1
  const ids = scenarios.filter(s => reviewSelection || selected.has(s.id)).map(s => s.id)
  const sizes = [...widths]
  const valid = sizes.length > 0 && sizes.length <= 12 && !custom.trim()
  const presets = [...new Map([{ label: 'Desktop', width: 1440 }, { label: 'Tablet', width: 768 }, { label: 'Mobile', width: 390 }, ...savedWidths].map(p => [p.width, p])).values()]
  const reset = () => { setPrepared(undefined); setError(""); setCopied(false) }
  function changeWidths(next: number[]) { setWidths(new Set(next)); setCustomError("") }
  function addWidths() {
    const entries = custom.trim().split(/[\s,]+/).filter(Boolean)
    if (!entries.length) { setCustom(""); return }
    if (entries.some(value => !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 7680)) {
      setCustomError("Enter whole-number widths between 1 and 7680 pixels, separated by commas."); return
    }
    const additions = entries.map(Number), next = [...new Set([...sizes, ...additions])]
    if (next.length > 12) { setCustomError("Choose up to 12 widths. Remove a selected width before adding more."); return }
    for (const width of additions) if (!presets.some(p => p.width === width)) addCustomWidth(`${width}px`, width)
    changeWidths(next); setCustom("")
  }
  async function prepare() {
    if (!valid || !ids.length) return
    if (!serverReady) { setError(IMPORT_SERVER_UPDATE); return }
    setBusy(true); setError("")
    try {
      const response = await fetch('api/figma/imports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, widths: sizes, labels: Object.fromEntries(presets.map(p => [p.width, p.label])), createComponents }) })
      const body = await readApiJson<{ code: string; summary: ImportSummary }>(response, 'Could not prepare this import')
      if (!createComponents && body.summary?.createComponents !== false) throw Error('Restart your app’s dev server and refresh UI Explorer to enable imports without components.')
      if (typeof body?.code !== 'string' || !body.code.startsWith('UIX1:') || !Number.isInteger(body.summary?.frameCount) || body.summary.frameCount < 1) throw Error('This server returned an invalid import request. Restart your app’s dev server and refresh UI Explorer.')
      setPrepared(body)
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not prepare import') }
    finally { setBusy(false) }
  }
  return <>
    <Button variant="outline" size="sm" disabled={isStatic || !scenarios.length} onClick={() => { reset(); setCustom(''); setCustomError(''); setSelected(new Set(scenarios.map(s => s.id))); setOpen(true) }}>Build in Figma</Button>
    <Modal open={open} size="wide" title="Build in Figma" onClose={() => { if (!busy) setOpen(false) }} footer={prepared
      ? <Button variant="outline" onClick={reset}>{reviewSelection ? 'Back to settings' : 'Change selection'}</Button>
      : <Button variant="default" disabled={busy || !serverReady || !ids.length || !valid} onClick={() => void prepare()}>{busy ? 'Preparing…' : `Prepare ${ids.length * sizes.length} ${ids.length * sizes.length === 1 ? 'frame' : 'frames'}`}</Button>}>
      <div className="figma-export">
        {prepared ? <>
          <section className="modal-section">
            <h3 className="modal-section-title">Your import is ready</h3>
            <p className="figma-export__summary">{prepared.summary.screenCount} {prepared.summary.screenCount === 1 ? 'screen or state' : 'screens & states'} × {prepared.summary.widths.length} {prepared.summary.widths.length === 1 ? 'width' : 'widths'} = {prepared.summary.frameCount} {prepared.summary.frameCount === 1 ? 'frame' : 'frames'}</p>
            <p className="modal-description">{prepared.summary.createComponents === false ? 'Regular editable layers. No components or instances will be created.' : 'Reusable components and instances will be created.'}</p>
          </section>
          <section className="modal-section">
            <p className="modal-description">Open UI Explorer design import in Figma and paste this code. Choose your canvas destination and arrangement there.</p>
            <div className="modal-field">
              <label className="modal-field-label" htmlFor="figma-import-code">Import code</label>
              <Input id="figma-import-code" className="control figma-export__code" value={prepared.code} readOnly onFocus={event => event.target.select()} />
            </div>
            <Button variant="default" onClick={async () => { try { await navigator.clipboard.writeText(prepared.code); setCopied(true) } catch { setError('Select the code above and copy it with Ctrl+C (⌘C on Mac).') } }}>{copied ? 'Copied import code' : 'Copy import code'}</Button>
            <p className="modal-meta">Keep UI Explorer running. This code expires in one hour and can be reused for re-imports during that time.</p>
          </section>
        </> : <>
          <p className="modal-description">Choose the layer structure and capture widths. Canvas settings are chosen in Figma.</p>
          <ExportScreenSelection scenarios={scenarios} selected={selected} onChange={setSelected} readOnly={reviewSelection} />
          <section className="modal-section" aria-labelledby="figma-structure-heading">
            <h3 className="modal-section-title" id="figma-structure-heading">Layer structure</h3>
            <ComponentCreationSetting value={createComponents} onChange={setCreateComponents} />
          </section>
          <section className="modal-section" aria-labelledby="figma-widths-heading">
            <h3 className="modal-section-title" id="figma-widths-heading">Viewport widths</h3>
            <MultiSelect id="figma-viewport-widths" label="Viewport widths" value={sizes} maxSelections={12} onChange={changeWidths} summary={sizes.length ? `${sizes.length} ${sizes.length === 1 ? "width" : "widths"} selected` : "Choose viewport widths"} options={presets.map(p => ({ value:p.width, label:p.label, description:p.label === `${p.width}px` ? undefined : `${p.width}px` }))} />
            {!!sizes.length && <ul className="figma-export__chips" aria-label="Selected viewport widths">{sizes.map(width => {
              const label = presets.find(p => p.width === width)?.label
              return <li key={width} className="figma-export__chip">
                <span>{label && label !== `${width}px` ? `${label} · ${width}px` : `${width}px`}</span>
                <Button aria-label={`Remove ${width}px viewport width`} onClick={() => { changeWidths(sizes.filter(value => value !== width)); customInput.current?.focus() }}><X size={12} aria-hidden="true" /></Button>
              </li>
            })}</ul>}
            <div className="modal-field">
              <label className="modal-field-label" htmlFor="figma-custom-widths">Additional widths</label>
              <Input id="figma-custom-widths" ref={customInput} className="control" placeholder="e.g. 1366, 1920" value={custom} aria-invalid={!!customError} aria-describedby={customError ? "figma-custom-error" : "figma-custom-help"}
                onChange={event => { setCustom(event.target.value); setCustomError("") }}
                onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); addWidths() } }} />
              <p className="modal-meta" id="figma-custom-help">Separate widths with commas, then press Enter. Select up to 12 widths.</p>
              {customError && <p id="figma-custom-error" role="alert">{customError}</p>}
              {!!custom.trim() && !customError && <p className="modal-meta" role="status">Press Enter to add these widths before preparing the import.</p>}
            </div>
            {!sizes.length && <p role="alert">Choose at least one viewport width.</p>}
          </section>
        </>}
        {(!serverReady || error) && <p role="alert">{!serverReady ? IMPORT_SERVER_UPDATE : error}</p>}
      </div>
    </Modal>
  </>
}
