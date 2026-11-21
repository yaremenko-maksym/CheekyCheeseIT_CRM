# Task sources-07c fix round 2 — PR #1431 (CI red on d17c856fb + round-2 review)

Parent task: `.claude/tasks/task-sources-07c-senior-queue-closed.md`. PR #1431, branch
`feat/sources-07c-senior-queue-closed-1`, head `d17c856fb`. Round-2 reviews: ids 5979029559 (code +
security, APPROVE) and 5979031032 (spec, PASS).

## Owner decision (2026-11-19)

Q3 narrowing is ACCEPTED: an HR cancel archives the card only while it is in `SUBMITTED`. Keep it; replace
the PR-body "needs owner acknowledgement" wording with "owner confirmed 2026-11-19".

## CI failures on d17c856fb (Integration Tests (Postgres): 4 files, 25 tests)

All fail with `ForbiddenException: Vacancy sourcing is run by ADMIN and HR; a senior sees the result as
interview cards` from `JobSourcingService.assertNotSenior`. Your pre-push run used only the specs you
touched; these integration specs still call the queue as a SENIOR:

- `apps/api/src/job-sourcing/job-sourcing.integration.spec.ts` (15)
- `apps/api/src/job-sourcing/compat-barrier.integration.spec.ts` (6)
- `apps/api/src/job-sourcing/job-sourcing-open-opportunity.integration.spec.ts` (2)
- `apps/api/src/job-sourcing/dou-golden.integration.spec.ts` (2)

Per test: if it uses a SENIOR only as a convenient actor, switch the actor to HR (or ADMIN) and keep the
behaviour assertion. If it asserts a SENIOR-only capability or SENIOR-scoped visibility of the queue, turn it
into the refusal assertion (403, nothing read or written) — do not delete coverage silently. List every
converted test in the PR body. Run the FULL api integration suite on scratch `crm_qa_07c` (DATABASE_URL
inline, never `crm_db`) and report the count; a `0 passed` run is not a pass.

`Typecheck · Lint · Unit Tests (core)` also fails on the E2E shard coverage guard: `ci.yml` still lists the
deleted `tests/job-sourcing-mobile.spec.ts`. That edit is `.github/workflows/**` (DevOps zone): a separate
DevOps agent pushes it to the same branch. Do not touch `ci.yml`; pull before your push
(`git pull --rebase origin feat/sources-07c-senior-queue-closed-1`).

## Round-2 review findings

- **CR2-L-1** `senior-interview-card.ts` `max(position)+1` can tie under two concurrent submits for one
  senior, and `interviews.service.ts` orders by `[asc(stage), asc(position)]` with no tie-break. Fix: add a
  deterministic tie-break (`created_at`, then `id`) to that order-by; a unit or integration test pins it.
- **CR2-L-2** PR body stale: deploy wiring is in this branch (`d09e23c53`); the AC 6
  `.claude/agents/project-state.md` claim was reverted (Master does it in a docs PR). Fix the body.
- **SR-L-4** deferral needs a backlog entry: Master records it in `.claude/tasks/BACKLOG-followups.md`
  (not your zone). Just keep the PR body's deferral text.

## Rules

Your zone: `apps/**`, `packages/**`. Red-check new assertions. Mutation gate on changed lines
(`node scripts/devops/mutation-gate.mjs --changed`), eslint, prettier, typecheck. Commit with
`ac_verified:` from the parent task; push `DATABASE_URL= git push origin HEAD:feat/sources-07c-senior-queue-closed-1`
(background), verify with `git ls-remote`. Notes server as before. No second-opinion. English only.
Report: `Worktree:`, `Pushed:`, `Findings: resolved N / disagreed M (ids)`, `Tests:` with counts,
mutation survivors.
