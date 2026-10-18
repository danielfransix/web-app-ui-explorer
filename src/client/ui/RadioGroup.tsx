import { Radio as BaseRadio } from "@base-ui/react/radio"
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group"
import Button from "./Button"

export function RadioGroup<Value>(props: BaseRadioGroup.Props<Value>) {
  return <BaseRadioGroup {...props} />
}

export function RadioOption<Value>({ children, ...props }: Omit<BaseRadio.Root.Props<Value>, "render" | "nativeButton">) {
  return (
    <BaseRadio.Root nativeButton render={<Button />} {...props}>
      {children}
      <span className="ds-radio-circle" aria-hidden="true">
        <BaseRadio.Indicator className="ds-radio-dot" />
      </span>
    </BaseRadio.Root>
  )
}
