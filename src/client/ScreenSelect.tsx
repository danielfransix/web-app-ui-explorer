import { Radio as BaseRadio } from "@base-ui/react/radio"
import { Check } from "@phosphor-icons/react/dist/csr/Check"
import { Checkbox } from "./ui"
import Button from "./ui/Button"

/** Reveal the square on hover or selection; retain the click target and keyboard focus outline. */
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

/** The same compact control, as a radio instead of a checkbox — one pick at a time, for the login-screen picker.
 *  Must sit inside a RadioGroup. */
export function ScreenSelectRadio({ title, value }: { title: string; value: string }) {
  return (
    <BaseRadio.Root
      value={value}
      nativeButton
      render={<Button />}
      className="design-screen-select design-screen-select--radio nodrag nopan"
      aria-label={`Pick ${title} as the login screen`}
      title="Pick as the login screen"
      onPointerDown={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}
    >
      <span className="design-screen-select__box" aria-hidden="true">
        <BaseRadio.Indicator className="design-screen-select__radio-dot" />
      </span>
    </BaseRadio.Root>
  )
}
