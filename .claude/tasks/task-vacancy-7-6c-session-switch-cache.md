# task-vacancy-7-6c-session-switch-cache — no cached rows of another account after the session cookie changes

## Agent: coder

## Status: done (merged as #1330, bd161791)

## Blockers: none (the 7.6 suite on PR #1324 asserts the leak itself in scenario 10b)

## Priority: high (a data-visibility leak across accounts)

## Model: opus-5-5 high (RBAC-visible data, auth cache)

## Branch: fix/vacancy-7-6c-session-switch-cache

## Context

Plan r5 §Task 7.6 scenario 10 requires: switching account never shows the previous account's queue rows. Task 7.6
(AutoTest) found a real gap while writing 10b: with a page open, when the session cookie changes to another user (a
sign-in in another tab does this) and the user opens the queue from the menu, the page shows the previous user's
cached rows. Example: Anna (Team Kovalenko) browses the queue, then the cookie becomes Kateryna (Team Marchenko);
Kateryna's queue page renders `job-queue-row-…` rows that only Kovalenko may see.

Cause found by AutoTest: the queue's query key is derived from the cached `auth/me` user, and nothing refetches that
user after the cookie changes. Only logout (`apps/web/app/lib/use-logout.ts`: `queryClient.clear()` and
`idbDel('crm-query-cache')`) and impersonation clear the cache.

The server still enforces visibility, so the leak is the client cache only; but the page shows rows the signed-in user
must not see.

## Seed / proof

The failing proof is scenario 10b in `apps/e2e/tests/job-queue.spec.ts`, which on PR #1324 asserts the leak
(`arrayContaining` of the previous account's rows, comment `product gap: Task 7.6c flips this`). Once this fix is in,
10b turns red: **flip that assertion to `not.toContain` and rename the test title (it says «still paints …») in this PR** (the
only edit allowed in `apps/e2e`; Master grants this cross-zone exception here). Rebase on `main` after #1324 merges, or
on its branch if it is still open (say which).

## Acceptance criteria

1. [ ] After the session cookie changes under an open page, the next navigation or refetch shows no query data of the
       previous account: either the auth user is revalidated on focus / navigation / queue open and the cache is cleared
       when the user id differs, or the cache key carries something the cookie change invalidates. Pick the smallest
       approach that fits the existing auth code and record it in the PR body.
2. [ ] A unit/component test fails without the change and passes with it (a user id change on revalidation clears the
       cache and the persisted copy).
3. [ ] Scenario 10b asserts that no previous-account row renders and passes; the three `job-queue` runs are green (paste counts).
4. [ ] No extra request on every render: the revalidation is bounded (focus or route change, deduplicated).
5. [ ] Logout and impersonation behaviour is unchanged (their existing tests stay green).

## Assumptions

- A1 (Master): this is its own PR, not part of #1324, because #1324 is the AutoTest zone and this is `apps/web`.
- A1 (Master): the single `apps/e2e` edit (flip the 10b assertion and title) is allowed here so the proof and the fix land together.

## Zone

`apps/web/**` for the fix and its tests; one line in `apps/e2e/tests/job-queue.spec.ts`. Nothing in `apps/api` or
`packages/**`. Auth/session code is a critical path: a security review applies.

## Verification (Coder before handing back)

1. `git diff origin/main --name-only` lists only the zone above.
2. Tests: the new unit test red before / green after; `pnpm --filter @crm/web test` and typecheck green.
3. Three green `job-queue` runs on a scratch stand (never `crm_db`).
4. Commit locally with `ac_verified: 1,2,3,4,5`; Master pushes.
