export function overview() {
  return `
    <div class="row"><div><h1>Overview</h1><p class="sub">How your billing is doing this month.</p></div>
      <button class="btn primary" data-action="open-dialog" data-dialog="new-invoice">Create invoice</button></div>
    <div class="cards">
      <div class="card"><span>Revenue</span><b>$13,770</b></div>
      <div class="card"><span>Outstanding</span><b>$2,140</b></div>
      <div class="card"><span>Overdue invoices</span><b>1</b></div>
    </div>`
}
