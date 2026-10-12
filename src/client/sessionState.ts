// Versioned, minimal sessionStorage for the explorer (client-localstorage-schema).
// Bump VERSION when a stored shape changes; old keys are then simply ignored.
const VERSION = "v1"
const key = (name: string) => `ui-explorer:${name}:${VERSION}`

export function readSession(name: string): unknown {
  try {
    const raw = sessionStorage.getItem(key(name))
    return raw === null ? undefined : JSON.parse(raw)
  } catch {
    // Blocked or corrupt storage falls back to defaults.
    return undefined
  }
}

export function writeSession(name: string, value: unknown) {
  try {
    sessionStorage.setItem(key(name), JSON.stringify(value))
  } catch {
    // Sandboxed/blocked storage must not prevent rendering or in-memory state.
  }
}
