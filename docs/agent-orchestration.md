# UI Explorer and Figma orchestration

Use the right tool for each part of a task. UI Explorer's companion plugin is an importer, not a
replacement for Figma's existing tools. Do not expand it just because a multi-step task needs another
Figma operation.

## Responsibilities

- **UI Explorer and its MCP tools:** discover registered source screens and states, identify exact
  folders and IDs, check counts, and capture editable design plans at the requested widths.
- **The companion importer plugin:** write those captured designs into Figma as editable layers,
  components and styles. Target the agreed destination and preserve existing edit protections.
- **Figma's native MCP tools or existing Plugin API connection:** inspect the file, create pages and
  sections, move and arrange frames, add native annotations, read results and inspect rendered output.
- **The orchestrating agent:** combine these existing tools in the right order and verify the whole
  result. A missing operation in the importer is not a reason to build it there.

## Working through a task

### Project-local MCP and exact screen IDs

Install the npm package in the app's devDependencies, then run one of these **inside that app**:

```sh
npx ui-explorer mcp install --client vscode --base-url http://localhost:8443
npx ui-explorer mcp install --client codex --base-url http://localhost:8443
```

Choose the client you use. Setup writes `.vscode/mcp.json` or `.codex/config.toml` in this project,
preserving other servers. There is no global installation. Restart the client; Codex project config
must be trusted. Use this project's installed package, working directory and Explorer URL. In a
monorepo, install in the app package and set its root explicitly. Never reuse a global MCP server
pointed at another app. If the client cannot load project configuration, report that limitation;
do not work around it by pointing a shared global server at this project.

Call `explorer_catalog` first and compare `project.root` to the active app directory. It replaces
the old list-groups/list-folders/list-screens/counts tools with `view: screens|groups|folders|summary`,
optional folder/group/kind/search filters, and pagination (`limit`, then `nextCursor` as `cursor`
with unchanged filters). All kinds are included unless filtered. Counts cover the entire filter;
when widths are requested, `expected` contains only that screen page's exact pairs. Read every page
before claiming complete coverage. `project.catalog` distinguishes live data from a saved catalog.
Without a base URL, live-only registered screens are unavailable. Do not claim that saved discovery
proves the app is reachable or that a screen can render.

Explorer generates random UUIDs for screens in `ui-explorer.ids.json`. Commit this file to share
stable IDs across clones. It contains no replay recipes or credentials. Never regenerate it just
to resolve an error. Internal scenario keys, titles and folders are not generated screen IDs.
When the person supplies a copied UUID, call `explorer_inspect_screen` with `screenId`. Its output
includes the internal `id`, generated `screenId`, source and connection evidence. A full `reference`
from the catalog is also accepted. Never choose by title when an exact ID was supplied. If the ID
is missing, stale or from another project, explain that and refresh discovery; do not substitute a
similarly named screen. Captures accept `screenId`/`reference`; exports accept `screenIds`/`references`
as alternatives to internal `ids`. Keep the person's exact selection.

Generated UUIDs are independent of names, folders, framework and source syntax. Registered screens
retain their UUID while their scenario key stays stable; integrations can declare a unique stable
`identityKey` when changing that key. Crawled screens use replay-recipe anchors so reordered title
slugs cannot silently inherit another state's UUID. A changed recipe can produce a new UUID. Do not
infer identity from visual similarity. Removed IDs stay reserved and are never recycled.

The server rejects a working directory different from `--root`, checks client workspace roots when
available, and verifies live Explorer and bridge checkout identities. Clients without workspace-root
support cannot reveal an active-editor mismatch reliably; the agent must still compare the returned
root. These checks prevent accidental cross-project routing, not malicious clients or filesystem
access outside an OS sandbox. See the package's `docs/figma-plugin-guide.md` for configuration and migration.

### Import workflow

1. Confirm the source selection, capture widths, output mode and target Figma file. Use Explorer's
   catalog for source facts and Figma's native tools for file facts. A connected bridge alone does
   not identify the target file to the native MCP tools.
2. Use Figma's existing tools to prepare the requested pages and sections. Keep the returned node IDs.
3. Use the importer to write only the agreed source designs into those destinations. Its existing
   placement and layout options remain supported, but do not add duplicate Figma capabilities to it.
4. Use Figma's existing tools for the remaining work, such as horizontal arrangement, native
   annotations and inspection. Keep annotations brief and based on the source screen's purpose.
5. Verify selection coverage, destination, ordering, layout and annotations with the appropriate
   tools. Report any incomplete step accurately; a successful import is not proof that the whole task
   is finished.

## When information or tools are missing

- Ask for a missing file link, folder name or selection instead of guessing. Do not broaden the
  import beyond what the person selected.
- A short import code is a temporary credential. Read its frozen selection with
  `explorer_get_prepared_import`, including widths, layer mode and source folders. Do not ask the
  person to retype details already carried by the prepared import. Do not repeat tokens or codes
  in output or logs. An expired code requires a newly prepared selection.
- Check `explorer_figma_status` for the connected importer's file and page before writing. Use
  `explorer_figma_status` with `discoverDesktop: true` to detect Figma's official local MCP when useful, then use native
  Figma tools for file operations. Desktop MCP availability alone does not mean the importer is open
  or paired. Never silently choose a different file or local project.
- The paired plugin keeps an authenticated WebSocket connection to the local bridge. Commands
  arrive automatically while it is open; an import code identifies a source selection, not a trigger
  that must be pasted before each agent action. Reconnecting never repeats a delivered command.
- If status reports `needsReview`, inspect the affected destination with native Figma tools before
  retrying. The command may have finished even if its response was lost. Wait for any command still
  running, then call `explorer_review_interrupted_commands` with the inspected command IDs only.
  This acknowledges the review; it does not undo content or rerun the import.
- If a native Figma operation is unavailable, explain the missing connection or access and use an
  existing supported tool where possible. Do not silently substitute another file, a different kind
  of annotation, a flattened image, or an expanded custom bridge.
- Do not take over the person's desktop. Ask them to perform any required plugin or editor UI step.

These boundaries apply to maintenance as well as execution. Keep source discovery in Explorer,
design import in the companion plugin, and general Figma operations in Figma's existing tooling.
