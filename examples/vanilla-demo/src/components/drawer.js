import { state } from "../state.js"

export function drawer() {
  if (!state.drawer) return ""
  return `<div class="drawer-wrap"><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="dr">
    <h2 id="dr">Add customer</h2>
    <div class="field"><label for="n">Company name</label><input id="n" placeholder="e.g. Wayne Enterprises" /></div>
    <div class="field"><label for="e">Billing email</label><input id="e" placeholder="billing@company.com" /></div>
    <div class="actions"><button class="btn" data-action="close">Cancel</button><button class="btn primary" data-action="save-customer">Add customer</button></div>
  </aside></div>`
}
