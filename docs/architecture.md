# How UI Explorer and its Figma plugin actually work

This is a plain-language tour of the machinery behind the package: what each piece does, how a
request or a design actually travels through the system, and why some things are built the way
they are. It assumes no prior knowledge of this codebase. For how to *use* the tool, see
[README.md](../README.md); for how to use the Figma side, see
[the Figma plugin and MCP guide](figma-plugin-guide.md).

The code lives in four folders plus the separate plugin:

```
src/runtime   code that runs INSIDE the app being explored, in the browser
src/node      code that runs on your machine: the proxy, the crawler, the CLI, the MCP server
src/client    the Explorer's own web page (the gallery/canvas you look at)
src/shared    small, framework-free helpers both Node and the browser can use
figma-plugin  the separate Figma plugin, which is its own little program running inside Figma
```

Think of the whole system as three separate programs that talk to each other over plain HTTP,
WebSockets and `postMessage`: **your app's dev server**, **the Explorer** (a small Node process
sitting in front of it), and **the Figma plugin** (running inside Figma, reachable through a small
relay the Explorer starts on demand). None of the three trusts the others blindly — each checks who
it is talking to before doing anything that matters.

## 1. The proxy: how Explorer sits in front of any dev server

`web-app-ui-explorer serve` ([src/node/serve.ts](../src/node/serve.ts)) is an ordinary Node HTTP
server. It does three things to every request that comes in:

1. **Is this request for the Explorer itself** (anything under `/__explorer/`)? If so, it answers
   the request itself and never touches your app. This is handled by `createExplorer()` in
   [src/node/core/explorer.ts](../src/node/core/explorer.ts) — see section 3.
2. **Otherwise, forward it to your real dev server** (`target`), byte for byte, including
   WebSockets (so hot-reload keeps working). The upstream server is told it *is* the origin — its
   `Host` header, and any `Origin`/`Referer` headers that pointed at the proxy, are rewritten to
   look like they came from itself. Response cookies and redirects are rewritten the same way in
   reverse, so your app never notices there's a proxy in between.
3. **If the response is an HTML page**, inject one `<script>` tag before sending it to the
   browser. That's the entire "integration": nothing about your bundler, framework or build
   process is touched. The tag points at `/__explorer/runtime.js`, a self-contained script built
   from [src/runtime/index.ts](../src/runtime/index.ts) (see section 4).

Two safety rules apply regardless of what you're doing:

- **Host checking.** If Explorer is bound to loopback only (the default), it refuses any request
  whose `Host` header isn't `localhost`/`127.0.0.1`/an explicitly allowed name. This stops a
  malicious web page from using your browser as a stepping stone to reach the proxy (a
  "DNS rebinding" attack).
- **Cross-site write checking.** A request that changes something (`POST`/`PUT`/`PATCH`/`DELETE`)
  is checked against `Origin`/`Sec-Fetch-Site`; a request that didn't originate from this same
  page is rejected before it can start a crawl or anything else.

The Vite plugin ([src/node/vite.ts](../src/node/vite.ts)) does the same job without a separate
process: it hooks into Vite's own dev server middleware instead of running its own HTTP server, so
Explorer lives on your app's own origin with nothing extra to start.

## 2. The runtime script: what actually runs inside your app

[src/runtime/index.ts](../src/runtime/index.ts) is bundled to a single `runtime.js` and is the
*only* code that ever touches the DOM of the app being explored. It has four jobs:

- **Draw the floating launcher button** and listen for the keyboard shortcuts.
- **List "what a person could act on right now"**: buttons, links, tabs, switches, radios,
  dropdowns, anything with a click handler — while excluding anything hidden behind an open
  dialog. This list is what the crawler (section 5) asks for at every step.
- **Replay a recipe**: given an ordered list of actions (click this, type that, choose this
  option), perform them one at a time and report what changed. [src/runtime/replay.ts](../src/runtime/replay.ts)
  is the part of this that survives a full page navigation — see the box below.
- **Capture the visual design** of the current page for the Figma pipeline: walk the live DOM,
  read each element's computed style, and produce a tree of plain-data `DesignNode` objects
  (geometry, fills, strokes, text, SVG, components) — this is what gets turned into Figma frames
  later. This is the single biggest and most detail-sensitive file in the project, because CSS has
  a lot of edge cases: zero-height scroll containers, `display: contents`, oklch colors Figma
  can't represent directly, one-sided borders, `font-size: 0` hacks, absolutely-positioned children
  of zero-height parents, and so on. Each of those has a comment next to the code that handles it
  and a matching case in [test/design-capture.test.mjs](../test/design-capture.test.mjs).

> **Why a separate replay job system?** Early on, a recipe that ended in an ordinary link
> (not a single-page-app route change) would destroy the page before its own "did this work?"
> check could run — the browser had already moved on. `replay.ts` solves this by giving every
> replay an identity and letting it save a short "I was in the middle of this" note in
> `sessionStorage` right before the page unloads. The *next* document checks for that note when it
> loads and picks the recipe back up. This is why crawling, previews, thumbnails and Figma capture
> all survive ordinary page loads, redirects, and client-side route changes the same way.

## 3. The Explorer core: one request handler, two hosts

[src/node/core/explorer.ts](../src/node/core/explorer.ts)'s `createExplorer()` is the actual
Explorer — a bundler-agnostic Node request handler plus a handful of lifecycle hooks. Both
`serve.ts` and `vite.ts` are thin wrappers around the exact same object, which is why every feature
behaves identically whether you use the standalone proxy or the Vite plugin. A host only has to:
put the runtime tag into HTML, route requests under the Explorer's path to `handle()`, call
`invalidate()` when a source file changes, and (for production builds) write `snapshotFiles()`
into the build output.

Inside, it keeps:

- **Two lists of scenarios**: scenarios *you wrote by hand* in `ui-explorer.config.mjs`, and
  scenarios the *crawler discovered* on its own (read from `.ui-explorer/scenarios.json`). The
  `mode` option (`merge`/`auto`/`manual`) decides which of the two the gallery actually shows.
- **Two background jobs** (`crawl` and `capture`), each with a status, a progress object, and an
  `AbortController` so the UI's Stop button actually stops the browser work, not just the HTTP
  request.
- **A live event feed**: `/api/events` is a Server-Sent-Events stream. Every job update, log line
  and "something changed, re-fetch state" ping goes out over this one connection, which is why the
  gallery updates live without polling.
- **A rolling, server-side log** (`recordLog`), so what the crawler/capture/login flow actually did
  is visible from the Explorer UI itself (the Logs panel), not just from whatever terminal happens
  to be running `serve`.
- **File-watching driven invalidation**: editing a source file recomputes a content hash
  (`revision`). Thumbnails are tagged with the revision they were captured at, so an edited screen's
  picture is dropped rather than silently shown as current.

### Logging in to apps behind authentication

Three different paths all end up writing the same kind of file — a Playwright
[`storageState`](https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state)
(cookies + localStorage) — and handing it to the crawler:

1. **You already have one.** Set `storageState` in the config; Explorer just loads it.
2. **You log in yourself, in your own browser tab**, using Explorer's in-page "Log in" flow. No
   browser is spawned for this — the person's own authenticated cookies are read straight from that
   request (`saveSession` → [src/node/session-capture.ts](../src/node/session-capture.ts) rebuilds
   a storage-state object from them) and saved to `.ui-explorer/auth.json`.
3. **Explorer logs in for you**, headlessly by default. You type credentials into Explorer's own
   UI; they are held only in server memory (never written to disk, never logged) and handed to
   [src/node/auto-login.ts](../src/node/auto-login.ts), which opens a real Playwright browser,
   uses generic heuristics to find a username/password field and a submit control, and submits the
   form. Crucially, **the crawl that follows reuses that exact same open browser context** — there
   is no "export the session, then re-import it somewhere else" step, so nothing can go stale
   between logging in and exploring. A visible-browser mode is available for watching this happen
   or nudging through a step the heuristics can't reach on their own; concurrency drops to 1 in
   that mode, because headed and headless are a launch-time choice for a whole browser process and
   can't be mixed, so a watchable run means exactly one tab.

[src/node/login-check.ts](../src/node/login-check.ts) snapshots a page's title/password-field state
once before an attempt and once after, purely so the Logs panel can say "this looks like it worked"
or "this looks unchanged" — it's a courtesy message, not a gate on whether exploring proceeds.

### Serving the client, and shipping a read-only copy

Everything under the Explorer's route that isn't an API call serves the pre-built React app from
`dist/client` (see section 7). `snapshotFiles()` produces the same thing as a set of static files —
HTML, the runtime script, one JSON file per scenario, and any thumbnails on disk — so
`web-app-ui-explorer snapshot` can drop a fully working, read-only Explorer into a production build
with no server behind it at all (Explore/Capture are hidden there, since there's no job runner to
drive them).

## 4. The crawler: how states are actually discovered

[src/node/crawl.ts](../src/node/crawl.ts) runs a breadth-first search over the app's interactive
surface, using several concurrent Playwright pages:

1. Load the app fresh, at `startPath`.
2. Ask the runtime script for the list of things a person could act on right now.
3. For each one: **start over from a clean page load**, replay every action that got you *here* so
   far (the "recipe"), then perform this one new action, and look at what happened.
4. Turn what's now on screen into a **fingerprint** — headings, open dialogs, selected values,
   visible text — and keep this new state only if that fingerprint hasn't been seen before.
5. Repeat for the newly discovered state's own candidate actions, breadth-first, until there's
   nothing new to try, `maxStates` is hit, or the time budget runs out.

Starting every recipe from a clean load (rather than, say, clicking "back") is what makes a
discovered state reliably reproducible later by a preview, a thumbnail or a Figma capture — it's
always the same deterministic sequence of actions from the same starting point.

A few deliberate design choices, each the result of a real failure found during testing:

- **Forms get believable values and a first choice in empty dropdowns/radio groups**, so a flow
  that needs valid input before it will continue doesn't just dead-end at "please fill this in."
- **Data-changing requests are blocked by default** (`blockWrites`): POST/PUT/PATCH/DELETE made by
  the page during exploration or capture get an empty success response, and never reach your real
  server. This is why it's safe to crawl an app that "Delete" buttons live in.
- **Concurrent workers used to each log in independently** when sharing one session — a real bug,
  because most login systems issue a *single-use* refresh token, and five workers racing to use it
  simultaneously meant four of them failed. The fix was giving every worker a reference to the
  *same* browser context rather than cloning the session file per worker.
- **A link that causes a full page navigation** is followed and continued (see the replay-job box
  in section 2); a link to another origin, a download, or a new tab/window is a hard boundary —
  the crawl does not follow it.
- **Closing a form with unsaved changes is tried too**, specifically because that usually triggers
  a confirmation dialog, which is itself an interesting discoverable state.

The result is written to `.ui-explorer/scenarios.json`: every scenario's recipe, its fingerprint,
and (via [src/node/sources.ts](../src/node/sources.ts)'s `guessSources`) a best-effort guess at
which source file renders it, by matching captured headings/labels against your source tree.

## 5. Turning a scenario into pixels: capture vs. design-capture

These are two different jobs that both "render a scenario and look at it," for two different
purposes:

- **[src/node/capture.ts](../src/node/capture.ts)** replays a scenario's recipe and takes an
  ordinary screenshot — this is what makes the small thumbnail picture on a gallery card. Cheap,
  and keyed to the source revision so a stale picture is dropped rather than shown as current.
- **[src/node/design-capture.ts](../src/node/design-capture.ts)** replays the *same* recipe but
  asks the runtime's design-tree walker (section 2) for a full structured description of the page
  instead of a flat image — every box's geometry, fill, stroke, text, and which React/Vue/etc.
  component (if any) rendered it. This is the raw material the Figma pipeline turns into real,
  editable frames rather than a picture of frames.

Both run at one or more pixel widths (`replayViewport` lets a discovered recipe remember which
viewport it needs — a mobile nav link hidden by desktop CSS, for instance — so a later preview or
capture resizes to that width *before* replaying it, not after).

## 6. From a design tree to a Figma plan: the pure half

[src/shared/plan.ts](../src/shared/plan.ts)'s `buildPlan()` takes a batch of `DesignCapture`s
(design trees + which screen/width each one is) and decides, with no Figma API involved at all
(which is why it's unit-testable on its own), what Figma needs to end up with:

- Every node the design-tree walker tagged as a **component occurrence** (because the runtime
  recognised, say, a React component boundary) is grouped by that component's stable ID.
- Within one component, occurrences whose *shape* and *appearance* are identical become one
  **variant**; occurrences that only differ in their text become **instances with text overrides**
  of that same variant, rather than separate variants. (Two buttons that only differ by their label
  are the same component variant with different button text — not two unrelated variants.)
- Dependencies are ordered first (`orderComponents`): a component that contains another component
  must be built after its dependency exists, in both the local plan and inside the plugin.

The result (`ExportPlan`) is plain, serialisable JSON — it is sent to the Figma plugin exactly as
produced here, over the bridge described next.

## 7. The bridge: how a local Node process talks to a Figma plugin

A Figma plugin's sandbox cannot make outbound network connections on its own initiative the way a
normal web page can, and it has no idea your dev server or Explorer exist. The bridge
([src/node/bridge.ts](../src/node/bridge.ts)) is the thing that makes the connection possible, and
its rules exist because of two hard constraints: **only the plugin's own UI thread can decide when
it's ready to receive a message**, and **a Figma write (creating/updating frames) can be slow
enough that a flaky connection must never silently double it**.

- It's a tiny local HTTP + WebSocket server, started on demand on the first loopback port that's
  free (remembered across restarts in `.ui-explorer/pairing.json` so reconnecting doesn't need a
  fresh code every time).
- Every request needs a bearer token, generated once per project and never sent anywhere except
  between this bridge and the one plugin instance paired to it.
- Only **one** Figma plugin session can be "the" connection at a time (`ownedByAnother`); a second
  plugin opening the same project politely waits rather than racing the first for control.
- Commands (`build`, `arrange`, `verify`, `render`, `repair-component-names`, `begin-export`,
  `end-export`) are queued (`pending`), delivered over the live WebSocket once it's open
  (`flush()`), and a reply is awaited with a timeout. If the socket drops **after** a write-type
  command was delivered but **before** its result came back, that command's ID is remembered in
  `.ui-explorer/command-ledger.json` as *uncertain* — and every subsequent write is blocked until a
  person inspects Figma and an agent explicitly acknowledges what actually happened
  (`explorer_review_interrupted_commands`). This is deliberate: a dropped acknowledgement must
  never be silently retried into a duplicate, half-created screen.
- **Import codes** are a separate, much simpler path for a person (not an agent): "Build in Figma"
  in the Explorer UI freezes an exact selection (screens, widths, component choice) into a short
  `UIX1:<port>:<token>:<id>` code with a one-hour expiry. Pasting that code into the plugin both
  connects it to the right bridge *and* loads that exact frozen selection — no separate "connect"
  step, and no way for a stale or mistyped code to accidentally run against the wrong project.
- **MCP client presence** is reported to the bridge every five seconds while an MCP session is
  open, purely so the plugin's UI can show "MCP connected: VS Code" — this is informational, not a
  grant of access; the bridge token itself is what actually authorises a write.

## 8. The MCP server: what an agent can actually do

[src/node/mcp.ts](../src/node/mcp.ts) exposes exactly seven tools over the
[Model Context Protocol](https://modelcontextprotocol.io/), launched over stdio by the agent's own
client (VS Code, Codex, …), one project at a time:

| Tool | What it actually does under the hood |
| --- | --- |
| `explorer_catalog` | Reads `projectState()` (the live `/api/state` if `--base-url` is configured, otherwise the saved `.ui-explorer/scenarios.json`) and paginates/filters it. |
| `explorer_inspect_screen` | Resolves one exact screen by its generated UUID and describes its recorded actions and canvas connections — read-only, no browser involved. |
| `explorer_get_screen_design` | Calls `captureDesigns()` directly (section 5) and returns the same `buildPlan()` output the UI's Copy button would produce — needs the real app reachable. |
| `explorer_figma_status` | Calls the bridge's `/status` endpoint; optionally also probes Figma's own separate desktop MCP server for presence. |
| `explorer_review_interrupted_commands` | Calls the bridge's `/commands/reviewed` endpoint, clearing specific uncertain command IDs after a person has checked Figma. |
| `explorer_get_prepared_import` | Reads a frozen import-code selection without claiming the plugin connection. |
| `explorer_export_to_figma` | Runs the exact same `exportScreens()` pipeline the bridge's `/imports` HTTP endpoint runs (section 9) — capture, `buildPlan`, then a sequence of bridge commands. |

Every call starts with a `guard()`: it re-checks that the server's working directory still matches
`--root`, and (when the connected client advertises workspace roots) that those roots still contain
this project. This exists because an MCP server is a long-lived process — it must not keep acting
with an earlier workspace's authority after a client's folder changes. Screen IDs (UUID v4, stored
in `ui-explorer.ids.json` — see [src/node/screen-identities.ts](../src/node/screen-identities.ts))
let an agent and a person refer to the *exact same screen* unambiguously even when two screens share
a title, because titles are not unique but these generated IDs are.

## 9. Running an actual import: `exportScreens()`

[src/node/local-import.ts](../src/node/local-import.ts)'s `exportScreens()` is the one function both
the HTTP bridge (`POST /imports`, used by the Figma plugin's own "Import screens" button and
clipboard flow) and the MCP tool `explorer_export_to_figma` call. It is the glue between sections
5, 6 and 7:

1. `begin-export`: tells the plugin which page(s) this batch will touch, and — importantly — asks
   it to record *right now* which existing frames/components already have unsaved manual edits,
   before this run writes anything. That baseline is what later lets the plugin tell "this frame
   changed because *we* just rebuilt its component" apart from "a person edited this by hand," so
   genuinely hand-edited content is reported as a conflict and left untouched instead of being
   silently overwritten.
2. Capture every requested scenario at every requested width (section 5), checking after each one
   that the batch wasn't cancelled.
3. `buildPlan()` the whole batch (section 6) into components and frames.
4. Send components to the plugin first (dependency-ordered), then frames — each as its own
   `build` bridge command, so progress can be reported screen by screen rather than as one giant
   blocking call.
5. `arrange` (grid or horizontal layout) and `verify` (exact coverage: which screen/width pairs
   actually ended up on the canvas) per destination.
6. `end-export`, always, even on failure or cancellation — releasing the pinned page/edit-baseline
   state the plugin was holding for this run.

## 10. The Figma plugin itself

The plugin is a separate small program, built independently (`npm run figma-plugin:build`), with
its own `tsconfig`s. It has two halves that only talk to each other through `postMessage`, because
that's how every Figma plugin is structured:

- **The sandbox** ([figma-plugin/src/code.ts](../figma-plugin/src/code.ts)) is the only code allowed
  to touch the actual Figma document (`figma.*` APIs). It has no network access and no DOM.
- **The UI** ([figma-plugin/src/ui.ts](../figma-plugin/src/ui.ts), rendered from `ui.html`) is an
  ordinary sandboxed iframe with full `fetch`/`WebSocket` access and no access to the document. It
  is the half that actually talks to the bridge.

### What the sandbox does with a `build` command

Given one `ExportPlan` fragment (a batch of components, or a batch of frames), the sandbox:

- Looks up whether a matching component master already exists on the hidden
  `⚙️ UI Explorer Components` page (tagged with a stable ID in `setPluginData`, not by name, so
  renaming a component in Figma doesn't break the match).
- **Fingerprints** every node it's about to touch (`fingerprint()`): a hash of its own visual
  properties plus its children's, recursively. Before overwriting anything, it compares that
  fingerprint against the one stamped on the node the last time *this plugin* wrote it
  (`appliedHash`). If they differ, a person changed it by hand since the last import — the plugin
  reports a conflict and leaves that node alone rather than clobbering a manual edit.
- Draws new content with the Figma Plugin API: frames, text (matching font family/weight as best
  it can from what's actually installed, falling back to Inter and recording a warning), vectors
  (imported straight from captured SVG markup), solid or image fills, and shared paint/text styles
  (reusing an existing style if one with the same values already exists, rather than creating
  duplicates on every import).
- For a repeat import of something that already exists, it **transplants** the new content into
  the existing node (`transplant()`) rather than deleting and recreating it — so the frame's node
  ID, and anything else that's pointing at it, survives re-importing.
- Yields back to its own UI thread periodically (`yieldToHost`) during a big batch, because Figma's
  plugin sandbox can be starved of time if a long synchronous loop never gives the UI thread (and
  therefore the person, and the "is this plugin still alive" heartbeat) a chance to run.

### What the UI half does

[ui.ts](../figma-plugin/src/ui.ts) and [dropdown.ts](../figma-plugin/src/dropdown.ts) render the
540×820 panel: pasting/loading an import code, the clipboard-based "Build from clipboard" flow,
the manual bridge connection field, destination/layout pickers, and progress/conflict/warning
reporting. [live-connection.ts](../figma-plugin/src/live-connection.ts) is the small state machine
that owns the actual WebSocket to the bridge: it tracks which command results have already been
sent and acknowledged (`results`, `received`) so a reconnect never re-runs a command that already
produced a result, retries with growing backoff on an ordinary drop, and treats a `4401` close code
(rejected pairing) differently from a `4409` (another plugin already connected) — the panel's
message to the person is different in each case.

## 11. The client UI: what you're actually looking at

[src/client/Explorer.tsx](../src/client/Explorer.tsx) is the root component. In broad strokes:

- It polls `/api/state` once and then just listens to the `/api/events` SSE stream for everything
  after that — jobs starting/finishing, logs, "something on disk changed, re-fetch" pings.
- **Gallery** and **Canvas** ([FlowCanvas.tsx](../src/client/FlowCanvas.tsx)) are two different
  views of the exact same scenario list; switching between them doesn't refetch anything.
- **FolderNavigator.tsx** turns each scenario's guessed source path into a real folder tree on the
  left, so picking folders scopes what the gallery/canvas show.
- **ScreenLightbox.tsx** is the enlarged, interactive preview: it loads the *actual app* inside an
  iframe at the recorded recipe, replays it, and lets you keep interacting with the real page —
  this is not a static screenshot viewer.
- **ExportScreenSelection.tsx**, **FigmaExport.tsx**, **CopyMenu.tsx**, **ComponentCreationSetting.tsx**
  are the "Build in Figma" / "Copy" flow: picking screens and widths, then calling
  `POST /api/figma/imports` (which hands off to `startBridge().prepareImport()`, section 7) or
  `POST /api/design` (which calls `captureDesigns` + `buildPlan` directly for the clipboard-copy
  path).
- **FigmaConnection.tsx** is the "Workspace overview → Figma connection" panel: it's just a thin UI
  over `POST /api/figma/connection`, which starts the bridge and returns its connection URL for
  manual pairing.
- **LoginPickerBanner.tsx** / **useLoginCapture.ts** / **useAutoLogin.ts** / **LogsPanel.tsx** are
  the three login paths from section 3, from the browser side: the manual "I'm logged in, use this
  tab's session" banner, the credential form for automated login, and the scrollable log viewer
  (the one deliberate exception to this project's "no modal dialogs" UI rule, because a long,
  copyable diagnostic log genuinely needs a dedicated, scrollable surface).

Nothing in `src/client` depends on your app's React, Tailwind config, or any of your aliases — it's
built once by this package and served as finished static files, which is also why your app doesn't
need to depend on it either.

## 12. The command line

[src/node/cli.ts](../src/node/cli.ts) is a thin dispatcher over everything above:

| Command | Calls into |
| --- | --- |
| `init` | [src/node/init.ts](../src/node/init.ts) — detects your bundler, writes `ui-explorer.config.mjs`, adds the `explorer` script, installs the AGENTS.md guidance. |
| `serve` | section 1. |
| `snapshot` | `explorer.snapshotFiles()`, section 3. |
| `crawl` | section 4, directly against any reachable dev server (no proxy needed). |
| `capture` | section 5's thumbnail path, against whatever the Explorer is serving. |
| `bridge` | [src/node/bridge.ts](../src/node/bridge.ts) directly, for command-line/CI Figma setups. |
| `mcp` | section 8. |
| `mcp install` | [src/node/mcp-install.ts](../src/node/mcp-install.ts) — writes `.vscode/mcp.json` / `.codex/config.toml`. |
| `agents` | re-runs just the AGENTS.md guidance step from `init`. |

## 13. Where things are written on disk

Everything generated lives under `.ui-explorer/` (configurable via `dir`), and is normally
git-ignored:

- `scenarios.json` — the crawler's discovered states and their recipes.
- `thumbnails/` — the gallery's pictures, plus a manifest keyed by source revision.
- `auth.json` — a saved login session (Playwright storage state).
- `bridge.json` / `pairing.json` — the current/last Figma bridge connection and its token.
- `command-ledger.json` — bridge commands whose outcome is still unconfirmed after a dropped
  connection (section 7).

One file is **meant** to be committed: `ui-explorer.ids.json` at the project root (not inside
`.ui-explorer/`) — the generated screen-UUID registry from section 8, so teammates and CI share the
same screen identities instead of regenerating them.
