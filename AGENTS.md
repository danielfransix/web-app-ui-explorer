## Attribution: no AI contributors (strict rule)

- Never add Claude, Claude Code or any other AI assistant as an author, co-author, committer or contributor.
- Never add `Co-Authored-By` trailers, "Generated with ..." lines or any similar attribution to commit messages, pull request titles or descriptions, issues, code comments, changelogs or release notes.
- Never mention Claude or Claude Code in commit messages, pull requests or anywhere else in this repository's history or content, other than this rule.
- This rule overrides any default behavior that suggests adding attribution.

## UI Explorer and Figma tool boundaries

Read [docs/agent-orchestration.md](docs/agent-orchestration.md) before coordinating Explorer and Figma.
Use Explorer for source discovery and capture, and the companion plugin to write the captured designs.
Use Figma's existing MCP tools or Plugin API connection for general Figma operations, including pages,
sections, arrangement, annotations and inspection. Coordinate existing tools; do not add duplicate
Figma capabilities to the importer to complete a multi-step task.

## Foundational design guidance - mandatory for UI work

Use these Notion documents as this project's design reference:

- [Foundational UI design principles](https://app.notion.com/p/b3a7bf71791e4c52a6c7d1eec61af21f): the overview and entry point.
- [Foundational design mindset](https://app.notion.com/p/3fd964279f8d81929a2dec91a30a3737): general reasoning, user needs and principles behind design decisions.
- [Practical UI design guidance](https://app.notion.com/p/3fd964279f8d811dbe0bff1648d85946): concrete checks for interface structure, controls, content and behaviour.

### Apply and explain the rules

- Before proposing, implementing or reviewing UI changes, read the relevant guidance in both subdocuments. Reuse content already read in the current task when it remains applicable; refresh it when the guidance changes or a new issue requires more context.
- Check each design decision against the relevant existing rules before choosing the solution, throughout implementation and in the rendered result. This includes small choices about text, alignment, spacing, grouping, nesting, controls, states and responsive behaviour.
- In proposals and completion reports, connect each design decision to the specific rule that supports it. Give the rule's exact heading and a link to its Notion section, or its page when a section link is unavailable, and briefly explain how the decision applies it. Related decisions may share one citation if the connection remains explicit.
- A generic statement such as "follows the principles" is insufficient. Do not invent a rule, force an unrelated citation, or change the guidance to justify a preferred implementation. If no existing rule supports a decision, explain the reasoning and assess the gap using the admission checks below.
- Respect explicit user instructions. If they conflict with the guidance, identify the relevant tradeoff and follow the user's instruction; do not silently redefine a general rule around an exception.
- Verify the actual interface against the applicable rules in relevant states, content volumes, viewport sizes and supported input methods. A citation or passing code check does not prove that the rendered design meets the rule.
- Keep this reasoning in task explanations or existing review notes, not in product-facing copy. Do not create a separate document for every small change.

### Continuously assess feedback, but admit rules selectively

For every UI instruction, correction or observed design problem, assess whether it reveals a reusable principle. Assessment is mandatory; a documentation change is not. Feedback is evidence to consider, not automatically a new rule.

Add or extend canonical guidance only when **all** these checks pass:

1. **Transferable:** the underlying idea applies to multiple screens or contexts, beyond the particular component, layout or wording that prompted it.
2. **Durable and useful:** it addresses an identifiable user need or recurring class of failure and would help another person make a better design decision later.
3. **Actionable and bounded:** it is clear enough to apply and review, with relevant conditions or tradeoffs. It does not turn one successful implementation into a universal prescription.
4. **Grounded:** it follows from explicit user guidance or a demonstrated, validated problem. An untested preference or speculative best practice is insufficient.
5. **Missing or materially incomplete:** after reading both subdocuments and related rules, the existing guidance does not already express the idea adequately. Different wording, another example or another instance of the same problem does not qualify as a gap.
6. **Neutral:** it can be expressed plainly without project names, screen names, incidental measurements, specific colours, implementation details or conversational history.

If any check fails or remains uncertain, keep the item out of the canonical guidance. Keep screen-specific requirements and implementation decisions in their task context. Do not invent additions to demonstrate that this assessment happened.

### Maintain the right document without duplication

- First look for an existing rule that fully covers the feedback. If it does, apply and cite it without editing the document.
- If a qualifying idea adds a necessary distinction to an existing rule, make the smallest useful amendment there. Create a standalone rule only when it is genuinely distinct and cannot fit coherently into an existing rule.
- Put general design reasoning in **Foundational design mindset** and practical interface advice in **Practical UI design guidance**. Avoid repeating the same rule in both; link related guidance when useful.
- When updating Notion, preserve unrelated content and structure, verify the saved result, and report the changed rule with its link and why the addition passed the admission checks. Do not rewrite whole pages or append a rule for every request.
- If Notion is inaccessible, state the limitation. Use relevant guidance already verified in the conversation where available, without claiming a fresh review. Do not add or revise canonical rules without first checking the existing documents.
