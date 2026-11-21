# task-sources-07c-senior-queue-closed — SENIOR has no queue access; sees HR's results as interview cards

## Agent: coder
## Status: ready
## Model: claude-opus-5 high (RBAC -> T3; security-reviewer MANDATORY)
## Branch: feat/sources-07c-senior-queue-closed

## Owner decision (chat, 2026-11-19, verbatim meaning)
"For the SENIOR close the queue and access to the page entirely. The senior only sees the result of
HR's work with the queue, as cards on the Interviews page." This supersedes option (A)'s
"nothing assigned yet" empty-state text from the task-07 brief.

## Facts (Master, 2026-11-19)
- Web: `/job-queue` and `/vacancies` already exclude SENIOR in `ROUTE_ACCESS`
  (`apps/web/app/lib/route-access.ts`; matrix in `.claude/agents/project-state.md` §3).
- API: `apps/api/src/job-sourcing/job-sourcing.controller.ts` still allows SENIOR on
  `GET suggestions` (:70), `PATCH suggestions/:id/status` (:81), `POST opportunities/:id/open`
  (:98), and `GET/POST/DELETE exclusions` (:105, :115, :122).
- The senior's suggestion dialog on the Interviews page reads legacy `job_suggestions` ⋈
  `job_postings` (always 0 rows on prod). See
  `~/.claude/handoffs/sources-connect-2026-11-19/task-07-REPORT.md`.
- No queue code creates an interview today (grep of `apps/api/src/job-sourcing/queue/` for
  `interview` is empty). Queue tables: `job_queue_actions` (append-only, retention triggers),
  `job_queue_assignments` (0 rows on prod).

## Acceptance criteria
1. Design first (report to Master BEFORE code if it needs DDL, a new table, or changes the
   append-only `job_queue_actions` contract): what HR action in the queue counts as "a result for
   the senior" (e.g. HR submits the senior to a vacancy / assignment), and how it becomes a card on
   the senior's Interviews page reusing the existing interview card component and data model.
2. SENIOR is refused (403, server-side, in controller AND service body per
   `.claude/rules/common/security-review` checklist) on every job-queue / suggestions /
   opportunities endpoint. Exclusions: keep SENIOR's own company/keyword exclusions only if they
   live outside the queue UI and the senior still has a place to edit them; otherwise refuse too.
   Record the choice in `## Assumptions`.
3. The senior's suggestion dialog / entry point on the Interviews page is removed; no dead
   endpoints left for SENIOR.
4. The HR result appears for the senior as an interview card (per AC 1), uk + en via Lingui.
5. Tests: API 403 tests per endpoint for SENIOR (integration, not mocked), unit tests for the card
   creation, web tests for the removed dialog; E2E affected specs run locally.
6. `ROUTE_ACCESS` / project-state §3 matrix stay in sync.

## Assumptions
- (A1) <coder fills>

## Owner answers (chat, 2026-11-19, on the 07c design brief)
- Design: `~/.claude/handoffs/sources-connect-2026-11-19/task-07c-DESIGN.md`.
- Q1 DDL: YES. `interviews.job_opportunity_id uuid` (nullable) + partial unique index on
  `(job_opportunity_id, senior_id)`, staged under `apps/api/drizzle/manual/` per manual-staged rules.
- Q2 stage: YES, a new `SUBMITTED` interview stage placed before HR screen (uk + en labels).
- Q3 cancel: ARCHIVE the card on HR cancel; re-submit of the same senior to the same vacancy
  restores that same card (no second card).
- Master (A1): the suggestion dialog is dead code for every role (`JOB_SOURCING_ENTRY_ENABLED = false`);
  delete it for all roles. Exclusion endpoints: refuse SENIOR (their only UI is that dialog).
