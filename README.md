# Web App UI Explorer

See every screen and state of a front-end app in one place, without writing a line of configuration.

Web App UI Explorer opens your running web app in a headless browser and explores it the way a careful tester would. It follows the flow, opens dialogs, tries dropdown choices and submits forms, then records each distinct state as a **scenario**: a name, a starting point and the clicks that reach it. The explorer shows them as a gallery of thumbnails, a flow canvas that connects them, and a source tree that places each state in the file that renders it.

It works with **any bundler**: Vite, Create React App, webpack, Next.js, Parcel, Rsbuild, esbuild, or a hand-written dev server. A small server sits in front of your running dev server, so nothing in your build changes. It is for **web apps** (anything a browser can render, built with any framework or none). It is a development tool. By default nothing is added to your production build; if you want teammates to browse the screens on a deployed internal URL, you can opt in to a read-only snapshot (see [Shipping it with a build](#shipping-it-with-a-build)).

## What it looks like

These are the real explorer pages. The gallery and canvas run on [`examples/vanilla-demo`](examples/vanilla-demo), a small billing app in plain HTML, CSS and JavaScript with no framework, where the crawler found 43 states on its own. The other three come from a larger real-world app, a multi-step hiring flow.

**Gallery.** Every state as a thumbnail, with the source folders on the left. Pick any combination of folders to scope what you see.

The **Workspace** menu (three dots at the top right) contains workspace totals, discovery, Return to UI,
and keyboard help. When both screen sources exist, it offers **Registered** (screens/states defined in
the project's Explorer setup), **Discovered** (states found automatically by exploring the app), or
**All screens** (the combined catalog). These replace the older Curated, Explored and Both labels.
**Build in Figma** appears with your selected screens. On mobile, search takes a full row below the
Gallery/Canvas switch; the keyboard hint is kept separate from its prompt on desktop.

![The gallery view: a source tree on the left and thumbnails of each discovered screen and state](https://raw.githubusercontent.com/danielfransix/web-app-ui-explorer/main/docs/images/gallery.png)

**Canvas.** The states connected by the control that leads from one to the next. Here, only the navigation and dialog states are selected.

![The canvas view: screens as nodes, with labelled arrows showing which control leads to which state](https://raw.githubusercontent.com/danielfransix/web-app-ui-explorer/main/docs/images/canvas.png)

**One screen, enlarged.** Open any state from the gallery or canvas. The preview is interactive: click buttons, type into fields, open menus and scroll the real app directly inside the modal. It shows where the state lives in the source tree and steps through the others with the arrow buttons. Small gallery and canvas thumbnails remain click-to-expand previews.

The preview modal fills the window with a 16px margin on every edge. **Fit window** gives the website the actual available viewport at normal size: making the window larger provides more layout space, not larger text and controls. Interactive previews are never zoomed or stretched. Only the small, non-interactive gallery and canvas thumbnails use a scaled canvas.

The **Viewport** dropdown is available in both the modal and full-page preview:

| View | CSS viewport size |
| --- | --- |
| Fit window (default) | Available preview width and height |
| Custom width | Enter 1–7680 pixels; height fits the preview area |
| Widescreen | 1920 × 1080 |
| Desktop | 1440 × 900 |
| Tablet | 768 × 1024 |
| Mobile | 390 × 844 |

**Custom width** lets you enter a whole-number pixel width and press **Apply** or Enter. Invalid values leave the last valid viewport unchanged. The custom width is remembered for the browser session; its height follows the available preview space.

Presets change the iframe's real viewport, so the website's own responsive CSS and media queries apply. A preset larger than the available area scrolls at 100% instead of being scaled down. The selected viewport is retained when changing screens, expanding or returning from full-page view, resetting a screen, and reopening the preview; it is also remembered for the browser session. Resizing does not reload the app or discard in-progress interactions. These are CSS viewport previews, not user-agent, touch, or device-pixel-ratio emulation.

![A single state, a hiring pipeline stage screen, enlarged over the canvas with its source path, a position counter and next and previous buttons](https://raw.githubusercontent.com/danielfransix/web-app-ui-explorer/main/docs/images/screen.png)

**Live view.** Choose **Open live UI** to expand the same running preview to full-screen without reloading it. The bar at the top lets you go back, reset the state, step to the next one or return to the app. **Back to preview** restores the modal; closing it returns to the gallery or canvas with your search, selected folders, scroll position and canvas zoom intact. Browser Back and Forward also traverse the preview layers. A direct full-screen link returns safely to the gallery when there is no originating modal.

**Reset state** is available in both the modal and full-screen preview. It reloads only the active screen's preview state; the viewport, custom width and selected screen are kept. Both views also have a searchable **Jump to a screen state** picker that lists only the screens in the current selection (folders and search). Typing filters the list without changing the selection.

Up to three visited screens stay in memory while the preview is open, so going back to a recent screen does not reload its app or discard your edits. Older screens are released. **Reset state**, a source revision change, or closing the preview clears this cache. Initial recipe previews wait for scripts, styles and hydration, but not unrelated images or media. Custom preview hosts that only set `data-uix-status` are also detected immediately, without waiting for the timeout.

![The live view of a state: the real app with the explorer's top bar for back, reset, previous, next and open in new tab](https://raw.githubusercontent.com/danielfransix/web-app-ui-explorer/main/docs/images/live.png)

**Floating launcher.** In development, a small button sits at the bottom-left of your app. Click it, or press **Alt + Shift + E**, to open the explorer. Drag it if it covers something; a refresh puts it back.

![The app in development with the round explorer launcher button at the bottom-left of the sidebar](https://raw.githubusercontent.com/danielfransix/web-app-ui-explorer/main/docs/images/launcher.png)

### Keyboard shortcuts

Shortcuts use **Alt + Shift** plus a letter (Option + Shift on a Mac), so they never collide with typing. They are not shown in the interface, except the search hint.

| Shortcut | What it does |
| --- | --- |
| **Alt + Shift + E** | Open the explorer from your app, and return from a preview. |
| **/** or **Ctrl/⌘ + K** | Focus search. **Esc** clears the search, and a second **Esc** leaves the field. |
| **Alt + Shift + F** | Focus search (works from anywhere in the workbench). |
| **Alt + Shift + V** | Switch between Gallery and Canvas. |
| **Alt + Shift + R** | Refresh from your current selection: re-captures the screens in the selected folders and search, or every screen when nothing is selected. Inside a preview it resets that screen's state and refreshes its thumbnail. |
| **Alt + Shift + X** | Explore the whole app again to find new screens. |
| **← / →** | Previous or next screen in a preview. |

Refresh and Explore need a running dev server, so they do nothing in a static build.

Try it yourself in this repository:

```sh
npm install
npm run demo        # builds the package, then serves the demo app with the explorer at /__explorer/
```

> **Renamed.** This package was briefly published as `@danielfransix/ui-explorer`. Use `@danielfransix/web-app-ui-explorer`.

## Install

Add the package to your project (it is on the public npm registry, so no account, token or `.npmrc` is needed), then let `init` set it up:

```sh
pnpm add -D @danielfransix/web-app-ui-explorer   # or npm install -D / yarn add -D
npx web-app-ui-explorer init
npx playwright install chromium                  # once: the browser used to explore
```

`init` reads your `package.json` to see which bundler you use. It writes `ui-explorer.config.mjs` with your dev server's usual address, adds an `explorer` script, and keeps `.ui-explorer/` out of git. Then:

```sh
npm run dev          # your dev server, as usual (any bundler)
npm run explorer     # the explorer, in front of it
```

Open the address `explorer` prints. Your app is there as always, and the explorer is at **`/__explorer/`**: press **Explore**. Exploring takes a few minutes for a typical app. Screens appear as they are found, and thumbnails are captured when it finishes.

Press **Alt + Shift + E** (Option + Shift + E on a Mac) in your app, or use the small draggable button at its bottom-left, to jump to the explorer, and again inside a preview to come back.

Requirements: Node 20+.

`init` also adds the [Explorer and Figma tool boundaries](docs/agent-orchestration.md) to your project's `AGENTS.md`, preserving its other instructions. Explorer handles source discovery and capture; the importer writes designs; Figma's existing tools handle pages, sections, arrangement, annotations and inspection. The MCP server supplies the same guidance when an agent connects. For an existing setup, run `npx web-app-ui-explorer agents --root .` to add or refresh just this guidance. Installing the dependency alone does not edit project instructions.

### How it works with any bundler

`web-app-ui-explorer serve` is a small server that listens on its own port (5199 by default) and forwards everything to your dev server. It adds one `<script>` tag to your pages, answers `/__explorer/` itself, and tunnels WebSockets, so hot reload keeps working. It does not read or change your bundler's configuration, which is why the same command works for Create React App, webpack, Next.js, Parcel, Rsbuild, esbuild and the rest.

```sh
web-app-ui-explorer serve --url http://localhost:3000      # or just: --url 3000
```

- It listens on `127.0.0.1` only, refuses requests addressed to any other host name, and refuses writes started by another website.
- Your dev server sees itself as the origin of every request. Redirects and cookies are rewritten on the way back.
- If your dev server is not up yet, add `--wait 60` to wait for it, or just reload once it is. A notice page explains what is happening.
- A dev server on https with a self-signed certificate needs `--insecure`.
- To reach it by another name (a hosts entry, a container), add `--allowed-host name`.

### Tested with

Every bundler below runs the same checks (`test/contract.mjs`): the page gets the runtime and still works, the dev server's hot-reload channel stays open through the proxy, a crawl finds every state, thumbnails are captured, a recorded state replays, a source edit changes the revision, and a production build gets a working read-only explorer from `snapshot`. The first three run in `npm test`; the rest run in CI with `npm run test:matrix`.

| Bundler | Version tested | How you use it |
| --- | --- | --- |
| Vite | 8.3 | `serve`, or the optional plugin |
| Create React App | react-scripts 5.0.1 | `serve` |
| webpack | 5.111 with webpack-dev-server 5.2 | `serve` |
| Next.js (App Router, Turbopack) | 16.4 | `serve` |
| Parcel | 2.16 | `serve` |
| Rsbuild (Rspack) | 1.7 | `serve` |
| esbuild | 0.27 | `serve` |
| A dev server with no bundler | Node's own HTTP server | `serve` |

Anything else that serves your app over HTTP should work the same way, but has not been run through the checks: Rspack on its own, Bun, Angular CLI, Expo web, and Vite-based frameworks such as Astro, SvelteKit, Nuxt and React Router. If one fails, [open an issue](https://github.com/danielfransix/web-app-ui-explorer/issues) with the dev server's name and version.

### Vite: the optional plugin

Vite projects can also run the explorer inside the dev server, on the app's own origin, with nothing extra to start. `init` does this by default when it finds a Vite config (`init --serve` sets up the standalone server instead). By hand:

```ts
// vite.config.ts
import uiExplorer from "@danielfransix/web-app-ui-explorer/vite"

export default defineConfig({
  plugins: [uiExplorer()],
})
```

The plugin and `serve` share one core and take the same options.

## What you get

- **Gallery.** Every state as a thumbnail. Click one to enlarge it, use the arrow keys to move between them, and open the live UI only when you want to.
- **Canvas.** The states connected by the control that leads from one to the next.
- **Source explorer.** Folders and files, with the states each one renders. Pick any combination to scope what you see.
- **Issues.** A state that fails to start, or a thumbnail that fails to capture, is listed with the reason, the file to look at and the recipe that reproduces it.
- **Thumbnails** that stay honest: they are tied to a hash of your source and are ignored the moment the code changes, so an out-of-date picture never stands in for a screen.

## How it explores

1. Opens the app at `startPath` in a fresh page.
2. Lists what a person could act on right now: buttons, links, tabs, switches, radios, dropdowns. Anything covered by an open dialog is excluded.
3. For each one, reloads from the start, replays the recipe so far, performs the step, and looks at the result: new dialog, new screen, something selected, something revealed.
4. Gives each distinct result a fingerprint (headings, dialogs, selections and visible text) and keeps only new ones.
5. Fills forms with believable values and makes a first choice in empty dropdowns and radio groups, so flows that need valid input can continue. Closing a form with unsaved changes is tried too, since that usually asks for confirmation.
6. Writes `.ui-explorer/scenarios.json`, then traces every state to the source file that contains its headings and labels.

Every recipe starts from a clean page load, so a state can always be reproduced. While exploring and capturing, requests that change data (POST, PUT, PATCH, DELETE) are answered with an empty success and never reach your server.

Recipes can cross ordinary page links, same-origin redirects and GET form submissions, then continue interacting with the destination. The crawler and browser previews share the same replay lifecycle, including thumbnails and editable captures. Full-page transitions require session storage for a short-lived, tab-local continuation; completed recipes clear it. Client-side routes and hash links continue within the current document. Navigations to another origin, downloads and new tabs are outside the crawl.

Discovered recipes record their `replayViewport`. Previews and captures reach the state at that size, then resize to the requested viewport. A desktop navigation link hidden by mobile CSS therefore does not prevent a mobile preview. Registered recipes can set the same optional field; without it, they replay at the requested size as before. Custom preview URLs keep the host's own routing behavior.

Source folders populate the file tree; they do not automatically register every route. Discovery follows reachable controls. Check the crawl's failed replay count and stopping reason when assessing coverage; pages that are unlinked or require unsupported interactions can be registered explicitly as scenarios.

## Options

Options live in `ui-explorer.config.mjs` (or `.js`, `.json`, or `.ts` on Node 22.18+) at the project root, and are the same ones the Vite plugin takes. Command-line flags override the file.

```js
// ui-explorer.config.mjs
import { defineConfig } from "@danielfransix/web-app-ui-explorer"

export default defineConfig({
  serve: { url: "http://localhost:3000" }, // the dev server `serve` sits in front of (port, host, wait, insecure, allowedHosts too)
  startPath: "/",                   // where every recipe starts
  sources: ["src"],                 // folders shown in the source explorer
  mode: "merge",                    // "merge" | "auto" (explored only) | "manual" (hand-written only)
  scenarios: [],                    // hand-written scenarios, see below
  transitions: [],                  // extra connections between screens for the canvas
  deny: ["delete account"],         // controls the crawler must never click (regular expressions)
  storageState: "auth.json",        // Playwright storage state, for apps behind a login
  maxStates: 250,                   // most states a crawl records
  autoCapture: true,                // capture thumbnails when the explorer opens without fresh ones
  allowWrites: false,               // let exploration send data-changing requests
  static: false,                    // ship a read-only snapshot of the explorer inside production builds
  dir: ".ui-explorer",              // where generated files go
  route: "/__explorer",             // where the explorer is served
})
```

With the Vite plugin the same options go to `uiExplorer({ ... })` and `serve` is not used.

### Inspecting canvas connections

Every connection has a compact label. Hover or focus it to read the action details; click, Enter or Space pins the panel. Close or Escape dismisses it. Pinned details stay readable while the canvas pans or zooms. They show the source and destination plus recorded actions such as **Click the “Get the app” link**. New crawls retain control roles and intermediate form/dropdown steps. Older recipes show the information that can be recovered, and missing trigger types are identified explicitly. Filled values and CSS selectors are excluded from the details.

For connections defined by the project, optional `details` can describe one or more actions, including automatic or custom events:

```js
transitions: [{
  source: "home",
  target: "download",
  label: "Get the app",
  details: {
    steps: [{ type: "click", role: "link", label: "Get the app" }],
  },
}]
```

Steps support `type`, `label`, `role` and `description`; `details.description` adds context for the connection. Use `type: "automatic"` only when the project defines that behavior. A scenario's optional `transition` carries the same details for its `parent` connection. See the [implementation plan and QA](docs/connection-details-plan.md).

### Shipping it with a build

By default the explorer exists only next to your dev server. After any bundler's production build, run

```sh
web-app-ui-explorer snapshot --dir build        # or dist, out ...
```

and the build folder gains a read-only `__explorer/`: the explorer page, one data file per scenario, the runtime that adds the floating button and shortcut, and any thumbnails in `.ui-explorer/thumbnails`. Every HTML file in the folder gets the runtime tag (pass `--html index.html` to limit that), and running it again replaces the previous copy. In a Vite project you can set `static: true` on the plugin instead and `vite build` does the same. Use it only for **internal** URLs, because anyone who can open the app can then open every screen state.

- There is no server in a build, so **Explore** and **Capture** are hidden. Explore and capture locally, then build.
- `.ui-explorer/` is usually git-ignored, so a clean CI build has no thumbnails and the gallery shows live previews instead.
- The app must expose its preview routes in that build, and the app and explorer must share one origin. Hand-written scenarios with a `url` must point at routes that exist in the production build.
- Apps served under a path prefix work: pass `--base /prefix` to `snapshot` (the Vite plugin reads Vite's `base`).

### Apps behind a login

Save a Playwright storage state once (log in, then `context.storageState({ path: "auth.json" })`) and pass it as `storageState`. The explorer uses it for exploring and capturing.

### Hand-written scenarios

Exploration is the default, but you can add scenarios for states it cannot reach (for example ones that need specific data) or to give a state a name you prefer.

```js
defineConfig({
  scenarios: [
    {
      id: "invoice-overdue",
      title: "Overdue invoice",
      group: "Billing",
      actions: [
        { kind: "click", selector: "button", text: "Billing" },
        { kind: "click", selector: "button", text: "Show overdue" },
      ],
    },
    // Or render the state yourself and point the explorer at it:
    { id: "empty-cart", title: "Empty cart", group: "Cart", url: "/?preview=empty-cart" },
  ],
})
```

When a project has both kinds, the explorer shows the hand-written set first. Choose **Curated**, **Explored** or **Both** from the overview panel.

A preview page you render yourself reports back by posting `{ type: "uix:ready", id }` or `{ type: "uix:error", id, message }` to `window.parent`, and by setting `data-uix-status` on `<html>` (`ready` or `error: <message>`).

## Command line

```sh
web-app-ui-explorer init                          # set the project up (config file and "explorer" script, or the Vite plugin)
web-app-ui-explorer serve --url 3000              # put the explorer in front of your dev server
web-app-ui-explorer snapshot --dir build          # add a read-only explorer to a production build
web-app-ui-explorer crawl --url http://localhost:3000 --root .
web-app-ui-explorer capture --url http://localhost:5199   # the address serve prints
```

`crawl` works against any dev server directly. `capture` takes its pictures from the pages the explorer serves, so point it at `serve` (or at a Vite dev server with the plugin).

`crawl --debug` also prints every recipe that fails to replay and saves what each state looked like next to the scenarios file. Run `ui-explorer help` for every option.

## How complete is it?

Measured on a real 7-step hiring wizard with drawers, dialogs, tabs and dropdowns, where 50 states were written by hand as an answer key: exploring found **all 13 screens** and between **58% and 82% of the 50 states** depending on the run. The spread comes from machine load: each browser runs a full copy of your app, and when pages get slow, recipes fail to replay and branches are lost. If a crawl reports many failed replays, lower `--concurrency` or raise `--time-budget`, and run it again.

## What it cannot do (yet)

- It explores single-page apps. A control that triggers a full page load ends the recipe at that step.
- States that need particular data, permissions, hover, drag and drop, or a long chain of conditions may be missed. Add them as hand-written scenarios.
- `serve` forwards ordinary HTTP and WebSocket traffic. A dev server that refuses to be reached under another port, or a page with a Content Security Policy that does not allow same-origin scripts, needs a setting changed on your side.
- Names come from headings and button text, so they are good but not always elegant. Hand-written scenarios override them.

## Staying up to date

The package is versioned with semver and published to npm by the release workflow (push a `v<version>` tag, for example `v0.2.0`). Repositories that use it pick up a new version like any dependency. Add Renovate or Dependabot to open a pull request for each release, with auto-merge for patch and minor versions:

```json
// renovate.json
{
  "extends": ["config:recommended"],
  "packageRules": [
    {
      "matchPackageNames": ["@danielfransix/web-app-ui-explorer"],
      "matchUpdateTypes": ["minor", "patch"],
      "automerge": true
    }
  ]
}
```

## Export screens to Figma

For local imports, browse folders in UI Explorer and check individual screens beside their titles,
below the thumbnails. **Select visible** selects the current folder/search results in bulk; uncheck
any exceptions. Selection is kept across folders, searches and Gallery/Canvas views. Click **Build
in Figma** (also available in a single-screen preview). Review the screens/states and capture widths, then prepare and copy the short
import code. Paste it into **UI Explorer design import** in Figma to connect automatically and load
that exact request. Choose the canvas destination and grid/horizontal arrangement, then build.
Explorer starts its own bridge on demand; no separate connection command or URL is required. Codes
last one hour while Explorer remains running and support protected re-imports, progress, cancellation
and final coverage verification. Source browsing and capture settings stay in Explorer.

Open a screen in the local Explorer and use **Copy** to select several preset or saved custom widths.
Run the companion **UI Explorer design import** plugin in Figma, choose a destination, and build from
the clipboard. If Figma restricts browser clipboard access, connect the local bridge below to enable
that button. A manual paste field is also available. It creates editable frames, vectors, components, instances and
linked paint/text styles. The built plugin is included under `figma-plugin/` in the npm package; import
its `manifest.json` through Figma desktop's development-plugin menu.

For MCP clients, install the package locally and run
`npx ui-explorer mcp install --client vscode --base-url <dev-url>` inside the app (use `--client codex`
for Codex). This writes project-local configuration and agent guidance; global MCP installation is
unsupported. Restart the client in this project. The server verifies its working directory, available
client workspace roots, and the running Explorer's checkout identity before using live screens.
Seven tools list folders, groups and all scenario kinds, count scenario/width pairs, capture designs, check
the plugin connection, and export a selected scope with explicit placement. Keep Figma and the plugin
open during a batch. Existing frames are updated without duplicates, and edit conflicts are reported.
The plugin separately shows connected MCP clients and import progress. No special trigger is needed
once the MCP server is enabled and the plugin is connected. See the
[MCP-to-Figma setup guide](docs/mcp-figma.md) for configuration, tool arguments and troubleshooting.

To ask an agent about one exact screen, expand its preview and use **Copy screen ID**. Explorer
generates a random UUID for each screen, so identical titles and folders remain distinct. Paste that
ID into your question; the agent resolves it with `explorer_inspect_screen`. Commit the generated
`ui-explorer.ids.json` file to preserve IDs across restarts and teammates' clones. UUIDs are independent
of framework, screen names and folders; [identity rules and migration](docs/mcp-figma.md#screen-ids-and-references)
explain what happens when discovery keys or replay recipes change.

See [plugin setup](figma-plugin/README.md) and [implementation status and remaining limitations](docs/figma-integration-options.md).

## Development

```sh
pnpm install
pnpm run build      # runtime, node side and the explorer page
pnpm test           # unit, proxy, CLI and crawler tests, plus Vite, esbuild and plain-Node runs of the whole stack
pnpm run test:matrix            # on demand: the same contract against webpack, Create React App, Parcel, Rsbuild and Next.js
```

```
src/runtime   runs inside the explored app: finds elements, replays recipes, fingerprints pages
src/node      the explorer core, the serve proxy and snapshot command, the optional Vite plugin, the crawler,
              thumbnail capture, source matching, the CLI
src/client    the explorer page (React, built to dist/client and served by serve or the plugin)
src/shared    the scenario format and the preview protocol
test          unit and end-to-end tests; contract.mjs is the check every supported bundler must pass
```

The explorer page is built once and served from the package, so it does not depend on your app's React, Tailwind or aliases, and your app does not depend on it.
