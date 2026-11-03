# ADR: Reason-partitioned claim for the shared `job_dirty_work` queue

## Status

Proposed — 2026-11-02. Task 4.6 (job sourcing). Unblocked by SFS U10 parts 1/2a/3 on main.

## Context

`job_dirty_work` is one polymorphic queue (`entity_kind`, `entity_id`, `target_version`, `reason`)
with the unique key `uq_job_dirty_work_entity_target` on
`(entity_kind, entity_id, target_version, reason)`. Three consumers read it:

| Consumer                     | Claim function                                           | Kinds claimed                                               | Reason filter                           |
| ---------------------------- | -------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------- |
| Match recompute (S4a/S4b)    | `claimDirtyBatch` via `createRecomputeSteps`             | default `CLAIMABLE_KINDS` (all five)                        | `reason <> 'DETAIL_FETCH'`              |
| Availability reconcile (S8d) | `claimDirtyBatch` via `createAvailabilityReconcileSteps` | `AVAILABILITY_CLAIM_KINDS` (`SOURCE_RECORD`, `OPPORTUNITY`) | `reason <> 'DETAIL_FETCH'`              |
| Detail tail (SFS U10)        | `claimDetailFetchForSource` (detail-tail runtime)        | `SOURCE_RECORD`                                             | `reason = 'DETAIL_FETCH'` + source join |

The detail tail is already partitioned by reason, which is why it coexists with the other two. The
match and availability consumers are not: both hand out every non-`DETAIL_FETCH` `SOURCE_RECORD` /
`OPPORTUNITY` row, and whichever claims a row completes it (`completeDirty` -> `DONE`/`DEFERRED`),
so the other consumer's work for that event is silently lost. `validateEnv` therefore refuses
`JOB_AVAILABILITY_RECONCILE_ENABLED && JOB_MATCH_RECONCILIATION_ENABLED` at boot.

### What each reason means to each consumer (the key fact)

Producers, read from the code (every non-spec caller of `enqueueDirty` / `enqueueDerivedDirty` and
the raw `INSERT` in `roster-fanout`):

The classifier matches on the reason **values** (`SOURCE_REVISION`, `CANONICAL_REVISION`, `RECORD_INVENTORY_CLOSED`, `RECORD_REOPENED`, `RECORD_WINDOW_EXPIRED`, `RECORD_RELISTED:<runId>`, ...), not on the exported `*_REASON` constant names used in the table below; each is derived from its constant, never retyped.

| Reason (producer)                                                                          | Kind                                | Match needs it                             | Availability needs it                                       |
| ------------------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| `SOURCE_REVISION_REASON` (`saveObservations`, head advanced)                               | SOURCE_RECORD                       | **yes** — `resolveRecords`                 | **yes** — fresh observation: reopen / counter / window path |
| `RECORD_RELISTED_REASON:<runId>` (`saveObservations`, closed record seen unchanged)        | SOURCE_RECORD                       | no (resolve is a no-op re-run)             | **yes** — the S8f reopen trigger                            |
| `DETAIL_FETCH` (recompute worker, `JobSourcingService` on-demand)                          | SOURCE_RECORD                       | no                                         | no — detail tail only                                       |
| `CANONICAL_REVISION_REASON` (canonical store, opportunity revision bump)                   | OPPORTUNITY                         | **yes** — evaluate + install               | **yes** — the active record set may have changed            |
| `INVENTORY_CLOSE_REASON`, `RECORD_REOPEN_REASON`, `WINDOW_EXPIRE_REASON` (`enqueueOwners`) | OPPORTUNITY                         | no direct need (see "revision bump" below) | **yes** — re-derive opportunity availability                |
| `fanout:<root>` (roster fan-out insert)                                                    | OPPORTUNITY                         | **yes**                                    | no                                                          |
| reconcile digest (`reconcileReason`, `reconcileOnce`)                                      | OPPORTUNITY                         | **yes**                                    | no                                                          |
| `senior.*`, exclusion / project-client reasons (`dirty-producers`)                         | SENIOR / EXCLUSION / PROJECT_CLIENT | **yes** (fan-out)                          | no (not claimed)                                            |

Two reasons — `SOURCE_REVISION` and `CANONICAL_REVISION` — serve **both** consumers. One row
cannot be completed twice, so no claim-side filter alone can satisfy both: a row has exactly one
`status`, one `claim_owner`, one terminal transition.

### Two coupled effects that make "just filter the claim" unsafe

1. **Version staleness is consumer-blind.** `completeDirty` marks a row `DEFERRED/VERSION_STALE`
   when the entity's current version moved past `target_version`, on the premise "a newer row
   redoes its work". That premise holds only if the newer row belongs to the **same** consumer.
   The availability consumer bumps `job_opportunities.revision` (`reconcileOpportunityAvailability`)
   and enqueues nothing; the canonical store bumps it and enqueues only `CANONICAL_REVISION`. With
   both consumers on, each bump can stale the other consumer's pending row with no successor row.
2. **The match sweep's dedup is reason-blind.** `enqueueReason` (match reconciliation) returns
   `null` (skip) whenever **any** `PENDING`/`CLAIMED` `OPPORTUNITY` row exists at the current
   revision, whatever its reason. A pending availability row therefore suppresses the match repair
   for that opportunity — forever, if the availability flag is off and the row is never claimed.

### The revision-bump gap that exists today

`reconcileOpportunityAvailability` writes `availability` and `revision = revision + 1` and enqueues
no `OPPORTUNITY` row. `evaluate` treats `CLOSED`/`EXPIRED` as the exclusion `AVAILABILITY_CLOSED`, so
matches must be recomputed after a close. `reconcileOnce` selects opportunities by roster/stored-match
fingerprint, not by revision, so it is not shown to catch an availability-only bump (confidence MED;
see verification V5). Status quo hides this because the two workers never run together.

### Status quo is not a working state for availability

With only `JOB_AVAILABILITY_RECONCILE_ENABLED` on, the availability worker claims every
`SOURCE_REVISION` row and never runs `resolveRecords`, so canonical resolution stops and new postings
never reach opportunities. With only the match flag on, availability never runs. Mutual exclusion
therefore means "availability can never be enabled in a useful deployment".

### Verification conditions (re-confirm before acting on this ADR)

- **V1** — the two claims are reason-blind beyond `DETAIL_FETCH`:
  `git grep -n "reason <> \${DETAIL_FETCH}" apps/api/src/job-sourcing/ownership/dirty-work.store.ts`
  returns exactly one hit (inside `dirtyWorkStatements.claim`), and
  `git grep -n "claimDirtyBatch(" apps/api/src -- ':!*.spec.ts'` lists only the store, the recompute
  worker and the availability worker.
- **V2** — the boot-time exclusion exists:
  `git grep -n "must not both be true" apps/api/src/config/env.ts`.
- **V3** — the producer set above is complete:
  `git grep -n -E "enqueueDirty\(|enqueueDerivedDirty\(|INSERT INTO job_dirty_work" apps/api/src -- ':!*.spec.ts'`.
- **V4** — the sweep dedup is reason-blind: `enqueueReason` short-circuits on
  `dirty.some((d) => d.status === 'PENDING' || d.status === 'CLAIMED')` before any reason check.
- **V5** — availability bump enqueues nothing: `reconcileOpportunityAvailability` contains no
  `enqueueDirty`; and an integration test that closes an opportunity's only record and then runs
  `reconcileOnce` shows whether a match row is enqueued (today: not covered by any spec — grep
  `reconciliation*.spec.ts` for `AVAILABILITY`).

## Decision drivers

1. **No lost work.** Every event a consumer cares about yields a row that consumer completes.
2. **No double work by the wrong consumer.** A row is completed only by the consumer it was produced
   for; idempotence of the handlers is a safety net, not the mechanism.
3. **Keep the proven claim/lease/fence semantics** (`heldBy`, epoch bump, `recoverExpiredDirty`) —
   adopt the existing `claimDetailForSource` reason-scoped pattern, do not invent a second queue.
4. **No DDL if avoidable.** A DDL promotion to prod is an owner-gated (A3) action; `reason` is free
   text and already part of the unique key, so it can carry a partition without a migration.
5. **Each flag independently safe.** Either flag on or off must not starve, stall or grow unbounded
   work for the other.
6. **Small, reversible rollout** behind the existing two flags.

## Options

### A — Consumer-side reason allow/deny lists on claim (claim filter only)

`claimDirtyBatch` gains a `consumer` option; the availability worker claims an allowlist
(`SOURCE_REVISION`, `RECORD_RELISTED:*`, the three `enqueueOwners` reasons, `CANONICAL_REVISION`),
the match worker claims everything else minus `DETAIL_FETCH`.

- **Correctness — fails driver 1.** `SOURCE_REVISION` and `CANONICAL_REVISION` must go to one side.
  Give them to match: availability never sees fresh observations (no S8f reopen on a changed
  posting, no counter reset) nor relinks. Give them to availability: canonical resolution stops.
  Give them to both lists: the first claimer completes the row and the second never sees it — the
  exact bug the exclusion guards against. Effect 1 (consumer-blind staleness) and effect 2
  (reason-blind sweep dedup) are untouched.
- **Ordering / idempotency / lease:** unchanged (same statement shape as `claimDetailForSource`).
- **DDL:** none. **Rollback:** revert the store change.
- **Verdict:** necessary but not sufficient. It is the claim half of option B.

### B — Producer fan-out by reason + partitioned claim (no DDL) ← recommended

Every event that matters to more than one consumer is enqueued **once per consumer**, the consumer
encoded in `reason`; each consumer claims only its own partition.

1. **A reason catalog in the store.** One exported classifier, e.g. `dirtyConsumerOf(reason)` →
   `'MATCH' | 'AVAILABILITY' | 'DETAIL'`, and its SQL twin used by the claim. Rule:
   - `DETAIL` — `reason = 'DETAIL_FETCH'` (as today).
   - `AVAILABILITY` — `reason LIKE 'AVAILABILITY:%'` **or** one of the legacy availability-only
     reasons: `RECORD_RELISTED:%`, `RECORD_INVENTORY_CLOSED`, `RECORD_REOPENED`,
     `RECORD_WINDOW_EXPIRED` (kept by name so rows already in the table classify correctly; no
     rename, no data rewrite).
   - `MATCH` — everything else (the residual). Residual-to-match keeps every existing match
     producer (`SOURCE_REVISION`, `CANONICAL_REVISION`, `fanout:*`, reconcile digests, the derived
     kinds) working with zero change, and an unknown future reason lands where it did before.
2. **Partitioned claim.** `claimDirtyBatch` requires a `consumer` (no default, so a new caller cannot
   forget it); the WHERE clause becomes `entity_kind IN (...) AND <partition predicate>`. Same
   `FOR UPDATE SKIP LOCKED`, same epoch bump, same `RETURNING` — the `claimDetailForSource` pattern
   generalised. `claimDetailFetchForSource` stays as is (it is the `DETAIL` partition plus a join).
3. **Fan-out at the two shared producers**, in the producer's existing transaction:
   - `saveObservations` on an advanced head: `SOURCE_REVISION` (match, unchanged) **and**
     `AVAILABILITY:SOURCE_REVISION` at the same `target_version`.
   - the canonical store's revision write: `CANONICAL_REVISION` (match, unchanged) **and**
     `AVAILABILITY:CANONICAL_REVISION` at the new revision.
     The unique key includes `reason`, so the two rows coexist and each still dedups on replay.
4. **Successor rows for cross-consumer version bumps** (closes effect 1). Every statement that bumps
   an entity's version must leave a row at the new version for **every** consumer that cares:
   - `reconcileOpportunityAvailability`, when it bumps `revision`, enqueues a **match** row at
     `revision + 1` (reason e.g. `OPPORTUNITY_AVAILABILITY_CHANGED`, deliberately NOT `AVAILABILITY:`-prefixed: it must classify as MATCH) in the same transaction as the revision bump and before `completeDirty` of the row being handled. This also closes
     the pre-existing gap that an availability close never triggers a match recompute.
   - the canonical bump is covered by step 3 (both partitions get a row at the new revision).
   - `SOURCE_RECORD` versions are bumped only by `saveObservations`, covered by step 3.
     Invariant (the test target): _for every consumer C and every version bump V of entity E that C
     cares about, a `PENDING` row of C's partition with `target_version = V` exists after the bumping
     transaction commits._ With it, `DEFERRED/VERSION_STALE` again means "my own newer row redoes it".
5. **Partition-aware sweep dedup** (closes effect 2). Both reason-blind `NOT EXISTS ... status = 'PENDING'` dedups must change: `enqueueReason` / `hasGivenUp` (recompute inputs) **and the raw `INSERT` in the roster fan-out** (a pending availability row at the same revision would otherwise suppress a roster-driven match recompute). They count only
   `MATCH`-partition rows when deciding "in flight", and the sweep's dirty sub-select filters by the
   same predicate.
6. **Gate availability production on its flag?** No — produce unconditionally (see Consequences,
   "Growth while availability is off", and owner decision OD-2).

- **Lost work:** none by construction (invariant in step 4).
- **Duplicated work:** each consumer does its own work once per event; the record resolve and the
  availability updaters run on different rows. Handlers stay idempotent (S8b replay watermark,
  `ON CONFLICT`) as the second line of defence.
- **Ordering:** within a partition, unchanged (`ORDER BY created_at, id`). Across partitions there is
  no ordering, and none is needed: match reads availability as an input (`evaluate`), and every
  availability change now enqueues a match row after it (step 4), so the match side converges to the
  latest availability. Availability does not read match output.
- **Lease / fence:** unchanged. `recoverExpiredDirty` stays partition-agnostic (it only returns
  expired leases to `PENDING` with an epoch bump), so either cron recovering the other's rows is
  harmless.
- **DDL:** none. `reason` is free text bounded at 100 characters by `ck_job_dirty_work_reason_bounded`
  (enforced again in `enqueueDirty`); the longest new reason, `AVAILABILITY:CANONICAL_REVISION`, is 31.
- **Index:** the claim still walks `idx_job_dirty_work_pending (status, created_at)`; the partition
  predicate is a residual filter. Cost grows only with `PENDING` rows of the _other_ partition ahead
  in `created_at` order (see OD-2 for the case where that pile grows).

### B′ — Producer fan-out with a consumer column in the unique key (DDL)

Same as B, but the consumer is a new `consumer` enum column and the unique key becomes
`(entity_kind, entity_id, target_version, reason, consumer)`, with an index on
`(consumer, status, created_at)`.

- **Correctness:** identical to B; cleaner predicate (equality on an enum instead of a reason
  classifier), and the claim gets a dedicated index.
- **DDL:** add column with a backfill default (`MATCH`), swap the unique constraint, add an index.
  **Prod DDL promotion is an owner-gated A3 action.** The unique swap on a table nothing prunes is
  a lock-heavy step.
- **Rollback:** a down-migration that drops the column must first collapse rows that differ only by
  consumer — not a no-op; effectively irreversible without data handling.
- **Verdict:** a later hardening of B if the reason classifier proves fragile or slow. Not now.

### C — Separate queue/table per consumer (DDL)

`job_availability_work` beside `job_dirty_work`, with its own store and claim.

- **Correctness:** strongest isolation; still needs the step-4 successor-row invariant (the two
  consumers still bump the same `revision`), and still needs the fan-out at the two shared producers
  — so it does not remove B's work, it adds a table.
- **DDL:** new table + indexes + constraints; **owner-gated prod promotion (A3)**; duplicates
  `heldBy`, `recover`, `release`, retention guard and their specs.
- **Rollback:** drop table after the flag is off — data loss of pending availability work.
- **Verdict:** rejected — pays a DDL gate and a duplicated store for isolation B already provides.

### D — Keep mutual exclusion (status quo)

- **Correctness:** safe in the narrow sense that no row is taken by the wrong consumer.
- **Cost:** availability can never be on in a useful deployment (see Context: availability alone
  stops canonical resolution). S8 (availability reconciliation) stays permanently dark, the funnel
  never sees `CLOSED`/`EXPIRED`, and the revision-bump gap stays latent instead of fixed.
- **DDL / rollback:** none.
- **Verdict:** acceptable only as the fallback if B is rejected.

## Decision

**RECOMMENDED: Option B** — producer fan-out by a namespaced `reason` plus a partitioned claim,
no DDL. _Why, in one line:_ it is the only no-DDL option that gives every consumer its own row per
event, and it reuses the reason-scoped claim pattern the detail tail already proves.

| Key point                                                                    | Confidence | Basis                                                                                      |
| ---------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| A claim filter alone (A) cannot work while two reasons serve both consumers  | **HIGH**   | One row has one terminal transition; producer table above (V3)                             |
| Reason namespacing needs no DDL and keeps dedup                              | **HIGH**   | `reason` is in `uq_job_dirty_work_entity_target`; free text; `DETAIL_FETCH` precedent      |
| The successor-row invariant closes consumer-blind staleness                  | **HIGH**   | Every version bump site enumerated: `saveObservations`, canonical store, availability bump |
| `CANONICAL_REVISION` matters to availability (relink changes the record set) | **MED**    | Reasoned from `readActiveRecordStates`; S8 ADR does not name a relink trigger              |
| The match sweep does not catch an availability-only revision bump today      | **MED**    | Sweep selects by roster/stored fingerprint, not revision (V5 settles it)                   |
| Claim performance stays acceptable with the residual predicate               | **MED**    | Holds while the other partition's `PENDING` pile is small; OD-2 controls that              |

Overall confidence: **MED-HIGH**. No LOW point on the critical path; the two MED correctness points
fail safe under B (an extra availability row on relink costs one idempotent re-derive; an extra match
row on an availability bump costs one recompute).

### Consequences

- **Gained:** both flags on together; S8 can actually run; an availability close now triggers a
  match recompute (closes the latent gap); the sweep stops being suppressed by foreign rows.
- **Cost:** about one extra row per record advance and per canonical revision (the availability
  twin). Nothing prunes `job_dirty_work` (pinned by the retention guard spec), so table growth roughly
  doubles for these two reasons.
- **Growth while availability is off.** Unconditional production leaves availability rows `PENDING`
  while `JOB_AVAILABILITY_RECONCILE_ENABLED` is off; on flip-on the worker drains a backlog (its
  handlers are idempotent and version-checked, so old rows complete `DEFERRED` cheaply). The
  alternative — produce only when the flag is on — couples producers to config and loses every event
  between deploy and flip. OD-2 asks the owner to choose.
- **Coupling:** producers now name their consumer. The classifier is the single place that knows the
  mapping; a new reason defaults to `MATCH`, so adding an availability reason without the
  `AVAILABILITY:` prefix is the one way to reintroduce the bug — covered by the catalog test below.

## Blast radius

Verified with `git grep` on main at `935a76b5` (re-run V1/V3 before implementing; codegraph returns
the same callers).

| Symbol / site                                                                                    | Change under B                                                             | Callers affected                                                             |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `dirtyWorkStatements.claim`, `claimDirtyBatch`                                                   | required `consumer`; partition predicate replaces `reason <> DETAIL_FETCH` | `createRecomputeSteps`, `createAvailabilityReconcileSteps`, store specs      |
| new `dirtyConsumerOf` + its SQL twin                                                             | new                                                                        | claim, `enqueueReason`, catalog test                                         |
| `saveObservations` (source-record store)                                                         | second `enqueueDirty` with `AVAILABILITY:SOURCE_REVISION` on an advance    | `saveObservationPage` and its specs (row counts per page change)             |
| canonical store revision write (`CANONICAL_REVISION_REASON`)                                     | second `enqueueDirty` with `AVAILABILITY:CANONICAL_REVISION`               | `resolveRecords` callers; canonical specs asserting exact dirty rows         |
| `reconcileOpportunityAvailability`                                                               | enqueue a match row at `revision + 1` when it bumps                        | availability worker specs                                                    |
| `enqueueReason`, `hasGivenUp`, `reconcileOnce` sub-select                                        | count only `MATCH`-partition rows                                          | match reconciliation specs                                                   |
| `validateEnv` refinement                                                                         | removed in the last slice                                                  | `env.job-availability-reconcile.spec.ts` (the "both true throws" case flips) |
| `claimDetailFetchForSource`, `recoverExpiredDirty`, `releaseDirty`, `failDirty`, `completeDirty` | unchanged                                                                  | —                                                                            |
| `enqueueOwners` reasons, `RECORD_RELISTED`, `fanout:*`, `dirty-producers`                        | unchanged names (classified by the catalog)                                | —                                                                            |

Zones: all production edits are in `apps/api/src/job-sourcing/**` and `apps/api/src/config/env.ts`
(Coder); specs are AutoTest. No `packages/shared` change (no new enum). Critical path: no money /
RBAC / auth; it is a queue-semantics change on a prod table, so code-review with an integration
proof is mandatory and security-review is advisable (the env exclusion is a safety interlock being
removed).

## Test strategy

1. **Catalog test (unit).** Import every reason constant and producer format
   (`SOURCE_REVISION_REASON`, `RECORD_RELISTED_REASON`, `CANONICAL_REVISION_REASON`,
   `INVENTORY_CLOSE_REASON`, `RECORD_REOPEN_REASON`, `WINDOW_EXPIRE_REASON`, `DETAIL_FETCH`, the
   `fanout:` root, a `reconcileReason` digest, the new `AVAILABILITY:*` and `OPPORTUNITY_AVAILABILITY_CHANGED`)
   and assert `dirtyConsumerOf` for each. A new constant without a row fails the test by an
   exhaustive-list assertion over the store's exported catalog.
2. **SQL/TS parity (integration).** For every catalog reason, insert a row and assert the SQL
   predicate selects it for exactly the consumer `dirtyConsumerOf` names.
3. **Partition exclusivity (integration).** Seed rows of all partitions; run match and availability
   claims concurrently (two connections); assert disjoint result sets and that each set equals its
   partition. Mirrors the existing concurrent-claim spec of the store.
4. **Fan-out (integration).** One `saveObservationPage` advance yields two `SOURCE_RECORD` rows at
   the same `target_version`; one canonical revision yields two `OPPORTUNITY` rows; a replay inserts
   nothing (`inserted: false` on both).
5. **Successor-row invariant (integration).** Close an opportunity's only active record → run
   availability → assert a `PENDING` match row at the new revision → run match → the opportunity's
   matches are `EXCLUDED` with `AVAILABILITY_CLOSED`. And the reverse: a canonical bump while an
   availability row is pending → the old row ends `DEFERRED` and an `AVAILABILITY:CANONICAL_REVISION`
   row at the new revision exists.
6. **Sweep dedup (unit, `enqueueReason`).** A `PENDING` availability-partition row at the current
   revision no longer returns `null`.
7. **Both-flags convergence (integration).** Extend the existing reconciliation convergence spec:
   both workers drain the same seeded queue to quiescence; no `PENDING` rows remain in either
   partition; no row was completed by the other consumer (`claim_owner` history via a test-only
   owner prefix per worker).
8. **Env.** The "both true throws" case is replaced by "both true parses" — in the last slice only.

## Rollout

Slices, each its own PR, each green and shippable alone:

1. **S-P1 — classifier + partitioned claim + sweep dedup.** No producer change yet, so with today's
   reasons the partition is: availability gets `RECORD_RELISTED:*` and the three `enqueueOwners`
   reasons; match keeps the rest. Exclusion in `validateEnv` **stays**. Safe: with one flag on, the
   only behavioural change is that match stops completing availability-only rows (which it handled
   as no-ops). Between S-P1 and S-P2 an availability-only deployment no longer receives
   `SOURCE_REVISION` / `CANONICAL_REVISION`; acceptable only while that flag is dark everywhere. **Precondition for merging S-P1:** confirm `JOB_AVAILABILITY_RECONCILE_ENABLED` is unset/false in every deployed environment (config read, owner-confirmed); otherwise ship S-P1 and S-P2 as one PR.
2. **S-P2 — producer fan-out** (`saveObservations`, canonical store) **+ successor row** in
   `reconcileOpportunityAvailability`. Exclusion still stays.
3. **S-P3 — remove the `validateEnv` exclusion** and the "COEXISTENCE" warning in the availability
   worker header; update the two flag comments.

**Flag flip order (after S-P3 is deployed):**

1. `JOB_MATCH_RECONCILIATION_ENABLED=true` alone first (or keep it as is if already on); confirm a
   drain completes and no availability-partition row is `CLAIMED` by the match owner.
2. Then `JOB_AVAILABILITY_RECONCILE_ENABLED=true`. Watch the first drains: availability backlog
   count falling, `DEFERRED/VERSION_STALE` share on availability rows (expected high on the backlog),
   no `FAILED` growth on the match side.
3. Flag off is the kill switch for either worker independently; rows of an off consumer simply wait.

Read-only checks (run on the target database, confirm `SELECT current_database()` first):

```sql
-- pending rows per partition (the classifier mirrored in SQL)
SELECT CASE WHEN reason = 'DETAIL_FETCH' THEN 'DETAIL'
            WHEN reason LIKE 'AVAILABILITY:%' OR reason LIKE 'RECORD_RELISTED:%'
              OR reason IN ('RECORD_INVENTORY_CLOSED','RECORD_REOPENED','RECORD_WINDOW_EXPIRED') THEN 'AVAILABILITY'
            ELSE 'MATCH' END AS consumer, status, count(*)
  FROM job_dirty_work GROUP BY 1, 2 ORDER BY 1, 2;
```

## Rollback

| Step undone | How                                                          | Expected state                                                                                                                                                  | Verify                                                            |
| ----------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Flags       | set `JOB_AVAILABILITY_RECONCILE_ENABLED=false`               | availability rows wait `PENDING`; match unaffected                                                                                                              | the partition query above: availability `CLAIMED` count reaches 0 |
| S-P3        | `git revert <S-P3 merge sha>`                                | boot refuses both flags again                                                                                                                                   | V2 grep hits                                                      |
| S-P2        | `git revert <S-P2 merge sha>`                                | producers emit one row again; already-written `AVAILABILITY:*` rows stay in the table, unclaimed if availability is off, or still drained by S-P1's claim if on | V3 grep shows a single `enqueueDirty` per producer                |
| S-P1        | `git revert <S-P1 merge sha>` (only after S-P2/S-P3 reverts) | claims are reason-blind again; leftover `AVAILABILITY:*` rows would be swept by the match worker as no-op resolves                                              | V1 grep hits                                                      |

No schema change, so no down-migration. The one irreversible artefact is extra rows in a table
nothing prunes; they are inert once no consumer claims them (and a future retention may delete them
under the rule the retention guard pins).

## Owner decisions needed

| #    | Question                                                                                                             | Recommendation                                                                                                                        | Reversibility                                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| OD-1 | Adopt option B (no DDL) over B′/C (DDL) and D (status quo)?                                                          | **B.** No prod DDL gate, reuses the proven reason-scoped claim; B′ stays available as a later hardening                               | **Reversible** — three code reverts, no schema change                                                                                |
| OD-2 | Produce availability-partition rows unconditionally, or only while `JOB_AVAILABILITY_RECONCILE_ENABLED` is on?       | **Unconditionally.** No lost events between deploy and flip; the backlog drains idempotently; growth is bounded by record advances    | **Reversible** in code; the rows already written stay (nothing prunes the table) — effectively irreversible for that data, but inert |
| OD-3 | Backfill availability rows for records observed before S-P2 (a one-off enqueue on prod)?                             | **No.** Availability has never run, every value is the `UNKNOWN` default; the next observation of each record enqueues its row anyway | Not doing it is reversible; doing it is a **prod data write — A3**, irreversible once drained                                        |
| OD-4 | Ship the match successor row (`OPPORTUNITY_AVAILABILITY_CHANGED` on an availability revision bump) inside this work? | **Yes**, in S-P2. Without it a closed opportunity keeps its `LEAD`/`TRIAGE` matches once both flags are on                            | **Reversible** — a code revert                                                                                                       |
| OD-5 | Order of the prod flag flips after S-P3                                                                              | Match first, availability second, per Rollout                                                                                         | **Reversible** — each flag is an independent kill switch                                                                             |

## Sources

- `apps/api/src/job-sourcing/ownership/dirty-work.store.ts` — `dirtyWorkStatements.claim`,
  `claimDetailForSource`, `completeDirty` (version staleness), `recoverExpiredDirty`, `heldBy`,
  `DETAIL_FETCH` and the `REASON_MAX` bound.
- `apps/api/src/job-sourcing/runtime/recompute-worker.ts` — `createRecomputeSteps` (default kinds),
  `resolveSourceRecord`, `recomputeOpportunity` (`DETAIL_FETCH` enqueue).
- `apps/api/src/job-sourcing/runtime/availability-reconcile-worker.ts` — `AVAILABILITY_CLAIM_KINDS`,
  `reconcileSourceRecordAvailability`, `reconcileOpportunityAvailability` (revision bump without
  enqueue), the "COEXISTENCE" header.
- `apps/api/src/job-sourcing/store/source-record.store.ts` — `saveObservations` step 7,
  `SOURCE_REVISION_REASON`, `RECORD_RELISTED_REASON`.
- `apps/api/src/job-sourcing/store/canonical.store.ts` — `CANONICAL_REVISION_REASON`.
- `apps/api/src/job-sourcing/availability/*` — `enqueueOwners`, `INVENTORY_CLOSE_REASON`,
  `RECORD_REOPEN_REASON`, `WINDOW_EXPIRE_REASON`.
- `apps/api/src/job-sourcing/runtime/reconciliation.ts` — `enqueueReason`, `hasGivenUp`,
  `reconcileOnce` dirty sub-select.
- `apps/api/src/job-sourcing/runtime/roster-fanout.ts` — `fanout:` root.
- `apps/api/src/config/env.ts` — `validateEnv` refinement on the two flags.
- `apps/api/src/database/schema/job-collection.ts` — `uq_job_dirty_work_entity_target`,
  `idx_job_dirty_work_pending`.
- `docs/architecture/2026-11-01-availability-reconciliation.md` — Decision 6 (S8d consumer) and the
  availability state model.
- `docs/architecture/2026-10-24-job-source-run-ownership.md` — the fencing idiom the claim keeps.
