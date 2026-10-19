# Navigation-safe discovery and replay

## Problem and acceptance criteria

UI Explorer 0.5.1 executes a complete recipe inside one browser document. Ordinary links replace that document, destroying the awaited JavaScript call. The crawler retries successful navigations as failures; browser previews also lose their recipe and ready signal. PaidHR exposes the failure: 46 working routes, but one recorded screen and 52 failed replays.

The correction must support complete document loads, redirects, client-side routing, and interactions after navigation. Crawling, interactive previews, thumbnails, editable captures, and static exports must agree on the recipe's final state. Existing scenario JSON must remain valid. Source-file inventory is not a route manifest and must not become one as part of this change.

## Architecture

Use a browser-runtime replay job with an explicit identity, current step, deadline, and terminal result. The Node crawler starts that job and observes completion across document replacements instead of awaiting a Promise belonging to the old page. Existing in-document replay remains available for callers that use it directly.

When a running action unloads the document, save a short-lived continuation in origin-scoped session storage. Use an independent key for each preview frame: same-origin iframes share their tab's storage. Save the next step only after dispatching the current action; a replacement document consumes the continuation once, waits for scripts/content, and continues. Preserve the preview identity and Explorer endpoint across redirects, including custom endpoints and static exports. Clear continuation state on completion, failure, expiry, and explicit cancellation. Never carry credentials or a recipe in navigation URLs or change the application's links.

Distinguish native link/form navigation from cancelled events used by SPA routers. Native navigation must not finish a recipe merely because the old DOM became quiet before the response arrived. Document lifecycle events cover programmatic navigation. Storage failures must produce an actionable replay failure when continuation is needed. Jobs must be bounded and independent across tabs. External navigation must not cause the crawler to explore another origin.

## Execution steps

1. Trace runtime activation, action execution, crawler retries, preview readiness, capture consumers, static injection, and error reporting. Confirm the minimal reproduction against the installed package.
2. Add shared replay job types and the runtime lifecycle. Implement one-shot continuation, native navigation detection, readiness after document replacement, bounded execution, and cleanup. Preserve the existing recipe schema and direct replay API.
3. Change crawler orchestration to start and observe an identified job across navigation. Keep genuine action errors and retry behavior; prevent external document traversal and dispose browser work on cancellation.
4. Route preview startup and continuation through the same replay lifecycle. Verify thumbnails and editable capture consume the destination's readiness; ensure live interaction after completion does not restart a recipe.
5. Add regression fixtures and browser tests covering a multi-page site, redirects, delayed navigation, multiple document transitions, fills and dialogs after transitions, SPA history changes, hash links, GET forms, explicit failures, stale state, independent tabs, custom Explorer paths, and static snapshots. Include capture and actual gallery/modal checks.
6. Build and typecheck. Run targeted regressions, then the full existing suite and applicable bundler/framework checks. Investigate every failure; distinguish pre-existing environmental failures with evidence.
7. Run an isolated patched Explorer against the existing PaidHR development server. Compare discovered URL coverage against all 46 handoff routes, inspect missing routes, verify representative destination previews at desktop/mobile sizes, and capture representative thumbnails/editable designs. Do not replace the user's existing installation or saved catalog during QA.
8. Record implementation details, exact validation outcomes, remaining limitations, and reproducible commands in this document. Review the final diff and repository status.

## QA principles

- Assert destination URL and visible content, not just absence of exceptions or HTTP success.
- Assert recipes execute each step once and never silently omit actions after a page load.
- Exercise real browser navigation through the standalone proxy as well as existing SPA/framework tests.
- Use temporary workspaces and isolated ports; clean up browsers, listeners, and generated fixtures.
- A completed crawl can still be incomplete: inspect failed replay counts and route coverage explicitly.

## Progress

- Plan written before implementation. Baseline: the installed 0.5.1 package records only the first page of a two-page native-link fixture.
- Implemented `src/runtime/replay.ts`: identified jobs, one-shot document continuations, independent frame keys, native event handling, history-cache restoration, cancellation, explicit errors, expiry, and a remaining-duration budget that also works when editable capture freezes the clock.
- Updated crawler orchestration to observe job completion in the destination document. Cancellation and time budgets close in-flight browser work. External top-level navigation is blocked independently of the write policy.
- Added destination metadata to link candidates. The queue prioritizes unvisited URLs over repeated shared links, retaining deferred interactions rather than discarding them.
- Unvisited destinations also bypass the learned repeated-control cutoff. A generic link label reused by a catalog cannot suppress later detail pages simply because the same label has already worked eight times.
- Previews resume through the same controller; thumbnail, editable capture, and static-export consumers retain their existing ready/error contract.
- Added visible catalog warnings for failed replays and state/time limits, including saved crawl statistics after a server restart.
- QA found and corrected two additional bugs during implementation: delayed runtime loading allowed sibling iframes to consume each other's checkpoint; absolute performance-clock deadlines were incompatible with frozen-clock editable captures. Both have regression coverage.
- Real PaidHR mobile QA also exposed viewport-dependent navigation recipes. Discovered scenarios now retain `replayViewport`; interactive previews, thumbnails, and editable captures reach the recorded state at that viewport before resizing. Registered scenarios and custom URLs retain their existing behavior unless explicitly configured. A mobile-first capture and a Mobile-preset reset have regression coverage using a link hidden by mobile CSS.

## Reference semantics

- [Playwright page initialization and navigation](https://playwright.dev/docs/api/class-page): runtime initialization runs for replacement documents; an evaluation belongs to its current document.
- [Session storage scope](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage): origin and tab scope requires additional isolation for sibling preview frames.
- [Document pagehide lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event): continuation is written on document departure; restored history documents use `pageshow` to resume.

## Validation results

| Check | Result |
| --- | --- |
| TypeScript | `npm.cmd run typecheck` passed. |
| Production and declaration build | `npm.cmd run build` passed. |
| Full automated suite | 154 tests: 153 passed, 0 failed, 1 skipped. The skipped HTTPS fixture requires OpenSSL, which is unavailable on this machine. |
| Generic repeated-label regression | Before the correction: 21 states and four valid destinations skipped despite a completed crawl. After the correction: the final detail page is reached and the regression passes. |
| Automatic PaidHR route coverage | 46 of 46 declared routes, 52 recorded states, zero failed replays; final coverage run took 59 seconds. The harness then intentionally cancelled further exploration. |
| PaidHR thumbnails | All 52 recorded states captured successfully through the actual thumbnail API; zero failures. |
| Desktop/mobile visual QA | Platform, Pricing, Employees, Hiring, and Research checked at 1440px and 390px, with destination URLs/headings asserted and all ten screenshots visually inspected. |
| Editable design capture | Platform captured at 1440px and 390px; expected destination content present, zero capture warnings. |
| Actual gallery/modal | Opened the captured Platform state, verified its identity and content, switched to Mobile, reset, and verified the completed 390 x 844 preview. Desktop and mobile modal screenshots visually inspected. |
| Browser exceptions | Zero page errors in the final live visual/modal pass. |

The full suite includes native multi-page sites, Vite, esbuild, plain Node, React, Vue, Angular, Svelte, Astro, Web Components, custom preview URLs, static snapshots, thumbnail/design captures, gallery interaction, responsive presets, MCP, and importer regressions. It also exercises expired/disabled storage, sibling iframe isolation, slow navigation, redirects, history restoration, GET forms, post-navigation input/dialogs, errors, cancellation, and deadlines. The final clean run is authoritative; a preceding run interrupted by a long host pause was discarded and its affected checks rerun.

Live evidence is in `.ui-explorer/navigation-qa/summary.json`, `thumbnails/manifest.json`, `designs.json`, the ten page screenshots, and `paidhr-gallery-modal.png` / `paidhr-gallery-mobile.png`. Automated build/typecheck/test logs are retained alongside them.

## Remaining boundaries

Discovery still follows reachable controls; a source folder is not a route manifest. Unlinked pages and unsupported controls can be registered explicitly. Navigation remains within the application origin; downloads and new browsing contexts are outside the crawl. Full document continuation requires session storage. Existing scenario JSON remains valid; re-explore an older catalog to add recorded viewport metadata to newly discovered recipes.

## Release delivery

Version 0.5.2 contains these changes. Publish through the repository's version-tag release workflow, which rebuilds the package and companion plugin, runs the full suite, and publishes using the repository's configured npm credential. Update both the Design Team web app and the PaidHR marketing source app to the registry release, refresh their lockfiles, and restart their Explorer servers. Consumer verification must resolve the installed version and exercise real browser previews; an HTTP response alone is insufficient.

Release delivery completed on 2026-10-19:

- Source commit `60ef3a4` and tag `v0.5.2` are pushed. The [release workflow](https://github.com/danielfransix/web-app-ui-explorer/actions/runs/39213241181) rebuilt the package and plugin, passed all 154 tests with no skips, and published 0.5.2. The npm registry confirms `latest: 0.5.2`.
- Both local consumer apps now declare `^0.5.2`, resolve installed version 0.5.2 from npm, and have updated lockfiles: `Design-Team-Web-App-V3` (pnpm 10.34.3) and the nested PaidHR marketing `source` app (npm). Both production builds passed.
- Both Explorer servers were restarted with the installed release. Final browser gallery checks show 201 registered Design Team states at port 8443 and 52 discovered PaidHR states at port 5199, with zero browser exceptions.
- Final image checks regenerated 13 missing Design Team cache files through its capture API, verified all 201 complete JPEG files and visible browser images, and rebuilt its production snapshot with all 201 thumbnails. The final gallery screenshots show the repaired images.
- The Design Team app's 26 Explorer browser checks all passed. Its pre-upgrade baseline exposed stale URL, control and preview-layer expectations; those checks now cover the current combobox, navigation parameters, preview stack and hiring-home entry point.
- A fresh crawl using PaidHR's installed npm package covered all 46 declared routes, recorded 52 states, and had zero failed replays in 56.2 seconds. It deliberately stopped once route coverage was complete. All 52 thumbnails were regenerated in that app's normal `.ui-explorer` catalog. Platform previews passed at 1440px and 390px, and its actual gallery modal rendered the destination with zero browser exceptions.

Release evidence is retained in the package checkout's `.ui-explorer/release-0.5.2-logs/` and `.ui-explorer/release-0.5.2-*-gallery.png`. PaidHR's normal `.ui-explorer/` folder contains `release-0.5.2-qa.json`, desktop/mobile screenshots, the gallery-modal screenshot, the refreshed catalog and thumbnails. Consumer dependency and test-file changes remain local working-tree changes.

The local patched review server at [http://127.0.0.1:5200/__explorer/?view=gallery](http://127.0.0.1:5200/__explorer/?view=gallery) uses the verified isolated catalog. Its API and actual gallery were checked for 52 scenarios, 52 current thumbnails, and zero browser exceptions. Select the Sites project checkbox to show all states. The screenshot is `.ui-explorer/navigation-qa/paidhr-final-gallery.png`.

## Reproduce the automated checks

Run from the Explorer checkout:

```powershell
npm.cmd run typecheck
npm.cmd run build
$env:ASTRO_TELEMETRY_DISABLED = '1'
npm.cmd test
```

The telemetry setting applies only to that shell's test processes. Focused browser regressions can also be run with:

```powershell
node --test test/navigation-replay.test.mjs test/crawl.test.mjs test/preview.test.mjs test/responsive-preview.test.mjs
```

PaidHR QA uses a separate loopback proxy and an isolated generated catalog in `.ui-explorer/navigation-qa/`. It reads the real development server on port 3000 and compares captured URLs against `source/handoff/route-map.json`. That map is an answer key only; it is never supplied as crawler seeds or registered scenarios. The coverage harness deliberately stops once all declared routes have been reached; it does not claim to exhaust every possible interaction state. Screenshots, structured captures, thumbnails, and the final JSON summary are retained in that ignored artifact folder.
