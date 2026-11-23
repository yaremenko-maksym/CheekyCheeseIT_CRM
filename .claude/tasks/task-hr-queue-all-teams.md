# Task: HR job queue shows all of the HR's teams at once (no team switcher)

Status: open · Track: full (RBAC — security-reviewer mandatory) · Created: 2026-11-23

## Owner request (2026-11-23, verbatim intent)

On `/job-queue` an HR sees a team dropdown (`TeamSwitcher`). It is broken in two ways:

1. Selecting "Команда Тимофій Єрофєєв" shows **0 vacancies**, while ADMIN (STUDIO scope) with the
   «Підходить сеньйору» filter on that team's senior (Viacheslav Kolisnichenko) sees stack-match cards.
2. The dropdown lists teams with no senior (e.g. "Команда Сергея").

Owner decision: **remove the team switcher; HR sees the queue like ADMIN does, but only across the
HR's own teams, all at once.** ADMIN keeps seeing everything. The «Підходить сеньйору» filter for an
HR lists only the seniors of the HR's teams, grouped by team like the ADMIN picker; teams without a
senior do not appear as filter groups.

This supersedes the 2026-10-18/25 rule "an HR works inside exactly ONE team scope". It does NOT
grant HR the STUDIO scope: STUDIO is `TRUE` visibility (suppressed items, triage, other teams'
manual cards) and stays ADMIN-only.

## Step 1 — diagnose the 0 first (blocks the design)

`listableOpportunityPredicate` / `visibleOpportunityPredicate` (TEAM, LEAD branch) and the row
columns (`queueRowColumns`) are both version-gated, so the gap is not obviously the predicate.
Candidates: TEAM generation build/serve (`queue-generation.ts` `currentGeneration`,
`isGenerationServable`), TEAM per-scope tab state (dismissals / opened, `queue-read-sql.ts`), the
LEAD branch's `team_members` / `liveTeam` conditions, roster `teamIds`. Reproduce with a real-DB
integration spec (scratch/QA DB only — `live-db-access.md`): one team, one senior with a fresh LEAD
match; STUDIO + `seniorIds` filter vs TEAM scope must list the same opportunity. If it does not
reproduce, write a read-only diagnostic SELECT for the owner to run on prod and put it in the PR
body; do not guess. A union of TEAM scopes inherits whatever bug the TEAM path has, so fix the root
cause here.

## Step 2 — design constraints

- Reads (list, counts, seniors picker, card, card continuations) for an HR with no `teamId` = the
  union (OR) of the HR's active live SENIOR teams' TEAM predicates. Senior-less teams stay in the
  union (grant / subscription / manual branches can still surface cards); they are only hidden from
  the filter groups.
- Writes stay per team: every action row, dismissal, assignment and generation is keyed by
  `(scope_kind, team_id)`. Prefer a design where reads are a union and each write still names one
  concrete team (e.g. the team derived from the card / chosen senior), so there is **no enum or DDL
  change**. If that is impossible, stop and write the question into this file (`decision-frontier`).
- Before choosing, list what every HR-reachable endpoint in `job-queue.controller.ts` does today with
  no `teamId` ("first team") and what it will do after. Put that table in the PR body.
- Cursor / policy signature (`policySignature`, `queue-read-sql.ts`) must change with the team set,
  so a cursor from one membership set never pages another.
- An HR naming a foreign `teamId` or a foreign senior in `seniorIds` still gets the empty / 404
  answer (unchanged non-disclosure).
- Web: `apps/web/app/routes/_authenticated/job-queue/index.tsx` drops `TeamSwitcher` for HR; the
  filter picker groups by team for HR too (`JobQueueFilters.tsx` currently flat for one team).
  Keep the "no team assigned" state. Remove `TeamSwitcher` if it becomes unused.

## Acceptance criteria

1. HR with 2+ teams opens `/job-queue` and sees one list = union of their teams' visible
   opportunities; no team dropdown.
2. The HR's «Підходить сеньйору» filter lists only seniors of the HR's teams, grouped by team;
   senior-less teams are not shown as groups.
3. Root cause of the "0 vacancies for a team that has matches" is identified, fixed, and covered by a
   real-DB integration test that fails before the fix.
4. Real-DB integration tests: HR never sees another team's opportunity (list, card, seniors picker,
   actions → 404 / empty); HR with a foreign `teamId` → empty; ADMIN behaviour unchanged.
5. Actions (dismiss / undo / submit / opened / manual) from the union view write the correct team.
6. Unit tests for the web route + filters updated; E2E for job-queue HR flow updated if it relies on
   the switcher.
7. typecheck, lint, unit pass; mutation gate per project rules.

## Assumptions

- A1: no DDL; union is read-side only (rollback = one PR).
