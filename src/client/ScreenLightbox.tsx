import type { ReactNode } from "react"
import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft"
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight"
import { ArrowSquareOut } from "@phosphor-icons/react/dist/csr/ArrowSquareOut"
import { Button, Modal, Tooltip } from "./ui"
import ScreenFrame from "./ScreenFrame"
import useArrowKeys from "./useArrowKeys"
import { folderCrumb, scenarioSource } from "./folderModel"
import type { Scenario } from "../shared/types"

type Props = {
  fullScreen?: boolean
  header?: ReactNode
  revision?: number
  scenario: Scenario
  // The screens that were visible when the preview was expanded, so Previous/Next stay in that set.
  siblings: Scenario[]
  onSelect: (id: string) => void
  onClose: () => void
  onOpenLive: (id: string) => void
}

// Both preview sizes share one frame so expanding and returning never reloads the live app.
export default function ScreenLightbox({
  scenario,
  fullScreen = false,
  header,
  revision,
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
      )}
    >
      <div className="design-lightbox-meta" hidden={fullScreen}>
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
        <ScreenFrame scenario={scenario} enlarged={!fullScreen} revision={revision} />
      </div>
      <p className="modal-description pb-1" hidden={fullScreen}>{scenario.description}</p>
    </Modal>
  )
}
