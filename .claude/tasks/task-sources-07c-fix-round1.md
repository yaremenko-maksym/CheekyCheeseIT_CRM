# Task sources-07c fix round 1 — PR #1431 (SENIOR queue closed, SUBMITTED stage, interview card)

Parent task: `.claude/tasks/task-sources-07c-senior-queue-closed.md` (read its "Owner answers"
section; it overrides earlier text). Branch `feat/sources-07c-senior-queue-closed-1`, head
`d09e23c53` (DevOps wiring commit on top of the coder's `4499be9a5` — keep it; do not touch
`.github/**`, `scripts/devops/**`, `docs/runbooks/deployment.md`).

Reviews: `gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/pulls/1431/reviews` — code review
(Verdict: BLOCK, 8 findings), spec review (APPROVE / PASS, 0), security review (see section below
once present). Resolve all; disagreements go in the PR body with the reason.

## Code review findings

- **CR-H-1** `job-sourcing.service.ts` `assertNotSenior`: Stryker survivors (BlockStatement at the
  body, Conditional + StringLiteral on the role check). Add a unit `*.spec.ts` (gate-runnable) that
  calls all six public queue/exclusion methods with `{ role: 'SENIOR' }` against a `db` stub whose
  `select` throws; assert the 403 AND that no row was read.
- **CR-H-2** `queue-actions.service.ts` call sites of `createSubmittedInterviewCard` /
  `archiveSubmittedInterviewCard` (in `submit`, `createManualCard`, `cancelSubmission`): the bound
  arguments (`opportunityId`, `seniorId`, `actorId`, `actorIsHr`) are untested. Make the strict
  fake capture statement parameters and assert them for both `interviews` statements, and drive
  `submit` → `cancelSubmission` → re-submit through the service in the integration spec.
- **CR-M-1** Drop `.claude/agents/project-state.md` from this branch (Coder zone forbids
  `.claude/agents/**`). Master lands that edit in a separate docs PR. Put the exact text you had
  into the PR body under "For Master" so it is not lost.
- **CR-M-2** `2026-11-19_interview_stage_submitted.sql` closing check: join `pg_namespace` and
  filter `n.nspname = current_schema()` on all three catalog reads. Keep idempotency; re-run the
  forward-DDL integration spec.
- **CR-L-1** `senior-interview-card.ts`: set `position` on the `DO UPDATE` restore branch too (or
  renormalise the SUBMITTED column), so a restored card never ties.
- **CR-L-2** Log (structured) when the card helper returns `null` (pair sits in a non-ARCHIVED
  stage), so a submission without a card is findable.
- **CR-L-3** `deleteExclusion`: rewrite the stale SENIOR IDOR comment; drop the now-dead comparison
  or state why it stays as a backstop.
- **CR-L-4** PR body: add literal `Task: <path>` and `Plan: <where>` lines (Flow Gate greps them).

## Security review findings

Security review: `Verdict: APPROVE`, 10 findings — SR-M-1, SR-M-2, SR-M-3, SR-L-1 … SR-L-7. Read
the full text in the PR review whose first line is `Verdict: APPROVE` and which lists `SR-` ids
(`gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/pulls/1431/reviews`). Resolve all ten like the
code-review ones. Any SR finding that touches the deploy wiring (DevOps zone) — do not edit it;
list it under "For Master" in the PR body.

## Rules

Scratch DB only, `DATABASE_URL` inline, `SELECT current_database()` first; never `crm_db`. Run the
affected integration specs and the mutation gate on the changed files locally before the final
push; report survivor count. `wip:` pushes early; `DATABASE_URL= git push` (background for long
pushes); the branch already has a DevOps commit — fetch first, never force-push over it. Final
commit `ac_verified: 1,2,3,4,5,6`. Never --no-verify. Notes server: `notes.search` before reading
code, `notes.add` for facts with file:line. Do not run second-opinion. English only.

Report: `Worktree:`, `Pushed: <branch> @ <sha>` (ls-remote), `Findings: resolved N / disagreed M
(ids)`, `Tests:` with counts, mutation survivors, `Skills:`.
