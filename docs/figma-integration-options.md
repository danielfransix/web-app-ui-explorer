# Figma export system — build plan

## Build status - 0.5.1 verification pass

Legend: ✅ implemented and tested / 🕒 implemented with the specific remaining limitation shown.

| System | Status | Evidence and limits |
|---|---|---|
| Capture engine | ✅ | Real browser coverage of multiple widths on one page, fixed Date, disabled CSS motion, image decoding/embedding, CSS colors, mixed text, SVG vectors and display:contents wrappers. Complex CSS limitations remain below. |
| Framework detection | 🕒 | Real React, Vue, Angular, Svelte and Web Component apps are tested. Astro scope detection is tested against real build output. Runtime metadata can be absent in stripped builds; ambiguous source names stay unresolved. Astro scope hashes do not yet resolve to source filenames. |
| Component and variant planner | ✅ | Reusable identities, breakpoint variants, distinct captured appearances at the same width, occurrence-specific names, nested text overrides and dependency ordering are tested. Only observed states can be exported. |
| Figma component interpreter | 🕒 | Creates components, sets and actual instances; extends existing sets and updates masters in place. Desktop/mobile Hiring home imported into a live Figma file. Published-library success paths still need an accessible published library for live QA. |
| Paint and text styles | 🕒 | Resolves exact existing values including alpha, font, size, line height and spacing. Imports explicitly configured published style keys before local fallback. Automatic variable binding is not implemented. |
| Repeat imports and conflicts | ✅ | Live identical-plan rerun produced zero writes. Automated interpreter tests cover appearance edits, unchanged frame IDs/positions, single-variant instances, relative coordinates, errors and recovery. |
| Companion plugin | ✅ | Panel opened in Figma Beta. Self-contained HTML, explicit placement, clipboard/manual-paste entrypoints, library registration, results and authenticated bridge controls. Build artifacts are included in the npm tarball. |
| Copy menu | ✅ | Multiple presets/custom sizes, shared saved sizes, deduplicated widths, removal, validation and reload persistence pass browser tests. |
| MCP discovery and counts | ✅ | Real stdio protocol tests; live discovery includes curated states absent from disk. Folder listing, every scenario kind and exact scenario-width expectations are supported. |
| MCP bulk export and bridge | ✅ | Authenticated loopback relay, dependency-first component batches, individual frame messages, disconnect errors and final coverage verification. Real MCP-to-plugin import completed on the existing open Figma page. |
| Release | 🕒 | 0.5.0 is already on npm; these fixes are prepared as 0.5.1. Publication is deferred until local testing is approved. |

The remaining product limitations and release tasks are listed at the end. Green checks describe the
specific evidence above, not support for every possible CSS feature or unobserved component state.

## What we're building

Everything the Explorer has already scanned — every screen, overlay, variant,
and navigation state, in any framework the Explorer supports — should be
portable into Figma as a real, editable, reusable design, not a flattened
picture of one. Concretely:

- A piece of UI that's a reusable component in the codebase becomes a
  reusable **Figma component**, reused via instances everywhere it appears —
  the same way it's reused in code — including *every* variant of that
  component Explorer has captured (every requested breakpoint, every
  interaction/state it discovered, everything), not just one default view.
- A color or text style that already exists as a design token or a Figma
  library style gets **linked to that style**, not re-created as a disconnected
  value, so changing the style once updates every use of it.
- Running this again after the app changes **updates what's already there**
  instead of duplicating it, and if a human has since hand-edited something in
  Figma, the system **says so instead of silently overwriting it**.
- Two surfaces expose all of this: a one-click **manual Copy control** in the
  Explorer UI (pick a view or a set of breakpoints, paste straight onto a
  Figma canvas), and an **agent-driven bulk mode** that can be pointed at a
  specific folder or group, build everything found there, and verify an exact
  count against what was actually created.

What follows is a goal-then-steps build plan for each piece this requires.
No code — the sequencing and mechanism for each system, so the next pass can
go straight to implementation with the hard decisions already made.

---

## 1. Capture engine — deterministic, multi-width DOM/style serialization

**Goal:** for any scanned scenario, produce a structured description of its
rendered layout, styling, and text at one or more pixel widths, where all
widths of the *same* scenario are guaranteed to show the same data in the same
visual state — the one piece every other system in this plan depends on.

**Steps:**
1. Replay the scenario's recorded action sequence once, the same way the
   crawler already does, to reach the target state.
2. Inject a settle override into the page: disable CSS animations and
   transitions, and freeze any time-based rendering (current time, relative
   timestamps) via the Explorer's existing injected runtime script.
3. For each requested width, in order, without reloading the page:
   a. Resize the live page in place to that width.
   b. Wait for network-idle, web fonts to finish loading, and every visible
      image to finish loading (a width change can reveal content — e.g. a
      carousel — that wasn't visible, and therefore wasn't loaded, at the
      previous width).
   c. Wait one additional short settle period to avoid capturing mid-reflow.
   d. Walk the rendered DOM under the scenario's root and record, per visible
      element: position and size, fills/background, border and corner radius,
      shadow, opacity, and — for text nodes — the actual rendered text plus
      font family/size/weight/line-height/letter-spacing/color. The baseline
      toolset for this is the standard `getBoundingClientRect()` /
      `getComputedStyle()` pair, available in any page Playwright controls;
      fall back to Chrome DevTools Protocol's `DOM`/`CSS` domains only if
      shadow-DOM or pseudo-element cases prove the plain DOM APIs
      insufficient. This is deliberately built from these primitives directly
      rather than on top of an existing DOM-to-Figma library (e.g.
      `@builder.io/html-to-figma` and its forks) — none of those do
      codebase-aware component/style detection, which is the actual hard
      requirement here, so there's nothing to inherit from them beyond the
      mechanical box-model walk this step already covers on its own.
4. Attach, at each node in the walk, whatever component/style metadata the
   systems below produce (component identity, resolved style reference) —
   this walk is the single pass everything else hangs off of.
5. Emit one structured payload per scenario covering all requested widths,
   each width's root tagged with the width itself so later systems can address
   "this scenario at this width" as one addressable unit.

---

## 2. Cross-framework component detection

**Goal:** recover "this subtree is component `X`, defined at this file" from
the *running app itself*, for every framework the Explorer already supports,
so component identity is a codebase fact fed into the design, never a guess
made by pattern-matching shapes inside Figma. Supports as many frameworks as
can be reliably detected, with an explicit, honest fallback for the rest.

**Steps, by framework, in confidence order:**

1. **React** (and framework wrappers built on it): walk each DOM node's
   attached fiber reference (React attaches this under a key shaped like
   `__reactFiber$<id>` on every element it renders) upward through parent
   fibers, skipping host/string fibers, until the nearest named
   function/class component is reached. This gives the component's display
   name (`type.displayName`/`type.name`) directly, and — in a development
   build only — `_debugSource` additionally gives its defining file and line.
2. **Vue 3**: each DOM element carries an internal reference to its owning
   component instance in development mode (via the element's attached
   `__vnode`, reached as `el.__vnode.component`). Read the component's
   registered name the same way; where no explicit name is set, fall back to
   the defining file via dev-mode source metadata.
3. **Angular**: use Angular DevTools' own debugging entry point
   (`ng.getComponent(domNode)`), which is built specifically to go from a DOM
   element to its owning component instance in a development build — the
   most official/sanctioned of all of these, since it's a documented
   debugging API rather than an internal implementation detail.
4. **Web Components (and Lit)**: no internals needed at all — a custom
   element's tag name *is* its component identity. Look up the registered
   class for that tag name directly through the standard `customElements`
   registry. The cleanest, most stable case in this entire list, because it's
   a web platform standard, not a framework internal.
5. **Svelte**: in development mode, each element carries file/line/column
   metadata attached by the compiler under `__svelte_meta.loc` (the same data
   the official Svelte inspector tool uses to jump to source). This gives a
   location, not a component name directly — resolve the human-readable name
   by reading the component definition at that file/line.
6. **Astro**: Astro components that use scoped styles get a documented,
   per-component scoping hash attribute (`data-astro-cid-*`) on their
   rendered elements — an official styling feature, not an internal. Resolve
   that hash back to its originating `.astro` file by cross-referencing
   Astro's own build output for that hash — giving component identity even
   though Astro has no persistent runtime component tree the way the others
   do (most Astro output is static markup; only hydrated islands have their
   own framework-specific instance, handled by whichever of the above applies
   to that island's framework).
7. **Everything else (Solid, Preact, Qwik, anything unrecognized, or any
   framework running a stripped production build with no dev-mode metadata
   at all):** no reliable runtime hook exists for several of these today.
   Degrade gracefully — capture the subtree as plain, disconnected shapes with
   no component reuse, exactly like the flat "copy website to Figma" tools
   already on the market. This must never block a capture; it only turns off
   the reuse intelligence for that one subtree.
8. In every case where a defining file is recovered, cross-check it against
   Explorer's existing source-matching logic (the same approach already used
   to attach a `source` file to each scanned scenario) so component identity
   and scenario identity are derived the same way, consistently.

---

## 3. Component & variant system

**Goal:** every piece of UI identified as a reusable component by system 2
becomes exactly one master component (or one component set, if it has
variants), reused via instances everywhere it occurs — and that master
carries *every* variant Explorer has evidence for: every requested breakpoint,
every interaction/state scenario Explorer already discovered for it, and any
other prop-driven variation that can be detected — not just a single default
rendering.

**Steps:**
1. Derive a stable component identity from where it lives in the codebase —
   a hash of its defining file plus its component/export name — so the same
   identity is produced on every future run, independent of anything about
   the Figma file itself.
2. Reserve one fixed-name page per Figma file (e.g. a literal, documented
   string the system always looks for first) as the canonical home for every
   master component created in that file — this is the one placement decision
   that is never a conversation, specifically so there's always a predictable
   place to look.
3. Before drawing anything tagged with a component identity, resolve it in
   this order: check a configured team library for an already-published
   master with this identity; if not found, check this file's reserved
   components page; if not found there either, this is the first time this
   component has been seen — create it fresh.
4. When creating fresh: draw every captured variant of this component as its
   own labeled draft (one per breakpoint actually captured, one per
   interaction/state scenario Explorer already recorded against it, plus any
   other detected prop-driven variation), name each draft using Figma's
   `property=value` variant-naming convention (e.g. `Breakpoint=Desktop`),
   and combine the full set into one component set via the Plugin API's
   `combineAsVariants()` call, place it on the reserved components page, and
   tag the set with the component's stable identity. `combineAsVariants`
   only accepts actual component nodes (not frames), and every combination
   referenced anywhere must exist as a real variant or Figma's own variant
   picker shows a blank gap for it — which is exactly why step 6 below matters.
5. Every later occurrence of the same component — anywhere in the file, at
   any width or state already covered by an existing variant — becomes an
   **instance** referencing the matching variant in that set, never a fresh
   draw. If a newly-encountered occurrence represents a variant combination
   that doesn't exist yet (a width or state never captured before), add it to
   the existing set rather than creating a second, disconnected component.
6. If a particular combination genuinely has no capture to back it (Explorer
   never recorded, say, a disabled state at a given breakpoint), leave that
   combination out rather than inventing one — note the gap in the run's
   report instead of failing or fabricating content.
7. Cross-file reuse via a real Figma team library: once a human promotes a
   locally-created component into a published library (an ordinary Figma
   action, outside this system), provide one explicit, human-triggered
   action — "register in library" — that records the now-published
   component's library key (the identifier the Plugin API's
   `importComponentByKeyAsync()`/`importComponentSetByKeyAsync()` calls need —
   only assigned once a component is actually published, and only resolvable
   after that point) against its stable component identity. Every subsequent
   run checks that record first (step 3) and imports the real library
   instance instead of recreating anything locally. This is the one step that
   must stay human-triggered, since nothing else can observe that the
   promotion happened.

---

## 4. Color and text style intelligence

**Goal:** a captured fill or text style resolves to an existing Figma style —
local or from a published library — whenever one already matches, instead of
being written as a disconnected raw value; and where a brand-new style has to
be created, it's named after the codebase's own design token rather than a
generic placeholder.

**Steps:**
1. For every captured fill and every captured text style, first check a
   configured team library's published styles for one whose resolved value
   matches (color compared with a small tolerance for rounding; text style
   compared on family, size, weight, line-height, and letter-spacing
   together).
2. If no library match, check this file's own local styles the same way.
3. If still no match, create a new style — and before falling back to a
   generic name, trace the captured value back to the design token that
   produced it (a CSS custom property, a theme/token file entry) and name the
   new style after that token directly, keeping Figma's style vocabulary
   aligned with the codebase's own.
4. Apply the resolved style reference (not a raw value) to the node. Because
   component instances inherit their master's style references, this is what
   makes "change the style once, every instance updates" actually hold.

---

## 5. Idempotency, conflict handling, and verification

**Goal:** running this system again, after the app has changed, is always
safe — nothing gets silently duplicated, and nothing a human has since edited
by hand in Figma gets silently overwritten. "Did we build everything we
scanned" is answerable exactly, including across multiple requested widths.

**Steps:**
1. Tag every node this system creates — screen frames and master components
   alike — with its originating scenario identity, the width it was captured
   at (for frames), its component identity (for components), and a hash of
   the payload used to build it, using the Plugin API's
   `setPluginData()`/`getPluginData()` pair. This lives on the node itself
   inside Figma, because it has to be readable regardless of which surface
   triggered the plugin (see systems 6–8) — plugin data is the one thing
   guaranteed to be there either way.
2. Before creating anything, check for an existing node carrying the same
   scenario+width (or component) tag. If found, compare its stored payload
   hash against the newly captured one.
3. If the hash is unchanged, skip it entirely — no write, which is also the
   main performance win on repeat runs.
4. If the hash changed, and the existing node's current state still matches
   what was last written by this system, update it in place.
5. If the hash changed *and* the node no longer matches what was last
   written — meaning a human edited it in Figma since — do not touch it.
   Record it as a conflict, and the agent must proactively tell the person
   running it exactly which screens/components hit this, rather than leaving
   it to be discovered later in a report file.
6. If a scenario that previously existed has disappeared from the manifest
   entirely, don't delete its Figma node automatically — flag it as orphaned
   for a human to deal with.
7. For verification: define "done" as the set of (scenario, width) pairs
   implied by the requested scope and requested widths. Compare that against
   the set of (scenario, width) tags actually found in Figma for that scope,
   and report the difference directly — which ones are missing, which are
   unexpected — rather than a bare count that can hide exactly this kind of
   partial completion.

---

## 6. The companion Figma plugin

**Goal:** the actual code running inside Figma that turns a capture payload
into real nodes, and that owns every mechanism above — component/style
resolution, variant combination, idempotency tagging, conflict detection —
so every surface that reaches Figma goes through the same logic and can never
drift apart.

**An important correction from the earlier research pass:** this plugin is
not a *fallback* behind a "paste with no plugin" default — it's the only path
that can deliver the actual feature. A plain OS clipboard paste, even with a
perfectly-crafted payload, can only ever produce flat vector/text shapes,
because creating a real Figma component, an instance, a variant set, or a
plugin-data tag all require the Plugin API itself — none of that exists on
the receiving end of a passive paste. Since components, variants, and
idempotency are the entire point of this system, the plugin has to be in the
loop every time something real is being built. A genuinely pluginless
clipboard paste is still worth keeping as a minor, separate bonus capability
(see system 7's note), but it tops out at the same flat-shapes ceiling every
existing "copy website to Figma" tool already has — it is not a path to the
same result as going through the plugin.

**Steps:**
1. Ship as plain plugin source inside this repository, loaded locally through
   Figma's own "import plugin from manifest" — no publishing step required.
2. Give the plugin its own UI panel with an explicit "Build from clipboard"
   (or equivalent) action. The user opens the plugin once and triggers that
   action — Figma plugins cannot silently intercept an ordinary system paste
   gesture, so this one extra click inside an already-open panel is the
   realistic, verifiable mechanism, not a background hook.
3. Inside that action, read the payload produced by the capture engine from
   the clipboard using the browser Clipboard API where supported, or the connected authenticated
   local bridge's native clipboard provider on restricted hosts, and hand it to the interpreter below.
4. Implement the payload interpreter: walk the structured payload from system
   1, and for each node, apply systems 3 and 4's resolution logic (component
   identity → instance-or-create, style value → resolved style reference).
5. Implement the idempotency/conflict pass from system 5 as the first thing
   that runs against any incoming payload, before any node is created or
   modified.
6. Implement the one human-triggered action from system 3 — registering a
   newly-published library component against its stable identity.
7. Implement a small results surface inside the plugin panel so conflicts and
   gaps from systems 3 and 5 are visible immediately, not only in whatever is
   driving the agent-side run.
8. Expose the same interpreter to the agent-driven surface below over a
   **local relay/bridge**: the plugin's UI (an ordinary sandboxed web page
   with network access) opens a connection — authenticated local HTTP polling is the
   implemented transport — to a small relay process running on the same machine. The
   agent's MCP tool calls target that relay, never Figma directly; the relay
   forwards each instruction to whichever plugin instance is currently
   connected, and relays its result back. This is a hard requirement, not a
   design preference: the Plugin API — the only thing that can create a real
   component, instance, variant set, or plugin-data tag — only runs inside a
   live, open Figma session, so *something* has to already be open and
   listening for an outside agent to reach it at all. Concretely, the person
   running an automated batch needs Figma open, the target file loaded, and
   the plugin launched and connected *before* the agent starts that run, and
   the agent must detect and clearly report a dropped connection (file
   closed, plugin closed) rather than failing silently mid-batch.
   `send_code_to_figma` was checked directly and ruled out as this bridge —
   it's Figma's "Code"/"Make" project-import feature and explicitly does not
   create native Design shapes. A bespoke relay (or some other mechanism) is
   still needed — see system 10.

---

## 7. Manual "Copy" control (Explorer UI)

**Goal:** from the Explorer's own screen view, copy one screen — at the
currently previewed width, at the three main breakpoints, or at specific
custom widths — and bring it into Figma as a real, reusable, editable design
(components, instances, variants, linked styles), with no agent involved.

**Steps:**
1. Add a "Copy" control with a dropdown to each screen's view in the Explorer
   UI, offering: the currently previewed width, the three main breakpoints as
   one combined action, or free-form custom width entry.
2. On selection, invoke the capture engine (system 1) for the chosen scenario
   across exactly the requested widths.
3. Package the resulting payload for delivery to the clipboard, structured so
   a multi-width selection produces multiple labeled, side-by-side frames from
   one single build rather than one at a time.
4. Write the payload to the system clipboard.
5. The user switches to Figma, opens the companion plugin, and clicks its
   "Build from clipboard" action (system 6) — the one extra click that gets
   the full feature (components, variants, idempotency), rather than relying
   on Figma's own undocumented native clipboard parsing.

**Optional, separate, minor bonus:** it's possible to additionally format the
clipboard payload so Figma's own native paste (a plain `Cmd+V`, no plugin
click at all) produces *something* — flat vector/text shapes with no
component or variant intelligence, the same ceiling existing third-party
"copy website to Figma" tools already have, and dependent on Figma's
undocumented clipboard behavior (which has visibly changed before for other
tools in this space). Worth doing only as a cheap, no-commitment extra for
quick visual reference — never positioned as equivalent to going through the
plugin, since it structurally can't be.

---

## 8. Agent-driven, folder/group-scoped bulk automation

**Goal:** point an agent at a folder or group, let it build every scenario
found there — any kind, any width set specified — and confirm an exact count
against what Explorer actually scanned, without needing to hand-hold it
screen by screen.

**Steps:**
1. Expose discovery: the agent can ask what folders and groups exist before
   committing to a scope, since not every target app organizes screens the
   same way (some have real directories, some only have logical group
   labels).
2. The agent asks the person running it where results should be placed —
   a specific section, a specific page, anywhere, or one page per
   folder/group — every run, since this is never assumed. The one exception
   is the reserved components page from system 3, which is never part of this
   conversation.
3. The agent lists every scenario in the chosen scope, with no kind filter
   applied — screens, overlays, variants, and navigation states all included.
4. For each scenario, the agent requests the capture engine's payload at
   whatever widths were specified for this run (a named preset, the three
   main breakpoints, specific custom widths, or a combination).
5. Each payload goes through the same companion-plugin interpreter as the
   manual path, over the local relay described in system 6 — not a separate
   implementation — so component/style/variant handling and idempotency
   behave identically whether a human clicked once or an agent is running
   through two hundred scenarios unattended. This requires Figma to be open,
   the target file loaded, and the plugin launched and connected to the relay
   *before* the agent starts the run — the agent is driving an already-open
   session, not launching one. If the connection drops partway (file or
   plugin closed), the agent must say so plainly and stop, rather than
   reporting partial progress as if the run completed.
6. Any conflicts the interpreter raises (system 5) are surfaced back to the
   person immediately, by name, rather than silently skipped or buried in a
   log only the agent sees.
7. At the end of the run, the agent checks the (scenario, width) verification
   set from system 5 against this scope and reports exactly what's missing or
   unexpected, not just a pass/fail count.

---

## 9. Build sequencing (original dependency order)

Dependencies run roughly in this order:

1. **Capture engine (1)** first — nothing else has anything to work with
   until this exists.
2. **Component detection (2)** next, since systems 3 and 4 both consume its
   output; React can land first given it's the immediate target app's
   framework, with the others following per the confidence order above.
3. **Component & variant system (3)** and **style intelligence (4)** can be
   built in parallel once 1 and 2 exist — they're peer systems that both
   consume the capture payload independently.
4. **Idempotency/conflict/verification (5)** wraps all of the above and
   should land before either surface ships, since both surfaces depend on it
   for safety.
5. **The companion plugin (6)** is where 1–5 actually get wired together into
   something that runs inside Figma.
6. **The manual Copy control (7)** and **agent automation (8)** can then be
   built in parallel — both are thin surfaces over the same plugin and engine,
   and neither depends on the other.

---

## 10. Remaining gaps after this verification pass

- 🕒 **Published library QA:** component/set import and paint/text-style import by configured key are
  implemented. Failed imports surface warnings and use local captures. A successful cross-file import
  still needs a published library with the required permissions and stable component mappings.
- 🕒 **Source identity:** unique runtime names resolve against declarations under src; source paths are
  normalized relative to the project, and IDs include project/framework/source/name. Ambiguous names
  and dependencies without source metadata retain runtime identities. Astro scope hashes still need
  source-map/build-metadata resolution for readable source filenames.
- 🕒 **Unobserved variants:** every captured appearance and requested width is represented. Runtime
  capture cannot discover arbitrary component props or states that the app/scenarios never render.
  Comprehensive source-defined variant enumeration and semantic prop names require framework-specific
  source adapters; hashes identify captured appearance variants today.
- 🕒 **CSS fidelity:** gradients, uneven borders/corners, pseudo-element decoration, shadow-root contents,
  complex transforms, rich mixed text runs and tainted canvases are not all modeled. Imported geometry
  uses fixed coordinates; responsive Auto Layout inference is not implemented. Figma/browser font
  metrics may still differ. This is editable reconstruction, not a guaranteed pixel-identical converter.
- 🕒 **Library variables:** paint/text-style matching exists, but automatic color-variable lookup and
  binding across published variable collections does not.
- 🕒 **Very large exports:** messages are batched by component and frame, with an explicit 32 MB message
  limit. Capture/planning still occur in memory; configure a generous MCP call timeout and select a
  narrower scope when necessary. Resumable persistent export jobs remain a future enhancement.
- 🕒 **Release:** test the local 0.5.1 build first; publish only after approval, then replace the test app's local-only link with
  the released version if desired. The current local link remains useful for testing and must not be
  committed into the test app.

## 11. Running the implemented workflow

1. Build the package and plugin with npm run build and npm run figma-plugin:build.
2. Start the target app with the Explorer enabled. The current test app serves it at
   http://localhost:8444/__explorer/.
3. In Figma desktop, import figma-plugin/manifest.json once, then run UI Explorer design import.
   Installed npm packages include the built manifest, code.js and self-contained ui.html.
4. For manual use, open a screen, check all widths to copy, add any named custom widths, and click Copy
   selected. Choose a destination in the plugin and Build from clipboard. If prompted, connect the
   local bridge to enable the button on restricted hosts. Manual paste remains optional.
5. For clipboard access on restricted hosts and for agent use, run web-app-ui-explorer bridge --root
   <app-root>. Expand Connect local bridge and paste the printed connection URL. Keep the bridge and
   plugin open for the session.
6. Install project-local MCP configuration with `web-app-ui-explorer mcp install --client vscode --root <app-root> --base-url <dev-server>` (or `--client codex`). Never reuse a global MCP pointed at another app; see [the MCP guide](mcp-figma.md).
   Discovery can use --route when the Explorer is mounted somewhere other than /__explorer.
7. Ask the agent to list folders/groups, select the scope and widths, and specify the destination in
   natural language. The agent must turn that into an explicit placement parameter before exporting:
   current-page, page by name, existing section by name/ID, or per-folder pages.
8. Use explorer_export_to_figma. The tool captures every selected kind, creates components before
   frames, and returns conflicts, warnings and missing/unexpected scenario-width pairs. Orphaned frames
   are reported rather than deleted.
9. Supply known published component/set keys and paintStyleKeys/textStyleKeys through the libraries
   parameter, or use the plugin's library mappings panel for manual imports. Registration of a selected
   published component stores its stable ID-to-key mapping for this plugin on this machine.

The bridge uses authenticated HTTP polling on a loopback-only server, not a hosted service or a
connector-specific write tool. It writes an ephemeral connection record under the app's ignored
.ui-explorer directory, rejects unauthenticated requests, and reports a closed plugin instead of
claiming a batch completed. Figma's development manifest allows http://localhost:5198 as documented in
[the official plugin manifest reference](https://developers.figma.com/docs/plugins/manifest/).

## 12. Local test handoff (2026-10-18)

- The Design-Team-Web-App-V3 dependency resolves through its local link to this checkout at version 0.5.1.
- Updated preview: http://localhost:8444/__explorer/ (347 scenarios returned by the live API).
- Browser check on the real Hiring home screen copied desktop and a saved 1366px custom view together,
  produced 18 component identities, and recorded no browser errors.
- The full automated suite passed 77 tests; one HTTPS test was skipped because OpenSSL is unavailable.
  Main TypeScript checks and the separately typed/bundled Figma plugin also pass.
- Re-run the development plugin after rebuilding so Figma loads the current code and panel.
- npm publication is deferred until the local test is approved.

## 13. Clipboard root-cause investigation (2026-10-18)

The live Figma Beta plugin iframe reported secureContext=false, Clipboard API unavailable,
clipboard-read policy=false, documentFocused=true, and userActivation=true when Build from clipboard
was clicked. The original direct navigator.clipboard.readText call therefore failed because
navigator.clipboard was undefined. This is a host capability restriction, not loss of the button's
click gesture. The deprecated document.execCommand("paste") path was also tested from the real click
and was not permitted. That unsuccessful probe was removed.

Build from clipboard now detects the unavailable API and uses the authenticated local bridge as a
native clipboard provider. The bridge reads only on an explicit button request from its connected
plugin client, validates the Explorer export marker and plan, and rejects unrelated clipboard text
without returning it. Browser clipboard reading is still used directly on hosts that support it.
The bridge process must remain running and connected on restricted hosts; changing plugin HTML or
the manifest cannot grant a permission denied by the embedding host.

The real Windows clipboard read and native button submission were verified in Figma Beta. That
exposed a separate importer error when inspecting instances of an invalid component set. Single
masters now regain their breakpoint variant name when promoted into a set, all generated siblings
receive consistent property keys, and unreadable existing instance properties protect affected
content instead of aborting the entire import. Regression tests cover both cases.

The live main-button import completed on the existing Page 5, created home-default at 1366px, and
preserved the pre-existing 1440px frame as a conflict. The 390px frame was reported as outside this
two-width request. The final targeted bridge, sandbox UI and importer suite passed all 10 tests,
and plugin typechecks passed. A broad parallel run passed 79 tests, skipped the unavailable-OpenSSL
check and hit a Copy timing timeout; that entire Copy test file passed when rerun separately.
Large builds now yield periodically so the host can process UI work between captured layers.

References: [Figma showUI options](https://developers.figma.com/docs/plugins/api/properties/figma-showui/)
and [Chrome Permissions Policy](https://developer.chrome.com/docs/privacy-security/permissions-policy).

## 14. Layout fidelity corrections (2026-10-18)

The Role settings import exposed capture and rendering defects despite successful frame creation.
The capture now retains visible absolute descendants of zero-height containers (including the Steps
panel), excludes clipped accessibility-only text, records the actual text layout box inside padded
controls, and wraps screen captures in the clipped viewport rather than the document's scroll height.
Browser overflow is retained on imported frames. Scientific-notation pill radii and one-sided borders
are captured instead of becoming square controls or disappearing dividers.

Inline SVG paints are resolved to explicit RGB values; embedded SVG images carry their rendered
viewport dimensions, and imported vector paths scale with their viewport. Component appearance
matching includes relative child geometry so equal-size components with different internal layouts
are not incorrectly shared. Protected local masters fall back to captured layers when necessary.
Fingerprint versions keep older unedited imports eligible for updates as new visual properties are
added, and component edit decisions are captured before dependency updates propagate into instances.

The authenticated bridge can render an imported frame as PNG for visual comparison. A bounded busy
lease lets acknowledged builds finish when Figma temporarily blocks its iframe heartbeat; explicit
disconnect remains immediate. Local clipboard builds use the same lease. The final targeted capture,
planner, bridge, sandbox UI and importer suite passes 20 tests; both plugin TypeScript checks pass.

Live verification updated the existing role-settings frame (184:14513) on Page 5 in place. Its final
PNG is 1440x900 and was compared with a browser render at the same viewport. Logo/navigation icons,
Steps, control padding, pill switches, dividers and viewport clipping are restored. Zero-line-height
superscripts also receive finite text coordinates so required markers remain visible. Three older
component masters remained protected; the frame uses captured layers for those conflicts.

The full automated suite passes 84 tests with one HTTPS/OpenSSL availability skip. Main TypeScript
and both plugin TypeScript checks pass. Changes remain linked locally into Design-Team-Web-App-V3;
npm publication remains deferred.

## 15. Component naming correction (2026-10-18)

Updating a standalone master previously assigned its variant label (for example Breakpoint=Desktop)
as its node name. The source component name was restored only during first creation, so subsequent
updates exposed breakpoint labels as top-level asset names. Standalone masters now keep source names;
only variant children inside named component sets use property labels. New instances also use their
source component name as their layer label.

Imports repair known generated names using stable component IDs. An authenticated naming-only bridge
command can repair older imports without rebuilding geometry, replacing IDs or removing instances.
Custom names, published remote masters and correctly named variant children are preserved. Existing
edit baselines are retained only for content that was unedited before the naming repair.

The live repair restored six masters (RoleDetails, AvatarRootContext, PublishedRoleBanner,
SetupHistoryButton, SetupStepper and ScenarioPreview), with no unresolved top-level breakpoint names.
The plugin/bridge regression suite passes 11 tests and both plugin TypeScript checks pass. Names such
as FieldRootContext still reflect detected framework implementation components; this correction does
not claim semantic filtering or a curated design-system taxonomy.

## 16. Local project browser and bulk canvas layouts

The companion panel now has Local project and Clipboard entrypoints, with Figma light/dark theme
colors. A bridge started with `--root <app-root> --base-url <running-app-url>` exposes the running
Explorer catalog, including curated states. The panel browses exact folder boundaries, searches
registered screens, supports subset selection and exact screen IDs, and previews the selected
screen/state-by-width count. Preset and custom widths are validated and deduplicated.

Local imports use a managed named section inside the chosen destination. Horizontal and grid layouts
support spacing; grids also support columns. Ordering is stable by normalized source path, exact ID,
then descending width. Re-imports retain frame and section identities, protect manual edits and moved
frames, report coverage differences and keep orphaned content. The target page is pinned at run start;
completed sections are selected and revealed only if that page is still active.

The panel and MCP share discovery, selection, capture, component batching, layout and verification.
`explorer_export_to_figma` accepts `placement.container` and `layout` (`mode`, `columns`, `gap`).
Capture coverage is checked against the requested pairs before frames are written. Authenticated local
jobs return immediately, expose progress/results, reject concurrent exports, support cancellation and
release their run on failure. Cancellation closes an active capture browser or stops after the current
acknowledged Figma operation; previously created content remains. MCP batches also keep the panel busy
and retain a combined final report. Temporary polling failures retry without losing the active job.

Large live batches exposed UI timeouts and repeated whole-document fingerprint scans. Polling/result
requests allow for long Figma operations, while edit baselines and the component index are reused
within a run. Legacy naming repairs avoid fingerprinting the document when no repair is needed.

Validation: the full suite passed 89 tests with one OpenSSL-dependent HTTPS test skipped. After the
final feature and recovery changes, all 22 focused bridge, local-import, MCP, sandbox UI and renderer
tests passed. Both plugin TypeScript checks and the main project typecheck passed. Light/dark panels
were visually inspected, with fixed-footer and scroll checks at 320px and 400px widths.

Live Figma verification used Hiring home and Role settings at 1440px and 390px on the existing open
page. All four frames appeared in section `UI Explorer bulk import QA` (188:28690), with exact coverage.
The two-column grid placed frames at (40,40), (1560,40), (40,1020), (1560,1020). A subsequent horizontal
import preserved all four frame IDs and the section ID, verified one row with 80px gaps, and was then
restored to the grid. Live cancellation was also verified. Three previously edited component variants
(AppSidebar desktop/mobile and Header desktop) were protected and reported; there were no asset or
font warnings. This verifies batch behavior and observed screens, not complete CSS fidelity or every
registered state in the app. The local package remains linked into Design-Team-Web-App-V3.

## 17. Progressive disclosure and typography

The panel now opens at 540 by 820 pixels with more generous spacing and a two-step local workflow:
Choose screens, then Import settings. Before connection it shows only setup. After connection it
reveals source controls, and a chosen folder reveals search and selection. Continue opens widths,
destination and layout; Back preserves the user's choices. Current open page is the default
destination, with name fields shown only for named destinations. Single-frame imports hide layout,
horizontal rows hide columns, and custom widths, spacing and published-library mappings stay collapsed
until opened. Invalid JSON mappings and spacing errors reveal and focus their relevant controls.

Plus Jakarta Sans variable WOFF2 subsets from Google Fonts are embedded into the generated UI HTML.
The build uses checked-in assets, and the font renders without runtime network requests. The source
URL and SIL Open Font License are retained under figma-plugin/assets; the license ships in the package.
The browser suite verifies the actual bundled font loads, disclosure gates, back navigation, counts,
clipboard imports, MCP batches and cancellation. All 13 focused plugin/UI tests and all TypeScript
checks pass. Light/dark screenshots and fixed-footer overflow checks cover 320, 400 and 540px widths.
The larger panel, connection disclosure, exact-ID selection and Continue-to-settings flow were also
checked live in Figma. No canvas import was needed for this UI validation.

## 18. Explorer-owned import requests

This replaces the source-browser workflow described in sections 16 and 17. Folder selection, screen
and state subsets, and viewport widths now belong to Explorer. Build in Figma opens a review dialog
from the selected gallery folders/search or a single-screen preview. Preparation validates explicit
IDs, starts a loopback bridge on a free port, and retains a copy of the selected scenario definitions,
widths and custom breakpoint labels. No capture or Figma write occurs during preparation.

The short `UIX1:<port>:<session credential>:<request ID>` code locates that request without a registry,
external service or manual bridge command. Only localhost addresses can be reconstructed. Requests
expire after one hour, are bounded to 100 per session, and disappear when Explorer closes. Codes can
be reused for re-imports while valid. Existing source code/assets are captured at build time.

The plugin accepts the code, connects and fetches only its request summary. It has no folder, ID,
catalog or capture-width picker. Destination, managed section, grid/horizontal layout, spacing and
published-library settings remain canvas concerns. The import endpoint resolves the saved selection
server-side; submitted replacement IDs/widths cannot change it. Existing bounded build messages,
coverage verification, edit protection, cancellation and polling recovery are reused.

Manual bridge connections remain in Advanced connection for clipboard imports and MCP. Existing
catalog and direct import endpoints remain compatible for tools, but the plugin does not browse
them. Explorer's bridge closes with its owning dev server. Static snapshots disable preparation.

Automated verification exercises a real Explorer/bridge/capture pipeline with a simulated Figma
consumer, selection tampering, reusable codes, expiry, cancellation, custom widths, clipboard denial,
and the sandboxed plugin. Live Figma verification is left to the user; no desktop automation is used.

Validation: main and plugin typechecks/builds pass. The regression run covered 97 cases, with one
OpenSSL-dependent HTTPS case skipped. It exposed a 32px/36px preview-toolbar height mismatch from
the new action; that was corrected and all 13 affected preview, copy, handoff and sandbox UI tests
passed on rerun. Explorer dialogs were inspected at desktop and 320px widths; plugin menus were
checked in light/dark themes at 320, 400 and 540px. The package remains linked locally into
Design-Team-Web-App-V3; no npm publication was performed.

## 19. Individual card selection

Gallery cards place a persistent checkbox beside the title in the caption, entirely below the
thumbnail. Canvas cards use the same control in their title row. Selecting a card does not open its
preview, pan or rearrange the canvas, or change thumbnail geometry. Selected cards receive a subtle
brand outline. Controls support keyboard selection and keep text/checkboxes vertically centered.

Folder rules and search scope browsing. Explicit screen IDs form the export batch; Select visible
adds current results, while Clear selection clears the batch. A selection bar reports the total,
including screens outside the current search/folder. Selection survives view changes and session
reloads; entries removed from the live catalog are excluded from export. Build in Figma is disabled
for an empty batch, then reviews exactly those screens with capture widths. The review does not ask
the user to choose the same screens again. Single-screen preview exports remain available.

## 20. Workbench disclosure and responsive search

The idle header now contains the workspace title and a single Workspace menu. Active discovery or
capture exposes progress and Stop only while running. Discovery, Return to UI, workspace metrics and
source controls live in the menu; keyboard help is collapsed. Build in Figma appears in the selection
bar only when a batch is selected, alongside its count and Clear selection.

Source choices are now Registered, Discovered and All screens, with descriptions on each choice.
Registered refers to project-supplied scenario definitions; Discovered refers to crawler-generated
entries. All screens combines the catalogs. The source picker appears only when both types exist,
and workspace counts describe the chosen catalog rather than the currently browsed folder.

Search uses a flexible, bounded field with an independent desktop keyboard hint. Below 768px it takes
the full row beneath the view switch, with 16px input text. Header/menu sizing and live-job controls
also fit narrow viewports. Tests cover 320, 390, 540, 768, 800, 1024 and 1440px, complete search prompts,
page overflow, busy status, source switching, contextual export and menu action behavior. Six focused
toolbar, keyboard and handoff checks pass, along with the main typecheck and client build.

## 21. Import API compatibility and text-button hover

A read-only catalog request and an invalid-body validation probe against the running local app
confirmed that its interface was newer than its in-memory API: the catalog worked but the import
endpoint returned plain-text HTTP 404. Reading that response unconditionally as JSON exposed a parser
error. Refreshing browser assets does not replace a running Node plugin instance.

Live state now advertises import capability version 1; static snapshots advertise no import support.
The preparation dialog detects older servers, disables preparation and explains that the app's dev
server must restart before refreshing Explorer. A shared response reader handles plain-text errors
and preserves structured API messages for both handoff preparation and legacy design copying.
Malformed successful handoffs are rejected, and single-frame counts use singular wording.

Neutral ghost and compact text buttons use the same brand-tinted hover background/text colors.
Padding is established in the default state, so hover no longer shifts button or neighboring text
geometry. Danger text actions retain their semantic red color and also keep stable geometry.

## 22. MCP setup, client presence and dropdown text

The [MCP-to-Figma guide](mcp-figma.md) is the setup reference for model clients. It covers the stdio
command, matching project root and running app URL, connecting the plugin through Explorer's Figma
connection section, tool discovery and export arguments. The workflow imports registered screens;
it is not an unrestricted Figma scripting service. A configured client calls the export tool directly;
no separate plugin trigger is required once the plugin is connected.

An initialized MCP session now reports its client name to the authenticated bridge every five
seconds. The plugin shows this separately from bridge connectivity and import progress, including
when a client is connected before any export. Multiple clients can be listed. Normal disconnects
remove presence and crashed clients expire after 15 seconds. Missing or older bridges do not block
offline MCP discovery; presence retries when Explorer becomes available. Client names identify the
connected software, not the particular model running in it.

Selected dropdown labels use a complete line box. Applying cap-to-baseline text trimming together
with hidden overflow had clipped descending letters in labels such as Current open page. Horizontal
ellipsis remains available for labels that actually exceed the available width.

Verification covers real stdio initialization/discovery, capture and export routing with exact
coverage, late bridge startup and presence displayed in the built plugin, normal disconnect, stale
presence expiry, and dropdown label bounds in both themes at narrow and normal widths. Plugin
rendering uses a simulated Figma API; this pass does not claim a new live-canvas check.
