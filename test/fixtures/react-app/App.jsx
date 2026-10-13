import { useState } from "react"

// The same small app as test/fixtures/bundled-app, written in React: two screens, a dialog, a dropdown and a form
// with validation. Every bundler in the matrix builds this one component.
export default function App() {
  const [screen, setScreen] = useState("home")
  const [dialog, setDialog] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const [frequency, setFrequency] = useState("")
  const [name, setName] = useState("")
  const [error, setError] = useState("")
  const [saved, setSaved] = useState(false)

  const go = (next) => {
    setScreen(next)
    setDialog(false)
    setListOpen(false)
    setSaved(false)
    setError("")
  }
  const save = () => {
    if (!name) return setError("Display name is required")
    setError("")
    setTimeout(() => setSaved(true), 200)
  }

  return (
    <>
      <nav aria-label="Main" style={{ display: "flex", gap: 8, padding: 12, borderBottom: "1px solid #ddd" }}>
        <button id="go-home" onClick={() => go("home")}>Home</button>
        <button id="go-settings" onClick={() => go("settings")}>Settings</button>
        <button id="go-reports" onClick={() => go("reports")}>Reports</button>
      </nav>
      <main style={{ padding: 24 }}>
        {screen === "home" && (
          <>
            <h1>Welcome</h1>
            <p>This is the home screen.</p>
            <button id="help" onClick={() => setDialog(true)}>Open help</button>
            {dialog && (
              <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "grid", placeItems: "center" }}>
                <div role="dialog" aria-modal="true" aria-labelledby="d-title" style={{ background: "white", padding: 24, borderRadius: 8, minWidth: 280 }}>
                  <h2 id="d-title">Help centre</h2>
                  <p>Ask us anything.</p>
                  <button id="close-help" onClick={() => setDialog(false)}>Close</button>
                </div>
              </div>
            )}
          </>
        )}
        {screen === "settings" && (
          <>
            <h1>Settings</h1>
            <label>Display name <input id="name" value={name} onChange={(event) => setName(event.target.value)} /></label>
            {error && <p role="alert">{error}</p>}
            <div>
              <button id="frequency" role="combobox" aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>{frequency || "Choose frequency"}</button>
              {listOpen && (
                <div role="listbox" style={{ border: "1px solid #ccc", padding: 4, marginTop: 4, width: 200 }}>
                  {["Weekly", "Monthly"].map((option) => (
                    <div key={option} role="option" style={{ padding: 6, cursor: "pointer" }} onClick={() => (setFrequency(option), setListOpen(false))}>{option}</div>
                  ))}
                </div>
              )}
            </div>
            <button id="save" onClick={save}>Save changes</button>
            {saved && <p>Settings saved</p>}
          </>
        )}
        {screen === "reports" && (
          <>
            <h1>Reports</h1>
            <p>Nothing to show yet.</p>
          </>
        )}
      </main>
    </>
  )
}
