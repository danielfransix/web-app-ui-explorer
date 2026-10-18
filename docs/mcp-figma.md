# Use UI Explorer with an MCP client and Figma

An MCP client can discover registered screens and states, capture them at chosen widths, and ask the
companion plugin to create editable content in Figma. This is a screen-import workflow, not a general
tool for arbitrary Figma edits or JavaScript execution.

For tasks that also need pages, sections, native annotations or other Figma operations, coordinate
the importer with Figma's existing MCP tools or Plugin API connection. Do not add those operations
to the custom importer. See [orchestration boundaries](agent-orchestration.md).

`web-app-ui-explorer init` installs this guidance into a marked section of the consuming project's
`AGENTS.md`, preserving its other instructions. Existing installations can run
`web-app-ui-explorer agents --root <app-root>` to add or update only that section. The package also
sends the same guidance in its MCP initialization response, so connected clients receive the
boundaries without relying only on local files. Installing the npm dependency by itself does not
modify the project's instructions; run one of these setup commands.

The connection has three parts:

```text
Your model's MCP client -> UI Explorer MCP server -> local bridge -> open Figma plugin
```

The MCP client launches the server over standard input/output (stdio). The bridge passes import
commands to the plugin, which writes the captured designs and returns results. The model does not
need the bridge token. Design import alone does not need a separate Figma MCP connection; tasks
involving other Figma operations need Figma's existing tools and access to the target file too.

## 1. Connect the plugin to your project

1. Start the app and UI Explorer.
2. Open the intended Figma file and page, and run **UI Explorer design import**. For a development
   install, import the package's `figma-plugin/manifest.json` in Figma desktop.
3. In Explorer, open **Workspace overview** (three dots), then **Figma connection**. This starts the
   bridge and displays its connection URL.
4. Copy that URL into the plugin's **Optional settings -> Advanced connection** and click
   **Connect bridge**. Keep Explorer and the plugin open.

Loading an Explorer import code also connects the plugin automatically. A separate bridge command is
only needed for command-line setups; do not start another bridge for a project that is already connected.

The plugin remembers a successful local pairing in Figma client storage and reconnects when reopened.
The project keeps its pairing credential and reuses its loopback port across server restarts when
available. Reconnection never starts an import. **Disconnect bridge** forgets the saved plugin pairing.
Reopening creates a fresh UI session. Once the previous socket closes, that new session can connect
immediately, including during the old session's reconnect grace period. A genuinely open plugin in
another file keeps ownership; the waiting plugin retries when it closes. Any unfinished write from
the previous session remains recorded for review and is never replayed to the new session. An expired
saved selection does not invalidate the local pairing.
The plugin displays its file and page; `explorer_figma_status` reports the same connection context.
Confirm that destination against the person's requested Figma file before writing.

After pairing, the plugin opens an authenticated WebSocket to the local bridge. MCP and CLI commands
are pushed through that connection; the plugin does not need a new code for each command. The pairing
credential travels in the first socket message, never in its URL. Older plugin builds continue using
HTTP polling until updated. Reopen the development plugin after updating its files to load the new code.

The connection retries automatically after a brief interruption. A heartbeat checks the socket
independently of import progress, and the plugin keeps command results until the bridge acknowledges
them. Neither side automatically repeats a delivered command. If the plugin closes or the server
restarts before a write's outcome is known, the bridge records that command locally and blocks another
write until its outcome is checked. Keep both Explorer and the plugin open during imports.

While a native Figma command is pending, a missed heartbeat marks the socket as unresponsive rather
than closing it at the idle deadline. The command's timeout still limits the wait. This lets a paused
plugin UI recover without dropping its write result. Status includes `responsive`, the last socket
close code and reason, and the last command phase. Page and available-font discovery are reused within
an export instead of repeated for every component batch.
The native worker yields through a message round trip to its UI while inspecting and drawing nodes;
it does not rely on sandbox timers to resume long imports. Component progress identifies the variant
or existing node being processed. A healthy socket confirms the connection, not completion of a
canvas operation; use the returned coverage report to confirm the requested screens were created.
Exports also load and inspect only their destination pages and component library, so unrelated pages
do not delay preparation. If Figma's page-loading API reports a connection error while the WebSocket
remains responsive, check that the destination page loads in the editor before retrying the import.

An agent can use `explorer_get_prepared_import` with the short code to read the exact source selection
before the plugin connects. It includes each screen's source folder, widths and component choice.
Without a code, it resolves the plugin's loaded selection or the sole unexpired prepared import;
multiple unclaimed selections require a code. After initial pairing, an agent can read a newly prepared
selection and import it without asking the person to paste its code into the plugin again.

`explorer_discover_figma_desktop` probes Figma's official local MCP at `http://127.0.0.1:3845/mcp`.
It detects an enabled server, not an arbitrary running desktop process. According to
[Figma's desktop MCP documentation](https://developers.figma.com/docs/figma-mcp-server/local-server-installation/),
that server requires enabling in Figma and does not write to the canvas. It cannot replace opening
and initially pairing the importer. Native file operations still use Figma's tools. Initial pairing
uses an import code or manual bridge URL in both desktop and web; public Plugin APIs do not provide
an external launch-and-pair mechanism. Never expose bridge credentials through an unauthenticated
discovery endpoint or control the person's UI to bypass this step.

## 2. Add UI Explorer to the model's MCP client

Configure the client to launch:

```sh
node /absolute/path/to/web-app-ui-explorer/dist/node/cli.js mcp --root /absolute/path/to/app --base-url http://localhost:8443
```

Use the reachable URL of the app serving Explorer. `--root` must be the same project whose Explorer
started the bridge. The MCP server reads that project's `.ui-explorer/bridge.json` automatically;
do not paste the connection URL or token into the model's instructions.

For an app-local package, the CLI is at
`<app>/node_modules/@danielfransix/web-app-ui-explorer/dist/node/cli.js`. For a local development
checkout, build it first and use that checkout's `dist/node/cli.js`. Keep the CLI and plugin builds
up to date together.

Clients that accept an `mcpServers` JSON object can use this Windows example, with their own paths:

```json
{
  "mcpServers": {
    "ui-explorer": {
      "command": "node",
      "args": [
        "C:/projects/web-app-ui-explorer/dist/node/cli.js",
        "mcp",
        "--root", "C:/projects/my-app",
        "--base-url", "http://localhost:8443"
      ]
    }
  }
}
```

Configuration format and location depend on the client. Enable the server, reload its tools or restart
the client, and allow its tool calls when prompted. No special phrase, slash command or plugin trigger
is required after both connections are active.

Discovery can read a saved scenario catalog without a running app. Captures and imports require the
app; supplying `--base-url` also discovers its live registered states. Authentication for captures can
be supplied with `--storage-state <file>`. Requests that change app data are blocked unless
`--allow-writes` is explicitly enabled; this setting is separate from creating content in Figma.

## 3. Ask the model to import screens

For example:

> List the registered screens in this project. Import the screens I choose at 1440px and 390px into
> a section named Hiring review on the current Figma page, using a three-column grid and regular
> editable layers. Check the plugin connection first, then verify the result.

The model should discover exact IDs or folder paths before exporting. Its tools are:

| Tool | Purpose |
| --- | --- |
| `explorer_list_groups` | Find groups and their counts. |
| `explorer_list_folders` | Find exact source-folder scopes and counts. |
| `explorer_list_screens` | Find screen/state IDs, with optional folder, group or kind filters. |
| `explorer_get_counts` | Check the expected screen and screen/width counts. |
| `explorer_figma_status` | Check plugin connectivity, connected file/page, pending work and MCP clients. |
| `explorer_review_interrupted_commands` | Acknowledge specific interrupted commands after inspecting their outcome with native Figma tools. Does not retry, undo or edit content. |
| `explorer_get_prepared_import` | Read exact screens, folders, widths and layer mode from a short import code, even before the plugin connects. Without a code, resolves the loaded or sole prepared selection. |
| `explorer_discover_figma_desktop` | Detect Figma's official localhost MCP and list its tools without controlling the desktop. |
| `explorer_get_screen_design` | Capture one ID and return a design plan; this does not write to Figma. |
| `explorer_export_to_figma` | Capture, build, arrange and verify the selected scope through the plugin. |

An export call uses explicit widths and placement. Replace the sample ID with one returned by discovery:

```json
{
  "ids": ["role-settings"],
  "widths": [1440, 390],
  "createComponents": false,
  "placement": { "mode": "current-page", "container": "Hiring review" },
  "layout": { "mode": "grid", "columns": 3, "gap": 80 }
}
```

Use `folder` or `group` instead of `ids` for a whole scope. Horizontal layout uses
`"layout": { "mode": "horizontal", "gap": 80 }`. `createComponents: false` creates regular editable
layers; omitting it creates reusable components and instances. The final result reports missing or
unexpected screen/width pairs and protected-edit conflicts. A successful connection alone does not
mean an import has succeeded.

## Connection feedback in the plugin

Once the bridge is connected, a line below the plugin description reports MCP presence:

- **MCP: No client connected**: the plugin is connected to Explorer, but no initialized MCP session
  has announced itself to this bridge.
- **MCP connected: [client name]**: a client has completed the MCP handshake. Multiple clients are
  listed together. The name comes from the client; it does not identify or prove which model is running.
- **MCP status unavailable**: presence could not be checked. Update and restart Explorer if the
  bridge predates this feature, or reconnect if the local service is unavailable.

Presence is announced every five seconds, including when the bridge starts after the MCP client.
A normal disconnect removes it; a client that exits unexpectedly disappears after about 15 seconds
without a heartbeat. This connection line is separate from the import progress and final report.
It does not announce an export or grant additional permission to write.

## When something does not work

- **The model cannot see the tools:** check the command and paths, enable the MCP server in its
  client, and reload the tools. UI Explorer cannot register itself in every model client automatically.
- **No plugin connected:** open the plugin in the target file and connect it to the same project's
  bridge. An MCP session and a plugin session are separate connections.
- **MCP is connected but capture fails:** check `--base-url`, the Explorer route and app login.
  Use `--route` for a custom Explorer route or `--storage-state` for an authenticated capture.
- **Build timed out:** inspect the plugin and canvas before retrying. Some content may already have
  been created. Keep the plugin open, check its report and use protected re-imports rather than assuming
  the timed-out batch completed successfully. The default bridge command timeout is five minutes.
- **Connection interrupted:** leave the plugin open while it reconnects. Status exposes the transport,
  command IDs and last execution phases. A brief socket interruption can recover an unacknowledged
  result without rebuilding the screen. Reopening the plugin cannot resume its previous JavaScript run.
- **An interrupted command needs review:** inspect the affected destination using Figma's native
  tools. When no affected command is still running, pass the exact reviewed IDs to
  `explorer_review_interrupted_commands` with `reviewedInFigma: true`. Then decide whether a protected
  re-import is needed. Do not clear this warning just to make a retry possible. The local
  `.ui-explorer/command-ledger.json` retains unresolved write IDs across server restarts.

Automated checks cover the real stdio MCP protocol, app capture, bridge commands and coverage, and
MCP presence in the built plugin UI. Figma rendering tests use a simulated Plugin API. These checks
do not establish that any particular live Figma file or every captured CSS layout will import perfectly.
