## Summary

<!-- What changed and why. -->

## Flow

<!--
The Flow Gate check reads the lines below. Every step is the default for every PR, whoever opens it
(owner, collaborator, Claude, Codex, by hand). A step is either satisfied by evidence or skipped by an
uncommented line `Skip-<Step>: <reason>` (reason at least 10 characters; it is echoed into the check
summary). A docs-only diff (every changed path ends in `.md`) is exempt; non-markdown files under `.claude/` are not docs.
Light-track PRs: skip with the reason "light-track: <why>".
After a review lands, re-run the check by editing this body or toggling a label.
Contract: .claude/agents/contracts.md §4.1 · AGENTS.md
-->

Task:
Plan:

<!-- To skip a step, move its line out of this comment block and write the reason.

Skip-Task: <why there is no task file or issue>
Skip-Plan: <why there is no plan>
Skip-Tests: <why product code changes without a test change> (required when .ts/.tsx/.js/.jsx/.mjs/.cjs code under apps/** or packages/** changes)
Skip-Review: <why no code-reviewer `Verdict: APPROVE`>
Skip-Security-Review: <why no security-reviewer `Security Review: APPROVE`> (required on critical paths: auth, finance, RBAC, wallets/transactions, migrations, webhooks, workflows)
Skip-Spec-Review: <why no spec-reviewer `Spec Review: PASS`> (required when Task: is declared)
Skip-Copy-Review: <why no copy-reviewer `Copy Review: PASS`> (required when i18n catalogs or landing dictionaries change)
Skip-QA: <why no manual-qa `QA Verdict: PASS`> (required when apps/web or apps/landing UI code changes)
Skip-Design-Review: <why no ui-ux-designer `Design Review: PASS`> (required when apps/web or apps/landing UI code changes)
Skip-AC: <why the last non-wip commit has no `ac_verified:` line>
-->

## Test plan

<!-- What you ran and what it printed (the case count, not "it passed"). -->
