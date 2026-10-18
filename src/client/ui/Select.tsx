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
  const options: { value: string; label: string; disabled?: boolean; group?: string }[] = []
  const textContent = (nodes: ReactNode): string => Children.toArray(nodes).map((node) =>
    isValidElement<{ children?: ReactNode }>(node) ? textContent(node.props.children) : String(node)).join("")
  function collect(nodes: ReactNode, group?: string, disabled = false) {
    Children.forEach(nodes, (option) => {
      if (!isValidElement<{ value?: string; label?: string; disabled?: boolean; children?: ReactNode }>(option)) return
      if (option.type === "optgroup") {
        collect(option.props.children, option.props.label, disabled || !!option.props.disabled)
      } else if (option.type === "option") {
        options.push({ value: String(option.props.value ?? textContent(option.props.children)),
          label: textContent(option.props.children), disabled: disabled || option.props.disabled, group })
      }
    })
  }
  collect(children)
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
                {items.map((option, index) => (
                  <div key={option.value}>
                  {option.group && option.group !== items[index - 1]?.group && (
                    <div className="design-copy-menu__divider">{option.group}</div>
                  )}
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
                  </div>
                ))}
              </BaseSelect.List>
            </BaseSelect.Popup>
          </BaseSelect.Positioner>
        </BaseSelect.Portal>
      </BaseSelect.Root>
    </span>
  )
}
