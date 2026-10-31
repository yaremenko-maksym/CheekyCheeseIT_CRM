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
- D-6 — Slice plan S6a–S6g, then the flag flip, then S7. _(section 6)_
- Owner questions Q1–Q6: three A3 (prod DDL, flag flip, backfill), three A2. _(section 7)_

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

| #   | Fact                                                                                                                                                                                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | `JobSourcingService.collectSource` is the legacy seam: kind check (`NotLegacySourceError`) → `chargeBudget` → `provider.collect(config)` → zero postings throws and leaves `lastCollectedAt` → `persistPostings` → `createSuggestions(created)` → write `lastCollectedAt`. No transaction spans these steps.                                                     |
| F2  | `persistPostings` returns only the **created** rows (`ON CONFLICT (fingerprint) DO NOTHING RETURNING`); a duplicate is a count. `createSuggestions` is called with that list. So a crash after `persistPostings` and before `createSuggestions` loses those suggestions **for good**: the rerun sees every row as a duplicate and calls `createSuggestions([])`. |
| F3  | `JobRunLedger.claimSource` and `claimGate` refuse every non-`REPORTING` kind with `NOT_ACTIVATABLE`. DOU is `LEGACY`, has `manifest_id` NULL and `host_key` NULL.                                                                                                                                                                                                |
| F4  | `JobRunLedger.endRun` → `account` writes `job_sources` failure columns (`consecutive_failures`, `cooldown_until`, `next_attempt_at`, `last_success_at`, `last_nonempty_at`, `last_error_code`; a neutral or cost-stop ending still writes `next_attempt_at` and `last_error_code`) and never `last_collected_at`. `recoverExpired` ends an expired run `FAILED` / `LEASE_EXPIRED`, which counts as a failure.                                                                               |
| F5  | `job_collection_runs` has no column or CHECK that needs a manifest. Two partial unique indexes allow one `STARTED` run per source and per account key. A source with no meter gets the synthetic account key `#source:<id>`.                                                                                                                                     |
| F6  | `write-gate.spec.ts` makes the ledger the only writer of the run row and the scheduling columns. A new claim path must live in `JobRunLedger`.                                                                                                                                                                                                                   |
| F7  | `saveObservationPage` (the S1 page write) needs a run handle: `assertOwned`, then observations, then `writePageCheckpoint`, in one transaction. Identity is `(provider, namespace, identityKey)`; `MAX_OBSERVATIONS_PER_PAGE` is 500.                                                                                                                            |
| F8  | The barrier already exists in part (Task 4.6a, PR #1154; golden fixtures PR #1010): the DOU golden unit and integration specs and the compat-barrier specs. Their flag-on variant is an `it.todo` ("add when the queue flag is wired (Task 4.6d)"). No queue flag exists in product code.                                                                        |
| F9  | All job-sourcing tables are privilege class `A` (`PRIVILEGE_CLASSES`). The env schema already carries a default-off boolean of the same shape: `JOB_MATCH_RECONCILIATION_ENABLED`.                                                                                                                                                                               |

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

| Behaviour                                                   | Pinned today?                       | Flag off  | Flag on                                                                                                          |
| ----------------------------------------------------------- | ----------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| One unit written before the provider is asked               | yes (compat barrier)                | unchanged | unchanged: `chargeBudget` runs after the claim and before `provider.collect`                                     |
| The provider throws → the unit stays spent                  | yes (compat barrier)                | unchanged | unchanged; the run ends `FAILED` / `UPSTREAM` (run row only)                                                     |
| Zero postings → failure, unit spent, `lastCollectedAt` kept | yes (compat barrier, DOU golden)    | unchanged | same `Error` thrown, so `collectAll` reports it the same way; the run ends `FAILED` / `PARSE_DRIFT`              |
| Exhausted source → typed stop, zero requests                | yes (budget specs)                  | unchanged | `chargeBudget` throws `JobSourceBudgetExhaustedError` as today; the run ends `PARTIAL` / `COST_STOP`             |
| Contention → `JobSourceBudgetContentionError`               | yes (budget contention spec)        | unchanged | unchanged; no request was made and the budget is not spent, so the run ends `CANCELLED` / `CANCELLED`            |
| Unlimited source is never charged                           | yes (compat barrier)                | unchanged | unchanged: `resolveBudget` returns `limited: false` before any write                                             |
| Window rollover restarts the count at one                   | yes (compat barrier)                | unchanged | unchanged (same function)                                                                                        |
| Twenty sequential clicks spend twenty units                 | **no** — new test in S6a            | unchanged | unchanged: each run ends before the next click                                                                   |
| Two **concurrent** collections                              | **no** — new test in S6a (flag off) | both run  | **the one deliberate divergence:** the second gets `JobSourceRunBusyError` and spends zero units (Q2, section 7) |
| `collectAll` isolates a failing source                      | yes (collect-all specs)             | unchanged | unchanged: every new error is caught by the existing loop; deliberate stops take the warn branch                 |

The pairs are the ones `validateEnding` accepts: `PARTIAL` admits only `PAGE_CAP` / `COST_STOP` /
`DEADLINE`, `CANCELLED` admits only `CANCELLED`, and `FAILED` admits any known code except
`LEASE_EXPIRED`. Exhaustion is a cost stop. Contention is not: nothing was spent, so it is a
cancellation. Under the LEGACY branch, both end the run row only; the `endingEffect` they select is
not applied to `job_sources`. No new code is needed.

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

### Decision D-2 (confidence: **HIGH** on the delivery-row design, **MED** on the store-write ordering)

**One delivery row per (consumer, identity, version).** Table `job_bridge_deliveries` (section 3):

- **identity** — the DOU posting's `fingerprint`. It is already the legacy dedupe key, it is
  `sha256("DOU_RSS|<canonical url>")`, and the golden spec pins it.
- **consumer** — `LEGACY_POSTING` (the `persistPostings` row write) or `LEGACY_SUGGESTION` (the
  `createSuggestions` fan-out).
- **version** — a content hash of the `NormalizedPosting` exactly as the provider returned it.
  It is not the store's `observation_seq`, so the legacy feed **never depends on the new store**: an
  item the observation validator refuses still reaches the legacy consumers (the "complete array"
  clause).
- **payload** — that `NormalizedPosting`. The posting consumer needs it, and the record may not
  exist.
- **checkpoint** — the row's own status (`PENDING` → `DONE` | `INVALID`), written **in the same
  transaction as the consumer's effect**. This is the consumer checkpoint of the plan: an effect and
  its checkpoint commit together or not at all.

### The flow with the flag on (after `provider.collect` returned `postings`)

```
T1  enqueue          one tx: assertOwned(run); INSERT one LEGACY_POSTING row per element of the
                     COMPLETE postings array, ON CONFLICT (consumer, identity, version) DO NOTHING
T2  observation      saveObservationPage(run, DOU postings mapped to observations, checkpoint)
    store            -- chunked by chunkPage; a failure is logged and counted, never fatal (below)
T3  posting drain    for each PENDING LEGACY_POSTING row of this SOURCE (not only this run), in
                     enqueue order, one tx per row:
                       assertOwned(run)
                       INSERT job_postings … ON CONFLICT (fingerprint) DO NOTHING RETURNING id
                       created → INSERT LEGACY_SUGGESTION row (PENDING, posting_id = id)
                       duplicate → SELECT the existing id by fingerprint (it must be stored:
                         see "A purged posting reappearing", section 3)
                       UPDATE this row → DONE, outcome CREATED | DUPLICATE, posting_id
                     a row the database refuses → separate tx marks it INVALID (today's MED-2
                     per-row isolation: one bad row costs that row, loudly logged)
T4  suggestion       for each PENDING LEGACY_SUGGESTION row of this source, one tx per row:
    drain              assertOwned(run); the createSuggestions body for [that posting], inside
                       the tx; UPDATE this row → DONE, suggestions_created = n
T5  lastCollectedAt  only after T3 and T4 drained without a thrown error (unchanged rule)
```

**`createSuggestions` gets the right input on retry.** Today's suggestion input is "the rows this
call happened to create" (F2), and it exists only in memory. Here it is a persisted fact: the
`LEGACY_SUGGESTION` row holds the `posting_id`, written in the same transaction as the posting
insert that created it. After a crash, the retry finds a `PENDING` row and offers that posting.
Calling `createSuggestions([])` recovers nothing: the empty list is the symptom of the lost fact,
not a retry of it.

**Legacy semantics are kept, not re-derived.** A `DUPLICATE` posting gets no suggestion row, so a
re-collection creates no further suggestions (golden). First write wins: a changed description makes
a new version, the insert is `DUPLICATE`, nothing is updated (golden). Exclusions and eligibility are
evaluated when the suggestion row is drained. Today they are evaluated in the same call, so they
differ only after a crash. `APPLIED` / `REJECTED` stay safe: the unique `(posting_id, senior_id)`
index with `DO NOTHING` never rewrites an answered suggestion.

**New sources never leak into legacy suggestions.** Only `claimLegacyRun` runs can enqueue a
`LEGACY_*` row. T1 asserts that the run's source kind is `LEGACY` and the row's `provider` equals
the run's source type. The drain repeats the check. A reporting adapter has no code path to this
table. A CHECK constraint pins `provider = 'DOU_RSS'` until a second legacy source exists (section 3).

### Crash points — why each retry is idempotent

| Crash after …                             | State left                                             | What the next DOU run does                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `chargeBudget`, before T1                 | unit spent, run `STARTED`                              | recovery ends the run (neutral). Nothing is delivered; the next run fetches again and spends its own unit, as today             |
| T1 (enqueue)                              | `PENDING` posting rows                                 | its T1 inserts the same keys → `DO NOTHING`; its T3 drains the old and new rows together                                        |
| T2 (store)                                | records/revisions saved                                | store idempotence (same content → no new revision; run membership PK) — Task 4.5's own tests                                    |
| a T3 row commits (**after legacy write**) | `job_postings` row + `DONE` + `PENDING` suggestion row | the `DONE` row is skipped; the `PENDING` suggestion row is drained                                                              |
| a T3 row's insert, before its commit      | nothing (one tx)                                       | the row is still `PENDING`; the insert re-runs and gets the same answer                                                         |
| a T4 row's commit (**after suggestion**)  | suggestions + `DONE`                                   | skipped                                                                                                                         |
| T4 inserts, **before the checkpoint**     | nothing (one tx)                                       | re-drained. Even outside a tx the unique index makes the re-insert a no-op; only the `suggestions_created` count would be lower |
| T5 (`lastCollectedAt`), before `finish`   | delivered, run `STARTED`                               | recovery ends the run as the neutral run-row ending. `job_sources` is untouched, as section 1 says                              |

A fenced executor — lease lost, successor claimed — fails `assertOwned` inside every T1/T3/T4
transaction, so two executors never drain the same row at once. The single-flight index guarantees
one live owner per source.

**Who drains after a crash.** The next DOU run of the same source: the 05:00 cron or an ADMIN click.
So a crash delays suggestions by at most one cycle. It never loses them. No separate drain worker
is added: YAGNI for one daily feed of about 25 items. **The drain runs only after a successful
fetch.** It sits after `provider.collect` and the zero-postings check. While DOU is down or returns
nothing, pending suggestion rows wait. They are delayed, not lost (risk R3).

### Ordering: why legacy enqueue comes before the store write

The plan says "persist valid records before evaluating". For the **new** pipeline, T2 is that
persist step: it runs before anything new evaluates a record (the dirty/recompute worker reads only
what T2 wrote). The **legacy** consumers are not evaluation. They are today's product, and they must
not fail because the new store refuses something. So T1 runs first. A T2 failure is logged and
recorded on the run row as a lower `received`, and it **does not fail the DOU run** (owner question
Q3). The run row's counters have one writer: `write-gate.spec.ts` bars the service from writing
`job_collection_runs`. So the T2-failure count goes through a ledger-side writer, `writePageProgress`
or a new sibling in `JobRunLedger` (S6e), never a direct service UPDATE. Item-level: the DOU → observation mapping skips an item the validator refuses and counts it in
`invalid`. It never drops the item from T1.

**Rejected alternatives.**

- _Mark suggestions by re-reading which postings have no suggestion rows._ "Has no suggestions" is
  also true for a posting every senior excluded and for an ineligible team. Such a rule would offer
  those postings again. Rejected: it re-derives a fact instead of recording it.
- _Run `persistPostings` + `createSuggestions` in one big transaction._ Locks the
  suggestions table for the whole fan-out (seniors × postings). It also drops the per-row isolation
  of MED-2: one bad row would roll back the batch. Rejected.
- _Key the version on the store's `observation_seq`._ Couples the live feed to the new store's
  validator and to its availability. Rejected.
- _A generic outbox with a separate worker process._ The class-C collector role and its worker are
  not shipped (privilege classes C/D empty). Draining in the run that owns the source needs no new
  process. Rejected for now. The table shape allows a worker later.

## 3. DDL sketch (not applied — owner A3 go required)

> **SKETCH.** Nothing below is applied, staged or wired by this ADR. Promoting it to production
> deploy wiring (slice S6f) needs an explicit owner **A3 go** (owner question Q1). The column list
> is the design. S6b may rename columns, but must keep the keys, the CHECKs and the class.

### Decision D-3 (confidence: **HIGH** on keys and class, **MED** on the column set)

```sql
-- staged as apps/api/drizzle/manual-staged/<date>_job_bridge_deliveries.sql; S6f moves it to manual/
CREATE TYPE job_bridge_consumer AS ENUM ('LEGACY_POSTING', 'LEGACY_SUGGESTION');
CREATE TYPE job_bridge_status   AS ENUM ('PENDING', 'DONE', 'INVALID');

CREATE TABLE IF NOT EXISTS job_bridge_deliveries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id           uuid REFERENCES job_sources(id) ON DELETE SET NULL,   -- OPEN (S6b), see below
  provider            job_source_type NOT NULL,
  consumer            job_bridge_consumer NOT NULL,
  identity_key        text NOT NULL,            -- the posting fingerprint
  content_version     text NOT NULL,            -- sha256 of the NormalizedPosting
  payload             jsonb NOT NULL,           -- the NormalizedPosting (LEGACY_POSTING) / {} (SUGGESTION)
  status              job_bridge_status NOT NULL DEFAULT 'PENDING',
  outcome             text,                     -- CREATED | DUPLICATE | <db error class>
  posting_id          uuid REFERENCES job_postings(id) ON DELETE CASCADE,
  suggestions_created integer,
  enqueued_by_run     uuid NOT NULL REFERENCES job_collection_runs(id) ON DELETE RESTRICT,
  delivered_by_run    uuid REFERENCES job_collection_runs(id) ON DELETE RESTRICT,
  attempts            integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  delivered_at        timestamptz,
  CONSTRAINT ck_job_bridge_legacy_only     CHECK (provider = 'DOU_RSS'),
  CONSTRAINT ck_job_bridge_suggestion_post CHECK (consumer <> 'LEGACY_SUGGESTION' OR posting_id IS NOT NULL),
  CONSTRAINT ck_job_bridge_done_stamped    CHECK ((status = 'PENDING') = (delivered_at IS NULL)),
  CONSTRAINT ck_job_bridge_payload_size    CHECK (pg_column_size(payload) <= 65536)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_bridge_delivery
  ON job_bridge_deliveries (consumer, identity_key, content_version);
CREATE INDEX IF NOT EXISTS ix_job_bridge_pending
  ON job_bridge_deliveries (source_id, consumer, created_at) WHERE status = 'PENDING';
```

- **Keys.** The unique index is the delivery identity: identity / consumer / version. A suggestion
  row's `content_version` is its posting row's, so a posting yields at most one suggestion row.
  The partial index serves the drain, which reads only `PENDING`.
- **`ON DELETE` choices.** `CASCADE` from `job_postings`: retention (`purgeStalePostings`) deletes
  unanswered postings, and a delivery row of a purged posting has no meaning. `RESTRICT` from
  the run rows: runs are kept, so nothing is lost, and a purge of runs must not erase delivery
  evidence silently. **Check at S6b:** does any run-retention path delete `job_collection_runs`?
  If one does, use `SET NULL` on `delivered_by_run` and keep `enqueued_by_run`.
- **OPEN — `source_id` on source deletion (decide in S6b, together with the run-retention check
  above).** `job_postings.source_id` is `ON DELETE SET NULL`, so postings outlive a deleted source.
  A `CASCADE` here would erase that source's `PENDING` deliveries while its postings survive. That
  is silent loss of exactly the fact this table exists to keep. **Recommendation: `SET NULL`**,
  nullable, matching `job_postings`. The evidence survives, and an ADMIN can still delete a source.
  A pending row whose source is gone is inert, because the drain selects by `source_id`. S6g's
  runbook lists such rows with one query. `RESTRICT` is rejected: it would block deleting a source
  forever once it has any delivery row, `DONE` rows included, and nothing else in job sourcing
  blocks an ADMIN delete that way.
- **A purged posting reappearing.** After the delivery row cascades away, the next collection of
  the same feed item enqueues a fresh row, the insert creates the posting again, and seniors get a
  fresh `NEW` suggestion. That is today's behaviour ("undecided ones are purged and re-offered as
  fresh NEW", compat-barrier integration spec), so it is preserved. It works **only if a
  `DUPLICATE` row also stores the existing `posting_id`**. Otherwise that row survives the purge and
  its unique key makes the re-enqueue a no-op, so the purged posting is never re-offered. S6b adds
  `CHECK (consumer <> 'LEGACY_POSTING' OR status <> 'DONE' OR posting_id IS NOT NULL)`.
- **`INVALID` is terminal per version.** The refusals MED-2 isolates are payload refusals, so they
  are deterministic: the same version would fail again. A changed item has a new version and is
  tried again. Today, by contrast, every run retries the same refused item and logs it again. The
  log line goes, the outcome does not change.
- **Privilege class `A`**, like every job-sourcing table (F9): `crm_app` gets SELECT / INSERT /
  UPDATE / DELETE, `crm_collector` nothing. Add the table to `PRIVILEGE_CLASSES.A` and, while staged,
  to `STAGED_RELATIONS`.
- **Growth.** About 25 posting rows + up to 25 suggestion rows per day, each with one payload that
  is bounded (≤ 64 KiB by CHECK; real DOU items are a few KiB). `DONE` rows older than
  `POSTING_RETENTION_DAYS` may be deleted by the existing retention cron. That is slice S6g's
  choice; it is not needed for correctness.

### Deploy wiring — the S0 pattern (PR #1171)

1. **S6b — staged.** The file and its Drizzle declaration land, with a forward-DDL integration spec
   that applies the file twice and compares the catalog with `db:push` (the
   `job-record-store-forward-ddl` precedent). `check-prod-ddl-wiring.py` passes, because a staged
   file lives in `drizzle/manual-staged/`, not `manual/`. Nothing reaches production.
2. **S6f — promoted (DevOps, owner A3 go).** Do what S0 did for `2026-10-25_job_record_store.sql`.
   The file set below is the #1171 diff:
   - **move** the file `manual-staged/` → `manual/` as a pure rename (no byte changes);
   - `.github/workflows/deploy.yml`: add the file to the rollback preflight list (a hard
     requirement) and add an SCP copy step;
   - `scripts/devops/deploy-stack-on-vps.sh`: add an apply block. It checks the file exists (fails
     loud if scp flattened the tree), then applies it with
     `psql -v ON_ERROR_STOP=1 --single-transaction` **after** the record-store block and **before**
     `2026-10-18_db_grants.sql`;
   - privileges: remove the table from `STAGED_RELATIONS` in `privilege-classes.ts`; **regenerate**
     `2026-10-18_db_grants.sql` and `2026-10-18_db_privileges_check.sql` from it; update
     `privilege-classes.spec.ts` / `generate-privilege-sql.spec.ts`. The catalog check runs after the
     grants and must pass;
   - `scripts/devops/check-prod-ddl-wiring.py`: register the file as wired;
   - the forward-DDL spec: point it at the new path;
   - `docs/runbooks/deployment.md`: add the line for the new DDL step.
3. **Order against the code.** The bridged code path (S6d) needs the table only with the flag on.
   With the flag off it never touches the table, so S6d may merge and deploy before S6f. **S6f
   ships only after S6d** is merged and green flag-on in CI (Q1): the schema goes to production for
   a reader that exists. S6b staging may precede both. The flag stays off in production until S6f
   is deployed (Q4).

### DDL rollback

The table is additive and nothing outside the bridge reads it.

- **Code rollback** = flag off. No DDL is touched.
- **Schema rollback** (owner-run, only after the flag has been off for a full cycle):
  `DROP TABLE IF EXISTS job_bridge_deliveries; DROP TYPE IF EXISTS job_bridge_status; DROP TYPE IF EXISTS job_bridge_consumer;`
  — **plus** a reverse commit that undoes the S6f file set (`deploy.yml` preflight + SCP, the
  `deploy-stack-on-vps.sh` apply block, the regenerated privilege files, the wiring check).
  Otherwise the next deploy re-creates the table.
- **Loss.** Dropping the table loses any `PENDING` suggestion rows. Section 4's flag-off drain rule
  is what makes that loss zero.

## 4. The compatibility barrier and the flag

### Decision D-4 (confidence: **HIGH**)

**Flag:** `JOB_QUEUE_BRIDGE_ENABLED`, a boolean in the API env schema (`apps/api/src/config/env.ts`).
It is parsed with the same `preprocess` as `JOB_MATCH_RECONCILIATION_ENABLED`, `.default(false)`,
and documented in `.env.example` (DevOps). It is **read once at module construction** and injected
into `JobSourcingService`; there is no per-request read. The only branch on it is in
`collectSource`, at the top of the LEGACY path: off → today's body, byte for byte; on → the
section 1 + 2 path. Nothing else reads it. A spec asserts that the off-branch makes no ledger call
and no bridge-table query (a recording double, like the compat-barrier harness).

**What "barrier first" means given F8.** Most fixtures already exist. S6a closes the gap, and no
behaviour slice merges before S6a is green. The barrier = these suites, run **with the flag off AND
on** (a `describe.each` over the flag, real Postgres for the integration ones):

| Golden behaviour (plan list)                        | Existing pin                                               | Gap to close in S6a                                                          |
| --------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| DOU normalisations                                  | `dou-golden.spec.ts` (parse, normalize, truncation, NUL)   | none (pure functions; the flag cannot reach them) — run once                 |
| fingerprints                                        | `dou-golden.spec.ts` dedupe identity block                 | none — run once                                                              |
| posting → suggestion decisions                      | `dou-golden.integration.spec.ts` suggestion block          | flag-on variant                                                              |
| eligibility / exclusion results                     | both DOU golden specs                                      | flag-on variant                                                              |
| legacy ranking                                      | `compat-barrier.integration.spec.ts` ranking block         | flag-on variant                                                              |
| APPLIED / REJECTED preservation                     | `compat-barrier.integration.spec.ts` purge + re-collection | flag-on variant                                                              |
| trigger modes                                       | `compat-barrier.integration.spec.ts`, `due-policy.spec.ts` | flag-on variant of the integration case                                      |
| one-unit budget arithmetic                          | `compat-barrier.spec.ts`, budget contention/race specs     | flag-on variant; **plus** "a refused claim spends zero units"                |
| crash around legacy write / suggestion / checkpoint | none                                                       | new in S6d, flag-on only (section 2 table) — fault injection per crash point |

**Controlled inputs.** Every barrier case uses a fixed clock (the existing `NOW` constants) and
compares rows by **fingerprint and content**, never by generated `id`. Where an id must be fixed
(run, cycle), the spec passes it in through the existing `onlyIds` / seam pattern. A
`gen_random_uuid()` value is never asserted. The flag-on variant compares its row set and counts with
the flag-off result of the same fixture: **parity is the assertion**, not a second hand-written
expectation.

**Until S6d lands, the flag-on run is the same code**, so S6a's flag-on variant is green
trivially. That is the point: it is the harness. From S6c onward every slice must keep both
variants green, and the `it.todo` in the compat-barrier integration spec is replaced by real cases.

**Flag-off drain rule** (for rollback safety). Before an operator turns the flag off, they run
one manual DOU collection with the flag still on. Its T3/T4 drains every `PENDING` row. A runbook
line records it (S6g). If the flag is turned off with rows still pending, those suggestions wait
until the flag is on again. Nothing is lost — the rows are durable — but they are delayed.

## 5. Backfill (slice S7)

### Decision D-5 (confidence: **MED** — the shape is clear; the run-handle mechanics need a PoC in S7)

The S6 bridge feeds the observation store only for postings collected **after** the flag goes on.
S7 brings the existing `job_postings` DOU rows into the store. Each `job_postings` row becomes one
source record, keyed **by fingerprint**:

- **Explicit legacy namespace.** Records are written under a dedicated namespace (for example
  `legacy-job-postings`), never the live DOU namespace. Two consequences:
  - a backfilled record and a live one never collide by accident;
  - the link from a backfilled record to a live one is the cross-source identity machinery's job
    (Task 4.5 canonical store), not an overwrite.
- **Preserved, never rewritten:** `job_postings.id`, every `job_suggestions` row and its status
  (`NEW` / `APPLIED` / `REJECTED`), and the queue-v2 columns. S7 writes **only** to the store
  tables and to `job_bridge_deliveries`. It updates and deletes nothing in `job_postings` or
  `job_suggestions`.
- **No re-offer.** For each backfilled posting, S7 inserts the `LEGACY_POSTING` delivery row as
  `DONE` / `DUPLICATE` with the existing `posting_id`, and **no** suggestion row. A later live
  collection of the same item and version is then a no-op in T1, which is what today does for a
  known fingerprint.
- **Reruns reconcile only.** Every write is `ON CONFLICT DO NOTHING` on the store's natural keys
  and the delivery key. A rerun adds only the rows that are missing and reports counts
  `{ seen, created, alreadyPresent, refused }`. A row the observation validator refuses is
  counted and listed by fingerprint, not fixed.
- **Run handle.** `saveObservationPage` needs an owned run. S7 claims a `claimLegacyRun` run on the
  DOU source under a `MANUAL` cycle whose actor is the ADMIN who started it, in pages of at most
  `MAX_OBSERVATIONS_PER_PAGE`, with a checkpoint (last fingerprint) so a crash resumes. It is
  mutually exclusive with a live DOU run by the single-flight index. **PoC point:** whether a
  backfill run ending must also be neutral to `job_sources` (yes, by section 1's LEGACY branch), and
  whether the run lease survives a large page (it should: heartbeat per page).

**Its own risks.**

- It touches production data at volume, so it is critical-path and owner A3 (Q6).
- It is a long run inside the 05:00 window, so it must not run at 05:00: it would hold DOU's
  single-flight slot.
- Purge interaction: a posting purged while S7 runs cascades its delivery row away, so the
  backfilled record exists without a posting. That is harmless: the store keeps history, and a
  re-collection re-creates the posting.
- Dry-run first: `--dry-run` prints the counts and writes nothing.

## 6. Slice plan

### Decision D-6 (confidence: **HIGH** on order, **MED** on sizes)

Ordered so the barrier lands first. "Dark" means it ships with the flag off and changes nothing in
production. Every slice is its own PR on `origin/main`; each states `depends_on` in its task file.

| Slice   | What (files by symbol)                                                                                                                                                                                                                                 | AC (abridged)                                                                                                                                                                                                                                                                         | depends_on | Tier         | Critical path / security-review      | DDL / owner go                       | Ships dark?            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------ | ------------------------------------ | ------------------------------------ | ---------------------- |
| **S6a** | Flag `JOB_QUEUE_BRIDGE_ENABLED` in the env schema + `.env.example` (DevOps line); injected into `JobSourcingService`; the barrier suites parameterised flag off/on; the `it.todo` replaced by the harness                                              | (1) flag defaults off, parses like `JOB_MATCH_RECONCILIATION_ENABLED`; (2) every barrier case runs both ways and passes; (3) the off-branch makes no ledger / bridge call (recording double); (4) "a refused claim spends zero units" written as a pending case for S6d               | —          | sonnet       | budget path → **yes** (light, haiku) | none                                 | yes                    |
| **S6b** | Staged DDL file + Drizzle declaration of `job_bridge_deliveries` + `PRIVILEGE_CLASSES.A` / `STAGED_RELATIONS` + forward-DDL spec                                                                                                                       | (1) file applies twice, catalog == `db:push`; (2) every CHECK has a refusing case; (3) privileges spec green; (4) `check-prod-ddl-wiring.py` green                                                                                                                                    | —          | sonnet       | migration → **yes**                  | staged only, nothing to prod         | yes                    |
| **S6c** | `JobRunLedger.claimLegacyRun`; LEGACY branch in `account` (run row only) used by `finish` and `recoverExpired`; `JobSourceRunBusyError`; `write-gate.spec.ts` updated                                                                                  | (1) LEGACY claimed, REPORTING refused by `claimLegacyRun`, LEGACY still refused by `claimSource` / `claimDue`; (2) busy → typed stop; (3) finish / recovery of a LEGACY run leaves every `job_sources` column unchanged (real-DB); (4) epoch / lease / fencing as for reporting runs  | S6a        | **opus**     | run ownership → **yes**              | none (F5)                            | yes (nothing calls it) |
| **S6d** | `collectSource` flag-on branch: cycle, claim, `chargeBudget`, provider, T1 / T3 / T4 drains, `lastCollectedAt`, `finish` in a `finally`; `createSuggestions` and the per-row insert take a transaction executor; `collectAll` threads the MANUAL actor | (1) barrier parity flag on; (2) one fault-injection test per crash row of section 2; (3) a pending suggestion row from a crashed run is drained by the next run; (4) `createSuggestions` is never called with an empty list on a retry; (5) new sources never produce `LEGACY_*` rows | S6b, S6c   | **opus**     | budget + run ownership → **yes**     | needs the S6b table in test DBs only | yes (flag off in prod) |
| **S6e** | DOU `NormalizedPosting` → `SourceObservation` mapping (pure) + T2 store write, best-effort, counted on the run row                                                                                                                                     | (1) mapping golden over the DOU fixture; (2) a refused item is counted, never dropped from T1; (3) a T2 failure does not fail the run; (4) yield every 50 observations (benchmark, per plan)                                                                                          | S6d        | sonnet       | no (no money / RBAC)                 | none                                 | yes                    |
| **S6f** | DevOps: promote the DDL into `drizzle/manual/` + `deploy.yml` wiring (preflight list, SCP, single-tx apply before grants, privileges check)                                                                                                            | (1) the S0 checklist; (2) a dry deploy on scratch applies it once and reruns as a no-op                                                                                                                                                                                               | S6b        | sonnet       | prod DDL → **yes**                   | **A3 owner go (Q1)**                 | n/a (schema only)      |
| **S6g** | Runbook: flag-on / flag-off procedure (the flag-off drain rule), what to watch on the run rows; optional retention of old `DONE` rows                                                                                                                  | (1) runbook lines exist; (2) if retention is added, its SQL keeps `PENDING` rows                                                                                                                                                                                                      | S6d, S6f   | haiku (docs) | no                                   | none                                 | n/a                    |
| _flip_  | Owner sets `JOB_QUEUE_BRIDGE_ENABLED=true` in production                                                                                                                                                                                               | barrier green flag on in CI; S6f deployed; one manual DOU collection watched                                                                                                                                                                                                          | S6d–S6g    | —            | —                                    | **A3 owner (Q4)**                    | —                      |
| **S7**  | Backfill (section 5)                                                                                                                                                                                                                                   | idempotent rerun; ids / suggestions / statuses unchanged (checksums before / after); dry-run first                                                                                                                                                                                    | flip       | **opus**     | prod data → **yes**                  | **A3 owner (Q6)**                    | dry-run first          |

**Parallelism.** S6a and S6b share no files and may run as one wave of two. S6c waits for S6a,
because it relies on the harness. S6e and S6f may run in parallel after their dependencies.

## 7. Risks and owner questions

Classified per `autonomy-levels.md`. Prod DDL, prod data and a prod env change are critical-path,
so they are A3. Behaviour choices that are reversible by the flag are A2.

| #   | Question                                                                                                                                    | Level  | Recommendation                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Ship `job_bridge_deliveries` to production (S6f)?                                                                                           | **A3** | Yes, after S6d is merged and green flag-on in CI. The table is additive, class A, and read by nothing else.                                                         |
| Q2  | With the flag on, a second **concurrent** DOU collection is refused (`JobSourceRunBusyError`, zero units) instead of running twice. Accept? | A2     | Accept. It is stricter and costs nothing. Today two parallel runs race on the same fingerprints for no gain. Reversible by the flag.                                |
| Q3  | A failure of the new observation-store write (T2) does not fail the DOU run: it is logged and counted. Accept?                              | A2     | Accept while the store is dark (nothing reads it for the product). Revisit when a product reader of the store ships. Then T2 failure should become a `PARTIAL` run. |
| Q4  | Turn `JOB_QUEUE_BRIDGE_ENABLED` on in production?                                                                                           | **A3** | After S6f is deployed and S6g's runbook exists: turn it on, watch one manual collection, keep it on.                                                                |
| Q5  | DOU under the ledger keeps **no** failure cap and no backoff (run-row-only ending). Accept, versus adopting the cap?                        | A2     | Accept. It is the SR-M-17 guarantee: the only live feed cannot be capped out. Adopting the cap is a separate, later decision.                                       |
| Q6  | Run the S7 backfill on production data?                                                                                                     | **A3** | Yes, after the flip has been stable for a week: dry-run counts first, then the run, outside the 05:00 window.                                                       |

**Risks (not questions).**

- **R1 — a second code path to keep in parity.** Until the flag is retired, `collectSource` has two
  bodies. The barrier runs both, and that is the mitigation. Retire the off-branch in a follow-up
  once the flag has been on for a stable period. That follow-up should be named in S6g.
- **R2 — transaction count.** T3 / T4 take one transaction per row (about 50 a day). That is
  negligible at DOU's size. It is not a pattern for a 2 000-item board: such sources are reporting
  adapters and never touch this table.
- **R3 — drain is per source.** A crash delays suggestions to the next DOU run (≤ 24 h, or the next
  ADMIN click). If that delay is ever unacceptable, add a small sweep. The table already supports it.
- **R4 — the amended paragraph.** Readers of the run-ownership ADR may miss that SR-M-17 is now
  flag-conditional. S6c adds one line to that ADR's Amendments block pointing here (an Architect
  edit, docs-only).

## Consequences

- DOU gains a run row, epoch, lease and fencing with the flag on. Every bridge write is fenced.
  `job_sources` accounting for DOU stays exactly as today.
- Legacy suggestions survive crashes. The suggestion input becomes a recorded fact instead of an
  in-memory list. That closes the F2 loss, which exists today independently of the queue work.
- The observation store starts receiving the live feed, dark, without making the legacy product
  depend on it.
- Cost: one table, one ledger method, one `account` branch, and a second `collectSource` body
  behind a flag until retirement.

## Rollback

| Scope                 | Undo                                                                                                    | Expected state                                                            | Verify                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| This ADR              | close the PR, or `git revert <merge sha>`                                                               | docs only; no code or schema depends on it                                | `git show --stat <revert sha>` lists only this file                                                         |
| Behaviour (after S6d) | follow the flag-off drain rule (section 4), then set `JOB_QUEUE_BRIDGE_ENABLED=false` and redeploy      | DOU runs today's body; no new run rows for DOU                            | no `job_collection_runs` row for the DOU source after the next 05:00; barrier flag-off suite green          |
| A code slice          | `git revert` of that slice's squash commit                                                              | the previous slice's state; the flag still gates everything               | CI green on the revert; barrier both ways                                                                   |
| Schema (after S6f)    | section 3 "DDL rollback": drop the objects **and** revert the deploy wiring                             | table and types gone; deploy no longer applies the file                   | `SELECT to_regclass('public.job_bridge_deliveries')` returns NULL; next deploy log has no apply step for it |
| Backfill (S7)         | delete store rows in the legacy namespace and their `DONE` delivery rows (S7 ships this SQL, owner-run) | live namespace and every `job_postings` / `job_suggestions` row untouched | checksums of `job_postings` / `job_suggestions` equal to those recorded before S7                           |

## Sources

- Plan r5, Task 4.6 ("Compatibility barrier first", the bridge paragraph) and the contradiction rows
  C-02, C-05, C-06: `docs/superpowers/plans/2026-10-10-vacancy-sourcing-plan.r5.md`.
- Owner decisions D1 / D3 (2026-10-27), as relayed in the task brief for S6.
- Run ownership ADR and its 2026-10-26 Amendments (SR-M-17, SR-M-23, T7 AC 15, "Failure
  accounting"): `docs/architecture/2026-10-24-job-source-run-ownership.md`.
- Fetch-strategy ADR (DOU stays at 05:00 in `handleDailyCollection`):
  `docs/architecture/2026-10-25-source-fetch-strategy.md`.
- Code read on `origin/main` @ `221491a68`: `JobSourcingService.collectSource` / `collectAll` /
  `persistPostings` / `createSuggestions` / `chargeBudget`; `JobRunLedger.claimSource` /
  `claimDue` / `insertRun` / `finish` / `endRun` / `account` / `recoverExpired`; `claimGate`,
  `endingEffect`, `RunEndOutcome`; `assertOwned`; `saveObservations` / `saveObservationPage` /
  `chunkPage`; `COLLECTION_ERROR_CODES`; `PRIVILEGE_CLASSES`; the `JOB_MATCH_RECONCILIATION_ENABLED`
  env entry; the record-store DDL header (`2026-10-25_job_record_store.sql`) and the single-flight
  indexes `uq_job_collection_runs_one_started_per_source` / `_per_account`.
- Barrier state: PR #1154 (Task 4.6a), PR #1010 (golden fixtures); the `it.todo` "flag-on variant"
  in the compat-barrier integration spec.
- S0 deploy pattern: PR #1171.
- The codegraph MCP was not available in this session. The call graph was read with bounded
  `grep` / windowed reads instead; every symbol above was confirmed in the source.
