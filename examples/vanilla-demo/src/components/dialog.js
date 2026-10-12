import { state } from "../state.js"

export function dialog() {
  if (state.dialog === "new-invoice")
    return `<div class="scrim"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dt">
      <h2 id="dt">Create invoice</h2>
      <div class="field"><label for="c">Customer</label><input id="c" placeholder="e.g. Globex Corporation" /></div>
      <div class="field"><label for="a">Amount</label><input id="a" placeholder="e.g. 1200.00" /></div>
      <div class="actions"><button class="btn" data-action="close">Cancel</button><button class="btn primary" data-action="save-invoice">Save invoice</button></div>
    </div></div>`
  if (state.dialog === "delete-account")
    return `<div class="scrim"><div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dt">
      <h2 id="dt">Delete your account?</h2>
      <p>This removes your invoices and customers. It cannot be undone.</p>
      <div class="actions"><button class="btn" data-action="close">Keep account</button><button class="btn danger" data-action="toast" data-text="Account deleted">Delete account</button></div>
    </div></div>`
  return ""
}
