import { state } from "../state.js"

const label = { overview: "Overview", invoices: "Invoices", customers: "Customers", settings: "Settings" }

export function nav() {
  return Object.keys(label)
    .map((key) => `<button class="nav" data-action="go" data-view="${key}" ${state.view === key ? 'aria-current="page"' : ""}>${label[key]}</button>`)
    .join("")
}
