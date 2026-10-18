/** Styled single-select menus backed by the import form's option values. */
export function initializeDropdowns() {
  let dismiss: (() => void) | undefined
  for (const select of Array.from(document.querySelectorAll<HTMLSelectElement>(".select-control select"))) {
    const wrapper = select.parentElement!
    const label = document.querySelector<HTMLLabelElement>(`label[for="${select.id}"]`)!
    const trigger = document.createElement("button")
    trigger.type = "button"; trigger.id = select.id + "-trigger"; trigger.className = "select-trigger"
    trigger.setAttribute("role", "combobox"); trigger.setAttribute("aria-haspopup", "listbox")
    trigger.setAttribute("aria-expanded", "false"); trigger.setAttribute("aria-controls", select.id + "-listbox")
    label.id ||= select.id + "-label"; label.htmlFor = trigger.id
    trigger.setAttribute("aria-labelledby", label.id)
    const value = document.createElement("span"); value.className = "select-value"
    trigger.append(value, wrapper.querySelector(".select-arrow")!)
    wrapper.append(trigger)
    select.hidden = true; select.tabIndex = -1
    const menu = document.createElement("div")
    menu.id = select.id + "-listbox"; menu.className = "dropdown-menu"; menu.hidden = true
    menu.setAttribute("role", "listbox"); menu.setAttribute("aria-labelledby", label.id)
    document.body.append(menu)
    let open = false, active = -1, typed = "", typedAt = 0
    const options = () => Array.from(select.options)
    const enabled = () => options().map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0)
    function close() {
      if (!open) return
      open = false; menu.hidden = true; trigger.setAttribute("aria-expanded", "false")
      trigger.removeAttribute("aria-activedescendant"); dismiss = undefined; typed = ""
    }
    function position() {
      if (!open) return
      if (trigger.disabled || !trigger.getClientRects().length) { close(); return }
      const rect = trigger.getBoundingClientRect(), margin = 12, gap = 6
      const viewportWidth = document.documentElement.clientWidth, viewportHeight = document.documentElement.clientHeight
      if (rect.bottom < margin || rect.top > viewportHeight - margin) { close(); return }
      const below = viewportHeight - rect.bottom - gap - margin, above = rect.top - gap - margin
      const up = below < Math.min(menu.scrollHeight, 220) && above > below
      menu.style.width = Math.min(Math.max(rect.width, select.id === "folder" ? 300 : rect.width), viewportWidth - margin * 2) + "px"
      menu.style.maxHeight = Math.max(0, Math.min(280, up ? above : below)) + "px"
      menu.style.left = Math.max(margin, Math.min(rect.left, viewportWidth - menu.offsetWidth - margin)) + "px"
      menu.style.top = (up ? rect.top - gap - menu.offsetHeight : rect.bottom + gap) + "px"
    }
    function highlight(index: number) {
      active = index
      Array.from(menu.children).forEach((node, i) => node.classList.toggle("is-active", i === index))
      const item = menu.children[index] as HTMLElement | undefined
      if (item) {
        trigger.setAttribute("aria-activedescendant", item.id)
        // Scroll only the option list; the surrounding panel must stay still.
        if (item.offsetTop < menu.scrollTop) menu.scrollTop = item.offsetTop
        else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight
      } else trigger.removeAttribute("aria-activedescendant")
    }
    function commit() {
      if (active < 0 || !select.options[active] || select.options[active].disabled || select.disabled) { close(); return }
      const changed = select.selectedIndex !== active
      select.selectedIndex = active; close(); sync()
      if (changed) {
        select.dispatchEvent(new Event("input", { bubbles: true }))
        select.dispatchEvent(new Event("change", { bubbles: true }))
      }
    }
    function render() {
      menu.replaceChildren(...options().map((option, index) => {
        const item = document.createElement("div")
        item.id = select.id + "-option-" + index; item.className = "dropdown-option"
        item.setAttribute("role", "option"); item.setAttribute("aria-selected", String(option.selected))
        if (option.disabled) item.setAttribute("aria-disabled", "true")
        const text = document.createElement("span"); text.textContent = option.text; item.title = option.text
        const check = document.createElementNS("http://www.w3.org/2000/svg", "svg")
        check.setAttribute("viewBox", "0 0 16 16"); check.setAttribute("aria-hidden", "true")
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
        path.setAttribute("d", "m3.5 8 3 3 6-6"); check.append(path); item.append(text, check)
        item.addEventListener("pointermove", () => { if (!option.disabled) highlight(index) })
        item.addEventListener("pointerdown", event => event.preventDefault())
        item.addEventListener("click", () => { if (!option.disabled) { active = index; commit(); trigger.focus() } })
        return item
      }))
    }
    function sync() {
      value.textContent = select.selectedOptions[0]?.text ?? "Choose an option"
      trigger.title = value.textContent; trigger.disabled = select.disabled
      trigger.classList.toggle("is-placeholder", !select.value)
      if (select.disabled) close()
      if (open) { render(); position(); highlight(select.selectedIndex) }
    }
    function expand() {
      if (select.disabled || open) return
      dismiss?.(); open = true; dismiss = close
      render(); menu.hidden = false; trigger.setAttribute("aria-expanded", "true")
      position(); highlight(select.options[select.selectedIndex]?.disabled ? enabled()[0] ?? -1 : select.selectedIndex)
    }
    trigger.addEventListener("click", () => open ? close() : expand())
    trigger.addEventListener("keydown", event => {
      if (Date.now() - typedAt > 700) typed = ""
      if (event.key === "Escape") { if (open) { event.preventDefault(); event.stopPropagation(); close() }; return }
      if (event.key === "Tab") { if (open) commit(); return }
      if (["Enter", " "].includes(event.key) && !(event.key === " " && typed)) {
        event.preventDefault(); if (open) commit(); else expand(); return
      }
      if (["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(event.key)) {
        event.preventDefault()
        const wasOpen = open; expand()
        if (event.altKey && event.key === "ArrowUp" && wasOpen) { commit(); return }
        const indices = enabled(), current = indices.indexOf(active)
        if (event.key === "Home") highlight(indices[0] ?? -1)
        else if (event.key === "End") highlight(indices[indices.length - 1] ?? -1)
        else if (wasOpen) {
          const delta = event.key === "PageDown" ? 10 : event.key === "PageUp" ? -10 : event.key === "ArrowDown" ? 1 : -1
          highlight(indices[Math.max(0, Math.min(indices.length - 1, current + delta))] ?? -1)
        }
        return
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault(); expand()
        const now = Date.now(); typed = now - typedAt > 700 ? event.key : typed + event.key; typedAt = now
        const query = typed.toLocaleLowerCase(), repeated = [...query].every(char => char === query[0])
        const indices = enabled(), start = repeated ? indices.indexOf(active) + 1 : 0
        const ordered = [...indices.slice(start), ...indices.slice(0, start)]
        const match = ordered.find(index => select.options[index].text.toLocaleLowerCase().startsWith(repeated ? query[0] : query))
        if (match !== undefined) highlight(match)
      }
    })
    document.addEventListener("pointerdown", event => {
      if (open && !wrapper.contains(event.target as Node) && !menu.contains(event.target as Node)) commit()
    })
    document.addEventListener("focusin", event => {
      if (open && !wrapper.contains(event.target as Node) && !menu.contains(event.target as Node)) commit()
    })
    window.addEventListener("resize", position)
    document.addEventListener("scroll", event => { if (event.target !== menu) position() }, true)
    select.addEventListener("change", sync)
    new MutationObserver(sync).observe(select, { attributes: true, childList: true, subtree: true, characterData: true })
    new MutationObserver(() => { if (open && !trigger.getClientRects().length) close() }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden"] })
    sync()
  }
}

export function focusDropdown(id: string) {
  document.getElementById(id + "-trigger")?.focus({ preventScroll: true })
}
