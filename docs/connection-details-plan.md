# Canvas connection details

## Problem and outcome

Canvas connections currently reduce a transition to optional, truncated SVG text. A label such as “Get the app” cannot explain whether the source control was a link, button, field, or an automatic event. Some declared connections have no label at all. The crawler already observes control roles, but discards them when saving its parent connections.

Keep one short label per line. Hover or keyboard focus reveals a compact connection-details popover; clicking or pressing Enter/Space pins it until Close or Escape. The details identify the source and destination and show the action or ordered action sequence. Missing evidence is stated clearly instead of guessing an action type.

## Design and compatibility decisions

- Add optional, plain-data transition details to declared connections and discovered parent links. A step has an extensible event type, a human label, an optional observed control role, and optional explanation. This supports buttons, links, forms, choices, keyboard events, hover and explicitly declared automatic events without changing the replay action protocol.
- Newly discovered connections preserve observed roles and every intermediate step, including opening a listbox, choosing an option and completing a form. Store human action summaries separately from replay recipes. Never copy filled values, passwords or selector strings into the detail payload or render them in the panel.
- Older catalogs remain valid. Derive only the recipe suffix after a verified parent-prefix match; identify this as saved-recipe evidence. Native/ARIA roles may be inferred only from unambiguous target selectors. Unrelated recipes and label-only connections retain an explicit unknown-trigger explanation. Never infer automation from missing actions or labels.
- Author-supplied details are authoritative. Explicit connections for a parent pair replace its generated parent edge; distinct explicit parallel connections remain distinct. Every visible connection receives a useful label or an honest “View connection” fallback. Metadata edits with unchanged counts must refresh the canvas.
- Use the existing Base UI popover for hover intent, safe pointer movement, collision handling, focus management and dismissal. Use React Flow's HTML label portal for accessible native buttons. The expanded panel is portalled outside the graph transform, with a bounded width/height and wrapping for long text.
- One shared popover per canvas, rather than one expanded panel per edge. Hover is temporary; click pins the active connection. Hovering elsewhere and panning cannot replace a pinned connection. Clicking another label switches the pinned detail. Close and Escape dismiss it; filter/removal of the underlying connection clears obsolete details. Preserve meaningful selection and the existing foreground-only hover styling.
- Keep a stable screen-space anchor when pinned so graph zoom/pan and edge virtualization do not remove the inspection panel. Reflow within the viewport on resize. Hover does not take keyboard focus; explicit activation allows keyboard access to Close and the panel contents. Touch uses activation without depending on hover.
- This feature reads captured evidence. It does not execute an action, contact a backend, navigate the app, or add any Figma capability.

## Execution steps

1. Add the optional shared types and a pure connection-description resolver. Cover recorded, declared, legacy, unknown, multi-step, long-label and private-value cases with meaningful model tests.
2. Carry per-connection step summaries through crawl queues, listbox expansion and autofill. Preserve the existing replay recipes. Verify real DOM button/link/field/option roles survive crawl serialization without filled values in the new payload.
3. Normalize parent and explicit connections without losing author descriptions or parallel edges. Retain full text for details while reserving compact label dimensions in ELK. Refresh layouts/data after same-count metadata edits.
4. Build the shared hover/pin popover and native edge-label buttons. Implement pointer, focus, Enter/Space, touch activation, explicit Close/Escape, pin replacement, filtering cleanup and viewport-safe positioning.
5. Add restrained styles: white compact labels, blue foreground feedback, a clear From/To hierarchy, ordered action steps, provenance/missing-evidence text and a small pinned indicator. Keep technical selectors and filled values out of the product UI.
6. Build and typecheck. Run focused model/crawl/browser tests, then the existing UI suite and full package suite. Fix regressions while preserving the previous hover work already in the checkout.
7. QA the real PaidHR preview on port 5200, including its old 52-state catalog. Verify a legacy “Get the app” connection, hover dismissal, click pinning, close/focus return, zoom/pan, filtering and desktop/mobile bounds. Review screenshots and retain evidence in the ignored `.ui-explorer` folder. Refresh stale thumbnails when needed to make the preview reviewable.
8. Record final results here and provide the live preview and remaining evidence limits. Leave publication for a separate release request.

## Validation matrix

| Area | Cases |
| --- | --- |
| Evidence | Captured button/link/field/option, explicit automatic event, custom event, ordered form/listbox steps, older prefix recipe, mismatched recipes, no metadata, no label, parallel edges |
| Privacy | Filled values and password-like selector contents never appear in connection details or the new capture metadata |
| Interaction | Hover/open/leave, pointer into popup, focus/open, Enter/Space/click pin, touch activation, explicit close, Escape, outside interaction while pinned, switch connection |
| Canvas | Pan/zoom, virtualized trigger, filter/removal, same-count label/detail update, long labels, cycles and parallel routes, bounded single active panel |
| Accessibility/layout | Native button names, dialog title, focus return, visible focus rings, no accidental canvas drag, 320/390/768/1440px widths, no clipping or horizontal overflow |
| Regression | Existing label placement, canvas zoom/selection, previews, modal hierarchy, capture/replay, snapshots and browser errors |

## Design guidance review

The guidance in both linked subdocuments was read for the final design review. This request is covered by existing principles; it does not require an addition to the canonical guidance.

| Decision | Supporting rule and application |
| --- | --- |
| Short line labels with details on demand | [4 · Reveal complexity when it becomes useful](https://app.notion.com/p/3fd964279f8d81929a2dec91a30a3737) keeps the canvas concise while preserving access to action evidence. |
| Source/destination context and one anchored panel | [4 · Keep revealed content connected](https://app.notion.com/p/3fd964279f8d811dbe0bff1648d85946) keeps the explanation tied to its connection as the canvas moves. |
| Hover preview, explicit pinning, close/Escape and unknown-evidence copy | [5 · Keep people informed and in control](https://app.notion.com/p/3fd964279f8d81929a2dec91a30a3737) supports deliberate inspection without claiming missing action details. |
| Native labels, keyboard activation, touch and named close control | [5 · Use the simplest clear action control](https://app.notion.com/p/3fd964279f8d811dbe0bff1648d85946) and [6 · Be consistent and inclusive](https://app.notion.com/p/3fd964279f8d81929a2dec91a30a3737) make the feature usable without hover. |
| Heading, From/To rows, action sequence and subdued provenance | [2 · Give text a clear hierarchy](https://app.notion.com/p/3fd964279f8d811dbe0bff1648d85946) distinguishes names, relationships, actions and supporting evidence. Shared gaps and aligned rows apply **3 · Align related content and let groups manage spacing** on the same page. |
| Flat panel, restrained foreground hover and preserved selected states | [1 · Use as little nesting as necessary](https://app.notion.com/p/3fd964279f8d811dbe0bff1648d85946) and **8 · Use colour and decoration deliberately** avoid repeated cards and competing blue backgrounds. |
| Virtualized graph, one panel, wrapping and bounded scrolling | [7 · Plan for large amounts of content](https://app.notion.com/p/3fd964279f8d811dbe0bff1648d85946) is checked with 120 states, long labels/descriptions and persistent access to Close. |
| Real preview and input/viewport coverage | [10 · Check every state and related screen](https://app.notion.com/p/3fd964279f8d811dbe0bff1648d85946) requires rendered review beyond merely passing code checks. |

## Implementation references

- [Base UI Popover](https://base-ui.com/react/components/popover): controlled state, multiple triggers, hover opening and event reasons.
- [Base UI Tooltip guidance](https://base-ui.com/react/components/tooltip): interactive hover panels use Popover.
- [React Flow EdgeLabelRenderer](https://reactflow.dev/api-reference/components/edge-label-renderer): HTML labels need explicit pointer events and `nodrag nopan` classes.

## Results

All eight implementation steps are complete. Connection labels now open one shared, readable inspector on hover or keyboard focus. Click, Enter, Space or touch pins it; Close/Escape dismisses it. The panel shows full source/destination names, ordered actions, control types and evidence provenance. Preview opening or removal of the connection clears the obsolete inspector.

The optional metadata is retained through exploration, autofill, saved catalogs, API responses and static snapshots. Existing catalogs use conservative replay evidence; author-supplied details and parallel connections are preserved. New detail summaries omit entered values and selector strings. Missing evidence stays explicit, and automation is shown only when declared.

### Validation evidence

- Build and TypeScript checks passed. Final `npm test`: **159 tests, 158 passed, zero failed, one OpenSSL-dependent test skipped** (147.96 seconds). This includes every test in the UI suite and the five new connection-detail cases. `git diff --check` passed.
- Five focused tests cover the resolver, explicit/parallel edges, saved API/static metadata, real DOM crawl serialization, and browser interactions. The larger fixture has 120 states and 119 connections with one shared inspector. The browser fixture also includes cyclic and parallel routes.
- Pointer, keyboard and touch checks cover temporary hover/focus, movement into the panel, pinning, switching, Escape/Close, focus return, canvas panning/zooming, virtualized labels, filtering, preview dismissal and same-count metadata updates. Long content and 320/390/768/1440px layouts were checked for bounds and horizontal overflow. The header remains outside the scrollable body so Close is always available.
- Real PaidHR review: all 52 thumbnails refreshed successfully; zero failed captures and zero browser errors. Its legacy **Get the app** connection shows **Click “Get the app” · Link**, identified as saved replay evidence. Hover, pin, close, zoom, filtering and viewport checks passed against the running preview.
- Rendered screenshots were inspected and two interaction defects were fixed during QA: a virtualized pinned anchor failing to reflow after resizing, and focus return reopening a just-closed panel. Long-content review also led to separating the persistent header from the scrolling body.
- Review server: <http://127.0.0.1:5200/__explorer/?view=canvas>. Select **Homepage** and **Employee pages** under Components to inspect the Get the app connection in a smaller graph.
- Local QA evidence: `.ui-explorer/connection-paidhr-qa.json`, `connection-paidhr-hover.png`, `connection-paidhr-pinned.png`, responsive screenshots, `connection-details-sequence-320.png`, and the reusable ignored review/QA scripts. The new regression suite is `test/connection-details.test.mjs` and is included in `npm run test:ui`.

### Remaining boundaries

Older captures cannot recover control semantics that were never recorded; conservative inferred details are marked as incomplete. Explore again to obtain observed metadata, or supply `transitions[].details` for application-specific events. Connection inspection does not execute actions. The initial preview used this local checkout; release and consumer rollout are recorded below.

### Action typography refinement

The control type is now part of the action sentence, for example **Click the “People & onboarding” link**. It no longer occupies a separate hanging caption. Known controls use the same sentence pattern across buttons, links, fields and choices; uncertain control evidence remains explicit inline. Single actions omit numbering, while multi-step sequences retain their ordered structure.

The connection name is the primary heading (14px/600); the generic panel heading and pinned status are quieter supporting context (12px and 11px). Action names are regular body text with restrained emphasis on the target. These choices apply [2 · Give text a clear hierarchy](https://app.notion.com/p/3fd964279f8d811dbe0bff1648d85946), [3 · Align related content and let groups manage spacing](https://app.notion.com/p/3fd964279f8d811dbe0bff1648d85946) and [3 · Make relationships and importance visible](https://app.notion.com/p/3fd964279f8d81929a2dec91a30a3737). The existing rules fully cover this feedback; no canonical guidance change is needed.

Refinement validation: build/typecheck and all five connection tests passed, including keyboard/touch/pin behavior and a long multi-step sequence at 320px. PaidHR hover, pin, zoom, close, filtering and responsive checks passed at 320/390/768/1440px with no browser errors. Rendered desktop/mobile screenshots were reviewed for hierarchy, alignment and wrapping.

## Release 0.5.4

This release includes the optional connection evidence model, captured control/action summaries, backward-compatible legacy interpretation, hover/pin inspection, action-sentence hierarchy and the foreground-only hover refinements. Publication uses the repository's version-tag workflow, which builds both package and plugin, runs tests, and publishes to npm. The plan ships with the package alongside its README.

The initial pre-release validation passed: package typecheck/build, plugin typecheck/build, package-content inspection and a full suite rerun. An earlier run had one navigation-modal replay timeout; the isolated case and full rerun passed without changing the test or implementation. The release workflow then reproduced the problem, as described below.

The attempted `v0.5.3` release was blocked by CI before npm publication because the navigation-modal failure recurred. An instrumented browser reproduction identified its cause: one background thumbnail called `history.back()`, and Chromium traversed a different iframe's history in the same tab. The foreground replay consequently resumed on the wrong document. The trace and reproduction are retained locally in ignored QA artifacts.

Opening a screen preview now suspends live background thumbnails through shared preview activity context. Cached images remain visible, preview budget slots are released, and live fallback thumbnails resume when the preview closes. This applies to both gallery and canvas without changing captured replay recipes or the host app's history API. The regression test first failed with eight active background frames, then passed with those frames suspended, the destination interactive, and thumbnail activity restored after closing.

This correction applies [8 · Treat the experience as a whole](https://app.notion.com/p/3fd964279f8d81929a2dec91a30a3737) by resolving the shared thumbnail behavior, and [10 · Check every state and related screen](https://app.notion.com/p/3fd964279f8d811dbe0bff1648d85946) through the real multi-frame navigation case. It does not introduce a new canonical rule. The existing `v0.5.3` tag is preserved; `v0.5.4` carries the correction.

The corrected preview passed nine consecutive focused runs. The final 0.5.4 typecheck/build and full suite passed: 159 tests, 158 passed, zero failures, one OpenSSL-dependent skip (161.68 seconds). No timeouts or assertions were weakened.

After the Explorer repository and npm release are pushed, the consumer rollout updates the PaidHR marketing source app first, then Design Team Web App V3. Both use the registry release and updated lockfiles. Existing local guidance, test updates and Explorer configuration are included in their reviewed commits. PaidHR web-app is explicitly excluded: its original `develope` branch and pending changes are preserved, with no dependency update, commit or push for that repository.
