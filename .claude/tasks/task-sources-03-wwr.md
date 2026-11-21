# task-sources-03-wwr — We Work Remotely stores postings

## Agent: coder
## Status: ready
## Model: gemini-3.8-flash (jev T2 @0.51 -> free-worker draft; Claude verifies)
## Branch: fix/sources-03-wwr
## Source: `~/.claude/handoffs/sources-connect-2026-11-19/task-03-wwr.md`

## Context
- Prod 2026-11-19: `wwr.rss.all-jobs` and `wwr.rss.devops` run HTTP 200, up to 2.3 MB read,
  `received 0`, nothing stored, coverage `PARTIAL`.
- Also seen: `PAYLOAD_TOO_LARGE` `exceeded 2097152 bytes` (2 runs 2026-11-17) although
  `WWR_MAX_FEED_BYTES = 4 MiB` (`apps/api/src/job-sourcing/providers/sources/wwr.provider.ts:108`)
  -> find which limit actually applied (a lower shared/feed-reader cap?). `TRANSIENT_NETWORK`
  `This operation was aborted` (timeouts, 2 runs).
- From the prod container: devops feed returns 24 items, `parseWwrTitle` finds a company in 24/24.
  Employer split is NOT the cause.
- Suspects (unverified): `RECENT` inventory window `WWR_RECENT_WINDOW_MS` = 24 h (wwr.provider.ts:78,
  used at :114) dropping items by date; pubDate parsing; link/URL validation; `collectFeedPages` in
  `apps/api/src/job-sourcing/providers/rss.provider.ts`. "received 0" means items are dropped before
  the observation builder, so look at the provider/inventory path first.

## Zone
Write: `wwr.provider.ts`, `rss.provider.ts` (+ shared feed reader only if the root cause is there),
their specs, a fixture under the job-sourcing fixtures dir (follow its README). Do NOT touch
`manifest.definitions.ts` or `arbeitnow.provider.ts`. Djinni also uses `rss.provider.ts`: keep its
specs green.

## Acceptance criteria
1. Root cause proven with a red test built from a real capture of today's feed (one plain GET per
   feed URL, owner-approved; commit the capture as a fixture per the fixtures README; trim it if
   large, keeping the real item shape).
2. Fix at the root; the capture yields observations that would be stored.
3. Size cap and timeout: measure the all-jobs feed size; set limit and timeout with headroom,
   comment with measured size + date; explain the 2 MiB vs 4 MiB discrepancy.
4. Optional, only if cheap (< ~60 LOC): expose WWR namespaced fields (region, type, skills, expiry)
   via the shared feed reader (backlog 309 second half). Otherwise skip and say so.
5. (Master, after deploy) WWR runs store postings.

## Assumptions
- (A1) If the 24 h RECENT window is the cause, widen it to cover the feed's real date span rather
  than switching inventory kind, unless the capture proves the feed is not date-ordered.
