# Phase 2: replace `eslint-feedback.sh` PostToolUse hook with eslint MCP pre-check

**Date:** 2026-06-03
**Author:** Migration Architect
**Scope:** ADR `2026-05-31-ecc-migration-design.md` §2.2.5
**Branch:** `architect/phase-2-hooks-migration`

---

## Decision

**Replace** the legacy `.claude/hooks/eslint-feedback.sh` PostToolUse hook
with an **agent-driven `eslint` MCP pre-check** before suggesting code.
Remove the hook entry from `.claude/hooks-ecc-draft.json` (already done).

Do NOT include `eslint-feedback.sh` in the activated ECC config in
Phase 2.5. Deferred removal of the `.sh` file itself: **Phase 5 cleanup**.

---

## Why MCP pre-check > PostToolUse hook

### 1. Latency / feedback-loop placement

| Stage                                              | PostToolUse hook                                                          | MCP pre-check                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| When violation is surfaced                         | After file is already written → hook re-injects errors → agent re-edits   | Before agent suggests the code at all → cleaner write                              |
| Number of write/edit cycles per violation          | At minimum 2 (write → eslint flag → re-edit). Often more if errors cascade | 1 (agent validates intended snippet → writes once)                                  |
| Token cost of feedback                             | Full hook output injected as `additionalContext`                          | Targeted lint result on the snippet only                                           |
| Auto-fix behavior                                  | `eslint --fix` runs on disk → silent mutation between agent thoughts      | Agent sees fix proposal explicitly, decides to accept                              |

### 2. Workspace correctness

The legacy hook hard-codes per-package eslint binaries
(`apps/web/node_modules/.bin/eslint`, `apps/api/...`). It breaks if:

- Coder edits a file in `packages/shared/` (no branch → silently exits).
- `pnpm install` hasn't been run in that workspace yet.
- File path uses a symlinked path (e.g., `.claude/worktrees/*` resolves to a
  different prefix than the hardcoded one).

The `eslint` MCP server resolves the right config via
`apps/{web,api}/eslint.config.mjs` automatically (see `CLAUDE.md`
"eslint — линтинг в реальном времени"), independent of file path tricks.

### 3. Existing project policy

Project `CLAUDE.md` (section "MCP серверы") already states:

> **eslint** — Запускает правила из `apps/web/eslint.config.mjs` и
> `apps/api/eslint.config.mjs`. **Используй перед тем как предложить код**.

So MCP-first is **already the documented preferred path**. The PostToolUse
hook is redundant overhead that bypasses the documented contract.

### 4. ECC alignment

ECC `hooks/hooks.json` does not ship a linter PostToolUse equivalent for
ESLint — it relies on `post:quality-gate` (general checks) and
`stop:format-typecheck` (batched at Stop time). Removing our custom
ESLint PostToolUse aligns with ECC's "batch at Stop, validate via MCP
in-flight" model.

---

## How an agent should use the eslint MCP server (post-Phase 2.5)

**Before suggesting any code change to a `.ts` / `.tsx` file in apps/** or
packages/**:**

1. Call `mcp__eslint__lint-files` with the file path(s) the agent intends to
   modify (or pass a temp file with the planned snippet).
2. If errors → adjust snippet to comply before writing.
3. After Write/Edit → optionally re-run the MCP call to catch regressions
   (cheap, ~50 ms typical).

**Stop-time fallback:** the ECC `stop:format-typecheck` hook (and our
existing CI `pnpm lint`) catches anything that slipped through.

---

## CLAUDE.md update (Phase 5 — separate PR — DO NOT do in this PR)

Append the following note under the "eslint — линтинг в реальном времени"
bullet:

> **PostToolUse hook removed (Phase 2 ECC migration).** Используй MCP `eslint`
> до Edit/Write, а не после. Старый `.claude/hooks/eslint-feedback.sh`
> удалён в Phase 5 cleanup; обратной совместимости нет.

Tracking checklist item for the Phase 5 PM/Architect:

- [ ] Edit `CLAUDE.md` MCP table footer with the note above.
- [ ] Delete `.claude/hooks/eslint-feedback.sh`.
- [ ] Update any agent prompt (`docs/agents/coder.md` §2.x linting workflow)
      that references the hook.

---

## Risks & mitigations

| Risk                                                                       | Mitigation                                                                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent forgets to call MCP eslint pre-check                                 | CI `pnpm lint` still gates merge. ECC `stop:format-typecheck` (after Phase 5 activation) catches at Stop time.                              |
| MCP eslint server temporarily down                                         | Fallback: legacy `.sh` remains in repo until Phase 5. Re-enable via `.claude/settings.json` if needed.                                      |
| Some IDE workflows depended on hook side-effect (auto-fix on disk)         | Document removal in Phase 5 CLAUDE.md note. Devs run `pnpm lint --fix` manually if needed.                                                  |
| coder-progress-marker / safety / push-gate hooks accidentally affected     | Each hook is independently registered with its own stable ID; removing eslint-feedback does not touch them.                                  |

---

## Confidence

**HIGH** for the replacement decision (MCP > PostToolUse hook is well-
established ECC pattern + CLAUDE.md already endorses MCP-first).

**MEDIUM** for the cleanup timing — Phase 5 vs Phase 2.5. Chose Phase 5 to
avoid coupling cleanup with activation (smaller, more reviewable PRs).
