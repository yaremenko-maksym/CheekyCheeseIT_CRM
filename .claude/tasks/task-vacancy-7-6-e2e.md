# task-vacancy-7-6-e2e — Task 7.6 E2E for the vacancy queue (plan r5 §Task 7.6)

## Agent: autotest

## Status: blocked until Tasks 7.3b and 7.5 are merged

## Blockers: Task 7.3b, Task 7.5

## Priority: high

## Model: sonnet (escalate to opus on a failed check)

## Branch: test/vacancy-7-6-e2e

## Context

Files: create `apps/e2e/tests/job-queue.spec.ts` and `apps/e2e/fixtures/job-queue.ts`. Skill `playwright-patterns`.
Stand: dev-login via `POST /api/auth/dev-login`, following the login fixture pattern already in `apps/e2e`. Data: the
seed on a scratch / QA database, never the live `crm_db`. `apps/e2e` has no database client, so `mcp__postgres__query`
is the author's tool for looking up seed rows while writing; at run time a spec finds its rows through the API. A scenario
the seed cannot express (shared senior, triage, unsafe HTML) is reported to Master: the seed is the Coder's zone. Anchors are the testids of design §14, not headings.

**Plan text vs the shipped model (the shipped model wins).** Plan r5 still speaks of a vacancy-level "take"
(«Нові» → «У роботі», «вже взято <name>»). The shipped card is per senior (owner decision A3 (a), 2026-11-04): the action is
«Записати подачу» per senior and the tabs are «Нові» / «Подані» / «Приховані» (design §4.2). The scenarios below are
written for the shipped model.

## Scenarios (each one a named test)

1. HR opens «Черга зовнішніх вакансій» from the menu; the card shows sources and the own team's matched seniors.
2. «Записати подачу» on a senior moves the vacancy from «Нові» to «Подані» for that team.
3. A second HR of the same team sees the senior as «Подано» with the submitter's name.
4. HR of another team that shares the senior sees a nameless «Подано» and no submit button (A3 (a)); HR of another team
   without that senior sees the vacancy as untouched (design §3).
5. HR with no team sees an empty authorized queue.
6. Scoped dismiss and undo («Приховати» → «Скасувати»); hide → undo → reload → hide succeeds (Task 7.3b `dismissal`).
7. Availability change while the card is open; uncertainty marks; triage items and the zero-match empty state.
8. Unsafe HTML / `javascript:` link / remote image in the description render inert.
9. Expired generation refresh; empty / error / loading / partial-health states.
10. Cache purge on logout and on account change.
11. SENIOR direct URL is redirected (defence in depth only; the backend guard is proven by Task 6.4).
12. ADMIN: source switch (Task 7.5) — toggle off and on, readiness failure keeps the state.
13. Mobile 375: no horizontal scroll, full-screen card, targets ≥ 44 px, gesture-safe open (pattern:
    `job-sourcing-mobile.spec.ts`).

Mock mode is never used for a rights check.

## Acceptance criteria

1. [ ] Every scenario above exists as a named test and passes.
2. [ ] `pnpm --filter @crm/e2e test -- job-queue` runs three times green locally (zero-flake policy); paste the three counts.
3. [ ] No hardcoded ids or amounts; rows are found through the API at run time; logins follow the existing e2e fixture
       pattern.

## Assumptions

- A1 (Master): the plan's "take" wording is replaced by the per-senior submission model (see Context).

## Verification (AutoTest before `git push`)

1. `git diff HEAD --name-only` — only `apps/e2e/**`.
2. Three green runs with non-zero test counts.
3. Commit: `ac_verified: 1,2,3`.
