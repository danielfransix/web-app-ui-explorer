import { useState } from "react"
import { Check } from "@phosphor-icons/react/dist/csr/Check"
import type { Scenario } from "../shared/types"
import { Button, Checkbox, Input } from "./ui"

export type LoginMethod = "choose" | "manual" | "auto"

/** The banner shown at the top of the gallery while picking, then logging into, a screen — the mode is
 *  explicit rather than inferred from radio buttons alone, per "10 · Show status and a way forward" (practical
 *  guidance): what's happening and what to do next are both stated, not left for the person to notice on
 *  their own. */
export default function LoginPickerBanner({
  method,
  watching,
  pastPassword,
  starting,
  saving,
  error,
  pick,
  onCancel,
  onConfirm,
  onChooseManual,
  onChooseAuto,
  onAutoSubmit,
  onFinish,
}: {
  method: LoginMethod | undefined
  watching: Scenario | null
  pastPassword: boolean
  starting: boolean
  saving: boolean
  error: string | undefined
  pick: string | undefined
  onCancel: () => void
  onConfirm: () => void
  onChooseManual: () => void
  onChooseAuto: () => void
  onAutoSubmit: (username: string, password: string, headless: boolean) => void
  onFinish: () => void
}) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [visible, setVisible] = useState(false)

  if (!method)
    return (
      <div className="design-login-banner" role="status">
        <span>Pick the login screen below, then confirm.</span>
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="default" size="sm" onClick={onConfirm} disabled={!pick}>
          Confirm
        </Button>
      </div>
    )

  if (method === "choose")
    return (
      <div className="design-login-banner" role="status">
        <span>How do you want to log in?</span>
        <Button variant="outline" size="sm" onClick={onChooseManual}>
          Open a tab myself
        </Button>
        <Button variant="outline" size="sm" onClick={onChooseAuto}>
          Enter login details
        </Button>
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    )

  if (method === "auto" && !watching)
    return (
      <form
        className="design-login-banner design-login-banner--form"
        role="status"
        onSubmit={(event) => {
          event.preventDefault()
          onAutoSubmit(username, password, !visible)
        }}
      >
        <span>Enter login details for this run only — never saved, never shown in the logs.</span>
        <Input className="control" type="text" autoComplete="off" placeholder="Email or username" aria-label="Email or username" value={username} onChange={(event) => setUsername(event.target.value)} required />
        <Input className="control" type="password" autoComplete="new-password" placeholder="Password" aria-label="Password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        <Checkbox checked={visible} onChange={setVisible} className="design-login-banner__visible">
          <span className="design-login-banner__visible-box" aria-hidden="true">{visible && <Check size={12} weight="bold" />}</span>
          <span>Show the browser while it works</span>
        </Checkbox>
        <Button variant="outline" size="sm" onClick={onCancel} type="button">
          Cancel
        </Button>
        <Button variant="default" size="sm" type="submit" disabled={starting || !username || !password}>
          {starting ? "Logging in..." : "Log in"}
        </Button>
        {error && <span role="alert">{error}</span>}
      </form>
    )

  // method is "manual", or "auto" with a window now open and being watched.
  return (
    <div className="design-login-banner" role="status">
      <span>
        {pastPassword
          ? "Looks like you're past the password step. Finish any remaining steps (an org or account picker, a code), then click I'm done."
          : "Log in in the window that just opened, then click I'm done — nothing is saved until you say so."}
      </span>
      {error && <span role="alert">{error}</span>}
      <Button variant="outline" size="sm" onClick={onCancel}>
        Cancel
      </Button>
      <Button variant="default" size="sm" onClick={onFinish} disabled={saving}>
        {saving ? "Saving..." : "I'm done"}
      </Button>
    </div>
  )
}
