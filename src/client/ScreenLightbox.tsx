import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft"
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight"
import { ArrowSquareOut } from "@phosphor-icons/react/dist/csr/ArrowSquareOut"
import { Button, Modal, Tooltip } from "./ui"
import ScreenFrame from "./ScreenFrame"
import useArrowKeys from "./useArrowKeys"
import { folderCrumb, scenarioSource } from "./folderModel"
import type { Scenario } from "../shared/types"

type Props = {
  scenario: Scenario
  // The screens that were visible when the preview was expanded, so Previous/Next stay in that set.
  siblings: Scenario[]
  onSelect: (id: string) => void
  onClose: () => void
  onOpenLive: (id: string) => void
}

// Expands a thumbnail in place so it can be read at size. Jumping to the interactive UI is a separate,
// explicit action, so clicking a thumbnail never navigates away from the gallery or canvas.
export default function ScreenLightbox({
  scenario,
  siblings,
  onSelect,
  onClose,
  onOpenLive,
}: Props) {
  const index = siblings.findIndex((s) => s.id === scenario.id)
  const previous = index > 0 ? siblings[index - 1] : undefined
  const next =
    index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : undefined
  useArrowKeys({
    onPrevious: previous && (() => onSelect(previous.id)),
    onNext: next && (() => onSelect(next.id)),
  })
  return (
    <Modal
      open
      size="expanded"
      title={scenario.title}
      onClose={onClose}
      footer={
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
      }
    >
      <div className="design-lightbox-meta">
        <span title={scenarioSource(scenario)}>
          {folderCrumb(scenarioSource(scenario))}
        </span>
        {index >= 0 && siblings.length > 1 && (
          <span>
            {index + 1} of {siblings.length}
          </span>
        )}
      </div>
      <div className="design-lightbox-stage">
        <ScreenFrame scenario={scenario} enlarged />
      </div>
      <p className="modal-description pb-1">{scenario.description}</p>
    </Modal>
  )
}
