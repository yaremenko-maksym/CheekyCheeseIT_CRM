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
- (A1, coder) The removal at detection lives in the two store writers every close path goes
  through (`closeRecordByInventory`, `expireRecordByWindow`): the inventory counter, the detail-GONE
  closure (it delegates to `closeRecordByInventory`), the detail tail and the window expiry all reach
  it. The opportunity re-derive removes instead of writing CLOSED/EXPIRED.
- (A1, coder, rewritten in review round 2) No DDL. Every table the purge writes is privilege class
  A for `crm_app` (`SELECT, INSERT, UPDATE, DELETE`). A tombstone is marked in an existing column:
  `field_revisions = '{"retention":"TOMBSTONE"}'` (`retentionTombstone`), a value the canonical
  builder never writes. The sweep, the roster fan-out and the duplicate list skip a marked row.
- (A1, coder) A re-listed posting is collected as a new opportunity: an unnamed record is deleted;
  a record the action log names is retired (`namespace = 'retired:<id>'`, URLs and `source_id`
  cleared, revisions removed), which frees its natural key.
- (A1, coder) A senior's tailored resume is a keep reason as well as a logged action (it would
  otherwise cascade away). An interview card keeps its copied fields and loses only the link
  (`ON DELETE SET NULL`, the schema's own documented intent); a queue-made card always has a logged
  action, so its opportunity is tombstoned, not deleted.
- (A1, coder) Manual cards (`manual_team_id IS NOT NULL`) are excluded from the sweep.
- (A1, coder) `job_dirty_work` is never deleted (guarded invariant). A detail row whose record was
  removed settles terminally as `DEFERRED / ENTITY_MISSING`.
- (A1, coder) A posting with no date is never filtered at intake (it falls back to `first_seen_at`
  in the sweep).
- (A1, coder, rewritten in review round 2) The sweep runs daily at `43 4 * * *`, bounded at 50
  batches of 200 opportunities per tick, each opportunity in its own READ COMMITTED transaction.
  The kill switch is `VACANCY_RETENTION_ENABLED` (see the SR-M-3 line below).
- (A1, coder, review round 1) The purge never waits on a lock: every lock is `FOR UPDATE SKIP
  LOCKED` (member records first, ordered by id, then the opportunity). A busy row, a member set that
  changed, a manual card, or a decision that no longer holds under the lock returns `SKIPPED`. The
  next cycle retries it, or the next re-derive does for the reconcile path, which then writes the
  derived availability as before. The purge itself never waits, so it cannot be one side of a lock
  cycle. The reconcile path takes the opportunity row first (`FOR NO KEY UPDATE`, as before), and
  its fall-through `UPDATE` reuses that lock. On `SKIPPED`, the member locks it did get stay held
  until commit. A cycle there would need a writer that queues on the same dirty-work key before it
  locks the record. Postgres detects such a deadlock (40P01) and aborts one side. The recompute
  worker treats that as an infrastructure failure: the row returns to PENDING until its attempts
  are spent.
- (A1, coder, review round 1) Past 60 days, an opportunity is removed even if a member is still
  OPEN (owner rule: the limit is absolute). A young CLOSED/EXPIRED opportunity with an OPEN member
  is skipped.
- (A1, coder, review round 1; rewritten in review round 2) A tombstone keeps its
  `job_queue_generation_entries` rows (immutable by trigger; they go when their generation is
  deleted). Pages never show them, because the page frame joins through an active linked record.
  A tombstone also keeps its title, employer, their keys and its senior assignments (SR-M-2).
  Dismissals, triage, relevance, matches and identity tokens are removed explicitly. A deleted
  opportunity loses all of them by cascade.
  The FK delete rules were checked on a scratch database: no RESTRICT beyond the
  `job_opportunity_sources` link rows (deleted first) and `job_queue_actions` (the keep reason).
- (A1, coder, review round 1) The sweep also removes source records with no active link (past 60
  days by their latest revision date, else `first_seen_at`, or CLOSED/EXPIRED), and collects
  `job_text_blobs` that no revision or opportunity references. Shortcut: a writer's
  `ON CONFLICT DO NOTHING` blob insert takes no lock, so a blob collected in the same instant is
  rejected by the referencing insert's FK. That run fails the page; the successor run re-fetches
  it, because the checkpoint did not move. Upgrade to a locked upsert if this shows up in logs.
- (A1, coder, review round 1) No expression index on `COALESCE(published_at, first_seen_at)`: the
  sweep pages by keyset on the primary key (`o.id > last ORDER BY o.id LIMIT n`), so one night's
  batches walk the table once in id order, filtering as they go. EXPLAIN on a near-empty scratch
  table (with `enable_seqscan = off`) shows the shape: an index scan on `job_opportunities_pkey`
  with `id > last` as the index condition. Blob collection is index-backed too: both referencing
  columns (`description_sha256` on revisions and opportunities) are indexed.
- (A1, Master, review round 2, SR-M-1) An opportunity that lost its last link row is still swept.
  The sweep predicate does not require a link.
- (A1, Master, review round 2, SR-M-2) An opportunity an ADMIN suppressed is never purged, by the
  sweep or at detection. The duplicate guard still sees a senior submission on a tombstone, so a
  re-listing is not submitted twice for one senior without confirmation. Losing HR dismissals on a
  tombstone is accepted.
- (Owner decision, 2026-11-25) The 60-day limit and immediate removal of CLOSED/EXPIRED vacancies
  are the owner's rule ("delete them right away"); the first production tick removes everything over
  the limit, bounded at 10,000 opportunities per tick; the data is external and re-collectable;
  opportunities with logged actions are tombstoned, not deleted. No production row count is
  available to Master.
- (Review round 2, SR-M-3; review round 3, SR-M-6) Kill switch `VACANCY_RETENTION_ENABLED`, default
  on, boot-validated in `config/env.ts` and listed in `apps/api/.env.example`. It accepts exactly
  `true` or `false` (any case); unset is on; any other value fails boot, and
  `vacancyRetentionEnabled` parses with the same schema. Off, the sweep does not run, the closers and the re-derive write
  CLOSED/EXPIRED as before this work, and the legacy purge keeps its previous 90-day limit
  (`LEGACY_POSTING_RETENTION_DAYS`). `NEW_STORE_CLEANUP_ENABLED` is documented as a policy value
  for the pure twin of the legacy purge, not a runtime switch.
- (A1, coder, review round 2) The intake skip for postings older than 60 days is not behind the
  kill switch. It deletes nothing, it only declines to create rows.
- (A1, Master, review round 2, CR-M-2) Every inline purge runs in its own SAVEPOINT. On a failure
  the purge rolls back to it and logs `vacancy_retention_purge_failed`. The close, the counter and
  the owner enqueue still commit. The sweep or the next re-derive retries the purge.
- (A1, Master, review round 2, CR-M-3) A purge takes only the opportunity's ACTIVE members with it.
  A historical (unlinked) member is left to the record sweep's own predicate.
- (A1, Master, review round 2, CR-M-5) Accepted: an undated posting that stays listed is purged at
  `first_seen_at` + 60 days. It is then collected again as NEW, once every 60 days.
- (A1, Master, review round 2, CR-M-6) The cron minute is 43. It is outside `*/10`, `5-59/10`, `:17`
  and `:37`.
- (A1, Master, review round 2, CR-M-7) The blob pass pages by keyset (`sha256 > last`). The record
  pass walks `job_source_records` by primary key with one correlated probe per row. No partial
  index: no production-sized copy was reachable from this machine to count rows or EXPLAIN. Master
  states the row count in the PR before merge, or a follow-up adds the index.
- (A1, Master, review round 2, CR-H-1) Every integration spec that stores a posting through the
  60-day intake dates it relative to now. Committed captures stay byte-identical and are re-dated
  at load time. Captures already older than 60 days (the DOU golden feed, August 2026) are past the
  window today and pass, so their outcome can no longer change with the calendar.
- (Review round 3, SR-M-4) A tombstone lives only as long as its keep reason. Once it has no
  `job_queue_actions` row (the two-year log purge took the last one) and no tailored resume, the
  daily sweep deletes it under the same SKIP LOCKED discipline and the same kill switch. Its senior
  submissions (`senior_id`, `assignee_id`, `team_id`, `release_reason`) and generation entries
  cascade with it, so no staff attribution outlives the decided two-year period.
- (A1, coder, review round 3, SR-M-6) An empty `VACANCY_RETENTION_ENABLED=` also fails boot: it is
  neither `true` nor `false`, and unset means the variable is absent. Reversible in one line.

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
