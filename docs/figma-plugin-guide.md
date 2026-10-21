# Figma plugin and MCP guide

This is the full reference for the companion **UI Explorer design import** Figma plugin: installing
it, importing screens by hand (import codes, clipboard), connecting it to an MCP client for
agent-driven imports, and troubleshooting. For the short version, see
[Export screens to Figma](../README.md#export-screens-to-figma) in the main README.

The importer is a screen-import workflow, not a general tool for arbitrary Figma edits or JavaScript
execution. For anything else in Figma — pages, sections, arrangement, annotations, inspection — use
Figma's existing MCP tools or Plugin API connection instead; do not add those operations here. See
[orchestration boundaries](agent-orchestration.md).

## Build and install the plugin

Run `npm run figma-plugin:build` from the repository root. The build typechecks the sandbox and UI
separately, bundles the main thread to `code.js`, and embeds the UI script inside `ui.html` (Figma
cannot resolve a sibling `ui.js` script from its sandbox, so the panel is self-contained). The
540 x 820 panel uses Plus Jakarta Sans from Google Fonts, bundled as variable WOFF2 subsets so it
renders offline; its SIL Open Font License is included in `assets/OFL.txt`.

In Figma desktop: **Plugins -> Development -> Import plugin from manifest**, then choose this
folder's `manifest.json`. The npm package already includes the built files, so installing it does not
require building the source repository. Re-run the development plugin after rebuilding it.

## Import a selection from UI Explorer (import codes)

1. Start your app and open its live UI Explorer.
2. Browse source folders in Explorer and check the screens you want beside their card titles, below
   the thumbnails. **Select visible** includes the current folder/search results; uncheck exceptions
   or use **Clear selection**. Selections persist across folders, search, Gallery/Canvas views and
   reloads in the same browser session. Click **Build in Figma** to review that exact batch and choose
   preset, saved custom, or additional capture widths. The action is also available inside a single
   screen preview.
3. Click **Prepare frames**, then **Copy import code**. If clipboard permission is denied, select the
   code field and copy it manually. Keep Explorer running.
4. Open the plugin. Paste the code into **Import code**. Pasting loads the request automatically;
   typing a code can be followed by **Load import** or Enter. Loading does not write to the canvas.
5. Review the project/count/width summary. Choose the destination, name the import section, and select
   **Grid** or **Horizontal row**. Grid columns and spacing are configurable. Click **Import screens**.

Explorer starts a loopback bridge automatically when the first request is prepared, on an available
port. No separate terminal command, connection URL or design JSON is needed for this flow. Selection
and capture settings belong to Explorer; the plugin never fetches a full project catalog. Change
screens or widths by preparing another code in Explorer. Manual connection remains under **Advanced
connection** for clipboard and IDE workflows.

After the first successful pairing, reopening the plugin reconnects automatically and shows the
current Figma file and page. Disconnecting forgets that pairing. An MCP agent can read a prepared
selection directly with `explorer_get_prepared_import`; you do not need to paste its code into an
already paired plugin for an agent-driven import. Figma's desktop MCP discovery is separate from
this importer connection (see below).

Each code identifies a prepared request with explicit IDs, saved scenario definitions and deduplicated
widths. Imports use that saved selection even if a caller supplies different IDs or widths. Source
code and assets are captured when the import runs. Codes expire after one hour or when Explorer
restarts. The same unexpired code supports re-imports. Requests remain in memory, bounded to 100 per
session. Static snapshots cannot prepare a local import.

After updating a locally linked package, restart the app's existing dev-server process and then
refresh Explorer. Refreshing only the browser can load a new interface while the server still has an
older API in memory. Explorer detects this mismatch and explains the restart requirement before
enabling preparation. A missing endpoint or plain-text error is reported without JSON parser details.

Current open page is the default destination; page/section names appear only when required. Layout
is shown for multiple frames, columns only for grids, and spacing/library mappings remain collapsed.
The target page is pinned at run start. Named sections and frame identities are reused on re-import;
manual edits and moved frames are protected and reported. Coverage reports missing and unexpected
scenario/width pairs without deleting old frames. Use separate section names for independent scopes.

Progress covers capture, components, frames and verification. **Cancel import** stops capture or stops
at the next acknowledged frame; already-created content stays on the canvas. Polling retries transient
connection failures. Only one export runs on a bridge at a time. MCP and clipboard imports remain
available and share the existing capture/build/verification pipeline.

### Copy a screen (clipboard, no import code)

In Explorer's **Copy** menu or **Build in Figma** configuration, **Create components** is enabled by
default. Turn it off for regular editable layers with no component masters, variant sets, or instances.
Import codes retain this choice, and the plugin shows it in the prepared-import summary. Re-importing
with a different choice updates unedited frames in place; existing component masters remain untouched.

1. Open a screen in the local Explorer and click Copy.
2. Check the desired preset and custom widths. Saved custom sizes also appear in the preview picker.
3. Click Copy selected, switch to Figma, and run this plugin.
4. Switch to **Clipboard**. Choose the destination: current open page, a named page, an existing section, or one page per folder.
5. In **Import a copied screen**, click **Build from clipboard**. If the Figma host does not expose the browser Clipboard API, connect
   the local bridge once using the instructions below, then click the same button again. The bridge
   reads the Windows/macOS/Linux clipboard on demand; no manual paste gesture is needed.
6. Alternatively, expand **Paste copied design manually** below the divider, paste the export, and click
   **Build pasted export**. Both methods use the destination above. Library mappings and connection
   controls are grouped under **Optional settings**. Ordinary canvas paste does not invoke this plugin.

### Connect the local bridge manually

In the running UI Explorer, open the workspace menu (three dots), then **Figma connection**.
Opening this section starts the local bridge automatically. Click **Copy connection URL** and paste
it into the plugin's **Optional settings -> Advanced connection**. Keep UI Explorer and the plugin open.
This enables Build from clipboard on hosts that restrict clipboard access, as well as IDE connections.
Import codes connect automatically and do not need this step.

For command-line setups, `web-app-ui-explorer bridge --root <target-app-root>` still prints a connection
URL. Explorer-managed bridges select a free local port automatically. The relay listens only on
loopback and authenticates requests with an ephemeral session token. Clipboard reads require the
connected plugin's authenticated client ID and return only valid Explorer design exports. Unrelated
clipboard text is rejected locally and never returned to the plugin.

## Components, styles and conflicts

Masters live on `UI Explorer Components`. Stable component identities and per-occurrence variant tags
connect captured uses to instances. Repeat imports update existing nodes while preserving frame IDs
and positions. Source changes that conflict with hand-edited geometry, text or appearance are reported
and left untouched. Missing source frames are not deleted automatically.

Known published keys can be supplied through the library mappings field or MCP's `libraries` argument:
`components` maps stable IDs to `{ key, set? }`; `paintStyleKeys` and `textStyleKeys` list published
styles to compare before local fallback. Select a published master/set and register its stable ID to
save a reusable mapping on this machine. Publication and library access are managed in Figma.

Only captured component states can become variants. Cross-file library success paths, automatic
variable binding, semantic prop inference, and complete CSS/Auto Layout conversion remain limited.
Font substitutions and failed assets are shown in the panel.

## Connect an MCP client for agent-driven imports

An MCP client can discover registered screens and states, capture them at chosen widths, and ask the
plugin to create editable content in Figma without a person pasting an import code. The connection
has three parts:

```text
Your model's MCP client -> UI Explorer MCP server -> local bridge -> open Figma plugin
```

The MCP client launches the server over standard input/output (stdio). The bridge passes import
commands to the plugin, which writes the captured designs and returns results. The model does not
need the bridge token. Design import alone does not need a separate Figma MCP connection; tasks
involving other Figma operations need Figma's existing tools and access to the target file too.

`web-app-ui-explorer init` adds a short link to the tool guide in a marked section of the consuming
project's `AGENTS.md`, preserving its other instructions. Existing installations can run
`web-app-ui-explorer agents --root <app-root>` to add or update only that section. The package also
sends the full tool guide in its MCP initialization response, so connected clients receive the
boundaries without relying only on local files. Installing the npm dependency by itself does not
modify the project's instructions; run one of these setup commands.

### 1. Connect the plugin to your project

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

`explorer_figma_status` with `discoverDesktop: true` probes Figma's official local MCP at
`http://127.0.0.1:3845/mcp`. It detects an enabled server, not an arbitrary running desktop process.
According to [Figma's desktop MCP documentation](https://developers.figma.com/docs/figma-mcp-server/local-server-installation/),
that server requires enabling in Figma and does not write to the canvas. It cannot replace opening
and initially pairing the importer. Native file operations still use Figma's tools. Initial pairing
uses an import code or manual bridge URL in both desktop and web; public Plugin APIs do not provide
an external launch-and-pair mechanism. Never expose bridge credentials through an unauthenticated
discovery endpoint or control the person's UI to bypass this step.

### 2. Add UI Explorer to the model's MCP client

Install the npm package in this app's devDependencies, then run **one** of these from the app root:

```sh
npx ui-explorer mcp install --client vscode --base-url http://localhost:8443
npx ui-explorer mcp install --client codex --base-url http://localhost:8443
```

Choose your client. The command writes only `.vscode/mcp.json` or `.codex/config.toml` in this app,
plus the managed guidance section in `AGENTS.md`. It preserves unrelated servers and comments;
malformed files and conflicting entries fail without overwriting the configuration. Repeating the
same setup is idempotent. VS Code configuration uses `${workspaceFolder}` for portable paths. Codex
configuration uses explicit absolute paths; rerun installation after moving/cloning the app or
changing the Node installation. Custom settings inside its managed block require manual review.
An existing VS Code entry with different settings must be reviewed and removed before reinstalling.

Use the reachable URL of the app **serving Explorer**, which may be the standalone proxy rather than
the original app URL. Pass `--route /custom/explorer` for a custom route. Omit `--base-url` for saved
catalog discovery only: this does not include live-only manual registrations or allow capture.
Restart the client after installation; approve/trust the project using that client's normal setup.
Keep the CLI, running Explorer and companion plugin up to date together.

#### Project scope is required

Do not install this MCP server in user/global configuration or reuse one pointed at another app.
The installer has no global mode and requires a locally installed dependency. In a monorepo, run
setup with the app package as `--root`, and open that app as the client's workspace folder. The
server's working directory must equal `--root`; launching it from another directory fails. When
the client supplies MCP workspace roots, each call checks that they contain this app, including
after workspace changes. Every live catalog fetch checks the serving checkout's identity before
capture/export, including per-call URL overrides. Figma operations check this project's bridge
metadata; a prepared import code cannot redirect an MCP session to another project's bridge.

Workspace roots are client-supplied context, not authentication. Clients which do not advertise
roots cannot reliably reveal an active-editor mismatch. Always call `explorer_catalog` first and
compare `project.root` with the intended app directory. These safeguards prevent accidental routing;
they are not an OS sandbox or protection against a malicious client or edited local files. If a
client cannot load project-local MCP configuration, report the limitation instead of installing a
shared global fallback. Remove any old global Explorer entry in that client's settings yourself;
the installer does not read or alter user configuration.

For a client requiring manual setup, here is a project-local VS Code `.vscode/mcp.json` example:

```json
{
  "servers": {
    "ui-explorer": {
      "type": "stdio",
      "command": "node",
      "cwd": "${workspaceFolder}",
      "args": [
        "${workspaceFolder}/node_modules/@danielfransix/web-app-ui-explorer/dist/node/cli.js",
        "mcp",
        "--root", "${workspaceFolder}",
        "--base-url", "http://localhost:8443"
      ]
    }
  }
}
```

For project-local Codex `.codex/config.toml`, use absolute paths appropriate to your machine:

```toml
[mcp_servers.ui-explorer]
command = "node"
cwd = "C:/projects/my-app"
args = ["C:/projects/my-app/node_modules/@danielfransix/web-app-ui-explorer/dist/node/cli.js", "mcp", "--root", "C:/projects/my-app", "--base-url", "http://localhost:8443"]
```

Project MCP configuration and `cwd` follow the official
[Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp) and
[VS Code configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).
Enable the server, reload its tools or restart the client. No special trigger phrase is required.
For local package development, build this repository and launch its CLI from the target app's working
directory with that same `--root`; the installation command intentionally requires an app-local dependency.

Discovery can read a saved scenario catalog without a running app. Captures and imports require the
app; supplying `--base-url` also discovers its live registered states. Authentication for captures can
be supplied with `--storage-state <file>`. Requests that change app data are blocked unless
`--allow-writes` is explicitly enabled; this setting is separate from creating content in Figma.

### 3. Ask the model to import screens

For example:

> List the registered screens in this project. Import the screens I choose at 1440px and 390px into
> a section named Hiring review on the current Figma page, using a three-column grid and regular
> editable layers. Check the plugin connection first, then verify the result.

The model should discover exact IDs or folder paths before exporting. Its tools are:

| Tool | Purpose |
| --- | --- |
| `explorer_catalog` | Project identity/root, search, paginated screens/groups/folders and exact counts. |
| `explorer_inspect_screen` | Resolve an exact generated UUID/reference or internal key; source, safe action summaries, incoming/outgoing connections and evidence. No replay or capture. |
| `explorer_figma_status` | Plugin connectivity, file/page, pending work, MCP clients; optional `discoverDesktop: true` checks native desktop MCP availability. |
| `explorer_review_interrupted_commands` | Acknowledge specific interrupted commands after inspecting their outcome with native Figma tools. Does not retry, undo or edit content. |
| `explorer_get_prepared_import` | Read exact screens, folders, widths and layer mode from a short import code, even before the plugin connects. Without a code, resolves the loaded or sole prepared selection. |
| `explorer_get_screen_design` | Capture one `screenId`, `reference` or internal `id` at specified widths. Does not write to Figma. |
| `explorer_export_to_figma` | Capture, build, arrange and verify the selected scope through the plugin. |

#### Catalog queries and pagination

Call `explorer_catalog` with `{}` for the first 50 screens, or use `view: "groups"`, `"folders"` or
`"summary"`. Optional `search` matches generated UUID, internal ID, title, group or source. `folder`
matches a source folder and descendants with an exact path boundary. `group` is exact. `kind` is
optional; omitting it includes screens, navigation, overlays and variants. A missing kind means screen.

Set `limit` from 1 to 100. Repeat the **same query** with `cursor: nextCursor` until it returns null.
Changing the query or catalog invalidates the cursor; restart listing rather than skipping results.
`total` and `byKind` cover all matching screens. `totalItems` counts entries for the chosen view.
When supplying `widths` (1-12 values, each 1-7680px), `expectedFrames` covers the whole matching scope;
`expected` is returned for the current screens page only. Aggregate every page's exact pairs before
checking a complete batch. Width duplicates are counted once. Summary views do not return pairs.
Discovery/inspection return no replay selectors or filled values. Live records include `revision`
and `generatedAt` when available; these are metadata, not a successful rendering check.

#### Screen IDs and references

Expand a screen in Gallery or Canvas and choose **Copy screen ID** in its preview toolbar. The same
control exists in full-screen preview. Paste the UUID into your question, for example:

> Explain what leads to screen `a7d43ec1-b6cf-4c9b-8576-adb52744bb82`.

The agent calls `explorer_inspect_screen` with `{"screenId":"a7d43ec1-b6cf-4c9b-8576-adb52744bb82"}`.
The tool resolves it exactly. Even screens with the same name and source file have different UUIDs.
If clipboard access is denied, a selected text field lets you copy the UUID manually.

Explorer generates UUID v4 identifiers, independently of source syntax, framework, titles and folders,
and stores them in **`ui-explorer.ids.json` at the app root**. Commit this file; teammates and future
clones then use the same UUIDs. Do not put it in `.ui-explorer/`, regenerate it on every run, or ignore
it with the disposable capture cache. The registry contains hashed crawler anchors/internal keys
and IDs, with no replay recipes or bridge credentials. Atomic writes and a short cross-process lock
prevent concurrent Explorer/MCP instances from losing assignments. A corrupt registry is reported,
never silently replaced. Source/package updates preserve the registry.

Registered screens retain UUIDs while their internal keys remain stable, regardless of title, folder
or order changes. Set a unique `identityKey` on a registered scenario to preserve its identity while
renaming the internal key. Declare it at first discovery, or add it while keeping the old internal
key, let Explorer save the registry, then rename the internal key. Crawled states use hashed replay
recipes and start paths, so a renamed or reused title slug does not give one state another's UUID.
Recipe changes can create a new identity; Explorer does not guess by visual similarity. Identical
legacy recipes remain distinct by internal key, and duplicate explicit `identityKey` values fail.
Retired IDs are reserved rather than recycled. Resolve identity-file merge conflicts by preserving
established assignments and checking UUID uniqueness; do not generate new IDs for the entire project.

Catalog records contain `screenId` (generated UUID), `id` (internal scenario key) and a full
`reference`, formatted `uix-screen:v1:<project-UUID>:<screen-UUID>`. Both the bare UUID and reference
are accepted by inspection/capture, using `screenId` or `reference` respectively. A foreign project
reference is rejected; unknown/retired bare IDs fail instead of selecting a similarly named screen.
The persistent project UUID travels with the registry. It is distinct from `project.id`, the local
checkout identity used to verify the running app URL and bridge. Moving/cloning changes that routing
identity while retaining the generated screen UUIDs when the registry is copied.
Generated UUIDs are additive: existing scenario keys, replay endpoints and Figma import matching
remain compatible, so assigning UUIDs does not create duplicate Figma frames for existing imports.

#### Export example

An export call uses explicit widths and placement. Replace the sample UUID with one returned by discovery:

```json
{
  "screenIds": ["a7d43ec1-b6cf-4c9b-8576-adb52744bb82"],
  "widths": [1440, 390],
  "createComponents": false,
  "placement": { "mode": "current-page", "container": "Hiring review" },
  "layout": { "mode": "grid", "columns": 3, "gap": 80 }
}
```

Use exactly one of `screenIds`, `references` or legacy internal `ids`; folder/group filters may narrow
that selection, and every requested ID must exist in the narrowed scope. Use `folder` or `group`
alone for a whole scope. Horizontal layout uses `"layout": { "mode": "horizontal", "gap": 80 }`.
`createComponents: false` creates regular editable layers; omitting it creates reusable components
and instances. The final result reports missing or unexpected screen/width pairs and protected-edit
conflicts. A successful connection alone does not mean an import has succeeded.

#### Migrating older MCP configurations

The MCP surface contains exactly seven tools. Four overlapping discovery tools were consolidated and
desktop discovery became an option on status. Update clients/automation using this mapping:

| Old tool | Current call |
| --- | --- |
| `explorer_list_screens` | `explorer_catalog` (`view: "screens"`, follow pagination) |
| `explorer_list_groups` | `explorer_catalog` (`view: "groups"`) |
| `explorer_list_folders` | `explorer_catalog` (`view: "folders"`) |
| `explorer_get_counts` | `explorer_catalog` (`view: "summary"`, optional widths) |
| `explorer_discover_figma_desktop` | `explorer_figma_status` (`discoverDesktop: true`) |

The old tools and their compatibility flag have been removed. There is no alternate MCP tool set:
only the seven tools above are registered. Update automation using the mapping above, remove the
old flag from launch arguments, and refresh the client's tool list. Unsupported MCP options fail
with an error rather than silently enabling a different configuration. Existing capture/export
calls with internal IDs remain supported. Set the client `cwd` explicitly, move old global entries into
project configuration, update the package, restart the running Explorer/bridge, and refresh the
managed AGENTS section with `npx ui-explorer agents` (or rerun project MCP installation).

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
- **Project scope or identity mismatch:** open the correct app folder, rerun project-local setup and
  check the returned catalog root. Update/restart Explorer and its bridge if either has no identity;
  never disable the checks to reuse another project's server. A moved checkout needs fresh local
  launch paths but retains UUIDs through its committed identity registry.
- **A copied ID cannot be found:** confirm the registry is present and the intended project is active.
  Saved-only discovery may lack live registered screens. Removed screens are not substituted by name.
- **The ID registry is invalid/busy:** restore corrupt JSON from version control, or wait for the
  other process to finish. A crashed process can leave `ui-explorer.ids.json.lock`; remove that lock
  directory only after confirming no Explorer/MCP process is assigning IDs. Keep the registry file.
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
