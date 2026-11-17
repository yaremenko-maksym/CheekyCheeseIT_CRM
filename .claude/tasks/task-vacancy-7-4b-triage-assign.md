# task-vacancy-7-4b-triage-assign — ADMIN «Призначити команді…» on a triage card (descoped from Task 7.4)

## Agent: coder

## Status: blocked until Task 7.3b is merged

## Blockers: Task 7.3b (`task-vacancy-7-3b-card-fields.md`)

## Priority: medium

## Model: opus

## Depends on: Task 7.3b merged into `main`

## Branch: feature/vacancy-7-4b-triage-assign

## Design tier: 2 (spec `docs/design/vacancy-queue.md` §5.6; reference `docs/design/assets/vacancy-queue/card-admin-menu-320.png`)

## Context

Task 7.4 AC 6 required the ADMIN vacancy «⋯» item «Призначити команді…» for triage items. It was descoped (owner decision
brief Q1, 2026-11-10, recommendation taken): the request needs the policy version, a list of every team for ADMIN and a
grant expiry, and the card did not expose them while 7.4 could not touch card fields.

The API exists: `POST /job-queue/:id/team-triage` (ADMIN, `jobQueueTeamTriageGrantRequestSchema`: `teamId`,
`expectedOpportunityRevision`, `policyVersion`, `reason`, `expiresAt`, `idempotencyKey`) and
`DELETE /job-queue/:id/team-triage/:teamId`.

## Concrete changes

1. Reuse the existing `useGrantJobQueueTeamTriage` in `apps/web/app/hooks/use-job-queue.ts` (no new hook); the card's
   ADMIN-only `policyVersion` comes from Task 7.3b.
2. `apps/web/app/components/job-queue/JobQueueActions.tsx` — the ADMIN vacancy «⋯» item «Призначити команді…» on triage
   items: team picker (every active team), bounded reason, expiry; a 409 shows the one conflict note (§5.6).
3. Lingui catalogs for every new string.

## RBAC

| Role   | Access                                  |
| ------ | --------------------------------------- |
| ADMIN  | the menu item and the grant              |
| others | not rendered; the API answers 403        |

## Acceptance criteria

1. [ ] The item renders for ADMIN on triage items only; never for HR (test both roles).
2. [ ] A grant sends every field of `jobQueueTeamTriageGrantRequestSchema` with the versions the card returned; a 409 refetches
       the card and shows «Дані змінилися. Оновіть картку й повторіть.»
3. [ ] Expiry: a default chosen and recorded in Assumptions (A1), editable in the dialog.
4. [ ] Keyboard: the dialog traps focus, the safe button takes initial focus, Escape returns focus to «⋯».
5. [ ] i18n (uk + en), no extract diff; responsive 320 → 1920, targets ≥ 44 px.

## Assumptions

- A1 (Master): `policyVersion` — the client sends `0`, a named constant meaning "unversioned". The server stores the
  value as an audit stamp and validates it against nothing; the card has no server policy version to return (Task 7.3b,
  SPEC-M-2); real versions start at 1, so `0` never collides. Server-side policy versioning is backlog 425 (owner, A3).
- A1 (Coder fills in): the grant-expiry default and why, one line here before the first commit. Owner brief Q1 left the
  default to this task; the value rides into the PR body Assumptions block.

## Verification (Coder before `git push`)

1. `git diff HEAD --name-only` — only files from "Concrete changes".
2. Each AC: a named test.
3. Commit: `ac_verified: 1,2,3,4,5` and `vision: ✓ /job-queue`.
