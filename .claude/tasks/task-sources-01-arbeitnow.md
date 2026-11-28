# task-sources-01-arbeitnow — Arbeitnow collects again

## Agent: coder
## Status: ready
## Model: gemini-3.8-flash (jev T1; Claude verifies)
## Branch: fix/sources-01-arbeitnow
## Source: `~/.claude/handoffs/sources-connect-2026-11-19/task-01-arbeitnow.md`

## Context
- Prod 2026-11-19: last 3 runs FAILED `PAYLOAD_TOO_LARGE`, `www.arbeitnow.com response too large:
  exceeded 8388608 bytes`. Last success 2026-11-18 17:22 (4349 new postings in 7 days before).
- `ARBEITNOW_MAX_BYTES = 8 * 1024 * 1024` at
  `apps/api/src/job-sourcing/providers/sources/arbeitnow.provider.ts:57` (used :166). Shared ceiling
  is 10 MiB (find the symbol).
- 3 runs on 2026-11-16 FAILED `PERSISTENCE`, `validateObservation: description over the display
  limit`. PR #1365 (merged 2026-11-16 20:28 UTC, "one oversize record no longer fails a job-source
  run") probably already fixed this: `apps/api/src/job-sourcing/normalize/observation.ts` now has
  `DISPLAY_TRUNCATED` evidence. VERIFY with a test before writing new code; if already covered,
  add only a regression test for the Arbeitnow shape and say so.

## Zone
Write: `arbeitnow.provider.ts`, its spec(s), a fixture if needed. Do NOT touch
`manifest.definitions.ts`, `wwr.provider.ts`, `rss.provider.ts`. Touch `observation.ts` only if
AC 2 proves it is still broken.

## Acceptance criteria
1. Measure the current page size (one plain GET per page with the adapter's normal request,
   owner-approved; record bytes + item count + date). Set the cap with headroom over the largest
   measured page. If a page would exceed the shared 10 MiB ceiling, read fewer items per page or
   paginate instead of raising the ceiling; justify the number in a code comment.
2. One over-long description never fails the whole run (cut to the display limit and marked, as
   #1365 does for other adapters).
3. Unit tests: oversize page, over-long description; red before the fix (or, for an already-fixed
   case, a regression test that fails if the fix is reverted).
4. (Master, after deploy) next prod run of `arbeitnow.api.feed` is `SUCCEEDED` with created > 0 or
   unchanged > 0.

## Assumptions
- (A1) Over-long description: cut + mark (consistent with #1365), not quarantine.
