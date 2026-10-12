import { Select as BaseSelect } from "@base-ui/react/select"
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown"
import { Check } from "@phosphor-icons/react/dist/csr/Check"
import { Children, isValidElement, useState, type ReactNode, type SelectHTMLAttributes } from "react"
import usePopupContainer from "./usePopupContainer"

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange"> & {
  onChange?: (event: { target: { value: string } }) => void
}

// A dropdown that takes <option> children like a native select. Options may only contain text.
export default function Select({
  children,
  className = "",
  id,
  value,
  defaultValue,
  disabled,
  title,
  onChange,
  "aria-label": ariaLabel,
}: SelectProps) {
  const { container, triggerRef } = usePopupContainer()
  const [local, setLocal] = useState(String(defaultValue ?? ""))
  const current = value === undefined ? local : String(value)
  const options = Children.toArray(children)
    .filter(isValidElement<{ value?: string; disabled?: boolean; children?: ReactNode }>)
    .map((option) => ({
      value: String(option.props.value ?? option.props.children ?? ""),
      label: String(option.props.children ?? ""),
      disabled: option.props.disabled,
    }))
  const items = options.filter((option) => option.value !== "")
  const placeholder = options.find((option) => option.value === "")?.label ?? "Choose an option"
  const selected = items.find((option) => option.value === current)
  return (
    <span className="control-select">
      <BaseSelect.Root<string>
        value={current}
        disabled={disabled}
        modal={false}
        items={items}
        onValueChange={(next) => {
          if (value === undefined) setLocal(next ?? "")
          onChange?.({ target: { value: next ?? "" } })
        }}
      >
        <BaseSelect.Trigger
          ref={triggerRef}
          id={id}
          title={title}
          aria-label={ariaLabel}
          className={["control control--select", className].filter(Boolean).join(" ")}
          data-placeholder={!selected}
        >
          <BaseSelect.Value className="control-select__value" placeholder={placeholder}>
            {(next) => items.find((option) => option.value === next)?.label ?? placeholder}
          </BaseSelect.Value>
        </BaseSelect.Trigger>
        <CaretDown size={16} aria-hidden="true" />
        <BaseSelect.Portal container={container}>
          <BaseSelect.Positioner
            side="bottom"
            align="start"
            sideOffset={8}
            collisionPadding={8}
            alignItemWithTrigger={false}
            className="uix-select-positioner"
          >
            <BaseSelect.Popup className="select-menu uix-popup">
              <BaseSelect.List>
                {items.map((option) => (
                  <BaseSelect.Item
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    className="select-menu__option"
                  >
                    <span className="select-menu__option-copy">
                      <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
                    </span>
                    <BaseSelect.ItemIndicator>
                      <Check size={16} aria-hidden="true" />
                    </BaseSelect.ItemIndicator>
                  </BaseSelect.Item>
                ))}
              </BaseSelect.List>
            </BaseSelect.Popup>
          </BaseSelect.Positioner>
        </BaseSelect.Portal>
      </BaseSelect.Root>
    </span>
  )
}
