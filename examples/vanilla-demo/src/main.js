// A small billing dashboard in plain JavaScript: no framework, no build step beyond the Vite dev server.
// It exists to show the explorer on an app anyone can read, and that it works without React.
import { dialog } from "./components/dialog.js"
import { drawer } from "./components/drawer.js"
import { nav } from "./components/nav.js"
import { state } from "./state.js"
import { customersView } from "./views/customers.js"
import { invoicesView } from "./views/invoices.js"
import { overview } from "./views/overview.js"
import { settingsView } from "./views/settings.js"

const views = { overview, invoices: invoicesView, customers: customersView, settings: settingsView }

function render() {
  document.getElementById("app").innerHTML = `
    <div class="shell"><aside class="side"><div class="brand">Acme Billing</div>${nav()}</aside>
    <main class="main">${views[state.view]()}</main></div>
    ${dialog()}${drawer()}${state.toast ? `<div class="toast" role="status">${state.toast}</div>` : ""}`
}

let toastTimer
function toast(text) {
  state.toast = text
  state.dialog = null
  state.drawer = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    state.toast = ""
    render()
  }, 2500)
}

document.addEventListener("click", (event) => {
  const el = event.target.closest("[data-action]")
  if (!el) return
  const { action, view, tab, dialog: which, key, text } = el.dataset
  if (action === "go") state.view = view
  if (action === "invoice-tab") state.invoiceTab = tab
  if (action === "settings-tab") state.settingsTab = tab
  if (action === "open-dialog") state.dialog = which
  if (action === "open-drawer") state.drawer = true
  if (action === "close") (state.dialog = null), (state.drawer = false)
  if (action === "switch") state.switches[key] = !state.switches[key]
  if (action === "save-invoice") toast("Invoice saved")
  if (action === "save-customer") toast("Customer added")
  if (action === "toast") toast(text)
  render()
})

render()
