import { useState } from "react"
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown"
import { Button, CopyField, Disclosure, DisclosurePanel, DisclosureTrigger } from "./ui"
import { readApiJson } from "./apiResponse"

export default function FigmaConnection() {
  const [open, setOpen] = useState(false)
  const [connectionUrl, setConnectionUrl] = useState("")
  const [busy, setBusy] = useState(false), [error, setError] = useState("")

  async function loadConnection() {
    if (busy) return
    setBusy(true); setError("")
    try {
      const response = await fetch("api/figma/connection", { method: "POST", cache: "no-store" })
      const body = await readApiJson<{ connectionUrl: string }>(response, "Could not start the Figma connection")
      const url = new URL(body.connectionUrl)
      if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) || !url.hash.slice(1)) throw Error("UI Explorer returned an invalid connection URL. Refresh and try again.")
      setConnectionUrl(url.href)
    } catch (caught) {
      setConnectionUrl("")
      setError(caught instanceof Error ? caught.message : "Could not start the Figma connection")
    } finally { setBusy(false) }
  }

  return <Disclosure className="design-figma-connection" open={open} onOpenChange={next => { setOpen(next); if (next) void loadConnection() }}>
    <DisclosureTrigger variant="outline" size="sm" className="design-figma-connection__trigger" rightIcon={<CaretDown size={14} />}>
      Figma connection
    </DisclosureTrigger>
    <DisclosurePanel className="design-figma-connection__body">
        <p>For manual plugin and IDE connections. Import codes connect automatically.</p>
        {busy ? <p role="status">Starting the local bridge…</p> : connectionUrl && <>
          <CopyField id="figma-bridge-url" label="Bridge connection URL" value={connectionUrl}
            copyLabel="Copy connection URL" copiedLabel="Copied connection URL" fallback="Select the URL above and copy it with Ctrl+C (⌘C on Mac)." />
          <p>In Figma, open Optional settings → Advanced connection and paste this URL.</p>
          <p>The local bridge is running. Keep UI Explorer open while connected.</p>
        </>}
        {error && <p role="alert">{error}</p>}
        {!busy && !connectionUrl && <Button variant="outline" size="sm" onClick={() => void loadConnection()}>Retry connection</Button>}
    </DisclosurePanel>
  </Disclosure>
}
