# Web App UI Explorer

See every screen and state of a front-end app in one place, without writing a line of configuration.

Web App UI Explorer opens your running web app in a headless browser and explores it the way a careful tester would. It follows the flow, opens dialogs, tries dropdown choices and submits forms, then records each distinct state as a **scenario**: a name, a starting point and the clicks that reach it. The explorer shows them as a gallery of thumbnails, a flow canvas that connects them, and a source tree that places each state in the file that renders it.

It is for **web apps** (anything a browser can render, built with any framework or none). It is a development tool. By default nothing is added to your production build; if you want teammates to browse the screens on a deployed internal URL, you can opt in to a read-only snapshot (see [Shipping it with a build](#shipping-it-with-a-build)).

## What it looks like

These are the real explorer pages. The gallery and canvas run on [`examples/vanilla-demo`](examples/vanilla-demo), a small billing app in plain HTML, CSS and JavaScript with no framework, where the crawler found 43 states on its own. The other three come from a larger real-world app, a multi-step hiring flow.

**Gallery.** Every state as a thumbnail, with the source folders on the left. Pick any combination of folders to scope what you see.

![The gallery view: a source tree on the left and thumbnails of each discovered screen and state](https://raw.githubusercontent.com/danielfransix/web-app-ui-explorer/main/docs/images/gallery.png)

**Canvas.** The states connected by the control that leads from one to the next. Here, only the navigation and dialog states are selected.

![The canvas view: screens as nodes, with labelled arrows showing which control leads to which state](https://raw.githubusercontent.com/danielfransix/web-app-ui-explorer/main/docs/images/canvas.png)

**One screen, enlarged.** Open any state from the gallery or canvas. It shows where the state lives in the source tree, steps through the others with the arrow buttons, and has an **Open live UI** button to jump to the real page.

![A single state, a hiring pipeline stage screen, enlarged over the canvas with its source path, a position counter and next and previous buttons](https://raw.githubusercontent.com/danielfransix/web-app-ui-explorer/main/docs/images/screen.png)

**Live view.** The same state running in the real app inside the explorer, with a bar at the top to go back, reset the state, step to the next one or open it in its own tab.

![The live view of a state: the real app with the explorer's top bar for back, reset, previous, next and open in new tab](https://raw.githubusercontent.com/danielfransix/web-app-ui-explorer/main/docs/images/live.png)

**Floating launcher.** In development, a small button sits at the bottom-left of your app. Click it, or press **Alt + Shift + E**, to open the explorer. Drag it if it covers something; a refresh puts it back.

![The app in development with the round explorer launcher button at the bottom-left of the sidebar](https://raw.githubusercontent.com/danielfransix/web-app-ui-explorer/main/docs/images/launcher.png)

Try it yourself in this repository:

```sh
npm install
npm run demo        # builds the package, then serves the demo app with the explorer at /__explorer/
```

> **Renamed.** This package was briefly published as `@danielfransix/ui-explorer`. Use `@danielfransix/web-app-ui-explorer`.

## Install

From the root of your Vite project:

```sh
npx @danielfransix/web-app-ui-explorer init      # adds the Vite plugin and a .gitignore entry
pnpm add -D @danielfransix/web-app-ui-explorer   # or npm install -D / yarn add -D
```

The package is on the public npm registry, so no account, token or `.npmrc` is needed. After it is installed, `npx web-app-ui-explorer` runs the local copy (the shorter `ui-explorer` command still works as an alias).

`init` edits your Vite config for you. To do it by hand:

```ts
// vite.config.ts
import uiExplorer from "@danielfransix/web-app-ui-explorer/vite"

export default defineConfig({
  plugins: [uiExplorer()],
})
```

Start your dev server, open **`/__explorer/`**, and press **Explore**. Exploring takes a few minutes for a typical app. Screens appear as they are found, and thumbnails are captured when it finishes.

Press **Alt + Shift + E** (Option + Shift + E on a Mac) in your app, or use the small draggable button at its bottom-left, to jump to the explorer, and again inside a preview to come back.

Requirements: Node 20+, Vite 5+. Playwright's Chromium is used to explore (`npx playwright install chromium` once).

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

## Options

```ts
uiExplorer({
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

### Shipping it with a build

By default the explorer exists only on the dev server. Set `static: true` and `vite build` also writes a read-only snapshot to `<outDir>/__explorer/`: the explorer page, one data file per scenario, the runtime that adds the floating button and shortcut, and any thumbnails in `.ui-explorer/thumbnails`. Use it only for **internal** URLs, because anyone who can open the app can then open every screen state.

- There is no server in a build, so **Explore** and **Capture** are hidden. Explore and capture locally, then build.
- `.ui-explorer/` is usually git-ignored, so a clean CI build has no thumbnails and the gallery shows live previews instead.
- The app must expose its preview routes in that build, and the app and explorer must share one origin. Hand-written scenarios with a `url` must point at routes that exist in the production build.
- Apps served under a path prefix work: the plugin reads Vite's `base`.

### Apps behind a login

Save a Playwright storage state once (log in, then `context.storageState({ path: "auth.json" })`) and pass it as `storageState`. The explorer uses it for exploring and capturing.

### Hand-written scenarios

Exploration is the default, but you can add scenarios for states it cannot reach (for example ones that need specific data) or to give a state a name you prefer.

```ts
uiExplorer({
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
web-app-ui-explorer init                          # add the plugin to a Vite project
web-app-ui-explorer crawl --url http://localhost:5173 --root .
web-app-ui-explorer capture --url http://localhost:5173
```

`crawl --debug` also prints every recipe that fails to replay and saves what each state looked like next to the scenarios file. Run `ui-explorer help` for every option.

## How complete is it?

Measured on a real 7-step hiring wizard with drawers, dialogs, tabs and dropdowns, where 50 states were written by hand as an answer key: exploring found **all 13 screens** and between **58% and 82% of the 50 states** depending on the run. The spread comes from machine load: each browser runs a full copy of your app, and when pages get slow, recipes fail to replay and branches are lost. If a crawl reports many failed replays, lower `--concurrency` or raise `--time-budget`, and run it again.

## What it cannot do (yet)

- It explores single-page apps. A control that triggers a full page load ends the recipe at that step.
- States that need particular data, permissions, hover, drag and drop, or a long chain of conditions may be missed. Add them as hand-written scenarios.
- It is a Vite plugin. Other bundlers are not supported.
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

## Development

```sh
pnpm install
pnpm run build      # runtime, node side and the explorer page
pnpm test           # unit tests, crawler and full-stack tests on a demo app
```

```
src/runtime   runs inside the explored app: finds elements, replays recipes, fingerprints pages
src/node      the Vite plugin and API, the crawler, thumbnail capture, source matching, the CLI
src/client    the explorer page (React, built to dist/client and served by the plugin)
src/shared    the scenario format and the preview protocol
test          unit tests, plus end-to-end tests against a framework-free demo app
```

The explorer page is built once and served from the package, so it does not depend on your app's React, Tailwind or aliases, and your app does not depend on it.
