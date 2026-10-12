import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox"
import Button from "./Button"

type Props = Omit<BaseCheckbox.Root.Props, "onCheckedChange" | "render" | "nativeButton" | "checked"> & {
  checked: boolean
  onChange: (checked: boolean) => void
}

export default function Checkbox({ checked, onChange, ...props }: Props) {
  return (
    <BaseCheckbox.Root
      checked={checked}
      onCheckedChange={(next) => onChange(next)}
      nativeButton
      render={<Button />}
      {...props}
    />
  )
}
