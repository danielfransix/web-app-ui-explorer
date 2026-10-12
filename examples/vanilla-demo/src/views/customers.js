import { customers } from "../state.js"

export function customersView() {
  return `
    <div class="row"><div><h1>Customers</h1><p class="sub">The people and companies you bill.</p></div>
      <button class="btn primary" data-action="open-drawer">Add customer</button></div>
    <div class="list">${customers.map((c) => `<div class="item"><span>${c}</span><button class="btn" data-action="toast" data-text="Opened ${c}">View</button></div>`).join("")}</div>`
}
