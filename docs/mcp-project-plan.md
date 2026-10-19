# Project-bound MCP implementation plan

## Findings and decisions

The existing ten tools repeat four catalog operations, return whole replay recipes during discovery,
and trust a configured live URL without checking which checkout serves it. A screen name and folder
are not an identity. The server also accepts a root unrelated to its launch directory.

1. Establish a checkout identity from the canonical project directory. Include it in live Explorer
   state and use it to validate MCP discovery before capture/export. Fail closed for old servers
   without identity; never fall back to a different project's saved manifest.
2. Bind every MCP operation to its launch directory and, when supported, the client's workspace roots.
   Check roots on every call, including after workspace changes. Roots are an additional check, not
   authentication. A client which deliberately hides its workspace cannot be detected reliably;
   document this limit rather than claiming an absolute sandbox.
3. Consolidate groups, folders, listing and counts into `explorer_catalog`: bounded pages, search,
   deterministic ordering, exact totals and width coverage. Add `explorer_inspect_screen` for an
   exact ID or project-qualified reference, safe connection evidence and capture readiness. Fold
   optional native desktop discovery into `explorer_figma_status`. Seven default tools replace ten.
   Remove the five old discovery names and their compatibility flag; migrate integrations to the
   seven supported tools instead of carrying duplicate tool registrations.
4. Generate and persist framework-independent screen UUIDs in `ui-explorer.ids.json`. Use a separate
   project UUID for portable references; keep the canonical checkout identity exclusively for local
   routing checks. Share the registry through version control. Use stable registered keys (or an
   explicit `identityKey`) and hashed crawler recipe anchors; never infer identity by title or visual
   similarity. Keep retired IDs reserved and serialize concurrent registry updates with a short lock.
   Reject wrong-project, malformed and stale references. Support them in inspection, capture and
   export. Exclude replay selectors, entered values and bridge credentials from discovery/inspection.
5. Provide `mcp install --client vscode|codex` writing only project-local configuration, using the
   locally installed package and explicit working directory. Preserve unrelated configuration;
   refuse conflicting entries. Validate JSONC/TOML instead of editing them with unchecked patterns.
6. Add a Copy screen ID control to the expanded and full-screen preview. Provide keyboard labels,
   copied feedback and selectable fallback text if clipboard access fails. No permanent ID badges
   on every card. Keep design-copy and reference-copy actions distinct.
7. Update README, the shipped MCP guide and installed AGENTS guidance with setup, migration, scope,
   references, safety boundaries and troubleshooting. Keep importer writes separate from native
   Figma operations. Do not add arbitrary browser/Figma execution or another generic file reader.

Additional tool decisions: exact connection inspection and bounded catalog search fill genuine gaps.
Separate browser capture, importer writes, prepared-selection reads and interrupted-write review keep
their distinct consequences visible. Automatic recrawls and job controls are deferred until they can
provide cancellation and authenticated session handling as one coherent workflow; existing UI/CLI
already cover them. Generic source-file reading belongs to the agent's existing filesystem tools.

## UI review rationale

| Before | After | Why |
| --- | --- | --- |
| Names and folders can be ambiguous | Copy the generated UUID beside preview controls | “4 · Reveal complexity when it becomes useful” ([mindset](https://app.notion.com/p/3fd964279f8d81929a2dec91a30a3737)); keep IDs out of the browsing surface |
| No direct screen handoff to an agent | A labelled icon action with feedback and a selectable fallback | “5 · Use the simplest clear action control” and “11 · Show status and a way forward” ([practical guidance](https://app.notion.com/p/3fd964279f8d811dbe0bff1648d85946)); pointer, keyboard and touch can all complete the task |

These needs are covered by existing design guidance; no canonical rule additions are needed.

## Verification sequence

- Real stdio MCP: exactly seven tools; removed options rejected; catalog pagination/search/counts;
  duplicate titles and source paths; reference round trips; unknown IDs; privacy of returned data.
- Isolation: mismatched launch directory, client roots (including changes), same-named checkouts,
  wrong or identity-less live servers, per-call URL overrides and foreign references before writes.
- Installer: both clients, Windows paths, idempotency, comments/unrelated servers, conflict/malformed
  files, local package resolution and paths which escape through symlinks.
- Rendered preview: copy exact active screen, switch screens, clipboard denial fallback, keyboard
  access and narrow layouts, with no application errors.
- Persistent UUIDs: duplicate names, changed folders/titles, explicit stable keys, crawler slug reuse,
  retired/reappearing screens, shared registries across clones, corruption rejection, 10,000 screens
  and concurrent writers. Use indexed lookup for generated IDs and batch selection.
- Typecheck, build, focused protocol/UI tests, then full repository suite. Record actual results here.

## Results

Completed locally on 2026-10-19.

- Typecheck and production build passed.
- Full repository suite: **169 passed, 0 failed, 0 skipped**. OpenSSL bundled with Git was supplied
  on the test process's PATH so the existing self-signed HTTPS check ran instead of skipping.
- Final focused verification after saved-catalog lifecycle cleanup: **15 passed** across real MCP
  stdio, UUID persistence/scaling, project isolation, installers, capture/export and rendered copy UI.
- Identity tests covered 10,000 screens plus four concurrent writers adding another 2,000 records;
  no assignments were lost or duplicated. Renames, folder changes, reordered crawler slugs, retired
  IDs, explicit-key migration, copied registries and corrupt data were checked.
- UI QA covered Gallery, Canvas and full-screen previews, duplicate titles in the same file, keyboard
  copying, denied clipboard access and widths 320/390/768/1440. An end-to-end preview copied the second
  of two identically named screens and resolved it through the real MCP protocol, with no page errors.
- Installed an actual packed artifact into an isolated project with production dependencies only.
  Both client installers and installed agent guidance worked; its seven-tool MCP resolved the exact
  generated UUID. The npm pack dry run includes the shipped MCP and orchestration documentation.
- The temporary duplicate-screen review demo and its preview server were removed after QA at the
  person's request. The automated regression fixtures remain part of the test suite.

Evidence is kept in the ignored `.ui-explorer/` folder: `mcp-full-test-final.log`,
`mcp-focused-final.log`, `mcp-packed-qa.json`, and automated-test desktop/mobile screenshots.
The feature has not been published to npm or pushed to consumer repositories as part of this task.

## Follow-up: remove compatibility tools and audit unused code

The requested final MCP surface has exactly seven tools. The five old registrations, their flag,
installer option, MCP option and private catalog wrapper are removed. Tests query the supported
catalog views; the CLI rejects unsupported flags, including the removed compatibility flag.
The migration table remains documentation, not an alternate runtime API.

The general audit covers Node, the client, injected runtime, both Figma entry points, examples,
tests and build configuration. TypeScript unused-symbol checks and an import/reference graph identify
candidates; repository searches and runtime entry points determine whether deletion is appropriate.
In particular, preserve the published saved-catalog Node API, React's lazy-loaded canvas, the Vite
entry point, the Figma layout helper, generated component classes and third-party DOM selectors.
Framework test dependencies and font subsets have active consumers and stay installed.

Remove orphaned badge, preview-shell, recipe-error, shortcut-hint, workspace-hint, section-heading
and old SVG edge-label styles, plus the unused secondary button variant and unused imports. Required
callback argument positions stay intact and are marked explicitly unused. Unused locals/parameters,
unreachable statements and unused labels now fail the normal app and Figma plugin typechecks.

| Before | After | Why |
| --- | --- | --- |
| Styles for retired UI structures and an unused button variant | Only styles referenced by the current interface | This is a behavior-preserving cleanup; rendered regression checks apply “8 · Treat the experience as a whole” ([mindset](https://app.notion.com/p/3fd964279f8d81929a2dec91a30a3737)) and “10 · Check every state and related screen” ([practical guidance](https://app.notion.com/p/3fd964279f8d811dbe0bff1648d85946)) |

The existing guidance covers this maintenance request; no canonical design rule changes are needed.
Follow-up validation completed on 2026-10-19:

- **169 tests passed, zero failures or skips**, including the real MCP protocol, rejected removed
  flag, migrated catalog scopes/counts, desktop discovery through status, app capture and Figma
  imports. Full rendered UI regression coverage passed after deleting the unused CSS.
- Root and both Figma typechecks passed with the new unused/unreachable-code checks enabled.
  The application and Figma plugin production builds passed.
- Import/reference analysis covered **84 source modules** across all runtime entry points; no
  disconnected modules or unconsumed internal named exports remained. The candidate CSS selectors
  retained after manual review are generated component classes or host/library-provided classes.
  The separate JavaScript/build/example/test audit has no unused-symbol findings.
- Confirmed that built JavaScript and public type declarations contain no removed MCP registrations
  or compatibility option. The seven-tool protocol contract is asserted directly in tests.
- Evidence: `.ui-explorer/cleanup-full-test.log`, `dead-code-audit.json`, and rendered screenshots.
  Publishing remains pending the person's approval.
