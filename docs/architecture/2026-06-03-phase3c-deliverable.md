# Phase 3c Deliverable — PM Agent Port to ECC YAML + Dispatch Logic Update

**Date:** 2026-06-03
**Architect:** Migration Architect
**Phase:** 3c (3c.1 frontmatter port + 3c.2 dispatch logic update)
**ECC version pin:** v2.0.0-rc.1
**Branches:**

- 3c.1 (merged #91): `feat/ecc-phase-3c1-pm-frontmatter` — YAML frontmatter zero-logic port
- 3c.2 (this PR): `feat/ecc-phase-3c2-pm-dispatch` — PM dispatch logic for the Phase 3b reviewer split

**Status:** 3c.1 merged (PR #91). 3c.2 proposed (awaits user review + merge).
**ADR reference:** [`docs/architecture/2026-05-31-ecc-migration-design.md`](2026-05-31-ecc-migration-design.md) § 2.1.1 (PM agent port)
**Predecessors:**

- Phase 3a (#87): Legal/Architect YAML frontmatter
- Phase 3b (#90): Reviewer split → code-reviewer + security-reviewer
- Phase 3c.1 (#91): PM YAML frontmatter (zero logic change)

---

## TL;DR

Phase 3c.2 applies the Phase 3b reviewer split (code-reviewer + security-reviewer) to the PM dispatch logic. All three ECC agents (code-reviewer, security-reviewer, Legal) are now dispatched by PM from a single DRY list of critical-path trigger zones. PM Mode 2 monitoring is extended with aggregate verdict logic + Mode 2.F (review timeout fallback). pm-state.json event types are extended with `code_review_*` + `security_review_*` + `review_timeout`; the pm-state.json **live state is not modified** (only the schema is documented in the new `docs/specs/pm-state-events.md`).

---

## Inventory — what changed / created

### Phase 3c.1 (PR #91 — merged)

| File                       | Change                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `docs/agents/pm.md`        | Added YAML frontmatter (name/description/tools/model: opus). The prompt body not touched. |
| `docs/agents/CLAUDE-pm.md` | Trim deprecation references (sync with the new frontmatter).                              |

### Phase 3c.2 (this PR — proposed)

| File                                                  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/agents/pm.md`                                   | Role intro updated → code-reviewer/security-reviewer/Legal listed. Mode 2 table updated (split review events). Mode 2.D rewritten for the aggregate verdict. Mode 2.F new — review_timeout handler. §"Critical-path trigger zones" DRY list. §"Aggregate verdict logic" table. L4 lesson rewritten (default reviewer policy). Reference section extended.                                                                                                                             |
| `docs/agents/pm-snippets.md`                          | The "Reviewer — code review" section split into "code-reviewer — default" + "security-reviewer — critical paths". The "Parallel launch of Reviewer + Legal" section extended to code-reviewer + security-reviewer + Legal in parallel. Typical agent durations: code-reviewer/security-reviewer rows added. The pre-review label comment updated. pm-state.json schema v2 `agent_invocations` keys updated. The Event types section fully extended + a deprecated block added. |
| `docs/agents/memory/pm/lessons.md`                    | Append-only: 2 new lessons (2026-06-03) — reviewer split + Mode 2.F timeout recovery. The historical 2026-05-21 lesson about Verdict: BLOCK is preserved (applicable to both new agents).                                                                                                                                                                                                                                                                                         |
| `docs/specs/pm-state-events.md`                       | **NEW.** Catalog of event types — historical + Phase 3a Legal + Phase 3c.2 reviewer split. A deprecated block for `review_approve` / `review_blocked`. Aggregate verdict — derived state (not an event). Agent invocations counter — new keys + historical compat.                                                                                                                                                                                                                |
| `docs/architecture/2026-06-03-phase3c-deliverable.md` | **NEW.** This file — the Phase 3c deliverable summary.                                                                                                                                                                                                                                                                                                                                                                                                                             |

### Untouched (intentional)

| File                                        | Reason                                                                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/specs/pm-state.json`                  | **LIVE state file** — contains the data of the Phase 6A onboarding task. Schema documentation is moved out into `pm-state-events.md`. The historical state is not migrated.                      |
| `docs/agents/CLAUDE-pm.md`                  | Already a deprecated stub without reviewer mentions (Phase 3c.1 sync). Not a trigger in 3c.2.                                                                                                     |
| `docs/agents/contracts.md`                  | Cross-agent state machine — owned by a separate phase. §6 Reviewer verdict semantics still works (Verdict: BLOCK first-line — a single pattern for both new agents). Phase 3d/4 may trim it.     |
| `docs/agents/reviewer.md` (shim)            | Already deprecated since Phase 3b. PM now does not dispatch it explicitly — but the file itself lives until the Phase 6 cleanup.                                                                 |
| `docs/agents/code-reviewer.md`              | Created in Phase 3b, not a trigger in 3c.2.                                                                                                                                                      |
| `docs/agents/security-reviewer.md`          | Created in Phase 3b, not a trigger in 3c.2.                                                                                                                                                      |
| Application code (`apps/**`, `packages/**`) | Phase 3 scope — docs-only. Application code is not a trigger.                                                                                                                                    |
| GHA workflows                               | `.github/workflows/archive/ai-review.yml` deprecated. Active workflows are not a trigger in 3c.2.                                                                                               |
| `.claude/hooks-ecc/**`                      | Phase 2.5 active, not a trigger in 3c.2.                                                                                                                                                         |

---

## PM Dispatch Decision Matrix (post Phase 3b split, codified in Phase 3c.2)

Who is dispatched for which PR — a single matrix:

| PR characteristic                                                          |      code-reviewer      | security-reviewer | Legal Mode B |         AutoTest          |           DevOps            |     Parallel?     |
| -------------------------------------------------------------------------- | :---------------------: | :---------------: | :----------: | :-----------------------: | :-------------------------: | :---------------: |
| Ordinary feature PR (UI / non-critical apps/api/\*\*)                      |       ✓ (default)       |         —         |      —       |   conditional (see §5)    |              —              |        n/a        |
| PR touches `apps/api/src/auth/**`                                          |            ✓            |         ✓         |      ✓       |        conditional        |              —              |   ✓ (3 agents)    |
| PR touches `apps/api/src/finance/**`                                       |            ✓            |         ✓         |      ✓       |        conditional        |              —              |         ✓         |
| PR touches `apps/api/src/transactions/**`                                  |            ✓            |         ✓         |      ✓       |        conditional        |              —              |         ✓         |
| PR touches `apps/api/src/payouts/**`                                       |            ✓            |         ✓         |      ✓       |        conditional        |              —              |         ✓         |
| PR touches `apps/api/src/wallets/**` (Phase 7+)                            |            ✓            |         ✓         |      ✓       |        conditional        |              —              |         ✓         |
| PR touches `apps/api/src/documents/**`                                     |            ✓            |         ✓         |      ✓       |        conditional        |              —              |         ✓         |
| PR touches `apps/api/src/users/**` (PII)                                   |            ✓            |         ✓         |      ✓       |        conditional        |              —              |         ✓         |
| PR touches `packages/shared/src/schemas/{auth,finance,users,documents}.ts` |            ✓            |         ✓         |      ✓       |        conditional        |              —              |         ✓         |
| PR touches `package.json` / `pnpm-lock.yaml`                               |            ✓            |   ✓ (npm audit)   |      —       |        conditional        |              —              |   ✓ (2 agents)    |
| PR touches `contracts/**` (Phase 8 USDT)                                   |            ✓            |         ✓         |      ✓       |        conditional        |              —              |         ✓         |
| PR touches `apps/api/drizzle/migrations/**`                                |            ✓            |  ✓ (data shape)   | conditional  |        conditional        | conditional (init-tracking) |         ✓         |
| Diff > 500 LOC + any of the above                                          |            ✓            |         ✓         | conditional  |        conditional        |              —              |         ✓         |
| Docs-only PR (only `docs/**`)                                              |  conditional (skip OK)  |         —         |      —       | skip (`autotest_skipped`) |              —              |        n/a        |
| DevOps PR (only `.github/**`, `.claude/hooks-ecc/**`)                      | ✓ (zone-of-write check) |  ✓ (CI security)  |      —       |           skip            |          initiator          | parallel possible |

**Reading the matrix:**

- ✓ = dispatched mandatorily
- conditional = dispatched per additional rules (see `contracts.md` §5 for AutoTest)
- — = not dispatched
- "Parallel?" — all dispatched in a single dispatch message with `run_in_background=True`

---

## Event Types Reference (new in Phase 3c.2)

Full catalog — `docs/specs/pm-state-events.md`. A brief overview of the new event types:

| Event type                |       Phase added        | Fields (minimal)                                   | Description                                                             |
| ------------------------- | :----------------------: | -------------------------------------------------- | ----------------------------------------------------------------------- |
| `code_review_started`     |           3c.2           | `pr`                                               | PM dispatched code-reviewer                                             |
| `code_review_done`        |           3c.2           | `pr`, `verdict`, `rounds`                          | code-reviewer finished. Verdict APPROVE/BLOCK.                          |
| `security_review_started` |           3c.2           | `pr`, `triggered_paths`                            | PM dispatched security-reviewer (only for critical-path PRs)            |
| `security_review_done`    |           3c.2           | `pr`, `verdict`, `rounds`, `owasp_categories_hit?` | security-reviewer finished. Verdict APPROVE/BLOCK.                      |
| `security_dispatched`     |           3c.2           | `pr`, `triggered_paths`                            | Alias for `security_review_started` (short form for Mode 2 logging)     |
| `review_timeout`          |           3c.2           | `pr`, `agent`, `dispatched_at`, `timeout_at`       | A reviewer did not return a verdict within 2× expected duration. Triggers Mode 2.F. |
| `brief_approved`          | (existing in live state) | `brief`                                            | BA brief accepted by PM. Documented in Phase 3c.2.                      |
| `task_file_created`       | (existing in live state) | `file`                                             | PM created a task-file. Documented in Phase 3c.2.                       |

**Deprecated (preserved in historical completed[] tasks):**

- `review_approve` → replaced by `code_review_done` + `verdict: "APPROVE"`
- `review_blocked` → replaced by `code_review_done` OR `security_review_done` + `verdict: "BLOCK"` (at the time of recording, PM knows exactly which reviewer)

---

## Mode 2 Verdict Aggregation Logic (codified in Phase 3c.2)

PM waits for ALL dispatched review events before the aggregate decision. The computation:

```
INPUT:
  code_review_done.verdict   ∈ {APPROVE, BLOCK}     (always present — code-reviewer default)
  security_review_done.verdict ∈ {APPROVE, BLOCK}   (present iff security-reviewer dispatched)
  legal_review_posted.confidence ∈ {HIGH, MED, LOW} (present iff Legal Mode B dispatched, info-only)

OUTPUT (aggregate):
  IF code_review_done.verdict == "BLOCK":
    aggregate = BLOCK (early-exit — no waiting on security)
    label: -awaiting-pm-review, +do-not-merge → Mode 2.D
  ELIF security_review_done.verdict == "BLOCK" (if it was dispatched):
    aggregate = BLOCK (early-exit)
    label: -awaiting-pm-review, +do-not-merge → Mode 2.D
  ELIF code_review_done.verdict == "APPROVE":
    IF security_review_done was dispatched AND not yet returned:
      wait
    ELIF security_review_done.verdict == "APPROVE" OR not dispatched:
      aggregate = APPROVE
      label: +awaiting-pm-review → Mode 2.B (post-review analysis)

Legal Mode B verdict — info-only:
  legal-noted label regardless of APPROVE/BLOCK.
  Confidence LOW + hard zone → legal_escalated_to_human event, USER informed,
    but the aggregate verdict does NOT depend on Legal (Legal is not a gate).
```

**Race-condition note (label awaiting-pm-review):**

The `awaiting-pm-review` label is set **only** by code-reviewer on APPROVE (per the `code-reviewer.md` workflow). If security-reviewer returns FIRST with APPROVE, it sets `security-noted` but does **not** touch `awaiting-pm-review` — that is the code-reviewer's zone. Edge case: if only security-reviewer was dispatched (ad-hoc on a contested PR without a code review) — then security-reviewer sets `awaiting-pm-review` (see `security-reviewer.md` Step 6).

---

## Critical-Path Trigger Zones (DRY single source)

PM has a **single** list of paths for:

1. Auto-dispatching security-reviewer in parallel with code-reviewer
2. Auto-dispatching Legal Mode B in parallel

The source of truth — `docs/agents/pm.md` §"Critical-path trigger zones". Any change to this list updates the dispatch for both branches (security + legal).

**Advantage of DRY:** adding a new sensitive path (for example, Phase 8: the `contracts/` directory) — a one-time change in one place; security-reviewer and Legal automatically pick it up via PM dispatch.

**Synchronization check (recommended for future zone expansions):**

- `pm.md` §"Critical-path trigger zones" — primary
- `security-reviewer.md` § "When you are dispatched" — secondary (should reference pm.md)
- `legal.md` Mode B trigger heuristic — secondary
- `pm.md` Mode 2 table "PR diff matches critical-path trigger zones" row — derived
- `pm.md` L4 lesson "Reviewer dispatching rule" — derived

In Phase 3c.2 the primary is updated; the secondary files (`security-reviewer.md`, `legal.md`) already had their lists from Phase 3a/3b — they **match** the primary, but for future expansions one must either reference the primary or update both synchronously.

---

## Risk Assessment

### R1. Reviewer hang / timeout (existing risk, Phase 3c.2 codifies recovery)

**Risk:** one of the dispatched reviewers (code or security) hangs on an MCP call (real incident 2026-05-23). Without a timeout handler — the PR hangs without a verdict indefinitely.

**Mitigation (codified in Phase 3c.2):**

- Mode 2.F (new) — review_timeout handler. PM detects if > 2× expected duration.
- Recovery steps: check `/tmp/reviewer-output/pr-<N>-*.md` (write-then-post safety); manual gh CLI post; re-dispatch with a reminder.
- The `review_timeout` event is recorded.

**Residual risk:** **LOW.** Recovery codified, the write-then-post pattern already preserves the body even on an MCP hang.

### R2. Async race condition between two reviewers over labels

**Risk:** security-reviewer returns before code-reviewer and tries to set `awaiting-pm-review` → a race with code-reviewer over the label.

**Mitigation:**

- In `security-reviewer.md` Step 6 it is clear: the `awaiting-pm-review` label is set **only** by code-reviewer (default). Security-reviewer sets `security-noted`. Edge case (only-security dispatch) — security-reviewer sets `awaiting-pm-review` itself.
- In `pm.md` the "Aggregate verdict logic" table — an explicit race avoidance note.

**Residual risk:** **LOW.** The race is theoretically possible only in the edge case of an ad-hoc security-only dispatch — there is a single agent there, no race arises.

### R3. Aggregate verdict misinterpretation after compaction

**Risk:** after session compaction PM reads `events[]`, sees only `code_review_done` (APPROVE), does not know whether security-reviewer was dispatched. It may mistakenly consider the aggregate APPROVE.

**Mitigation:**

- The session-recovery checklist (pm.md §"Session-recovery") includes reading `pm-state.json` and `agent_invocations.security_reviewer` — if > 0, security was dispatched.
- When uncertain — PM checks the PR reviews via `mcp__github__get_pull_request_reviews` to see the actual state.

**Residual risk:** **MED.** May require an additional recovery step for future complex multi-reviewer scenarios. Phase 4 (lessons consolidation) may add an additional recovery checklist item.

### R4. Critical-path zones drift (synchronization)

**Risk:** the primary list in `pm.md` is updated, but the secondary lists in `security-reviewer.md` / `legal.md` are not synchronized → the agents arrive with different expectations.

**Mitigation:**

- In the Phase 3c.2 deliverable the synchronization check is explicitly described.
- Phase 3d/3e may add a hook check: compare the trigger zone lists between files when a PR touches any of them.

**Residual risk:** **MED.** Manual sync for now — automation is possible in future phases.

### R5. Historical events compatibility

**Risk:** old `completed[]` tasks with `review_approve` / `review_blocked` events. PM during metrics aggregation must interpret them correctly.

**Mitigation:**

- `pm-state-events.md` explicitly describes the deprecated block and the mapping rule (review_approve ≡ code_review_done APPROVE).
- `agent_invocations.reviewer` (legacy) ≡ `code_reviewer` (post-split).

**Residual risk:** **LOW.** Backward compat is well documented.

---

## What's Next — Phase 3d (Coder shell port)

Phase 3d is next in the migration roadmap (per ADR § 2.1.X):

- `docs/agents/coder.md` — add YAML frontmatter (model: sonnet or opus depending on the ECC pattern)
- `docs/agents/CLAUDE-coder.md` — trim deprecation references
- Update the coder watchdog hooks (`.claude/hooks/coder-progress-marker.sh`) — verify compatibility with the ECC YAML format
- Update `docs/agents/memory/coder/` — frontmatter / lessons format normalization

After 3d:

- **Phase 3e:** AutoTest port (frontmatter + dispatch tuning)
- **Phase 3f:** DevOps port (frontmatter + GHA workflow refs)
- **Phase 4:** lessons → skills conversion (per ADR § 2.4.3) — split the shared `memory/reviewer/lessons.md` into a code/security split
- **Phase 5:** GHA workflow refresh (for `ai-review.yml` archived → `code-review.yml` + `security-review.yml`)
- **Phase 6:** Cleanup — remove the `reviewer.md` shim after migrating all task-files / references

---

## Verification (post-push, Phase 3c.2)

```bash
# 1. PR checks green (docs-only PR — e2e should SKIP per the Phase 2.5 fix)
gh pr checks <PR#>

# 2. Diff scope = docs-only
git diff origin/main...HEAD --stat
# Expected:
# docs/agents/pm.md                                   | +Nnn -Mmm
# docs/agents/pm-snippets.md                          | +Nnn -Mmm
# docs/agents/memory/pm/lessons.md                    | +2  (append-only)
# docs/specs/pm-state-events.md                       | +Nnn (new)
# docs/architecture/2026-06-03-phase3c-deliverable.md | +Nnn (new)

# 3. pm-state.json NOT a trigger (live state preservation)
git diff origin/main docs/specs/pm-state.json | wc -l
# Expected: 0

# 4. Reviewer references = only in historical / shim / deprecated context
grep -nE "Agent\(reviewer|reviewer dispatch|^### Reviewer" docs/agents/pm.md docs/agents/pm-snippets.md
# Expected: empty (or only in deprecated blocks/comments)

grep -nE "code-reviewer|security-reviewer" docs/agents/pm.md docs/agents/pm-snippets.md | wc -l
# Expected: many mentions (>= 20)

# 5. Modes 1-5 structure of pm.md preserved
grep -cE "^## Mode" docs/agents/pm.md
# Expected: 5 (Mode 1, Mode 2, Mode 3, Mode 4, Mode 4.A, Mode 5 — but 4.A is a subheading)

# 6. Golden rules of pm.md preserved
grep -c "Golden rules" docs/agents/pm.md
# Expected: 1

# 7. Session-recovery checklist of pm.md preserved
grep -c "Session-recovery" docs/agents/pm.md
# Expected: 1
```

---

## Rollback Plan

If the PM dispatch logic causes problems in real work (the new review flow breaks) — `git revert <merged-commit>` restores the Phase 3c.1 state (YAML frontmatter only). The 3c.2 files are deleted:

- `docs/agents/pm.md` — return to the Phase 3c.1 version (frontmatter + the old Mode 2 without aggregate verdict)
- `docs/agents/pm-snippets.md` — return to the pre-split Reviewer section
- `docs/agents/memory/pm/lessons.md` — the last 2 lessons (2026-06-03) are removed (append-only undone)
- `docs/specs/pm-state-events.md` — removed (new file)
- `docs/architecture/2026-06-03-phase3c-deliverable.md` — removed

After rollback PM returns to dispatching a bare `Agent(reviewer, ...)` (the old shim redirect).

Granularity: **Full phase rollback** per ADR § Architect Rollback granularity.

---

## Confidence

**HIGH** on:

- Reviewer split dispatch decisions (Phase 3b ADR pre-approved, code-reviewer/security-reviewer well-defined)
- DRY trigger paths consolidation (a single list in pm.md, secondary refs OK)
- Event types catalog (built on the existing pm-state.json schema + Phase 3a Legal events)
- Aggregate verdict logic (the early-exit BLOCK rule is simple and predictable)

**MED** on:

- Mode 2.F timeout duration estimates (`pm-snippets.md` typical durations) — may need tuning after real usage
- pm-state-events.md as a single source — may compete with the inline schema in pm-snippets.md (but cross-references are established)
- Synchronization risk between the primary trigger zones in pm.md vs the secondary in security-reviewer.md / legal.md (R4 risk)

**LOW** on:

- USDT smart contract trigger paths (`contracts/**`) — Phase 8 has not started, prospective
- Aggregate verdict computation after compaction (R3 risk) — may require an additional recovery step

---

## Links

- ADR master: [`docs/architecture/2026-05-31-ecc-migration-design.md`](2026-05-31-ecc-migration-design.md) § 2.1.1 (PM port)
- Phase 3a deliverable (Legal/Architect YAML port): PR #87
- Phase 3b deliverable: [`docs/architecture/2026-06-03-phase3b-deliverable.md`](2026-06-03-phase3b-deliverable.md) — Reviewer split
- Phase 3c.1: PR #91 — PM YAML frontmatter
- Phase 3c.2: this PR (`feat/ecc-phase-3c2-pm-dispatch`)
- PM system prompt: [`docs/agents/pm.md`](../agents/pm.md)
- PM snippets: [`docs/agents/pm-snippets.md`](../agents/pm-snippets.md)
- code-reviewer system prompt: [`docs/agents/code-reviewer.md`](../agents/code-reviewer.md)
- security-reviewer system prompt: [`docs/agents/security-reviewer.md`](../agents/security-reviewer.md)
- pm-state.json event catalog: [`docs/specs/pm-state-events.md`](../specs/pm-state-events.md)
- Deprecated reviewer shim: [`docs/agents/reviewer.md`](../agents/reviewer.md)
