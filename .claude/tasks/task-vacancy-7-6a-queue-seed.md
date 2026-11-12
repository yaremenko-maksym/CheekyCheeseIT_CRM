# task-vacancy-7-6a-queue-seed — a job-queue seed for the Task 7.6 E2E stand

## Agent: coder

## Status: ready

## Blockers: none (Tasks 7.3b, 7.4b, 7.5, 7.5b are merged)

## Priority: high

## Model: opus-5-5 high (jev T3: multi-table FK inserts, RBAC-visible data)

## Branch: feat/vacancy-7-6a-queue-seed

## Context

CI's E2E job runs `pnpm --filter @crm/api db:push && db:seed` and then the whole Playwright suite against the real
API. The seed (`apps/api/src/database/seed.ts` and `seed/*`) has **no job-queue data at all**, so Task 7.6 cannot
prove any rights scenario on the real stack (plan r5 §Task 7.6: "mock mode never used for rights checks"). This task
adds that data. Task 7.6 (AutoTest) runs in parallel on its mock-only scenarios and adds the real-API ones once this
merges; it finds every row **through the API by the titles and emails below**, so those strings are the contract and
must not drift.

Tables the queue read joins (`queue-read-sql.ts`): `job_opportunities`, `job_opportunity_matches`,
`job_opportunity_sources`, `job_source_records` (+ `job_source_record_revisions`, `job_text_blobs` for the
description), `job_queue_generations` / `job_queue_generation_entries`, `job_queue_assignments`,
`job_queue_dismissals`, `job_queue_actions`, `job_team_triage_subscriptions`, plus the source registry. The fixture
inserts in `job-queue-rbac.integration.spec.ts` and `job-queue.service.integration.spec.ts` already build valid rows
for these tables: reuse their shape rather than inventing one.

Existing seed facts: SENIOR teams Team Kovalenko (HR Anna, senior Oleksiy), Team Marchenko (HR Kateryna, senior
Dmytro), Team Kravchenko (HR `HR3_ID`, senior Artem), Team Ponomarenko (HR Anna, senior Nazar); the accountant is a
member of all four. There is no second HR on any team, no HR without a team and no senior shared by two teams.

## Seed contract (Task 7.6 depends on every line)

Users (new rows in `SEED_USERS` with matching `user_emails` WORK rows, ids in `seed/ids.ts`; pick the emails in the
existing seed style and list them in the PR body):

- **U-HR2**: role HR, member of Team Kovalenko (a second HR of Anna's team).
- **U-HR0**: role HR, member of no team.
- **S-SHARED**: role SENIOR, member of Team Kovalenko **and** Team Marchenko, with a technology profile that satisfies
  the `users.data.spec.ts` SENIOR floor.

Opportunities (titles verbatim; each one fresh relative to the moment the seed runs, never a fixed calendar date: the
queue hides anything outside its 14-day freshness window):

| Title | Eligibility | Matched seniors | Notes |
| --- | --- | --- | --- |
| `Seed: React Platform Engineer` | LEAD | Oleksiy, S-SHARED, Artem | two sources, so the card shows more than one source |
| `Seed: Data Pipeline Engineer` | LEAD | Dmytro | visible to Team Marchenko only |
| `Seed: Unclear Stack Vacancy` | TRIAGE | none | has a source (`primarySource` not null), so ADMIN «Призначити команді…» is offered |
| `Seed: Unsafe Description` | LEAD | Oleksiy | description holds a `<script>`, an `<a href="javascript:…">`, a remote `<img>` and an `onerror=` attribute |
| `Seed: Uncertain Match` | LEAD | Oleksiy | the match carries every uncertainty mark the card can show (whatever the match model calls them) |

No submission, dismissal, triage grant or action rows: every card starts untouched, and Task 7.6 creates and undoes
its own state through the API.

## Acceptance criteria

1. [ ] A seed module (`seed/job-queue.ts` or the name the seed layout suggests) inserts the rows above, wired into
       `seed.ts` after teams; `verifySeed` checks them.
2. [ ] On a freshly pushed + seeded scratch DB (never `crm_db`), the real API returns: Anna's `GET` queue contains
       React Platform, Unsafe Description and Uncertain Match, and not Data Pipeline; Kateryna's contains React Platform
       and Data Pipeline; `HR3_ID`'s contains React Platform; U-HR0's queue is empty and authorised (200); ADMIN sees
       Unclear Stack as a triage card with a source. Paste the counts per user in the PR body.
3. [ ] The seed stays re-runnable on a reset DB the way the rest of the seed is; `pnpm --filter @crm/api test` and
       typecheck are green; the existing seed specs (`users.data.spec.ts`, `shared.spec.ts`) still pass.
4. [ ] No existing e2e spec breaks on the new users or memberships: grep `apps/e2e` for counts of users, team members
       and HRs, and report what you checked. A spec you would have to edit is reported to Master (AutoTest's zone), not
       edited.

## Assumptions

- A1 (Master): the E2E data comes from the shared dev/CI seed, not from API-side test fixtures, because opportunities
  have no create API; the seed already refuses a non-disposable DB (`seed-db-guard.ts`).
- A1 (Master): new users and memberships rather than changing existing ones, so the existing specs keep their facts.
- A1 (Coder): the card exposes one per-match uncertainty mark, `matchApproximate`. "Every uncertainty mark" becomes
  OPTIONAL-only keywords (approximate), a null `published_at` and a stored `rankWarnings: ['UNKNOWN_DATE']`. The card
  does not render rank warnings today.
- A1 (Coder): the three new users are onboarded; without it the queue answers them 403 `ONBOARDING_REQUIRED`.
- A1 (Coder): the job-queue phase runs after onboarding, the last writer of users and teams, so the match profile and
  exclusion versions are the live ones.

## Zone

`apps/api/src/database/seed.ts`, `apps/api/src/database/seed/**`. Nothing in `apps/e2e`, `apps/web`, `packages/**`
or the schema.

## Verification (Coder before handing back)

1. `git diff origin/main --name-only` lists only the zone above.
2. AC 2 counts from the real API on a scratch DB, with `SELECT current_database()` shown first.
3. Commit locally with `ac_verified: 1,2,3,4`; Master pushes.
