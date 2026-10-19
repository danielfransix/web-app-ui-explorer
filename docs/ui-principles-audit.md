# Explorer UI principles review

Reviewed 19 October 2026 against [Foundational UI design principles](https://app.notion.com/p/b3a7bf71791e4c52a6c7d1eec61af21f).

That overview now links to two subpages: [Foundational design mindset](https://app.notion.com/p/3fd964279f8d81929a2dec91a30a3737) for the reasons behind design decisions, and [Practical UI design guidance](https://app.notion.com/p/3fd964279f8d811dbe0bff1648d85946) for checks to apply when building a screen. The practical guide includes the minimal-nesting rule. The review below records the coverage of the original ten principles.

This review covers the Explorer interface: gallery, canvas, source navigation, workspace overview, previews, export settings, prepared import, connection details and Issues. Application screens rendered inside previews retain their own design; they are not Explorer controls.

## Review by principle

| Principle | Findings and resulting behavior |
| --- | --- |
| 1. Show only what is needed now | Import codes and connection URLs use an inline copy icon instead of a separate full-width button. Important instructions, expiry information and errors stay visible. Task actions such as preparing an import keep words because their meaning needs more context. |
| 2. Show more when it is needed | Custom copy sizes are revealed on request. The selected-screen review remains collapsed initially, with search and pagination when opened. Connection details share a border and divider with their disclosure trigger. Only the selected source card shows its totals. |
| 3. Keep the layout calm and orderly | Shared copy fields reserve room for a centered square icon target with equal top, right and bottom clearance. Dropdown icons no longer have a vertical compensation offset. Workspace sections use parent gaps; related text and controls retain common left edges. Popup widths and collision handling accommodate small windows. |
| 4. Use colour for a reason | Outline buttons use neutral borders and a background change on hover. Primary buttons keep their opacity on hover. Gallery hover no longer adds a competing shadow. Selected values also have checks, radio dots, words or programmatic selected states. |
| 5. Make interactions clear and consistent | Copy, remove, add, close and zoom icon actions have names and discoverable labels. Copy settings use the shared popup primitive for Escape, outside dismissal, focus return and viewport placement. Hover preserves geometry. Gallery and canvas announce which view is selected. |
| 6. Make the most important things stand out | Dialog title, section title, field label, option and supporting text keep distinct sizes and weights. Copy groups use readable sentence-case labels. The Explorer title is a semantic heading. Hierarchy and alignment checks cover export, preview, Copy settings and Issues. |
| 7. Make choices easy to understand | Source selection remains a single-choice radio group. Component creation keeps explicit Yes/No choices. Widths use checkbox selection with removable chips. Copy settings and editable screen selection now use the shared checkbox component. Names and dimensions remain separate where needed. |
| 8. Plan for large amounts of content | A 100-screen selection remains a summary with at most eight review rows per page. Search, pagination, empty results, custom widths, duplicate widths and the 12-width limit are exercised. Selection survives filtering and view changes. Preview instances remain bounded and reuse visited screens. |
| 9. Follow the order of the task | Selection and capture settings remain in Explorer; destination and arrangement remain in Figma. Copy actions sit beside their values. Clipboard failures preserve the value and explain manual copying; issue-copy failures appear beside the affected value. Custom-size validation appears with its settings. |
| 10. Check the whole experience | Source review and rendered checks cover the shared controls and every Explorer surface listed above. Tests exercise collapsed and expanded content, long selections, empty results, loading, errors, success, keyboard navigation and responsive layouts. |

## Foundational rule added

The Notion document now explains that a familiar icon may replace button text when its meaning is clear in context. Words remain necessary for ambiguous actions. Icon buttons still need an accessible name, a label available on hover or keyboard focus, and a comfortable target. The action belongs beside the content it affects. Its review checklist includes this question too.

## Repeatable checks

### Minimal-nesting follow-up

Every container should serve layout, meaning, interaction or accessibility. Remove a wrapper or visual layer when those purposes survive without it; do not apply a fixed element-depth limit.

| Surface | Simplification or reason to retain its structure |
| --- | --- |
| Selected-screen review | Removed three layout wrappers and the inner results card. Search, bounded list, pagination and help now belong directly to the same disclosure panel. Shared padding and simple row dividers replace repeated containers. |
| Export and Copy settings | Component-creation choices use one grid for the label, Yes/No controls and help. Removed the nested card and header wrapper. Copy settings use a section divider instead. |
| Workspace connection | The disclosure panel itself owns padding and spacing; the additional body wrapper is gone. The trigger and content retain one shared boundary. |
| Shared modal headers and Explorer heading | Removed wrappers that only held a heading. The heading itself participates in its parent's layout. Preview, export and Issues inherit the shared header change. |
| Issues | Removed the redundant heading wrapper in the out-of-date captures section. Each failed screen keeps its meaningful group, and value rows retain the layout needed to keep copy feedback next to the value. |
| Gallery and canvas | Retained the thumbnail area, caption layout and node structure: they support preview overlays, selection, sizing and canvas behavior. |
| Source navigation | Retained real folder hierarchy, accessible disclosures and selection state. Meaningful source relationships should not be flattened to satisfy a nesting count. |
| Controls and previews | Removed the extra wrapper around each single-select option. Retained focus and popup boundaries, input/action layouts, preview clipping and cached-frame containers. These provide behavior and accessibility rather than decoration. |

The regression checks now verify that the selected-screen controls share a panel and the component choices stay flat. Existing alignment, hierarchy, keyboard, responsive and selection tests check the behavior retained by these changes.

### Commands

Build the current client before running browser checks:

```powershell
npm.cmd run typecheck
node node_modules/vite/bin/vite.js build --config vite.client.config.ts
npm.cmd run test:ui
git diff --check
```

`test:ui` runs the Explorer browser and handoff checks. It includes geometry assertions for close and copy targets, alignment, hierarchy, popup bounds, responsive search, selection persistence, real preview viewports, keyboard behavior and clipboard recovery. The new principles checks use fixture import codes and connection URLs, never real pairing credentials. Screenshots are written to the ignored `.ui-explorer` directory.

Verification result: typecheck, client build and whitespace checks passed; all 23 UI checks passed.

Rendered coverage includes widths from 320px through 1440px for the updated copy controls and popups; the broader preview suite also exercises larger windows. Screenshots of the ready modal, source cards, connection disclosure, Copy settings and Issues were visually reviewed. Language, grouping and visual priority also require design review; browser assertions cover measurable behavior rather than proving every design judgment automatically.
