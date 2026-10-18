import { Check } from "@phosphor-icons/react/dist/csr/Check"
import { Checkbox } from "./ui"

/** Kept in the card caption so selecting never obscures or opens its thumbnail. */
export default function ScreenSelect({ title, checked, onChange }: {
  title: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <Checkbox
      className="design-screen-select nodrag nopan"
      aria-label={`Select ${title} for Figma`}
      title="Select for Figma"
      checked={checked}
      onChange={onChange}
      onPointerDown={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}
    >
      <span className="design-screen-select__box" aria-hidden="true">
        {checked && <Check size={12} weight="bold" />}
      </span>
    </Checkbox>
  )
}
