# AGENTS.md — for any coding agent or harness working in this repository

This repository has a development flow, and **it is the default for every change**, whoever makes it:
the owner, a collaborator, Claude, Codex, or a person at a keyboard.

## The flow

Task → Plan → code + Tests → Review → Security-Review (critical paths) → Spec-Review → Copy-Review
(user-visible text) → QA + Design-Review (UI) → a final commit with `ac_verified:`.

The required check **`Flow Gate`** enforces it on every pull request into `main`. Each step is either
**satisfied by evidence** (a PR-body line, a review verdict line, a test file in the diff, a commit
line) or **skipped on purpose** with a PR-body line:

```
Skip-<Step>: <reason, at least 10 characters>
```

Steps: `Task`, `Plan`, `Tests`, `Review`, `Security-Review`, `Spec-Review`, `Copy-Review`, `QA`,
`Design-Review`, `AC`. Every skip and its reason is printed in the check summary. Skipping is allowed.
Skipping silently is not. A docs-only diff (every changed path ends in `.md`) is exempt; non-markdown files under `.claude/` are not docs.

Start from the PR template (`.github/pull_request_template.md`). It has the `Task:` / `Plan:` lines
and a commented skip line for every step.

## Where the rules live

- Project overview and pointer map: `CLAUDE.md`
- The evidence for each step and the merge gating: `.claude/agents/contracts.md` §4.1
- Domain glossary: `CONTEXT.md`
- Always-on rules (git policy, zones, versions, language): `.claude/rules/common/`

Repository language is English. Product UI text is localised (`uk` default, `en`) through Lingui.
Never merge without the owner's explicit approval.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
