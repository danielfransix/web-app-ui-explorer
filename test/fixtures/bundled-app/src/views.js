// The views of a small single-page app, as a module so that a bundler has something to bundle.
export const state = { screen: "home", frequency: "", listOpen: false, saved: false, dialog: false, name: "", error: "" }

export function html() {
  if (state.screen === "home") {
    return `
      <h1>Welcome</h1>
      <p>This is the home screen.</p>
      <button id="help">Open help</button>
      ${state.dialog ? `<div class="dialog"><div role="dialog" aria-modal="true" aria-labelledby="d-title"><h2 id="d-title">Help centre</h2><p>Ask us anything.</p><button id="close-help">Close</button></div></div>` : ""}`
  }
  if (state.screen === "settings") {
    return `
      <h1>Settings</h1>
      <label>Display name <input id="name" value="${state.name}" /></label>
      ${state.error ? `<p role="alert">${state.error}</p>` : ""}
      <div>
        <button id="frequency" role="combobox" aria-expanded="${state.listOpen}">${state.frequency || "Choose frequency"}</button>
        ${state.listOpen ? `<div role="listbox"><div role="option">Weekly</div><div role="option">Monthly</div></div>` : ""}
      </div>
      <button id="save">Save changes</button>
      ${state.saved ? `<p>Settings saved</p>` : ""}`
  }
  return `<h1>Reports</h1><p>Nothing to show yet.</p>`
}
