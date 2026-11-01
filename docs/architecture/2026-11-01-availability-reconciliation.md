# ADR: Availability reconciliation (Task 4.6 slice S8)

## Status

Proposed — 2026-11-01. Docs-only; no code, no DDL applied. Supersedes nothing; extends the
vacancy-sourcing r5 plan (Task 4.6, "Availability reconciliation") and sits beside
`docs/architecture/2026-10-25-source-fetch-strategy.md` (the collection layer this ADR consumes).

## Decisions (confidence; detail in the sections below)

1. **State model** — `availability` moves `OPEN -> UNKNOWN -> CLOSED/EXPIRED` and back to `OPEN`
   (reopen) by recorded, evidenced decisions; a transition to `CLOSED`/`EXPIRED` is never silent
   (HIGH). Aggregator disappearance is `EXPIRED`-at-source, not employer `CLOSED` (HIGH).
2. **404/410 closure (tested adapter contract)** — a `404/410` counts as closure only through a
   per-adapter proven `GONE` contract fed by a bounded/metered/resumable per-record detail re-fetch
   (HIGH on the shape; MED on the per-board rollout because only Greenhouse has the adapter today).
3. **Missing-inventory counter (D4)** — a source is closed by the inventory path only after 3
   consecutive VALID `FULL_INVENTORY` runs of the same board + `configVersion`, >=24h apart first to
   third; a >50% drop sends the source to review and does NOT advance; `WINDOW`/`PARTIAL`/invalid
   never advance (HIGH — the run ledger already carries every input).
4. **Reopen preserves claims/dismissals** — reopen bumps `job_opportunities.revision` and touches no
   `job_opportunity_matches` / suggestion decision rows; staleness is already version-driven, so a
   reopened opportunity re-evaluates without destroying any APPLIED/REJECTED state (HIGH).
5. **DDL (staged, not applied)** — availability evidence lives on columns that already exist on
   `job_source_records`; the inventory counter needs one small additive table; promoted via the
   S0/S6f staged-then-promote pattern, prod flip is an owner A3 (HIGH on shape, the promote is A3).
6. **Slice plan S8a..S8g** — schema/evidence lands dark first, the reconciliation worker last; the
   404/410 path is ordered behind the collection-layer dependency gate (HIGH).
7. **Risks + owner questions** — A2/A3 batched with recommendations (see the last section).

## Dependency gate — verdict (the first thing to read)

**S8 is PARTIALLY unblocked. Start now on the inventory path and the dark schema; the 404/410
per-record closure path is BLOCKED on the collection layer and must wait.**

What already exists on `origin/main` (merged U-slices of source-fetch-strategy, PRs #1172–#1209):

- **Coverage classification `FULL_INVENTORY | WINDOW | PARTIAL` — EXISTS.** `deriveCoverage` /
  `buildCollectionBatch` in `reporting-provider.ts` derive it; `job_collection_runs.coverage`,
  `.outcome`, `.sourceId`, `.cycleId`, `.configVersion`, `.sourceConfigSnapshot` persist it with the
  invariant "a non-SUCCEEDED attempt can never claim `FULL_INVENTORY`" enforced in code and by a
  CHECK. ATS boards (Greenhouse and peers) can claim `FULL_INVENTORY`; aggregators
  (Remotive/RemoteOK/Jobicy/Himalayas/Jobgether/Arbeitnow) are `WINDOW` by construction.
  → **The D4 missing-inventory counter has every input it needs today.**
- **Per-record detail/status re-fetch — NOT WIRED.** Only the Greenhouse adapter has the pure
  detail-by-id functions (`greenhouseDetailRequest`, `parseGreenhouseDetail`, `fetchGreenhouseDetail`),
  returning `GONE` on `404`. They are explicitly "not called by the routine run: U10 wires the
  trigger"; the manifest `detailMode` flips `IN_LIST -> ON_DEMAND` only at U10. No other ATS adapter
  has a detail-by-id adapter, and there is no triggered, metered, resumable re-fetch runner.
  → **The 404/410 closure path cannot be built until U10 (the detail re-fetch runner + `detailMode`
  flip) lands, and then only board-by-board as each adapter proves a `GONE` contract.**

**What must land first, for the 404/410 path only:** U10 — the on-demand detail/status re-fetch
runner (bounded, metered through the same `job_account_meters` reservation path as collection,
resumable via a checkpoint), plus the manifest `detailMode` flip for each board, plus a per-adapter
tested `GONE`-means-closed contract. Greenhouse is the only candidate on day one.

**Therefore the slice order is forced:** S8a (dark schema) -> S8b/S8c (the D4 inventory path and the
aggregator-expiry path, both on inputs that exist now) -> S8d..S8f (the worker and consumers) ->
**S8g (the 404/410 detail-closure path) is gated on U10 and does not start until it merges.**

<!-- sections below filled in subsequent commits -->

## Context

## Decision 1 — the availability state model

## Decision 2 — the 404/410 closure path and the tested adapter contract

## Decision 3 — the missing-inventory counter (D4)

## Decision 4 — reopen preserves claims and dismissals

## Decision 5 — DDL sketch (staged, not applied)

## Decision 6 — slice plan S8a..S8g

## Consequences

## Rollback

## Risks and owner questions (A2/A3)

## Sources
