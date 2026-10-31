# ADR: DOU bridge under run ownership — durable legacy delivery (r5 Task 4.6, slice S6)

## Status

**Proposed (2026-10-31).** Docs only: no code, no DDL applied. Every DDL in this file is a
**sketch** and needs an explicit owner **A3 go** before it ships to production.

## Decisions (summary)

- D-1 — DOU acquires a run handle through a new ledger entry point for LEGACY sources; budget stays
  `chargeBudget` on `job_sources`, written before the provider. _(section 1)_
- D-2 — A durable delivery table carries every posting of the complete provider array to the two
  legacy consumers; the consumer checkpoint is written in the same transaction as the consumer's
  effect. _(section 2)_
- D-3 — One new table, class A, staged first, promoted with the S0 deploy pattern. _(section 3)_
- D-4 — Flag `JOB_QUEUE_BRIDGE_ENABLED`, default off; the barrier runs off and on. _(section 4)_
- D-5 — Backfill is slice S7, separate. _(section 5)_
- D-6 — Slice plan S6a–S6g. _(section 6)_

## Context

**The owner's inputs (2026-10-27).** D1 = option (a): DOU runs under a ledger run (the
run-ownership machinery), and the one-unit budget arithmetic stays as it is. D3 = an environment
flag switches the queue bridge on and off, default **off**. The plan's Task 4.6 adds: "DOU keeps its
own fetch path until this gate exists (A1n)"; feed `persistPostings` / `createSuggestions` the
complete array before any new filter; durable delivery keyed by identity / consumer / version with
consumer checkpoints; `createSuggestions([])` is not recovery.

**This ADR amends the run-ownership ADR** (`2026-10-24-job-source-run-ownership.md`). Its paragraph
"DOU, the one live source, stays on the legacy path, entirely outside the ledger" (SR-M-17,
CONTRA-4) and T7 AC 15 ("DOU never gets a `job_collection_runs` row") hold **only while the flag is
off**. With the flag on, DOU gets a run row. What that paragraph protected — DOU cannot be capped
out by a ledger it does not heartbeat into — is kept by section 1's neutral accounting.

**Measured facts the decisions rest on** (read 2026-10-31 on `origin/main`):

| #   | Fact                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | `JobSourcingService.collectSource` is the legacy seam: kind check (`NotLegacySourceError`) → `chargeBudget` → `provider.collect(config)` → zero postings throws and leaves `lastCollectedAt` → `persistPostings` → `createSuggestions(created)` → write `lastCollectedAt`. No transaction spans these steps.                                     |
| F2  | `persistPostings` returns only the **created** rows (`ON CONFLICT (fingerprint) DO NOTHING RETURNING`); a duplicate is a count. `createSuggestions` is called with that list. So a crash after `persistPostings` and before `createSuggestions` loses those suggestions **for good**: the rerun sees every row as a duplicate and calls `createSuggestions([])`. |
| F3  | `JobRunLedger.claimSource` and `claimGate` refuse every non-`REPORTING` kind with `NOT_ACTIVATABLE`. DOU is `LEGACY`, has `manifest_id` NULL and `host_key` NULL.                                                                                                                                                                                   |
| F4  | `JobRunLedger.endRun` → `account` writes `job_sources` failure columns (`consecutive_failures`, `cooldown_until`, `next_attempt_at`, `last_success_at`) and never `last_collected_at`. `recoverExpired` ends an expired run `FAILED` / `LEASE_EXPIRED`, which counts as a failure.                                                                    |
| F5  | `job_collection_runs` has no column or CHECK that needs a manifest. Two partial unique indexes allow one `STARTED` run per source and per account key. A source with no meter gets the synthetic account key `#source:<id>`.                                                                                                                       |
| F6  | `write-gate.spec.ts` makes the ledger the only writer of the run row and the scheduling columns. A new claim path must live in `JobRunLedger`.                                                                                                                                                                                                     |
| F7  | `saveObservationPage` (the S1 page write) needs a run handle: `assertOwned`, then observations, then `writePageCheckpoint`, in one transaction. Identity is `(provider, namespace, identityKey)`; `MAX_OBSERVATIONS_PER_PAGE` is 500.                                                                                                              |
| F8  | The barrier already exists in part (Task 4.6a, PR #1154; golden fixtures PR #1010): the DOU golden unit and integration specs and the compat-barrier specs. Their flag-on variant is an `it.todo` ("add when the queue flag is wired (Task 4.6d)"). No queue flag exists in product code.                                                           |
| F9  | All job-sourcing tables are privilege class `A` (`PRIVILEGE_CLASSES`). The env schema already carries a default-off boolean of the same shape: `JOB_MATCH_RECONCILIATION_ENABLED`.                                                                                                                                                                  |

## 1. Run handle for DOU without changing the budget arithmetic

### Decision D-1 (confidence: **HIGH** on the order of steps, **MED** on the neutral-accounting mechanism)

A new ledger method, `JobRunLedger.claimLegacyRun({ cycleId, owner, sourceId, actor? })`, used
**only when the flag is on**. It:

1. locks the source row (`FOR UPDATE`, `lock_timeout` as in `claimSource`);
2. accepts **only** a `LEGACY` kind — the mirror of `claimGate`, which keeps refusing `LEGACY`, so
   the two claim paths stay disjoint by kind (the SR-M-23 "allow is the kind" rule, kept);
3. skips the cadence term, the manifest gate and the host slot (DOU has none of them);
4. checks `enabled` and the trigger mode exactly as `collectAll` does today, nothing more;
5. calls the existing `insertRun` with `adapter_version` = a constant that names the DOU provider
   version (for example `dou-rss-legacy/1`) and the `#source:<id>` account key;
6. maps a single-flight violation (`23505`) to a typed stop `JobSourceRunBusyError`, a subclass of
   `JobSourceDeliberateStopError` with `budgetExhausted: false`.

Ending a LEGACY run uses `finish` as today, with one new branch in `account`: **a source whose kind
is `LEGACY` gets a run-row-only ending.** The run row records outcome, error code and counts.
`job_sources` is not written at all — no `consecutive_failures`, no cooldown, no `next_attempt_at`,
no `last_error_code`. The same branch applies in `recoverExpired`. So the failure cap and backoff
never apply to DOU, which is the property SR-M-17 protected. `last_collected_at` stays the
service's write, as today.

**The order in `collectSource` with the flag on** (each step is named by today's symbol):

```
open or reuse the cycle (openCycle)          -- no unit spent
claimLegacyRun                               -- refused → typed stop, ZERO units spent
chargeBudget(source)                         -- ONE unit, BEFORE the provider (unchanged)
provider.collect(config)                     -- DOU's own fetch path, unchanged (A1n)
bridge delivery (section 2)
write lastCollectedAt                        -- only after the drain succeeds (unchanged)
finish(run, SUCCEEDED | FAILED + code)
```

Claim **before** charge: a refused claim must cost nothing, which is the budget's own rule ("an
exhausted source costs ZERO requests").

### Golden behaviour → new path

| Golden behaviour (pinned today)                             | Flag off      | Flag on                                                                                                     |
| ----------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| One unit written before the provider is asked               | unchanged     | unchanged: `chargeBudget` runs after the claim and before `provider.collect`                                |
| The provider throws → the unit stays spent                  | unchanged     | unchanged; the run ends `FAILED` / `UPSTREAM` (run row only)                                                |
| Zero postings → failure, unit spent, `lastCollectedAt` kept | unchanged     | same `Error` thrown, so `collectAll` reports it the same way; the run ends `FAILED` / `PARSE_DRIFT`         |
| Exhausted source → typed stop, zero requests                | unchanged     | `chargeBudget` throws `JobSourceBudgetExhaustedError` as today; the run ends `CANCELLED` / `COST_STOP`      |
| Contention → `JobSourceBudgetContentionError`               | unchanged     | unchanged; the run ends `CANCELLED` / `COST_STOP`                                                           |
| Unlimited source is never charged                           | unchanged     | unchanged: `resolveBudget` returns `limited: false` before any write                                        |
| Window rollover restarts the count at one                   | unchanged     | unchanged (same function)                                                                                   |
| Twenty sequential clicks spend twenty units                 | unchanged     | unchanged: each run ends before the next click                                                              |
| Two **concurrent** collections both run                     | unchanged     | **changes:** the second gets `JobSourceRunBusyError` and spends zero units (owner question Q2, section 7)   |
| `collectAll` isolates a failing source                      | unchanged     | unchanged: every new error is caught by the existing loop; deliberate stops take the warn branch           |

The error code per row is a proposal for S6c. `validateEnding` decides which codes each outcome
admits, and S6c may pick another code from `COLLECTION_ERROR_CODES` if that table refuses one. No
new code is needed.

**Rejected alternatives.**

- _Make DOU a `REPORTING` adapter._ It moves DOU onto the meter, the host slot, the failure cap and
  the hardened fetch at once. That breaks "DOU keeps its own fetch path" (A1n) and D1's budget
  clause. Rejected.
- _Reuse `claimSource` with a LEGACY exception._ That widens the reporting claim's gate. The kind
  disjointness (SR-M-23) would then rest on an `if` inside the gate instead of on two entry points.
  Rejected.
- _Charge first, then claim._ A busy run would spend a unit and make no request. Rejected.
- _Keep DOU outside the ledger and only add the bridge._ This contradicts D1. The bridge also needs
  a run handle: `saveObservationPage` fences on it (F7).

## 2. The durable bridge

_(pending)_

## 3. DDL sketch (not applied — owner A3 go required)

_(pending)_

## 4. The compatibility barrier and the flag

_(pending)_

## 5. Backfill (slice S7)

_(pending)_

## 6. Slice plan

_(pending)_

## 7. Risks and owner questions

_(pending)_

## Consequences

_(pending)_

## Rollback

_(pending)_

## Sources

_(pending)_
