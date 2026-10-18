import { Select as BaseSelect } from "@base-ui/react/select"
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown"
import { Check } from "@phosphor-icons/react/dist/csr/Check"
import usePopupContainer from "./usePopupContainer"

type Option = { value: number; label: string; description?: string }

export default function MultiSelect({ id, label, options, value, onChange, maxSelections, summary }: {
  id: string; label: string; options: Option[]; value: number[]; onChange: (value: number[]) => void; maxSelections?: number; summary?: string
}) {
  const { container, triggerRef } = usePopupContainer()
  return <span className="control-select">
    <BaseSelect.Root<number, true> multiple modal={false} value={value} onValueChange={onChange} items={options}>
      <BaseSelect.Trigger id={id} ref={triggerRef} aria-label={label} className="control control--select">
        <BaseSelect.Value className="control-select__value">{() => summary ?? (value.length ? `${value.length} selected` : "Choose options")}</BaseSelect.Value>
      </BaseSelect.Trigger>
      <CaretDown size={16} aria-hidden="true" />
      <BaseSelect.Portal container={container}>
        <BaseSelect.Positioner side="bottom" align="start" sideOffset={8} collisionPadding={8} alignItemWithTrigger={false} className="uix-select-positioner">
          <BaseSelect.Popup className="select-menu uix-popup">
            <BaseSelect.List aria-label={label}>
              {options.map(option => <BaseSelect.Item key={option.value} value={option.value}
                disabled={maxSelections !== undefined && value.length >= maxSelections && !value.includes(option.value)}
                className="select-menu__option multi-select__option">
                <span className="multi-select__checkbox" aria-hidden="true">{value.includes(option.value) && <Check size={12} />}</span>
                <span className="select-menu__option-copy">
                  <BaseSelect.ItemText className="multi-select__option-label">{option.label}</BaseSelect.ItemText>
                  {option.description && <span className="multi-select__option-description">{option.description}</span>}
                </span>
              </BaseSelect.Item>)}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  </span>
}
