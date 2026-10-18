# UI Explorer design import

Once paired, the open plugin listens for imports over an authenticated WebSocket to your local
Explorer bridge. It reconnects automatically after brief interruptions and resends unacknowledged
results without running the design command twice. Import codes choose screens; they do not need to
be pasted before each agent command. Reopen the plugin after a development update to load its new code.

If an import's outcome cannot be confirmed, inspect the canvas before retrying. The bridge preserves
unresolved write IDs across restarts and requires an agent to acknowledge that review. See the
[MCP connection and recovery guide](../docs/mcp-figma.md).

Imports captured screens as editable Figma frames, components, instances, variants, vectors and linked
paint/text styles. Tested in Figma Beta using the desktop and mobile Hiring home screens, with an
identical-plan rerun producing zero writes. See [the build report](../docs/figma-integration-options.md)
for remaining fidelity and library-validation limits.

## Build and install

Run `npm run figma-plugin:build` from the repository root. The build typechecks the sandbox and UI
separately, bundles the main thread to `code.js`, and embeds the UI script inside `ui.html`.
Figma cannot resolve a sibling `ui.js` script from its sandbox, so the panel is self-contained.
The 540 × 820 panel uses Plus Jakarta Sans from Google Fonts, bundled as variable WOFF2 subsets so it
renders offline. Its SIL Open Font License is included in `assets/OFL.txt`.

Figma desktop → Plugins → Development → Import plugin from manifest → choose this folder's
`manifest.json`. The npm package also includes these built files, so installation does not require
building the source repository. Re-run the development plugin after rebuilding it.

## Import a selection from UI Explorer

1. Start your app and open its live UI Explorer.
2. Browse source folders in Explorer and check the screens you want beside their card titles, below
   the thumbnails. **Select visible** includes the current folder/search results; uncheck exceptions
   or use **Clear selection**. Selections persist across folders, search, Gallery/Canvas views and
   reloads in the same browser session. Click **Build in Figma** to review that exact batch and choose
   preset, saved custom, or additional capture widths. The action is also available inside a single
   screen preview.
3. Click **Prepare frames**, then **Copy import code**. If clipboard permission is denied, select the
   code field and copy it manually. Keep Explorer running.
4. Open this plugin. Paste the code into **Import code**. Pasting loads the request automatically;
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
this importer connection; see [connection details](../docs/mcp-figma.md).

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

## Copy a screen

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
   controls are grouped under **Optional settings**. Ordinary canvas
   paste does not invoke this plugin.

## Connect the local bridge

In the running UI Explorer, open the workspace menu (three dots), then **Figma connection**.
Opening this section starts the local bridge automatically. Click **Copy connection URL** and paste
it into the plugin's **Optional settings → Advanced connection**. Keep UI Explorer and the plugin open.
This enables Build from clipboard on hosts that restrict clipboard access, as well as IDE connections.
Import codes connect automatically and do not need this step.

For command-line setups, `web-app-ui-explorer bridge --root <target-app-root>` still prints a connection
URL. Explorer-managed bridges select a free local port automatically.
The relay listens only on loopback and authenticates requests with an ephemeral session token.
Clipboard reads require the connected plugin's authenticated client ID and return only valid Explorer
design exports. Unrelated clipboard text is rejected locally and never returned to the plugin.

Configure the agent's MCP command as `web-app-ui-explorer mcp --root <target-app-root> --base-url <url>`.
Use the same project root as Explorer's bridge. Enable the server in the MCP client and reload its
tools. The plugin shows **MCP connected: [client name]** after the MCP handshake; this is separate from
its bridge connection and from an import running. No additional plugin trigger is required.
See the [MCP setup guide](../docs/mcp-figma.md) for a Windows configuration example and the full tool flow.
The agent lists folders/groups, asks where results belong, and calls `explorer_export_to_figma` with
explicit placement and widths. Components are created in dependency order, frames follow in bounded
messages, and the final response verifies scenario/width coverage. A lost plugin connection aborts the
batch with an error; rerunning the same plan skips unchanged content.

The MCP export tool shares the local panel's pipeline. It also accepts `placement.container` for a
managed section and `layout: { mode: "grid", columns: 3, gap: 80 }` (or `mode: "horizontal"`).

## Components, styles and conflicts

Masters live on `⚙️ UI Explorer Components`. Stable component identities and per-occurrence variant
tags connect captured uses to instances. Repeat imports update existing nodes while preserving frame
IDs and positions. Source changes that conflict with hand-edited geometry, text or appearance are
reported and left untouched. Missing source frames are not deleted automatically.

Known published keys can be supplied through the library mappings field or MCP's `libraries` argument:
`components` maps stable IDs to `{ key, set? }`; `paintStyleKeys` and `textStyleKeys` list published
styles to compare before local fallback. Select a published master/set and register its stable ID to
save a reusable mapping on this machine. Publication and library access are managed in Figma.

Only captured component states can become variants. Cross-file library success paths, automatic
variable binding, semantic prop inference, and complete CSS/Auto Layout conversion have remaining
limits described in the build report. Font substitutions and failed assets are shown in the panel.
