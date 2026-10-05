# Phase 3b Deliverable — Reviewer split into code-reviewer + security-reviewer

**Date:** 2026-06-03
**Architect:** Migration Architect
**Phase:** 3b (Reviewer agent split)
**ECC version pin:** v2.0.0-rc.1
**Branch:** `feat/ecc-phase-3b-reviewer-split`
**Status:** Proposed (awaits user review + merge)
**ADR reference:** [`docs/architecture/2026-05-31-ecc-migration-design.md`](2026-05-31-ecc-migration-design.md) § 2.1.5

---

## TL;DR

The monolithic `docs/agents/reviewer.md` (262 lines) is split into two narrow ECC agents per ADR § 2.1.5:

- **`code-reviewer.md`** — code correctness (sonnet, ESLint MCP, write-then-post, zone-of-write)
- **`security-reviewer.md`** — security depth (opus, OWASP, npm audit, USDT/ETH patterns)
- **`reviewer.md`** — a redirect shim until the Phase 3c PM dispatch transition

All Cheeky-specific patterns (Verdict: BLOCK / write-then-post / russian / eslint MCP / session-recovery / Pre-Report Gate) are preserved in both new agents.

---

## Inventory — what was created / changed

### Created

| File                                                  | Lines       | Purpose                                                                                                      |
| ----------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `docs/agents/code-reviewer.md`                        | ~235        | Narrow code review agent (default for any PR). YAML frontmatter (sonnet), tools allowlist, golden rules.     |
| `docs/agents/security-reviewer.md`                    | ~354        | Security-focused agent (auto-dispatched for auth/finance/wallets). YAML frontmatter (opus), tools allowlist. |
| `docs/architecture/2026-06-03-phase3b-deliverable.md` | (this file) | Phase 3b deliverable summary.                                                                                |

### Modified

| File                             | Change                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/agents/reviewer.md`        | **Deprecated → shim** (262 → ~40 lines). YAML frontmatter `name: reviewer` (deprecated description), redirect body + ADR link.                    |
| `docs/agents/CLAUDE-reviewer.md` | Trim references: instead of a single `reviewer.md`, points to `code-reviewer.md` + `security-reviewer.md`. Deprecation date updated.              |
| `docs/agents/README.md`          | Agent table: the Reviewer row replaced with 2 rows (code-reviewer + security-reviewer); Architect/Legal added; reviewer.md in Deprecated stubs.   |

### Untouched (intentional — for Phase 3c / Phase 4)

| File                                               | Reason                                                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `docs/agents/memory/reviewer/lessons.md`           | Shared accumulated legacy for both agents until Phase 4 (lessons→skills conversion). Not split into 2 files now.                   |
| `docs/agents/pm.md` / `docs/agents/pm-snippets.md` | PM dispatch logic — updated in Phase 3c (separate deliverable). For now PM continues to dispatch `reviewer` (the shim proxies it). |
| `.github/workflows/archive/ai-review.yml`          | Archived workflow, not active. Trim not required.                                                                                 |
| `.claude/hooks-ecc/**`                             | Phase 2.5 hooks live, not the Phase 3b zone.                                                                                      |

---

## Split rationale

Per ADR § 2.1.5 and ECC `AGENTS.md` "Agent-First orchestration with radical specialization":

| Concern                 | Monolith reviewer.md                                                 | Split rationale                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scope**               | Code correctness + security mixed                                    | Different mental models — code review = pattern matching / arch rules; security = adversarial threat modeling.                                |
| **Optimal model**       | sonnet (for speed)                                                   | code-reviewer = sonnet (fast). security-reviewer = opus (deep reasoning for OWASP / contract patterns).                                       |
| **Tool allowlist**      | Broad (mcp**eslint, mcp**github, ast-grep, WebSearch, WebFetch, ...) | Narrow per concern: code-reviewer = eslint + ast-grep + github MCP; security-reviewer = WebSearch + WebFetch + github + ast-grep (no eslint). |
| **Parallel invocation** | One agent = sequential                                               | Financial PRs — both launched in parallel (code + security), results independent → PM collects both verdicts.                                 |
| **Token efficiency**    | Each review loads both check zones                                   | code-reviewer does not spend tokens on an OWASP/secrets scan for ordinary PRs; security-reviewer does not duplicate code review.              |

---

## PM dispatch examples (for Phase 3c reference)

### Ordinary PR (not sensitive paths)

```
Agent(
  description="code-reviewer: PR #N review",
  prompt="Read docs/agents/code-reviewer.md. Review PR #N in yaremenko-maksym/CheekyCheeseIT_CRM. Sensitive paths not affected."
)
```

One dispatch, sequential, the reviewer returns `Verdict: APPROVE` or `BLOCK`.

### PR touches auth/finance/wallets/transactions

```
# Parallel dispatch (PM launches both at once)

Agent(
  description="code-reviewer: PR #N review",
  prompt="Read docs/agents/code-reviewer.md. Review PR #N. Sensitive paths: apps/api/src/finance/**, packages/shared/src/schemas/finance.ts. Signal that security-reviewer runs in parallel."
)

Agent(
  description="security-reviewer: PR #N security review",
  prompt="Read docs/agents/security-reviewer.md. Security review PR #N. Sensitive paths: apps/api/src/finance/**, packages/shared/src/schemas/finance.ts. Code-reviewer runs in parallel."
)
```

PM waits for both verdicts, merges them into the shared review-round 1 logic. If both APPROVE → the `awaiting-pm-review` label is set by code-reviewer (default). If at least one BLOCK → a fix-task for the Coder with both lists of findings.

### Triggers for security-reviewer auto-dispatch

PM checks `gh pr files <N>` against the list of sensitive paths from `security-reviewer.md` § "When you are dispatched":

- `apps/api/src/auth/**`
- `apps/api/src/finance/**`
- `apps/api/src/transactions/**`
- `apps/api/src/payouts/**`
- `apps/api/src/wallets/**`
- `packages/shared/src/schemas/finance.ts`
- `packages/shared/src/schemas/auth.ts`
- `package.json` / `pnpm-lock.yaml`
- USDT/ETH contracts (Phase 8: the future `contracts/`)

If even one file matches — security-reviewer is dispatched in parallel with code-reviewer.

---

## Preservation note (Cheeky-specific)

All patterns from the former monolithic reviewer.md are **preserved** in both new agents:

| Pattern                                  | code-reviewer.md | security-reviewer.md | Why preserved                                                                                                       |
| ---------------------------------------- | ---------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Verdict: BLOCK** first-line            | ✓                | ✓                    | GitHub blocks `REQUEST_CHANGES` when author==reviewer (a single owner `yaremenko-maksym`). PM parses the first line. |
| **Write-then-post pattern**              | ✓                | ✓                    | Real incident 2026-05-23 — MCP hang > 10 min → the review is lost. The body is saved to `/tmp/reviewer-output/`.    |
| **Mandatory `mcp__eslint__lint-files`**  | ✓                | —                    | code-reviewer checks lint before review (ESLint = a code concern). Security-reviewer does not duplicate it.         |
| **Russian output language**              | ✓                | ✓                    | CLAUDE.md hard requirement.                                                                                         |
| **Session-recovery checklist**           | ✓                | ✓                    | Protection against compaction / cold start.                                                                        |
| **Pre-Report Gate (HIGH/MED/LOW)**       | ✓                | ✓                    | LOW findings → a summary for PM, not in the review body (noise reduction).                                         |
| **Zone-of-write check**                  | ✓                | —                    | Coder zone violations — a code concern. Security-reviewer focuses on app code only.                                |
| **NOT REQUEST_CHANGES (owner conflict)** | ✓                | ✓                    | Same author/reviewer = `yaremenko-maksym`. Only `event: COMMENT` or `event: APPROVE`.                              |

---

## What remains for Phase 3c

1. **PM dispatch logic update** — `docs/agents/pm.md` and `docs/agents/pm-snippets.md`:
   - Replace `Agent(reviewer, ...)` with `Agent(code-reviewer, ...)` (default)
   - Add sensitive-path triage logic to auto-dispatch security-reviewer in parallel
   - Update the `pm-state.json` schema to track two reviewer dispatches (instead of one)
2. **PM Mode 3 (parallel dispatch)** — codify the pattern of launching two reviewer agents in parallel for financial PRs
3. **Smoke verification** — a real test dispatch of both agents on an open PR, verify that they coordinate correctly
4. **Lessons split (Phase 4)** — `memory/reviewer/lessons.md` → `memory/code-reviewer/lessons.md` + `memory/security-reviewer/lessons.md` (or a skill-based migration per ADR § 2.4.3)

---

## What remains untouched in this phase (intentional)

- **PM dispatch code** — not a trigger for the Phase 3b zone (PM keeps dispatching `reviewer` through the shim until Phase 3c)
- **memory/reviewer/lessons.md** — the split is deferred to Phase 4 (lessons→skills) for a cleaner conversion
- **GHA workflows** — `.github/workflows/ai-review.yml` archived; not a trigger in Phase 3b
- **ECC hooks** (`.claude/hooks-ecc/**`) — Phase 2.5 live, not the Phase 3b zone

---

## Verification (post-push)

```bash
# 1. PR checks green (docs-only PR, e2e should SKIP per the Phase 2.5 fix)
gh pr checks <PR#>

# 2. YAML frontmatter validity
head -10 docs/agents/code-reviewer.md       # triple dashes, name/description/tools/model
head -10 docs/agents/security-reviewer.md   # same
head -10 docs/agents/reviewer.md            # deprecated shim frontmatter

# 3. Diff scope = docs-only
git diff origin/main...HEAD --stat
# Expected:
# docs/agents/code-reviewer.md                  | +235
# docs/agents/security-reviewer.md              | +354
# docs/agents/reviewer.md                       | -242 +42 (rewrite as shim)
# docs/agents/CLAUDE-reviewer.md                | small trim
# docs/agents/README.md                         | table update
# docs/architecture/2026-06-03-phase3b-deliverable.md | +Nnn
```

---

## Rollback plan

If the split causes problems in PM dispatch (Phase 3c) — `git revert <merged-commit>` restores the monolithic `reviewer.md`. The new files (`code-reviewer.md`, `security-reviewer.md`, the deliverable doc) are deleted, the README is rolled back. The ECC migration returns to the Phase 3a state.

Granularity: **Full phase rollback** per ADR § Architect Rollback granularity (single commit revert).

---

## Confidence

**HIGH** on the overall split decision (ADR pre-approved § 2.1.5, the ECC pattern is well-documented).

**MED** on the exact distribution paths (sensitive-path triggers may require fine-tuning in Phase 3c when PM dispatch is implemented).

**LOW** on the USDT smart-contract section in security-reviewer — PHASE 8 has not started yet, the patterns are written prospectively, and will be validated in real practice when the contracts appear.

---

## Links

- ADR master: [`docs/architecture/2026-05-31-ecc-migration-design.md`](2026-05-31-ecc-migration-design.md) § 2.1.5 (Reviewer split decision)
- Phase 3a (Legal/Architect YAML port): PR #87
- Phase 2.5 (ECC hooks live): PR #89
- CI fix (docs-only PR pass required checks): PR #88
- code-reviewer system prompt: [`docs/agents/code-reviewer.md`](../agents/code-reviewer.md)
- security-reviewer system prompt: [`docs/agents/security-reviewer.md`](../agents/security-reviewer.md)
- Deprecated reviewer shim: [`docs/agents/reviewer.md`](../agents/reviewer.md)
