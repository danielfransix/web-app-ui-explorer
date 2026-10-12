import { invoices, state } from "../state.js"

export function invoicesView() {
  const rows = invoices.filter((i) => state.invoiceTab === "all" || i.status === state.invoiceTab)
  const tab = (key, text) => `<button class="tab" role="tab" data-action="invoice-tab" data-tab="${key}" aria-selected="${state.invoiceTab === key}">${text}</button>`
  return `
    <div class="row"><div><h1>Invoices</h1><p class="sub">Everything you have sent, and what is still owed.</p></div>
      <button class="btn primary" data-action="open-dialog" data-dialog="new-invoice">New invoice</button></div>
    <div class="tabs" role="tablist">${tab("all", "All")}${tab("paid", "Paid")}${tab("overdue", "Overdue")}</div>
    <table><thead><tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Status</th></tr></thead><tbody>
      ${rows.map((i) => `<tr><td>${i.id}</td><td>${i.customer}</td><td>${i.amount}</td><td><span class="pill ${i.status}">${i.status}</span></td></tr>`).join("")}
    </tbody></table>`
}
