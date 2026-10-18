import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft"
import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight"
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight"
import { ArrowSquareOut } from "@phosphor-icons/react/dist/csr/ArrowSquareOut"
import { ArrowCounterClockwise } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise"
import CopyMenu from "./CopyMenu"
import FigmaExport from "./FigmaExport"
import { addCustomWidth, useCustomWidths } from "./customWidths"
import ScreenPicker from "./ScreenPicker"
import { Button, Input, Modal, Select, Tooltip } from "./ui"
import ScreenFrame from "./ScreenFrame"
import useArrowKeys from "./useArrowKeys"
import { folderCrumb, scenarioSource } from "./folderModel"
import type { Scenario } from "../shared/types"
import { MAX_CUSTOM_WIDTH, MIN_CUSTOM_WIDTH, VIEWPORTS, isCustomWidth, isViewportPreset, type ViewportPreset, type ViewportSize } from "./viewports"

type Props = {
  fullScreen?: boolean
  header?: ReactNode
  revision?: number
  viewport: ViewportPreset
  customWidth: number
  onCustomWidthChange: (width: number) => void
  onViewportChange: (viewport: ViewportPreset) => void
  scenario: Scenario
  // The screens that were visible when the preview was expanded, so Previous/Next stay in that set.
  siblings: Scenario[]
  onSelect: (id: string) => void
  onReset: () => void
  onClose: () => void
  onOpenLive: (id: string) => void
}

// Keep at most three visited screens for this open preview session. Going back is immediate and
// preserves edits, but browsing a large project cannot leave an unbounded number of apps in memory.
// Reset state remounts the deck; closing the dialog releases every frame.
function PreviewDeck({ scenario, viewport }: { scenario: Scenario; viewport?: ViewportSize }) {
  const [cache, setCache] = useState({ entries: [scenario], recent: [scenario.id] })
  if (cache.recent[cache.recent.length - 1] !== scenario.id) {
    const existing = cache.entries.some((item) => item.id === scenario.id)
    const entries = existing
      ? cache.entries
      : cache.entries.length < 3
        ? [...cache.entries, scenario]
        : cache.entries.map((item) => item.id === cache.recent[0] ? scenario : item)
    // Recency is separate from DOM order: moving an iframe's DOM node reloads its document.
    setCache({ entries, recent: [...cache.recent.filter((id) => id !== scenario.id).slice(-2), scenario.id] })
  }
  return (
    <div className="screen-preview-deck">
      {cache.entries.map((item) => (
        <div className="screen-preview-entry" key={item.id} data-device={!!viewport} hidden={item.id !== scenario.id} inert={item.id !== scenario.id}>
          <ScreenFrame scenario={item.id === scenario.id ? scenario : item} viewport={viewport} />
        </div>
      ))}
    </div>
  )
}

// Both preview sizes share one frame so expanding and returning never reloads the live app.
export default function ScreenLightbox({
  scenario,
  fullScreen = false,
  header,
  revision,
  viewport,
  customWidth,
  onCustomWidthChange,
  onViewportChange,
  siblings,
  onSelect,
  onReset,
  onClose,
  onOpenLive,
}: Props) {
  const stageObserver = useRef<ResizeObserver | null>(null)
  const customWidths = useCustomWidths()
  const [available, setAvailable] = useState<ViewportSize>({ width: 0, height: 0 })
  const [widthDraft, setWidthDraft] = useState(String(customWidth))
  const [widthError, setWidthError] = useState(false)
  useEffect(() => {
    setWidthDraft(String(customWidth))
    setWidthError(false)
  }, [customWidth, viewport])
  const applyWidth = () => {
    const width = widthDraft.trim() === "" ? NaN : Number(widthDraft)
    if (!isCustomWidth(width)) {
      setWidthError(true)
      return
    }
    setWidthError(false)
    setWidthDraft(String(width))
    onCustomWidthChange(width)
    addCustomWidth(`${width}px`, width)
  }
  // Custom changes width only. The height follows the available stage minus its device padding.
  const size = viewport === "custom"
    ? { width: customWidth, height: Math.max(1, available.height - 32) }
    : VIEWPORTS[viewport].size
  const dimensions = size ?? available
  // The dialog portal mounts after this component's effects. Attach on the actual node, not in a
  // one-shot parent effect that can run while the portal (and therefore its ref) is still absent.
  const stage = useCallback((node: HTMLDivElement | null) => {
    stageObserver.current?.disconnect()
    stageObserver.current = null
    if (!node) return
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width)
      const height = Math.round(entry.contentRect.height)
      setAvailable((current) => current.width === width && current.height === height ? current : { width, height })
    })
    observer.observe(node)
    stageObserver.current = observer
  }, [])
  const index = siblings.findIndex((s) => s.id === scenario.id)
  const previous = index > 0 ? siblings[index - 1] : undefined
  const next =
    index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : undefined
  const screens = index >= 0 ? siblings : [scenario, ...siblings]
  useArrowKeys({
    onPrevious: !fullScreen && previous ? () => onSelect(previous.id) : undefined,
    onNext: !fullScreen && next ? () => onSelect(next.id) : undefined,
  })
  return (
    <Modal
      open
      size={fullScreen ? "fullscreen" : "expanded"}
      header={header}
      title={scenario.title}
      onClose={onClose}
      footer={!fullScreen && (
        <div className="design-lightbox-footer">
          <p className="design-lightbox-description">{scenario.description}</p>
        <div className="design-lightbox-actions">
          <Tooltip label="Previous (←)">
            <Button
              variant="outline"
              size="icon"
              aria-label="Previous preview"
              disabled={!previous}
              onClick={() => previous && onSelect(previous.id)}
            >
              <ArrowLeft size={20} />
            </Button>
          </Tooltip>
          <Tooltip label="Next (→)">
            <Button
              variant="outline"
              size="icon"
              aria-label="Next preview"
              disabled={!next}
              onClick={() => next && onSelect(next.id)}
            >
              <ArrowRight size={20} />
            </Button>
          </Tooltip>
          <Button
            variant="default"
            leftIcon={<ArrowSquareOut size={16} />}
            onClick={() => onOpenLive(scenario.id)}
          >
            Open live UI
          </Button>
        </div>
        </div>
      )}
    >
      <div className="design-viewport-toolbar" role="group" aria-label="Responsive preview controls">
        {!fullScreen && (
          <>
            <div className="design-lightbox-picker">
              <ScreenPicker screens={screens} value={scenario.id} onSelect={onSelect} />
            </div>
            <Tooltip label="Reset state">
              <Button variant="outline" size="icon" aria-label="Reset state" onClick={onReset}>
                <ArrowCounterClockwise size={16} />
              </Button>
            </Tooltip>
          </>
        )}
        <span className="design-viewport-divider" aria-hidden="true" />
        <Select
          aria-label="Preview viewport"
          value={viewport}
          onChange={(event) => {
            const value = event.target.value
            if (isViewportPreset(value)) return onViewportChange(value)
            const custom = customWidths.find((entry) => `custom:${entry.id}` === value)
            if (custom) {
              onViewportChange("custom")
              onCustomWidthChange(custom.width)
            }
          }}
        >
          <optgroup label="Presets">
            {Object.entries(VIEWPORTS).map(([value, preset]) => (
              <option key={value} value={value}>{preset.label}</option>
            ))}
          </optgroup>
          {customWidths.length > 0 && (
            <optgroup label="Custom">
              {customWidths.map((entry) => (
                <option key={entry.id} value={`custom:${entry.id}`}>{entry.label} ({entry.width}px)</option>
              ))}
            </optgroup>
          )}
        </Select>
        {viewport === "custom" && (
          <form className="design-viewport-custom" onSubmit={(event) => { event.preventDefault(); applyWidth() }} noValidate>
            <label htmlFor="preview-custom-width">Width</label>
            <Input
              id="preview-custom-width"
              aria-label="Custom viewport width"
              aria-invalid={widthError}
              aria-describedby={widthError ? "preview-width-error" : undefined}
              className="control design-viewport-width"
              type="number"
              min={MIN_CUSTOM_WIDTH}
              max={MAX_CUSTOM_WIDTH}
              step={1}
              value={widthDraft}
              onChange={(event) => { setWidthDraft(event.target.value); setWidthError(false) }}
            />
            <span>px</span>
            <Button type="submit" variant="outline">Apply</Button>
          </form>
        )}
        <output className="design-viewport-dimensions" aria-label="Preview viewport dimensions" title="Rendered at 100%, never scaled">
          {dimensions.width} × {dimensions.height}
        </output>
        <FigmaExport scenarios={[scenario]} />
        <CopyMenu scenarioId={scenario.id} currentWidth={dimensions.width} />
      </div>
      {viewport === "custom" && widthError && (
        <p id="preview-width-error" className="design-viewport-error" role="alert">
          Enter a whole-number width from {MIN_CUSTOM_WIDTH} to {MAX_CUSTOM_WIDTH} pixels.
        </p>
      )}
      <div className="design-lightbox-meta" hidden={fullScreen}>
        <nav className="design-lightbox-crumbs" aria-label="Screen location" title={scenarioSource(scenario)}>
          {folderCrumb(scenarioSource(scenario)).split(" › ").map((part, i) => (
            <span key={i} className="design-lightbox-crumb">
              {i > 0 && <CaretRight size={10} weight="bold" aria-hidden="true" />}
              {part}
            </span>
          ))}
        </nav>
        {index >= 0 && siblings.length > 1 && (
          <span className="design-lightbox-count">
            {index + 1} of {siblings.length}
          </span>
        )}
      </div>
      <div className="design-lightbox-stage" ref={stage}>
        <PreviewDeck key={revision} scenario={scenario} viewport={size} />
      </div>
    </Modal>
  )
}
