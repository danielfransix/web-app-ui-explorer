import { html, state } from "./views.js"

const view = document.getElementById("view")
const render = () => {
  view.innerHTML = html()
}

view.addEventListener("click", (event) => {
  const target = event.target.closest("button,[role=option]")
  if (!target) return
  if (target.id === "help") state.dialog = true
  if (target.id === "close-help") state.dialog = false
  if (target.id === "frequency") state.listOpen = !state.listOpen
  if (target.getAttribute("role") === "option") {
    state.frequency = target.textContent
    state.listOpen = false
  }
  if (target.id === "save") {
    state.name = document.getElementById("name").value
    if (!state.name) state.error = "Display name is required"
    else {
      state.error = ""
      setTimeout(() => {
        state.saved = true
        render()
      }, 200)
    }
  }
  render()
})
document.querySelector("nav").addEventListener("click", (event) => {
  const id = event.target.id
  if (!id) return
  state.screen = id.replace("go-", "")
  state.dialog = state.listOpen = state.saved = false
  state.error = ""
  render()
})
render()
window.__appReady = true
