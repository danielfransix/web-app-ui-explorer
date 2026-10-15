import { useMemo, useState } from "react"
import { Combobox } from "@base-ui/react/combobox"
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown"
import { Check } from "@phosphor-icons/react/dist/csr/Check"
import usePopupContainer from "./ui/usePopupContainer"
import type { Scenario } from "../shared/types"

const labelOf = (s: Scenario) => `${s.group} · ${s.title}`

// A searchable "jump to a screen" picker. It lists only the screens passed in (the current
// selection), and typing filters the list without changing which screen is active.
export default function ScreenPicker({
  screens,
  value,
  onSelect,
  label = "Jump to a screen state",
}: {
  screens: Scenario[]
  value: string
  onSelect: (id: string) => void
  label?: string
}) {
  const { container, triggerRef } = usePopupContainer()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const active = screens.find((s) => s.id === value)
  const needle = query.trim().toLowerCase()
  const visible = useMemo(
    () => (needle ? screens.filter((s) => labelOf(s).toLowerCase().includes(needle)) : screens),
    [screens, needle],
  )
  return (
    <span className="control-select screen-picker">
      <Combobox.Root<Scenario>
        items={screens}
        filteredItems={visible}
        value={active ?? null}
        open={open}
        modal={false}
        inputValue={open ? query : active ? labelOf(active) : ""}
        itemToStringLabel={labelOf}
        isItemEqualToValue={(a, b) => a.id === b.id}
        autoHighlight
        onOpenChange={(next) => {
          setOpen(next)
          setQuery("")
        }}
        onInputValueChange={(next, details) => {
          if (details.reason === "input-change" || details.reason === "input-clear") setQuery(next)
        }}
        onValueChange={(next) => {
          if (next && next.id !== value) onSelect(next.id)
        }}
      >
        <Combobox.Input
          ref={triggerRef}
          aria-label={label}
          placeholder="Search screens"
          className="control control--select screen-picker__input"
          onFocus={(event) => event.currentTarget.select()}
        />
        <CaretDown size={16} aria-hidden="true" />
        <Combobox.Portal container={container}>
          <Combobox.Positioner side="bottom" align="start" sideOffset={8} collisionPadding={8} className="uix-select-positioner">
            <Combobox.Popup className="select-menu uix-popup">
              <Combobox.Empty className="select-menu__empty">No matching screens</Combobox.Empty>
              <Combobox.List>
                {(item: Scenario) => (
                  <Combobox.Item key={item.id} value={item} className="select-menu__option">
                    <span className="select-menu__option-copy">{labelOf(item)}</span>
                    <Combobox.ItemIndicator>
                      <Check size={16} aria-hidden="true" />
                    </Combobox.ItemIndicator>
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
    </span>
  )
}
