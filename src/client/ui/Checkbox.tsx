import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox"
import Button from "./Button"
import { Check } from "@phosphor-icons/react/dist/csr/Check"
import { Minus } from "@phosphor-icons/react/dist/csr/Minus"

type Props = Omit<BaseCheckbox.Root.Props, "onCheckedChange" | "render" | "nativeButton" | "checked"> & {
  checked: boolean
  onChange: (checked: boolean) => void
}

export default function Checkbox({ checked, onChange, children, className = "", indeterminate, ...props }: Props) {
  return (
    <BaseCheckbox.Root
      checked={checked}
      indeterminate={indeterminate}
      className={children === undefined ? `ds-checkbox ${className}` : className}
      onCheckedChange={(next) => onChange(next)}
      nativeButton
      render={<Button />}
      {...props}
    >
      {children ?? <span className="ds-checkbox__box" aria-hidden="true">{indeterminate ? <Minus size={12} /> : checked ? <Check size={12} /> : null}</span>}
    </BaseCheckbox.Root>
  )
}
