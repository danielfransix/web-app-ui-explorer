import { state } from "../state.js"

export function settingsView() {
  const tab = (key, text) => `<button class="tab" role="tab" data-action="settings-tab" data-tab="${key}" aria-selected="${state.settingsTab === key}">${text}</button>`
  const sw = (key, text) => `<div class="switchrow"><span>${text}</span><button class="switch" role="switch" aria-label="${text}" data-action="switch" data-key="${key}" aria-checked="${state.switches[key]}"></button></div>`
  const body =
    state.settingsTab === "profile"
      ? `<div class="field"><label for="name">Business name</label><input id="name" value="Acme Studio" /></div>
         <button class="btn danger" data-action="open-dialog" data-dialog="delete-account">Delete account</button>`
      : state.settingsTab === "notifications"
        ? `${sw("email", "Email me when an invoice is paid")}${sw("weekly", "Send a weekly summary")}`
        : `<div class="card"><span>Current plan</span><b>Team, $29 / month</b></div>`
  return `
    <div class="row"><div><h1>Settings</h1><p class="sub">Manage your business and how you are notified.</p></div></div>
    <div class="tabs" role="tablist">${tab("profile", "Profile")}${tab("notifications", "Notifications")}${tab("plan", "Plan")}</div>
    ${body}`
}
