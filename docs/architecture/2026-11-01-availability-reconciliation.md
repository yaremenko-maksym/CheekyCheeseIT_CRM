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

## Context

The vacancy-sourcing store already carries an availability axis end to end on the READ side and
leaves the WRITE side empty. `jobAvailabilityEnum` is `OPEN | UNKNOWN | CLOSED | EXPIRED`. Both
`job_source_records` (with `availabilityEvidence` jsonb and `availabilityCheckedAt`) and
`job_opportunities` (with the match-invalidating `revision` counter) hold an `availability` column,
defaulting to `UNKNOWN`. The funnel consumer already acts on it: `evaluate.ts` treats `CLOSED`/
`EXPIRED` as the exclusion reason `AVAILABILITY_CLOSED`. **Nothing writes a record or opportunity to
`CLOSED`/`EXPIRED` today** — the producer of those transitions is exactly what S8 adds.

The collection layer (source-fetch-strategy, merged U-slices) already classifies every run's
coverage (`job_collection_runs.coverage` = `FULL_INVENTORY | WINDOW | PARTIAL`, derived once by
`deriveCoverage`/`buildCollectionBatch`, with "a non-SUCCEEDED attempt can never claim
`FULL_INVENTORY`" enforced in code and by CHECK) and keeps per-source run history with `sourceId`,
`cycleId`, `configVersion`, `outcome`. Source-grain health already detects `BOARD_GONE` (latest run
is HTTP 404, or a clean zero after having had some) and `STALE_FEED`. S8 is the per-record /
per-opportunity grain on top of that source-grain foundation.

S8 also reuses, rather than reinvents, the dirty-work queue: `job_dirty_work` is polymorphic
(`entity_kind` ∈ `SOURCE_RECORD | OPPORTUNITY`, `entity_id`, `target_version`, `reason`, `cycleId`),
with `enqueueDirty`, lease/claim recovery and the derived-version idempotence already proven by the
S4a/S4b match workers (`reconcileOnce`). Availability recomputation is the same shape of work.

## Decision 1 — the availability state model

**Decision (HIGH).** `availability` is a recorded decision with evidence at both grains, and moves:

- `UNKNOWN -> OPEN`: the default start is `UNKNOWN`; a record becomes `OPEN` on **current open
  evidence** — a fresh observation inside a run that actually covered it (a revision observed this
  cycle, or a detail re-fetch that returned `FOUND`). Being seen once long ago is not current
  evidence; canonical `OPEN` requires open evidence from the current reconciliation input.
- `OPEN/UNKNOWN -> CLOSED`: **employer closure** — positive evidence the posting itself is gone: a
  tested-adapter `404/410` `GONE` (Decision 2), or the missing-inventory counter reaching its D4
  threshold for a `FULL_INVENTORY`-capable board (Decision 3).
- `OPEN/UNKNOWN -> EXPIRED`: **aggregator expiry / loss of visibility** — the posting dropped out of
  an aggregator window, or a source we cannot treat as inventory stopped showing it. This is **not**
  employer closure: `EXPIRED` means "we can no longer see it here", `CLOSED` means "we have evidence
  the opening ended". The two are kept distinct because the funnel and any future notification must
  not tell a senior an opening "closed" when only our visibility lapsed.
- `CLOSED/EXPIRED -> OPEN` (**reopen**): current open evidence reappears (the posting is observed
  again, or a detail re-fetch returns `FOUND`). Reopen is itself a recorded decision (Decision 4).

**Evidence per transition** is written to `job_source_records.availabilityEvidence` at the record
grain (`availabilityCheckedAt` stamped) and summarised onto the opportunity: the kind
(`DETAIL_GONE | INVENTORY_MISSING | WINDOW_DROPPED | OBSERVED_OPEN`), the run/cycle id that produced
it, the board + `configVersion`, and the counter state where relevant. **No transition to
`CLOSED`/`EXPIRED` is silent** — a reader can always point at the run and the rule that produced it.

**Opportunity-grain rule (HIGH).** An opportunity's availability is the **most-open** of its ACTIVE
source links (`job_opportunity_sources` where `unlinkedAt IS NULL`): if any live record is `OPEN`,
the opportunity is `OPEN`; it is `CLOSED` only when every active source record is `CLOSED`, `EXPIRED`
when all are `CLOSED`/`EXPIRED` and at least one is `EXPIRED`. Rationale: one aggregator dropping a
cross-posted job must not close an opportunity another board still shows open. Any change to the
derived opportunity availability bumps `revision` (Decision 4).

**Rejected alternatives.**

- _A single boolean `isOpen`._ Rejected: it cannot distinguish "we have evidence it ended" from "we
  stopped seeing it", which is the whole point of `CLOSED` vs `EXPIRED` and drives different downstream
  copy. The four-state enum already exists and the consumer already reads it.
- _Close an opportunity as soon as any one source record closes._ Rejected: cross-posted jobs would
  flap closed/open as aggregators rotate their windows. Most-open over active links is correct.
- _Infer `OPEN` from "seen at some point"._ Rejected: the plan requires canonical `OPEN` to rest on
  **current** open evidence; a stale first-seen is not evidence of present availability.

## Decision 2 — the 404/410 closure path and the tested adapter contract

**Decision (HIGH shape; MED rollout).** A `404`/`410` on a per-record re-fetch counts as employer
`CLOSED` **only** through a per-adapter, tested `GONE` contract, fed by a bounded/metered/resumable
detail re-fetch. The contract an adapter must prove before its `GONE` closes a record:

1. **A dedicated detail-by-id (or detail-by-url) request builder**, pure, built only from validated
   identity (never from response text), host-pinned — e.g. Greenhouse's `greenhouseDetailRequest`,
   which refuses a bad board token or non-positive id.
2. **A parser that judges STATUS first, body second**, mapping to a closed sum type: `FOUND`
   (re-affirms `OPEN`), `GONE` (`404`/`410` — the only status that closes), `FAILED`
   (`UPSTREAM | PARSE_DRIFT | PAYLOAD_TOO_LARGE`, which **never** closes — a transient/our-fault
   error is not an answer). Greenhouse's `parseGreenhouseDetail` is the reference shape.
3. **Identity re-verification**: a `FOUND` body whose id is not the one asked for is `PARSE_DRIFT`,
   not a match — so a reused/redirected endpoint cannot re-affirm the wrong posting.
4. **Named tests** proving `404 -> GONE -> CLOSED`, `5xx/parse-drift -> FAILED -> no transition`, and
   `FOUND -> OPEN`. Without these a `404` is treated as `FAILED` (no closure), never as closure.

**The re-fetch runner** (the thing that calls the adapter) must be **bounded** (a cap on records per
tick), **metered** (it spends against the same `job_account_meters` reservation path as collection —
a status check is a paid request), and **resumable** (a checkpoint of remaining ids, like the
collection runs' `checkpoint`). It is driven by the dirty-work queue, not a date scan.

**Hard dependency (see the gate):** this runner and the per-board `detailMode = ON_DEMAND` flip are
**not built** (U10). Only Greenhouse has the adapter functions, and they are explicitly not called by
any routine run yet. **S8's 404/410 path is therefore the last slice and is blocked on U10.**

**Rejected alternatives.**

- _Treat a list-absence as a `404`._ Rejected: absence from a list is the inventory path (Decision 3)
  and is only valid under `FULL_INVENTORY`; conflating it with a per-record `GONE` would close jobs an
  aggregator simply did not include this window.
- _Close on any non-2xx._ Rejected: `429/451/5xx` are transient or policy refusals, already thrown
  typed and host-banned upstream; they are `FAILED`, never closure.
- _One shared detail client for all boards._ Rejected: each provider's id space, host and "gone"
  semantics differ; the contract is per-adapter and tested per-adapter (the manifest `detailMode`
  carries it), exactly as the collection adapters already are.

## Decision 3 — the missing-inventory counter (D4, owner-frozen)

**Decision (HIGH — every input exists today).** A `FULL_INVENTORY`-capable board (an ATS list-all
source) may close a record by **absence from the inventory**, under the owner-frozen D4 rule:

- A record not seen in a run advances its missing-inventory counter **only** when that run is a
  **VALID `FULL_INVENTORY` run** (`outcome = SUCCEEDED` **and** `coverage = FULL_INVENTORY`) of the
  **same board + same `configVersion`** as the prior advancing runs.
- The record is marked `CLOSED` by this path only after **3 consecutive** such runs, with **>= 24h**
  between the first and the third. (Three clean full sweeps over at least a day: a one-off glitch or a
  same-minute retry cannot close a real job.)
- An **inventory drop of > 50%** vs the previous run **does not advance any counter** and sends the
  **source to review** (a health signal, ADMIN-surfaced) — a board returning a fraction of its usual
  inventory is a collection fault, not a mass closure.
- **`WINDOW`, `PARTIAL`, invalid or non-SUCCEEDED** runs **never advance** the counter, and a run
  under a different `configVersion` **resets** the consecutive chain (a config change is a different
  observation regime; its runs are not comparable to the prior ones).

**Where the counter lives.** A new additive table (Decision 5), one row per
`(source_record_id, board, config_version)`, holding: the consecutive VALID-FULL_INVENTORY miss
count, the run id and timestamp of the first and most-recent advancing miss, and the last inventory
size (for the >50%-drop guard). The counter is driven by the collection run's result, read from
`job_collection_runs` (`sourceId`, `configVersion`, `coverage`, `outcome`, counts). The >=24h test
is `last_advancing_at - first_advancing_at >= 24h` at the moment the third miss would land.

**Why absence is only meaningful under `FULL_INVENTORY`.** A `WINDOW` run (every aggregator) does not
claim to have listed everything, so "not in this response" carries no information about closure; only
a run that asserts it saw the whole board makes absence evidence. This is why aggregators are closed
only via `EXPIRED` (window drop) or a per-record `GONE`, never via this counter.

**Configurability per source.** The three numbers (consecutive count `3`, min span `24h`, drop
threshold `50%`) are the owner-approved frozen **defaults**, stored per source in its config
(`job_sources` config / `sourceConfigSnapshot`), so a noisier board can be tuned without a code
change, and the snapshot on each run records which thresholds were in force.

**Rejected alternatives.**

- _Close on the first missing `FULL_INVENTORY` run._ Rejected by D4: a single clean sweep can still
  miss a job (pagination race, brief board glitch); three over >=24h is the owner-frozen floor.
- _A time-only "not seen in N days" rule._ Rejected: it ignores whether the runs that failed to see
  it were actually full sweeps, which is the entire validity condition.
- _Let a >50% drop advance counters for the survivors._ Rejected: a mass drop is a collection fault;
  advancing would mass-close real jobs. It parks the source for review instead.

## Decision 4 — reopen preserves claims and dismissals

**Decision (HIGH).** A reopen (or any availability change) **touches no `job_opportunity_matches`
row and no suggestion decision** (APPLIED/REJECTED/dismissed state). It only:

1. writes the new availability + evidence at the record grain and re-derives the opportunity grain,
2. **bumps `job_opportunities.revision`**, and
3. **enqueues the opportunity as dirty work** (`entity_kind = OPPORTUNITY`) for the S4a recompute
   worker, exactly as a content revision already does.

Why nothing is destroyed: match staleness is **already version-driven**. A `job_opportunity_matches`
row stores `opportunityRevision` and is "stale, never served" when it differs from the live
`revision`. So bumping `revision` on reopen makes existing matches recompute **without deleting
them**; a human decision recorded against a suggestion is preserved and simply re-surfaced against
the reopened opportunity. A close (`CLOSED`/`EXPIRED`) likewise bumps `revision`; the recompute
yields `AVAILABILITY_CLOSED` (the funnel already does this) — the match rows persist as history,
they are just not served as live leads.

This reuses the invalidation contract the match workers already depend on; S8 adds **no new**
coupling to matches beyond the `revision` bump + dirty enqueue it already understands. (Known
pre-existing gap, unchanged by S8: a senior who newly joins the roster for an opportunity that
already has rows for others is only detected at the next revision — reopen's `revision` bump
actually helps here, it does not hurt.)

**Rejected alternatives.**

- _Delete match rows on close and recompute on reopen._ Rejected: it destroys recorded human
  decisions and the audit trail, and it is unnecessary — the version mechanism already makes stale
  rows unservable without deletion.
- _A separate "reopened" flag._ Rejected: availability already carries the state; a reopen is just a
  transition back to `OPEN` with its own evidence row, and the `revision` bump is the existing signal.

## Decision 5 — DDL sketch (staged, not applied)

## Decision 6 — slice plan S8a..S8g

## Consequences

## Rollback

## Risks and owner questions (A2/A3)

## Sources
