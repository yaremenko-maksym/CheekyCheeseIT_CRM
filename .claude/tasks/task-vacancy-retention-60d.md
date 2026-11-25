# task-vacancy-retention-60d

## Agent: coder
## Status: in progress
## Blockers: none
## Priority: high
## Model: opus — data deletion on the live store (critical-path: prod data), routed T3
## Depends on: nothing
## Branch: feature/vacancy-retention-60d

## Context

Owner decisions 2026-11-25: (1) a vacancy lives at most **60 days**, counted from its
**publication date** (`published_at`, fallback `first_seen_at` when the source gives none);
(2) a vacancy whose availability becomes `CLOSED` or `EXPIRED` is hidden for everyone and
**deleted immediately**; if the source reopens it, the normal collection re-adds it to the queue
as a fresh opportunity. Today the new store (`job_opportunities`) deletes nothing
(`NEW_STORE_CLEANUP_DISABLED` in `apps/api/src/job-sourcing/retention.ts`); the legacy
`job_postings` store keeps 90 days (`POSTING_RETENTION_DAYS`).

Owner update 2026-11-25 (via coordinator): the CLOSED/EXPIRED removal happens **at the moment of
detection**, inline in the same transaction that marks the record/opportunity CLOSED or EXPIRED
(detail-gone closure, inventory-counter updater, window expiry, availability re-derive), not on a
later cron tick — HR must always see a fresh queue. The cron stays only as the 60-day sweep and a
safety net. A separate coder fixes backlog 470 (coverage always PARTIAL) in funnel/coverage +
freshness config: `deriveCoverage` and `FRESHNESS_MAX_AGE_MS` are NOT edited here.

## Concrete changes

1. `apps/api/src/job-sourcing/retention.ts` + `job-sourcing.service.ts` — legacy
   `POSTING_RETENTION_DAYS` 90 → 60. Turn new-store cleanup on with the owner's durations
   (60 days by publication date; closed/expired: immediately) and update the spec that pins the
   `false` default.
2. A new-store purge (a cron in the existing job-sourcing cron family, its own free minute, bounded
   batches, never rethrows — copy the shape of `job-queue-action-retention.cron.ts` /
   `job-availability-reconciliation.cron.ts`) that removes opportunities matching either rule, with
   their collection/queue rows (source records, matches, generation items, dirty work) so that a
   later collection of the same posting creates it anew and it re-enters the queue.
3. **The action-log constraint.** `job_queue_actions` is append-only, two-year legal retention
   (owner 2026-10-17, `docs/legal/2026-10-17-job-queue-actions-erasure.md`), every parent FK is
   RESTRICT. An opportunity with logged actions must NOT be hard-deleted and the log must not be
   touched: tombstone it instead (the design already named in `ObservationContext.hasLoggedActions`:
   UPDATE clearing the text, row kept) and make sure it is invisible in every queue read and card
   for every role. A re-collection of a tombstoned posting must still re-enter the queue — decide
   the mechanism (new opportunity vs revive) from the identity/dedup code and record it in
   `## Assumptions`.
4. **Re-entry after a too-old purge.** A posting older than 60 days by publication date that is
   still listed at the source would be re-collected and purged again every run. Stop it at intake:
   collection skips (does not create) postings whose publication date is older than 60 days.
5. Any DDL (if needed: an index for the purge predicate, a grant for the delete) — staged SQL under
   `apps/api/drizzle/manual/` following the existing convention, plus the deploy-workflow wiring the
   other manual SQL uses. The API role must get exactly the privilege the purge needs, no more.
6. **Inline removal at detection (owner update).** Every writer that marks a source record CLOSED
   or EXPIRED (`closeRecordByInventory` callers: inventory-counter updater, detail-gone closure,
   U10 detail tail; `expireRecordByWindow`: window-expiry updater) re-derives each owning
   opportunity in the same transaction and, when the most-open result is CLOSED/EXPIRED, purges
   it (delete or tombstone) right there. The opportunity re-derive
   (`availability-reconcile-worker.ts reconcileOpportunityAvailability`) purges instead of writing
   CLOSED/EXPIRED. The cron of item 2 is the 60-day sweep plus a safety net for anything left.

## Reuse / Regression scope

- `availability/derive-availability.ts`, `detail-gone-closure.ts`, `inventory-counter-updater.ts`
  — where CLOSED/EXPIRED is set; the delete hooks there inline (owner update, item 6).
- `queue/queue-read-sql.ts` `visibleOpportunityPredicate` / `triageIneligible` — already hide
  CLOSED/EXPIRED.
- `ownership/dirty-work.store.ts` + `retention.ts` comment on `job_dirty_work`: keep the newest row
  per (entity_kind, entity_id) for SENIOR / EXCLUSION / PROJECT_CLIENT; only terminal rows go.
- Must not break: queue generations/cursors of a scope whose items were purged mid-pagination
  (a page must not 500 on a vanished id), the action-log append-only triggers and catalog checksum
  check, senior interview cards, the two-year action purge.
- Do not edit `deriveCoverage` or `FRESHNESS_MAX_AGE_MS` (backlog 470 belongs to another coder).

## Seams under test

- The purge function/cron: integration spec on a scratch DB — too-old by `published_at`, too-old
  by `first_seen_at` fallback, closed, expired, open-and-young (kept), with-logged-actions
  (tombstoned, log untouched, hidden from queue reads), re-collection after purge re-enters.
- Inline removal: integration spec — a record close / window expiry that leaves its opportunity
  CLOSED/EXPIRED removes it in the same transaction; one with another open member is kept.
- Intake filter: unit spec on the collection path — an over-60-day posting is not created.

## Known limitation (do not fix here)

Backlog 470: prod runs are all `PARTIAL` coverage, so availability closures never fire yet; the
closed/expired branch will start deleting once 470 is fixed. The 60-day rule works regardless.

## Assumptions

- 60 days is measured from `published_at`, else `first_seen_at` (owner: "publication date").
- Legacy `job_postings` follows the same 60-day limit.

## Acceptance criteria

1. No opportunity older than 60 days (publication date, fallback first seen) remains visible or
   stored after one purge tick, except tombstones required by the action log.
2. A CLOSED or EXPIRED opportunity is removed (or tombstoned) within one tick and is never visible.
3. A purged posting collected again (and inside 60 days) appears in the queue again.
4. Over-60-day postings are not created by collection.
5. `job_queue_actions` rows are never updated or deleted by this work; append-only triggers green.
6. Legacy retention is 60 days.
7. Unit + integration specs above green on a scratch DB; never the live `crm_db`.
8. A record close / window expiry that leaves its opportunity CLOSED or EXPIRED removes (or
   tombstones) the opportunity in the SAME transaction; the opportunity re-derive does the same
   instead of writing CLOSED/EXPIRED. No later tick is needed for it to disappear from the queue.
