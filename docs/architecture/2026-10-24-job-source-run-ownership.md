# ADR: Job-source run ownership — hand-written Postgres claims vs `pg-boss` (Task 2.5)

## Status

**Proposed (2026-10-24).** Waiting for the owner to confirm the choice of A over B (A2, see
"Autonomy classification"). Companion research file: `2026-10-24-pg-boss-research.md`.

## Context — the measured facts

Plan r5, Task 2.5, requires PostgreSQL-backed run ownership and tells the implementer to compare the
hand-written version against `pg-boss` first. Four of phase 3's hardest defects were in hand-rolled
lifecycle arithmetic, so this comparison is a real one. Every fact below was re-measured on
`origin/main` at `d0f876f33` (2026-10-24), not copied from the brief. Each one is phrased so that a
`grep` for the named symbol confirms it (see "Verification").

**How the facts were obtained.** Codegraph MCP was not in this agent's tool set, so code facts come
from `grep` and reading files at that commit. Schema facts come from the Drizzle schema plus a
read-only `psql` session (`default_transaction_read_only=on`).

**Machine-local observations (not reproducible elsewhere; they support no conclusion on their own).**
On the author's machine on 2026-10-24, the local `crm_db` (docker-compose, PostgreSQL 16.15,
confirmed with `SELECT current_database(), version()`) held no user tables. So the column list was
read from a scratch database built from the migrations, `crm_scratch_manifest37`. Production was not
read. The reproducible source for every column named below is the committed DDL:
`git show origin/main:apps/api/drizzle/manual/2026-10-17_job_opportunities_store.sql`, plus the
Drizzle schema files.

### F1 — The service can reach only the legacy contract

`JobSourcingService` holds `providers: Map<JobSourceType, JobSourceProvider>`. Its constructor builds
that map from exactly one entry, `DouRssProvider`. `collectSource` looks the provider up, calls
`chargeBudget`, then calls `provider.collect(config)`, which returns `NormalizedPosting[]`. Every
phase-3 adapter implements the other contract, `ReportingJobSourceProvider`: `parseConfig(raw)` plus
`collectReport(config, ctx: CollectionContext) → CollectionBatch`. **No production path reaches a
reporting adapter.**

### F2 — No production code builds a `CollectionContext`

`CollectionContext` (in `providers/reporting-provider.ts`) carries these ports: `run`
(`{ sourceId, cycleId, attemptId, fencingEpoch }`), `policyVersion`, `signal`, `deadline`, `now`,
`secrets`, `fetchText`, `meter` (`reserve`, `markSent`, `reconcile`), `checkpoints`
(`load`, `savePage`) and `cache`.

Exactly two code paths build one from nothing, and both are test helpers:
`test/fake-collection-context.ts` and `test/quota-harness.ts`. One production function returns a
`CollectionContext` without being a producer: `withSecrets` in `providers/sources/quota-provider.ts`
spreads a context it is given and adds secrets. The only production implementation behind any port
is the 3.5a meter store, `createAccountMeter` in `metering/account-meter.store.ts`.

**`markSent`: the port method and its main call site both exist already (Task 3.5b).** The call site
is in the adapter loop, not the transport. `collectJsonPages` in `api-json.provider.ts` sets
`markSentStarted`, then awaits `ctx.meter.markSent(reservation)` immediately before
`ctx.fetchText(request)`. If `markSent` rejects, the reservation is reconciled `RELEASED` and the
failure is reported as `PERSISTENCE`, because nothing left the process.

**The gap that remains is the one the store header names:** a caller that reaches `fetchText`
without going through that loop. There is one such caller today. The SmartRecruiters adapter's
detail request reserves through `ctx.meter.reserve`, then calls `ctx.fetchText` directly with
**no `markSent`**. Run `git grep -n 'ctx.fetchText(' origin/main -- apps/api/src ':!*.spec.ts' ':!apps/api/src/test/**'` and
you get exactly two call sites: `collectJsonPages` and the SmartRecruiters adapter. Under recovery
(Option A), a `RESERVED` row is read as "never sent", so that path is unsafe once a ledger exists.
T7 owns closing it.

`transportOptionsFor` and `boundedFetchText` exist in `http/bounded-fetch.ts`, and production calls
neither. That is why every adapter's declared `maxBytes` is inert today (backlog 319; PR #1138 SR-M-2).

### F3 — The ownership columns exist, and nothing writes them

| Table                 | Ownership columns                                                                                                                                                           | Uniqueness the database enforces                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job_collection_runs` | `owner_token` (bounded text), `fencing_epoch` (bigint, default 1, `> 0`), `lease_expires_at`                                                                                | `uq_job_collection_runs_running_owner`: one `STARTED` row per **(source_id, config_version)**; `uq_job_collection_runs_attempt`: (source_id, attempt_id) |
| `job_dirty_work`      | `claim_owner`, `claimed_at`, `lease_expires_at`, `fencing_epoch`, `retry_count`                                                                                             | `uq_job_dirty_work_entity_target`; a CHECK pairs `CLAIMED` with owner + lease                                                                            |
| `job_sources`         | none: `next_attempt_at`, `cooldown_until`, `consecutive_failures`, `last_attempt_at`, `last_success_at`, `last_nonempty_at`, `readiness`, `admin_state`, `account_meter_id` | —                                                                                                                                                        |

`ck_job_collection_runs_running_has_lease` makes a `STARTED` run require an owner token and a lease.
The schema comment on `fencing_epoch` calls monotonicity a worker obligation: "a worker writes only
while its epoch is still the greatest for this source". So **the epoch is stored per run row, and its
ordering is meant per source**. No sequence, trigger or constraint relates one run's epoch to another
run's.

Outside the schema, its specs and the Zod shapes in `packages/shared` (`jobCollectionAttemptSchema`
and its worker-internal sibling carry `ownerToken` and `fencingEpoch`), the epoch appears only as the
type on the port and the literal `1` in the test fake. `owner_token` and `lease_expires_at` are read
or written by no production code.

Two consequences that the brief does not state:

- **The running-owner index is per `(source, config_version)`, not per source.** A config bump
  therefore lets a second `STARTED` run of the same source coexist with the first. This is deliberate
  (the comment says a run under a new config "does not contend with a stale running one"), but it
  means **"one active fetch per source" is not enforced by the database today**. Task 2.5 has to
  supply it.
- **Nothing enforces "one active fetch per account."** Two sources can share one `account_meter_id`
  (one paid account, several boards), and they have no common lock.

### F4 — The 3.5a store's exclusivity is a caller precondition, and a test pins its violation

The `createAccountMeter` header states it as a **caller precondition (SR-H-1)**: at most one live
executor per `attemptId`. The store's replay walk returns a `RESERVED` row as "never sent". That
reading holds only if the executor that took the row is gone. The integration spec
`account-meter.store.integration.spec.ts` contains the characterisation case
"TWO live executors of one attempt SHARE a reservation — the precondition, measured". It records 4
units leaving the account while 2 are charged. **Task 2.5 must make that case fail and replace it**
with an assertion that both executors are charged for what they spend, or that the second one is
refused. The header also says why folding the constant epoch `1` into the reservation key would only
look like fencing.

### F5 — Production DDL and the least-privilege role

From ADR `2026-10-17-db-least-privilege-roles.md` and its generated SQL (`2026-10-18_db_roles.sql`,
`_db_grants.sql`, `_db_privileges_check.sql`):

- The API connects as `crm_app`. That role is `NOSUPERUSER NOCREATEDB NOCREATEROLE` and has `CONNECT`
  on the database. `REVOKE ALL ON DATABASE … FROM PUBLIC` leaves it **no `CREATE` on the database**, so
  it cannot `CREATE SCHEMA`. On `public` it has `USAGE` only (`REVOKE CREATE ON SCHEMA public FROM
PUBLIC`).
- Table privileges are **per relation, generated from a manifest** (`privilege-classes.ts`). No default
  privilege on `TABLES` is granted.
- `deploy.yml` applies the DDL as the migration role (`crm_user`, a superuser on production) with
  `psql -v ON_ERROR_STOP=1`, from an explicit, ordered list of `apps/api/drizzle/manual/*.sql` files.
- The catalog check (part 7) **fails the deploy if `crm_app` owns any relation or any schema**. Its
  relation and grant parts inspect `public` only.

### F6 — Precedent already in the repository

`OutboxRepository.claimDue` (`notifications/notification-email.repository.ts`) claims work with
`UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` and uses a lease column. Its SQL is proven
against real Postgres by `notification-email-delivery.integration.spec.ts`. It has no fencing epoch.
Hand-written `SKIP LOCKED` claims are therefore **already the house pattern**, with a real-database
spec style that a new claim can copy.

### F7 — The cron has no time zone yet

`JobSourcingCronService.handleDailyCollection` is `@Cron('0 5 * * *')` with no `timeZone`, and it
calls `collectAll()` directly. The plan's target is that handlers **only enqueue due work**, both with
`timeZone: 'Europe/Kyiv'`.

### F8 — Ordering constraints carried in

Backlog 318 is **Open** on `origin/main` at `d0f876f33`. The JSON reader counts nodes only after
`JSON.parse`. The brief says a parallel PR is closing it. Until that PR merges, the transport-wiring
task below must not start (§ Decomposition, task T6).

## Option A — hand-written claims on Postgres

One module, the **run ledger** (working name `JobRunLedger`), is the only writer of the ownership
and scheduling columns (see "Who writes which column" below). Every operation is a short
transaction, and none holds a lock across network I/O.

**Scope, after review round 5.** The owner's goals are narrow:

- a handful of **free** sources;
- no runaway spend on a paid API;
- stop when banned;
- never lose or double-count spend.

Round 5 deleted every mechanism these goals do not need, because each one had opened a hole in its
neighbour. "What round 5 deleted" at the end of this section lists each deletion and what the owner
loses by it.

**Rules every operation follows:**

- **Isolation is pinned to `READ COMMITTED`**, explicitly on each transaction. Two arguments below
  depend on it: a blocked `FOR UPDATE` re-evaluates its predicate after the lock is released, and a
  statement after a conflicting insert takes a fresh snapshot.
- **The clock is the database's.** No operation takes an application `now`. Every time comparison is
  written in SQL with `clock_timestamp()`, including the pause read: a timestamp is never returned to
  TypeScript and compared there. Specs move time by **aging stored timestamps** through helpers in
  `src/test/` (`ageRun`, `ageHostPause`). The only injected clocks are on the pure TypeScript side:
  `isDue`, `readinessAt`, and the cron expression.
- **One source per claim transaction.** A refused or conflicting source rolls back, or commits only
  its refusal record, and the loop moves on. Locks are never accumulated across sources.
- **One active run per host.** `claimHostSlot` refuses a claim while any `STARTED` run exists on a
  source with the same `host_key`, checked under the host-row lock. Adapters issue their subrequests
  one at a time. So at most one request is in flight per host at any moment (see "Stop-on-ban").

**The complete lock-acquisition table** (round 5, SR-M-10). Every operation, every table it touches
and every lock it takes, in order. The global order is:
`job_sources` → `job_source_hosts` → `job_account_meters` (by `id`) → `job_collection_runs` →
`job_account_meter_reservations` → page tables (by natural key). Each row takes an ordered subset of
it. "Read" means a plain `SELECT` with no row lock.

| Operation (task)                      | Transactions      | Locks, in order                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openCycle` (T3, called by T5)        | 1                 | `INSERT` one `job_collection_cycles` row. No existing row is locked.                                                                                                                                                                                                                                         |
| `claimDue` / `claimSource` (T3)       | 1 per source      | `job_sources` 1 row (`FOR UPDATE SKIP LOCKED`; for `claimSource`, `FOR UPDATE` with `lock_timeout`) → `job_source_hosts` 1 row (`INSERT … ON CONFLICT DO NOTHING`, then `SELECT … FOR UPDATE`) → read the host's `STARTED` runs → `INSERT` 1 `job_collection_runs` row (it may wait on a unique-index entry) |
| `heartbeat` (T3)                      | 1                 | `job_collection_runs` 1 row (`UPDATE`)                                                                                                                                                                                                                                                                       |
| `readHostPause` (T8, called by T7)    | 1                 | read only                                                                                                                                                                                                                                                                                                    |
| `recordHostBan` (T8, called by T7)    | 1                 | `job_source_hosts` 1 row (`INSERT … ON CONFLICT DO NOTHING`, then `UPDATE`). `pause_source_id` is a **plain column with no foreign key**, so no lock is taken on `job_sources`.                                                                                                                              |
| `reserve` (meter store)               | 1                 | `job_account_meters` 1 row (`lockMeter`) → `job_collection_runs` 1 row (`assertOwned`, `FOR UPDATE`) → `INSERT` 1 reservation                                                                                                                                                                                |
| `markSent`, `reconcile` (meter store) | 1                 | `job_account_meters` 1 row → `job_collection_runs` 1 row (`assertOwned`) → 1 reservation (`FOR UPDATE`)                                                                                                                                                                                                      |
| `savePage` (T3)                       | 1                 | `job_collection_runs` 1 row (`assertOwned`) → page tables, rows written in ascending natural-key order (`namespace`, external id), so two runs whose records overlap lock them in the same order                                                                                                             |
| `finish` (T3)                         | 1                 | `job_sources` 1 row → `job_account_meters`, the account's whole set by `id` (`lockAccountMeters`) → `job_collection_runs` 1 row (ownership predicate) → the run's reservations (`FOR UPDATE`, by `id`)                                                                                                       |
| `recoverExpired` (T3)                 | 1 per run         | the same as `finish`, with the expired-run predicate in place of the ownership predicate                                                                                                                                                                                                                     |
| `sweepOrphanReservations` (T3)        | 1 per reservation | read the run (terminal outcomes are final) → `job_account_meters` 1 row → the reservation (`FOR UPDATE`)                                                                                                                                                                                                     |
| `resetFailures` (T9)                  | 1                 | `job_sources` 1 row                                                                                                                                                                                                                                                                                          |

There is no cycle. Every row's locks are an ordered subset of the global order. The claim's insert
can wait only on another transaction's uncommitted `STARTED` row (a claim, `finish` or recovery), and
none of those needs a lock the claim holds, so that wait is one-directional.

The table fits on one page, which is the round-5 test of whether the design is small enough. T3's
concurrency case runs **every row of this table** together (T3 AC 6).

**Operations.** The ownership predicate, written once and used verbatim by `heartbeat`,
`assertOwned` and `finish`:

```sql
id = $run AND owner_token = $owner AND fencing_epoch = $epoch
AND outcome = 'STARTED' AND lease_expires_at > clock_timestamp()
```

- **`claimDue(limit, owner)`** is the scheduled path, specified under "Claiming". **`claimSource(sourceId,
owner)`** is the manual path. It runs the same steps for one named source, drops the cadence term
  and nothing else, and runs with `SET LOCAL lock_timeout` (round 5, SR-L-16). On a timeout or a
  refusal it returns the reason to the caller, without waiting behind a `finish`.
- **`heartbeat(run, owner, epoch)`:** `UPDATE job_collection_runs SET lease_expires_at =
clock_timestamp() + L WHERE <ownership predicate>`. If zero rows change, the worker aborts its
  `signal` with `RUN_FENCED`.
- **`assertOwned(tx, run, owner, epoch)`:** `SELECT 1 … WHERE <ownership predicate> FOR UPDATE`. It
  is called first in `savePage`, and inside `reserve`, `markSent` and `reconcile` after the meter
  lock. No row means the transaction rolls back with `RUN_FENCED`.
- **`finish(run, owner, epoch, outcome, errorCode)`:** under the ownership predicate, it **settles the
  run's open reservations** (see "End-of-run settlement"), makes the terminal transition, and writes
  `job_sources` per "Failure accounting". It does **not** write a host ban; only the transport does
  that (see "Stop-on-ban").
- **`recoverExpired()`** reads candidates (`outcome = 'STARTED' AND lease_expires_at <
clock_timestamp()`) without locking. Then, one transaction per run, it locks as the table says,
  re-checks the run under its lock, and skips it if the run changed. It runs the end-of-run
  settlement and marks the run `FAILED` / `LEASE_EXPIRED`. It is called by each daily handler
  (T5) and once at worker start (T7).
- **`sweepOrphanReservations()`:** any `RESERVED`, `SENT` or `UNCERTAIN` reservation whose run is
  terminal is settled by the end-of-run rules, one reservation per transaction. This is a backstop to
  `finish` and recovery, called by each daily handler.
- **`openCycle(trigger)`** creates the cycle row that the runs of one handler invocation reference,
  and nothing else.
- **`resetFailures(sourceId, actor, reason)`** (called by T9) sets `consecutive_failures = 0` and
  `cooldown_until = NULL`, and appends `{ kind: 'RESET_FAILURES', actor, at, reason }` to
  `admin_state_history`. `at` is `clock_timestamp()`, and `reason` is bounded text.

**Why this makes F4 false.** The meter binding gains `ownerToken` and calls `assertOwned` inside its
own transaction. A second live executor of the same `attemptId` holds a different token, or the
superseded epoch, so its `reserve` and `markSent` are refused before anything leaves the process.
Recovery and `markSent` lock the same run row, so they serialize. Either `markSent` commits `SENT`
first, and recovery settles it as spent, or recovery commits first and `markSent` re-evaluates
`assertOwned` and is refused, so nothing is sent. A `RESERVED` row of a fenced-out or finished run
is therefore provably unsent, which is why the end-of-run settlement may release it.

**Every way a run ends.** `finish` and recovery are the only transitions out of `STARTED`.

| Ended by                                                                   | Outcome     | Error code                                                                       |
| -------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------- |
| `finish`: success                                                          | `SUCCEEDED` | none                                                                             |
| `finish`: a designed stop                                                  | `PARTIAL`   | `PAGE_CAP`, `COST_STOP` or `DEADLINE`                                            |
| `finish`: stopped by a host pause it did not cause                         | `PARTIAL`   | `HOST_PAUSED`                                                                    |
| `finish`: adapter or transport error                                       | `FAILED`    | the adapter's code, for example `ACCESS_POLICY`, `PARSE_DRIFT` or `CURSOR_CYCLE` |
| `finish`: shutdown while the lease is still held                           | `CANCELLED` | `CANCELLED`                                                                      |
| recovery: lease expired (crash, fence, a shutdown that could not `finish`) | `FAILED`    | `LEASE_EXPIRED`                                                                  |

A fenced-out worker cannot `finish`; recovery ends its run. Every row settles its open reservations
by the same rules.

**End-of-run settlement** (round 5: replaces `UNCERTAIN` as a durable state, SR-M-11, CONTRA-5).
When a run ends, by `finish`, recovery or the sweep, each of its open reservations is settled under
the locks in the table, through `planSettlement`, by a store function `settleRunReservations(tx,
runId)`. That function is not `reconcile`. It asserts no live run; it requires instead that the
caller holds the run row as being made terminal, or that the run is already terminal (the sweep).

| Open state  | Settles to                      | Why                                             |
| ----------- | ------------------------------- | ----------------------------------------------- |
| `RESERVED`  | `RELEASED`                      | provably unsent (see "Why this makes F4 false") |
| `SENT`      | `USED`, at the full reservation | it may have been billed; count it as spent      |
| `UNCERTAIN` | `USED`, at the full reservation | the adapter could not tell; count it as spent   |

Spend is therefore never lost and never double-counted. A request whose cost is unknown is counted
once, at its reservation, which is the overcount direction. **No `UNCERTAIN` hold outlives its run**,
so no resolver, no age constant and no manual settle exist. A hold from a past window settles into
that window's record and not into the current window's `used`, which is the store's existing
rollover rule.

The account's meter rows are locked by a new store helper, `lockAccountMeters(tx, accountKey)`. It
runs `SELECT … WHERE account_key = $1 ORDER BY id FOR UPDATE` and applies `lockMeter`'s lazy window
roll to each row (round 5, SR-M-10 item 5; `lockMeter` itself returns one row).

The run's `account_key` is read before the locks. It is written once at insert and never updated,
so the unlocked read is exact. Every reservation of the run is on one of those rows, because T7
builds the binding from the run's `account_key` and refuses a window from another account. A
`reserve` racing the end of a run meets it at the meter row: either `reserve` commits first and its
reservation is settled, or it later re-evaluates `assertOwned` against a terminal run and is
refused.

Today `reserve` writes `runId: binding.runId`, which is caller input. T3 changes it to the id of the
row that `assertOwned` locked.

**Claiming.** `claimDue(limit, owner)` runs at most `MAX_CLAIM_SCAN` candidate transactions per call
(a config value with a ceiling) and carries the ids it has already tried in `$tried`. Each
transaction does the following:

1. **Pick.** `SELECT … FROM job_sources s WHERE <due predicate> AND s.id <> ALL($tried) ORDER BY
s.next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1`.
2. **Gate, on the locked row** (round 5, SR-H-5). Each check below is a refusal with a recorded
   reason, never an exception:
   - the `manifest_id` resolves to a manifest entry (`MANIFEST_ENTRY_MISSING`);
   - **the registry says the type is activatable at the database clock.** That is T2's activation
     check, the same one the activation query uses, so an owner decision without captured evidence
     stays refused even when `enabled` is true (`NOT_ACTIVATABLE`);
   - `readinessAt(entry, DB clock)` permits a run (`READINESS_BLOCKED`);
   - **the adapter declares a non-empty `allowedHosts`** (`TRANSPORT_NOT_WIRED`; round 5, SR-M-16). No
     adapter declares one until T6 lands, so no reporting source can be claimed before the transport
     caps exist;
   - a type whose manifest declares a quota has a non-NULL `account_meter_id` (`METER_MISSING`).
3. **Host slot.** T8's `claimHostSlot(tx, host_key)` locks the host row and refuses:
   - while `paused_until > clock_timestamp()` (`HOST_PAUSED`);
   - while any `STARTED` run exists on the host (`HOST_BUSY`);
   - inside the per-minute gap, or over the daily count, for a type that declares `hostRate`.
4. **Insert** a new `job_collection_runs` row: a new `attempt_id`, a fresh `owner_token`,
   `fencing_epoch = COALESCE(max(fencing_epoch) for this source, 0) + 1`,
   `lease_expires_at = clock_timestamp() + L`, the `account_key` (Option A, "One active fetch per
   account"), and the checkpoint chosen by "Crash resume". A 23505 from a single-flight index rolls
   back this source only.
5. **Commit**, before any I/O.

**A refusal never stays at the head of the queue.** The refused source joins `$tried`. On the
scheduled path its refusal is also committed, in the same transaction:

- **Persistent refusals** set `last_error_code` and push
  `next_attempt_at = clock_timestamp() + REFUSAL_RECHECK`.
- **Host refusals** set `next_attempt_at` to when the slot opens: `paused_until`, the end of the
  gap, or the end of the 24 h window.
- **`HOST_BUSY` sets nothing.** The source simply waits for the host's active run to end, and a later
  claim in the same handler's collection window (T5) picks it up.

A refusal never touches `consecutive_failures`. A manual refusal is returned to the caller and moves
nothing.

**The due predicate** (T4 owns the scalar terms, T8 the host term, T3 the "already running" term):

```sql
s.enabled
AND s.admin_state = 'ACTIVE'                 -- round 5, SR-H-5: PAUSED and RETIRED are never due
AND s.manifest_id IS NOT NULL                -- no manifest entry: never due
AND s.host_key IS NOT NULL                   -- written first, so the NOT EXISTS below cannot fail open
AND s.next_attempt_at <= clock_timestamp()   -- cadence; claimSource drops this term and only this term
AND (s.cooldown_until IS NULL OR s.cooldown_until <= clock_timestamp())   -- failure backoff
AND s.consecutive_failures < $maxConsecutiveFailures
AND NOT EXISTS (SELECT 1 FROM job_source_hosts h
                 WHERE h.host_key = s.host_key AND h.paused_until > clock_timestamp())
AND NOT EXISTS (SELECT 1 FROM job_collection_runs r
                 WHERE r.outcome = 'STARTED'
                   AND (r.source_id = s.id OR r.account_key = <s's account key>))
```

**A manual trigger skips the cadence term and nothing else.** The gates in step 2, the host slot, the
cooldown, the cap and a running run all refuse a manual run too. `enabled` alone never makes a
source claimable (CONTRA-3): `admin_state` and T2's activation check must both agree.

**DOU, the one live source, stays on the legacy path, entirely outside the ledger** (round 5,
SR-M-17, CONTRA-4). DOU implements the legacy `JobSourceProvider` contract. Its `job_sources` row
keeps `host_key = NULL`, so it is never due, never claimed and never recovered. The legacy cron path
(`collectAll` → `collectSource` → `provider.collect`) runs it exactly as today, from the 05:00
handler. So the host-pause rule, the failure cap and the ledger do **not** apply to DOU. That is the
explicit exception, and the earlier "uniform ban rule" wording is withdrawn. **What the owner
loses:** DOU keeps today's per-run stop behaviour and no cross-run pause. That is acceptable for one
public RSS feed, and it guarantees the only live feed cannot be capped out by a ledger it does not
heartbeat into. T7 AC 15 pins DOU's golden outcomes.

**Crash resume (round 5, SR-M-15: simplified).** The checkpoint stays on the run row, and `savePage`
writes a page's observations and its checkpoint together under `assertOwned`. So a run's
`checkpoint` column always holds its last durable position. A new run copies the checkpoint of the
source's **latest** run (greatest `fencing_epoch`) if that run:

- has the same `config_version`;
- did not succeed;
- did not end `CURSOR_CYCLE`, the only error that means the cursor itself is bad.

Otherwise the run starts fresh. A successor that failed before its first page still carries the
inherited checkpoint in its own row, so a transient failure does **not** lose the cursor. An
unusable cursor already ends with a `RESTART` position, which `decideCheckpoint` turns into `FRESH`.

The loop then calls the existing `decideCheckpoint(stored, current)`. Its outcomes are `FRESH`,
`RESUME`, and `RESTART_WITH_OVERLAP` on an unparsable copy or a `policyVersion` / `adapterVersion`
mismatch. `validatedCheckpointSchema` only parses the shape.

**The re-spend bound:** a crash re-pays at most the page in flight. Its reservation is settled as
spent, and the successor fetches the page again. The one exception is a policy or adapter version
change between the crash and the resume, which re-reads the overlap by design.

No age rule and no clock comparison decide the copy, so a single clock is not even needed here.

**Failure accounting (round 5, SR-H-4, SR-M-14: by how the run ended, not by "progress").**

| Run ended                                                                                            | `consecutive_failures` | `cooldown_until`                         | `next_attempt_at`                                      |
| ---------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------- | ------------------------------------------------------ |
| `SUCCEEDED`                                                                                          | 0                      | cleared                                  | now + cadence                                          |
| `PARTIAL`: `PAGE_CAP`, `DEADLINE` or `HOST_PAUSED`                                                   | unchanged              | unchanged                                | now + cadence                                          |
| `PARTIAL`: `COST_STOP`                                                                               | unchanged              | unchanged                                | the later of now + cadence and the meter's `resets_at` |
| `CANCELLED` (shutdown)                                                                               | unchanged              | unchanged                                | now + cadence                                          |
| `FAILED`, **any** code, including `ACCESS_POLICY`, `PARSE_DRIFT`, `CURSOR_CYCLE` and `LEASE_EXPIRED` | +1                     | `clock_timestamp() + backoff(n)`, capped | now + cadence                                          |

"now" is `clock_timestamp()`, and the cadence is `min_interval_hours`, floored by T8.

**No ending schedules an immediate re-claim.** A deterministic error is therefore a failure whatever
the run persisted before it, and it reaches the cap after `MAX_CONSECUTIVE_FAILURES` runs.

`MAX_CONSECUTIVE_FAILURES` is **3**, a constant with a ceiling of 5, counted over consecutive runs
with no time window (round 5, SR-L-15). A source whose own requests are refused with 403 reaches
the cap the same way, and it never re-pauses its host more than once per pause (see
`recordHostBan`). The backoff lives in `cooldown_until`, which a manual trigger does not skip. A
capped source leaves the cap only through T9's recorded reset.

**Stop-on-ban (rounds 4–5, SR-H-3, SR-M-13, SR-M-14).**

- **The ban is written only by the transport, at the moment it is observed.** T7's `fetchText`
  wrapper catches the transport's typed refusals (`SourceBlockedError` for 403 and
  `SourceRateLimitedError` for 429, in `http/source-errors.ts`; 451 is added by T6 once it surfaces
  the status). On either, it calls T8's `recordHostBan` before rethrowing. `finish` does not write
  bans, so a run that merely obeyed a pause cannot extend it.
- **`recordHostBan` is monotone, not idempotent** (round 5, CR-L-6, CONTRA-1).
  - It sets `paused_until = GREATEST(paused_until, clock_timestamp() + HOST_BAN_PAUSE)`.
  - A repeat call from the **same** source while that source's pause is still active is a no-op, so
    one source cannot keep re-extending its host's pause.
  - `HOST_BAN_PAUSE` is the largest of three values: 24 hours, the longest `minIntervalHoursFloor` on
    the host, and a parsed `Retry-After`. It is capped at `HOST_BAN_PAUSE_MAX` (30 days).
  - `Retry-After` is parsed as finite and non-negative, in both its seconds and HTTP-date forms, and
    capped. Anything else is ignored.
- **Every request and every heartbeat checks the pause.** `readHostPause` returns a boolean
  computed in SQL, `paused_until > clock_timestamp()`, and is never cached in process. T7 calls it
  in its `markSent` wrapper before each request: a paused host means the call rejects with
  `HOST_PAUSED` and nothing is sent. It also calls it after each heartbeat: a paused host means the
  run's `signal` is aborted with `HOST_PAUSED`. A run stopped this way ends `PARTIAL` /
  `HOST_PAUSED`, which counts as neither a failure nor a ban.
- **The real bound.** At most one run is active per host (`HOST_BUSY`), and an adapter issues its
  subrequests one at a time. So at most one request per host is in flight when a refusal arrives:
  the refused request itself. After the ban commits, every check sees it. The slip window is the
  refused request's own round trip, and it involves no other request.

**Lease, heartbeat and page writes (SR-L-9).** The heartbeat interval is `H ≤ L / 3`. A page-write
transaction runs with `SET LOCAL statement_timeout` and `lock_timeout` so that it ends within `H`.
Heartbeats use a reserved connection, so the pool size is `N + 1`. A heartbeat delayed by one page
write still lands at least `L − 2H ≥ H` before expiry. `L` also exceeds the per-request timeout plus
the pool's acquire timeout.

**One active fetch per source, per account and per host.** The due predicate's last term covers the
source and the account. `HOST_BUSY` covers the host. Partial unique indexes over
`outcome = 'STARTED'`, on `source_id` and on `account_key`, are the backstop.

`account_key` is the meter's text `account_key`, read through `account_meter_id`, or
`'#source:' || source_id` for an unmetered source. **`#` can never occur in a real meter key:**
`ck_job_account_meters_account_key_format` enforces `JOB_PUBLIC_ID_PATTERN`,
`^[a-z0-9][a-z0-9._:-]{0,99}$`. A type whose manifest declares a quota but has a NULL meter fails
closed at claim step 2.

T1 was dispatched with this key as a `uuid` of the meter row. A meter row is one `(account_key,
unit, window_kind)`, so that `uuid` did not identify the account. The correction (T1b) is folded into
T1's migration (see T1b).

**Who writes which column** (T3's write gate, AC 7, enforces it; `*.spec.ts` and `src/test/**` are
excluded):

| Column(s)                                                                                                                                                                                                                                | Only writer                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `job_collection_runs`: `owner_token`, `fencing_epoch`, `lease_expires_at`, `started_at`, `outcome`, `ended_at`, `error_code`, `checkpoint`, `account_key`, the counts                                                                    | the ledger (T3), including `savePage`                                         |
| `job_sources`: `next_attempt_at`, `cooldown_until`, `consecutive_failures`, `last_attempt_at`, `last_success_at`, `last_nonempty_at`, `last_error_code`, `last_error_message`, and the `RESET_FAILURES` entries of `admin_state_history` | the ledger (T3); T9 only calls `resetFailures`                                |
| `job_sources.host_key`                                                                                                                                                                                                                   | T8's generated seed delta                                                     |
| `job_source_hosts`: every column                                                                                                                                                                                                         | T8's host-state module (`recordHostBan`, `claimHostSlot`)                     |
| `job_account_meters` counters, `job_account_meter_reservations`                                                                                                                                                                          | the meter store (`reserve`, `markSent`, `reconcile`, `settleRunReservations`) |

These indexes and T8's host table are the only DDL Option A needs. All of it is additive or
corrective, in `public`, changes no privilege, and goes through `deploy.yml`.

**What round 5 deleted, and what the owner loses by each:**

- **The one-minute ledger tick.** Recovery now runs from each daily handler and at worker start.
  _Loss:_ a crashed run is recovered at the next handler or the next boot, not within a minute.
- **Immediate re-claim ("next attempt = now" after progress) and the notion of "progress".**
  _Loss:_ a crawl interrupted mid-way resumes at its next cadence, not the same day.
- **`UNCERTAIN` as a state that outlives its run, `settleStaleUncertain`, `UNCERTAIN_MAX_AGE` and
  T9's manual settle.** _Loss:_ a request the provider did not actually bill is still counted as
  spent. This is an overcount, never an overspend.
- **The checkpoint age rule, the "produced by that run" rule and the ADMIN-reset rule.** _Loss:_ a
  checkpoint the provider has since expired is tried once and fails as a counted failure, rather
  than being skipped up front.
- **T9's host-wide `clearHostPause`, and the audit store it needed.** _Loss:_ a pause recorded by
  mistake lifts only on expiry (24 hours by default, at most 30 days).
- **`finish` writing bans.** _Loss:_ none. The transport has already written the ban, at the moment
  it saw it.

**Bounded worker pool.** An in-process semaphore of size `N` per API process. The claim's `LIMIT` is
the free slots, never more. `N`, `L`, the heartbeat interval and the per-run deadline are config
values with ceilings, frozen after MP-05.

**Cost of A** (estimate, not measured; revised in round 4). The ledger, `recoverRun` and the host
state are together about 700–1,000 lines, plus real-Postgres specs. Four review rounds grew it from
a first estimate of 300–450, and the growth is the honest measure of the problem's size. The
arithmetic A owns:

- the lease predicate and the epoch increment;
- the recovery and `finish` settlements;
- the refusal write-back and the failure-accounting table;
- the checkpoint-copy rule;
- the due-time computation (cooldown, cadence, readiness).

Due time, the host state, the checkpoint rule, the failure accounting and both settlements would be
needed under Option B too, because pg-boss provides none of them (Option B, "What pg-boss does not
give").
The precedent `OutboxRepository.claimDue` (F6) already covers the claim half, and the house has a
real-Postgres spec style for it.

**Strongest argument against A.** Phase 3's worst defects were hand-rolled lifecycle arithmetic.
Option A adds more of that arithmetic, in the most concurrency-sensitive place in the feature.

## Option B — `pg-boss`

All external facts in this section are in `2026-10-24-pg-boss-research.md`, where each is cited to the
npm registry, the shipped tarball of `pg-boss@12.38.0`, or
[pgboss.io/api/constructor](https://pgboss.io/api/constructor), all retrieved 2026-10-24. Only the
facts that decide the comparison are repeated here.

**What it is.** `pg-boss` 12.38.0 (2026-10-13), MIT, one npm maintainer, 77 releases in the 12.x line
in 11 months. `engines.node` is `>=22.12.0`, which our Node 22 pin satisfies. The package is
**ESM-only** (`"type": "module"`), while `apps/api` compiles to CommonJS with
`moduleResolution: Node`. The `types` field and `require(esm)` on Node 22.12 should make that work.
That is **unproven here**; a spike must show `nest build` output and Vitest both loading it.

**How it would be used.** One queue, `job-source-run`, with policy `singleton` and
`singletonKey = sourceId`, gives one active job per source. Group concurrency 1 with
`group.id = account key` gives one active job per account. The cron calls `send` for each due source.
Workers call `work` with `heartbeatSeconds`. Expiry and retries belong to pg-boss's supervise pass.

**Production DDL, concretely.** `crm_app` has no `CREATE` on the database or on `public`, and the
catalog check fails the deploy if it owns any schema or relation (F5). So pg-boss **cannot install
itself in production**. The only workable path:

1. Run `getConstructionPlans('pgboss')` at the pinned version and commit its output as
   `apps/api/drizzle/manual/<date>_pgboss_v46.sql`. Add the file to `deploy.yml`'s ordered list,
   where `crm_user` applies it.
2. Add a grants file for `crm_app` on schema `pgboss`: `USAGE`, per-table DML, `EXECUTE` on the
   functions it calls, and sequences. The exact set is not documented. It has to be derived from
   `dist/plans.js` and proven by a `crm_app` integration run.
3. Extend the generated catalog check, which inspects `public` only, to cover `pgboss`. Otherwise the
   least-privilege ADR's guarantee silently stops at the new schema.
4. Construct the client with `migrate: false`, `createSchema: false`, `persistQueueStats: false`,
   and only `partition: false` queues. That avoids the two runtime DDL paths the research found.
   `start()` then throws `requires migrations` whenever the database's schema version differs from
   the library's.
5. **Every `pg-boss` bump that moves the schema version** repeats steps 1–3 with
   `getMigrationPlans`, and the migration must land before the image. The schema version went from
   40 to 46 between 2026-09-03 and 2026-10-13. Exact pin, deliberate bumps only.

**The fencing epoch, which the plan says to keep.** pg-boss fences **its own** settle calls. Every
claim after the first increments `retry_count`, and `complete`, `fail` and `touch` match on
`id:retry_count` (upstream's "attempt fence", issue #925). That fence is invisible to our tables. A
page write into `job_source_records` or a checkpoint into `job_collection_runs` cannot be refused by
it, unless the write transaction reads `pgboss.job`, coupling our hottest write path to a
third-party schema that changes six times in 40 days. To meet the plan, Option B therefore **still
writes `owner_token`, `fencing_epoch` and `lease_expires_at` on `job_collection_runs`**, and still
runs `assertOwned` in every page write and meter call. That is Option A's fencing core, plus a
second lease (pg-boss's heartbeat) that must agree with ours.

**"Check every `send` result".** `send` returns `Promise<string | null>`. `null` means nothing was
inserted: a singleton or policy conflict, or a throttle. Checking means three things. Treat `null` as
"this source was not enqueued". Record that as the cycle's outcome for the source (`ALREADY_OWNED` or
`THROTTLED`), never as a dispatched run. Assert in a spec that a second `send` for a source with an
active job returns `null` and leaves exactly one job. A `send` that throws is an enqueue failure of
that source alone; it must not abort the cycle (C-23).

**What pg-boss does not give.** It does not recover our meter reservations (`RESERVED → RELEASED`,
`SENT → UNCERTAIN`), and it does not resolve `UNCERTAIN` holds. It does not evaluate readiness through `readinessAt`, cooldown, cadence,
`min_interval_hours`, or the host-level stop-on-ban across sources. It provides no epoch check on
our writes, and it does not keep `job_sources` state (last success versus last non-empty). All of
that is hand-written under either option.

**Bounded review of the new dependency.** Besides `pg-boss` itself, its dependency tree has ten
names: `pg`, `cron-parser`, `luxon`, `rrule-temporal`, `temporal-spec`, `serialize-error`,
`non-error`, `type-fest` (major 5), `tagged-tag`, and the peer `@opentelemetry/api`. Counted against
`pnpm-lock.yaml` on `origin/main`, **8 packages are new**: `pg-boss`, `cron-parser`,
`rrule-temporal`, `temporal-spec`, `serialize-error`, `non-error`, `type-fest` 5 and `tagged-tag`.
`type-fest` 5 would sit beside the already-locked `0.16.0`.

- **Not new:** `pg` and `luxon` 3.7.2 are already locked.
- **The peer:** `@opentelemetry/api` is not installed automatically. The lockfile is version 5.4
  (pnpm 7), there is no `.npmrc` turning on `auto-install-peers`, and the peer has no
  `peerDependenciesMeta` marking it optional. So it would be a **ninth** explicit addition, or a
  standing peer warning.

The round-1 fact-check counted 7. It stopped at `type-fest` and did not follow it to `tagged-tag`;
`type-fest` 5.x depends on `tagged-tag ^1.0.0` (research file). To re-derive the count, run
`git show origin/main:pnpm-lock.yaml | grep -n -E '^  /(luxon|type-fest|tagged-tag|@opentelemetry/api|pg-boss|cron-parser|rrule-temporal|temporal-spec|serialize-error|non-error)/'`.
On `d0f876f33` it prints only `/luxon/3.7.2` and `/type-fest/0.16.0`.

**Licences are not uniform.** Most packages are MIT, but `temporal-spec` is **Apache-2.0** and
`type-fest` is `(MIT OR CC0-1.0)`. The `pg-boss` tarball has no install hook (research file). Release cadence is high (14 releases between 2026-09-17 and 2026-10-13) and there is one
maintainer. That makes the upgrade policy an exact pin, a Renovate ignore, and a reviewed bump with
its migration file. The package would need its own row in `version-pins.md`.

**Strongest argument for B.** Claim, expiry, retry with backoff, singleton enforcement and attempt
fencing are battle-tested, years-old code paths with a large user base. The brief says that
"four of this phase's hardest defects were in hand-rolled lifecycle arithmetic" (Task 2.5 brief),
and that arithmetic was written by us. Upstream's own attempt fence exists because of
[issue #925](https://github.com/timgit/pg-boss/issues/925), a stale `complete()` settling a newer
attempt, which is the same shape of defect we guard against. The issue was opened 2026-09-23 and
closed 2026-09-24 (GitHub API, retrieved 2026-10-24), so the fix came after 12.30.0 (2026-09-03).
That cuts both ways. The library is actively maintained. But a stale-settle defect lived in its
12.x claim path until a month before this ADR, which weakens "battle-tested" for exactly the
property we need.

## Decision

**Option A: hand-written claims, in one run-ledger module, with a real multi-worker Postgres spec
for every transition. `pg-boss` is not adopted.**

### The comparison ("design it twice")

The deletion test asks: if we delete pg-boss from Option B, what complexity has to reappear in our
code?

| Concern                                                        | A writes it         | B: pg-boss gives it                 | B: we still write it                       |
| -------------------------------------------------------------- | ------------------- | ----------------------------------- | ------------------------------------------ |
| Claim with `SKIP LOCKED`                                       | yes (precedent F6)  | yes                                 | —                                          |
| Lease expiry detection                                         | yes                 | yes                                 | **and ours** (our lease fences our writes) |
| Retry and backoff                                              | yes, small          | yes                                 | cooldown and cadence anyway                |
| One active run per source / per account                        | yes, plus 2 indexes | singleton plus group concurrency    | the DB backstop is still advisable         |
| Owner token and epoch fencing **our** page and meter writes    | yes                 | **no** (it fences only its own row) | **yes, all of it**                         |
| Recovery of `RESERVED`/`SENT` reservations                     | yes                 | no                                  | yes                                        |
| Due time, readiness, cooldown, ban pause, `min_interval_hours` | yes                 | no                                  | yes                                        |
| Its own schema, grants, catalog check, migration per bump      | —                   | —                                   | **new, permanent**                         |
| Two leases that must agree (theirs and ours)                   | —                   | —                                   | **new**                                    |

The hard part of Task 2.5 is fencing our own writes and recovering our own reservations, and pg-boss
does not provide it (**confidence HIGH**: read from its shipped SQL, F-research "Ownership
semantics"). What it removes is the part the repository already has a working precedent for (F6).
What it adds is permanent: a second schema under the least-privilege regime, a deploy-applied
migration on each schema-version bump (six in 40 days), an unproven ESM-in-CommonJS load
(**confidence MED**; needs a spike), and two leases that must agree. Option B is shallower than it
looks. Its interface is larger than the part of the problem it solves.

**The rejected option's strongest argument, stated fully.** The brief records that "four of this
phase's hardest defects were in hand-rolled lifecycle arithmetic". pg-boss's claim, expiry, retry
and singleton paths have years of production use behind them, and adopting it would take that
arithmetic out of our hands. **Answer:** the brief does not list those four defects, so this ADR
does not claim to know which arithmetic they were. What the brief does name is the lifecycle
arithmetic this task must still write. Its facts 3 and 4 are an inert fencing epoch and two
executors sharing one reservation. Under the plan's requirement to keep the epoch, both stay ours
under either option: pg-boss fences only its own job row (Option B). Option A
limits that risk by **locality** instead: one module is the only writer of the ownership columns
(enforced by the write gate, T3 AC 6), and every transition has a real-Postgres multi-worker case.
That is the verification bar the brief sets anyway.

**When to reopen.** If a later task needs features pg-boss does well and we lack (DAG flows, cron
with rrule, dead-letter queues across many job types), reopen it for that work, not for run
ownership. Also reopen if `apps/api` moves to `module: node16`.

### Autonomy classification (`autonomy-levels.md`)

- **The choice of A over B is A2.** The ADR is reversible (one PR), but redoing an implemented
  ledger is expensive. The **owner** confirms, in the phase's decision brief.
  **Before the owner answers, T1, T1b, T2, T4 and T8 can start.** None of them consumes the ledger, and
  each is needed under either option. T3 is the ledger itself. T7 and T9 consume it. T5 and T6 depend on
  T7, and under B T5's cron would call `send` instead of the ledger. So T3, T7, T9, T5 and T6 all
  wait for the answer.
- **T1's migration** (two partial unique indexes and an `account_key` column) is a Drizzle migration
  in a critical-path zone. It goes through the normal full pipeline with a mandatory
  security-reviewer. It changes no privilege. So do **T1b** (the account-key correction) and **T8**
  (the host table).
- **Had the recommendation been B, it would be A3.** B adds a schema and new grants to `crm_app`
  under the least-privilege ADR, and that ADR's text is the owner's. The owner would decide before
  any code.

## Consequences

- **No new dependency.** `version-pins.md` is untouched. The ESM question does not arise.
- **The least-privilege boundary stays where the least-privilege ADR drew it.** The only DDL is
  additive or corrective (T1b), in `public`, and arrives through the existing manual-migration path.
- **The ledger becomes a critical module.** Its tests are the proof of exclusivity. The 3.5a
  characterisation case is deleted and replaced, not adjusted (F4).
- **Lifecycle constants (`L`, heartbeat interval, `N`, per-run deadline) are config with
  ceilings**, frozen after MP-05, as the plan requires.
- **A single API process** is today's deployment. The design does not assume one: two processes
  claiming concurrently is the first case in T3's spec (replica overlap, from the plan's test list).
- **Cost:** about 700–1,000 lines of ledger, recovery and host-state code (estimate, revised in round 4; see "Cost of A"). In exchange there is no external schema to
  keep in step on every upgrade.

## Decomposition of Task 2.5

Ten tasks plus one external prerequisite. Three were added in review: T8 in round 1 to store the
host-level state, T1b in round 3 to correct T1's account key, and T9 in round 4 for the ADMIN exits. T1's and T2's sections are left exactly as
dispatched. Files are named by module and symbol. Path fragments are
given only where a file does not exist yet. "Real-Postgres" means an integration spec against a
scratch database, never `crm_db` (`live-db-access.md`), and **run as `crm_app`** wherever the claim
is about privileges. That matches the least-privilege ADR's finding that specs run as `crm_user`
prove nothing about `crm_app`.

### Order and parallelism

Every arrow below is one entry of a task's own "Depends on" line, and there are no other arrows.
`A ──► B` means B depends on A.

```
T1 migration ──┬──────────────────────────────────────► T3 run ledger
               └──► T1b account key ──┬───────────────► T3
                                      └──► T8 host state ──► T3
T2 registry ──► T4 due policy ──┬─────────────────────► T3
                                └──► T8
T2 ────────────────────────────────────────────────────► T7 context + worker
T3 ────────────────────────────────────────────────────► T7
T8 ────────────────────────────────────────────────────► T7
T3 ────────────────────────────────────────────────────► T9 ADMIN controls
T8 ────────────────────────────────────────────────────► T9
T7 ──┬──► T5 cron
     └──► T6 transport wiring
T0 (backlog 318, parallel PR — external) ──────────────► T6
```

**Self-check: each task's "Depends on" line against the arrows.**

| Task | Its "Depends on" line                                | Arrows into it            |
| ---- | ---------------------------------------------------- | ------------------------- |
| T1   | nothing                                              | none                      |
| T2   | nothing                                              | none                      |
| T1b  | T1                                                   | T1 → T1b                  |
| T4   | T2 (sequencing only: both edit `JobSourcingService`) | T2 → T4                   |
| T8   | T1b, T4                                              | T1b → T8, T4 → T8         |
| T3   | T1, T1b, T4, T8                                      | T1, T1b, T4, T8 → T3      |
| T7   | T2, T3, T8                                           | T2 → T7, T3 → T7, T8 → T7 |
| T9   | T3, T8                                               | T3 → T9, T8 → T9          |
| T5   | T7                                                   | T7 → T5                   |
| T6   | T0, T7                                               | T0 → T6, T7 → T6          |

Sixteen arrows and sixteen dependency entries, one for one.

- **Wave 1, in parallel:** T1 and T2. Their file sets are disjoint: the run-table schema plus a
  migration, versus the registry plus `JobSourcingService`'s `providers` map and constructor.
- **Wave 2, in parallel:** T1b, after T1 merges, and T4, **after T2 merges**. Their file sets are
  disjoint (a run-table column plus a migration, versus a new scheduling module plus
  `JobSourcingService`). T4 waits for T2 because T4 edits `JobSourcingService` too: `collectAll`'s
  signature, and it moves `sourceAcceptsTrigger` out. The two touch different regions of one file,
  so a textual conflict is likely, and they are serialized rather than run in parallel. T2 is
  already running, so T4 is dispatched once T2 is on `main`.
- **Wave 3:** T8. It is the third migration, so it lands after T1b (all three append to
  `deploy.yml`'s ordered list), and it extends T4's due predicate.
- **Wave 4:** T3, which needs T1's and T1b's indexes, T4's due predicate and T8's host state.
- **Wave 5, in parallel:** T7, which needs T2's registry, T3's ledger and T8's host reads, and T9,
  which needs T3 and T8. Their file sets are disjoint: the runtime module, the service and the
  adapters, versus the controller plus one ledger function and one host-state function.
- **Wave 6, in parallel:** T5 and T6. Their file sets are disjoint: the cron file, versus `http/`,
  the context builder's `fetchText` and adapter host lists. **T6 also waits for T0** (backlog 318).
  Constraint (a): no `transportOptionsFor` wiring before 318 is fixed.
- **Not parallel:** T2 with T4 (both edit `JobSourcingService`); T1, T1b and T8 with each other
  (three migrations, one file list); T3 with T7 or T9 (both consume the ledger's interface); T2 with
  T5 (both edit `JobSourcingModule`); and T7 with T6 (both edit `buildCollectionContext`'s
  `fetchText`, so T6 follows T7).
- **May start before the owner answers the A-versus-B question:** T1, T1b, T2, T4 and T8 (see
  "Autonomy classification").

### T0 — backlog 318: parse-order fix in the shared bounded-JSON reader (prerequisite, not part of 2.5)

Being closed by a parallel PR. Listed only as T6's gate. **Verification that it is done:** entry 318
is marked closed in `BACKLOG-followups.md` on `origin/main`, and the reader refuses an over-cap body
before `JSON.parse` is entered (its own spec).

### T1 — ownership indexes (migration)

- **Files:** the Drizzle schema (`job-collection.ts`, `jobCollectionRuns`); a new
  `apps/api/drizzle/manual/<date>_job_run_single_flight.sql`; the ordered file list in `deploy.yml`
  (a DevOps-zone line, so the dispatch names it); the privileges manifest, if the new column needs a
  grant class entry.
- **Change:** add `account_key uuid NOT NULL` to `job_collection_runs`. It is backfilled from
  `job_sources.account_meter_id`, or from `source_id` when that is null. No production code writes runs yet (F3), so the backfill is expected to touch no rows; the migration must still handle rows rather than assume none.
  Add a partial unique index on `(source_id) WHERE outcome = 'STARTED'` and another on
  `(account_key) WHERE outcome = 'STARTED'`. Keep `uq_job_collection_runs_running_owner`.
- **Depends on:** nothing.
- **AC:** (1) both indexes exist after the migration; (2) a second `STARTED` row for the same source
  under a different `config_version` is refused with 23505; (3) a second `STARTED` row for a
  different source sharing one meter is refused; (4) a terminal row does not contend; (5) the
  catalog check still passes, and `crm_app` gets no new privilege.
- **Real-Postgres:** the three refusals, each in its own transaction, plus the catalog check run as
  the migration role.
- **Model:** opus (Drizzle migration). **security-reviewer mandatory.**

### T2 — registry seam

- **Files:** `JobSourcingService` (its `providers` map and constructor); a new
  `job-sourcing/registry/` module (`JobSourceRegistry`, `LegacyDouAdapter`); `JobSourcingModule`; the
  manifest consumer of activation; the `*_OWNER_DECISION` constants in `providers/owner-decisions.ts`.
- **Carries:** one adapter per type, with duplicates rejected **at startup** (throw). DOU stays
  wrapped in an explicit legacy adapter (plan A1h / C-20). There is one registry, and the
  `providers` map is deleted rather than kept beside it. There are no optional constructor arguments
  that change the production pipeline. **Only readiness-approved adapters register for
  activation.** **Evidence is not permission** (PR #1139): a source permitted by owner decision but
  with no captured payload registers as not verified and is not activated by `enabled` alone.
  **`SMARTRECRUITERS_OWNER_DECISION` is `Object.freeze`d** (#1139 delta LOW 1), and so are its four siblings (HN, Remotive, Jobgether, Workable; none is frozen on `d0f876f33`), so a mutated
  decision cannot leave an adapter armed.
- **Depends on:** nothing.
- **AC:** (1) a duplicate type throws at module init; (2) DOU's golden outcomes are unchanged
  (`dou-golden` specs pass untouched); (3) an unverified-evidence source is reported
  `NOT_VERIFIED` and is never returned by the activation query; (4) mutating the frozen decision
  throws in strict mode; (5) `grep` shows no `new Map<JobSourceType` left in the service.
- **Real-Postgres:** none needed beyond the existing DOU integration spec, which must stay green.
- **Model:** sonnet, medium.

### Follow-up notes for the dispatched T1 and T2

T1 and T2 were dispatched from their sections above, and those sections are not edited. Two
findings concern them. Each is routed so that it reaches the task without changing its text:

- **T1 → T1b** (round 3, SR-M-3): the account key. See T1b below and its fold rule.
- **T2 → a fix item for T2's review round, or a one-line follow-up if T2 has merged** (round 4,
  SR-L-12). T2 freezes the five `*_OWNER_DECISION` objects, but each manifest type's
  `ownerDecisions` **array** in `manifest.definitions.ts` stays mutable. A pushed or spliced decision
  would change what `readinessAt` derives at runtime. The arrays get `Object.freeze`, and T2's AC 4
  extends to them.

### T1b — correct T1's account key (follow-up migration)

Added in review round 3 (SR-M-3), because T1 was already dispatched from its current text and that
text is left unchanged. The defect and the correct key are described under Option A, "Defect in T1
as dispatched".

- **Files:** the Drizzle schema (`jobCollectionRuns.account_key`); a new
  `apps/api/drizzle/manual/<date>_job_runs_account_key_text.sql`; its line in `deploy.yml`'s ordered
  list (a DevOps-zone line, so the dispatch names it); the privileges manifest only if a class
  changes.
- **Change:** `account_key` becomes `text NOT NULL`. It is backfilled from
  `job_account_meters.account_key` through `job_sources.account_meter_id`, or from
  `'#source:' || source_id` when the source has no meter. The `#` prefix cannot occur in a real
  meter's key (Option A, SR-L-6). The partial unique index on `(account_key) WHERE outcome =
'STARTED'` is rebuilt over the new column.
- **Fold rule (round 4, CR-L-4).** If T1 has **not** merged when T1b would be dispatched, T1b is
  folded into T1's next review round as fix items, and T1b is not dispatched separately. If T1
  **has** merged, T1b is a separate task after it, as the waves show. Either way, T8 waits for the
  corrected key.
- **Depends on:** T1.
- **AC:** (1) two sources of one paid account, bound to different unit rows of that account's
  meters, cannot both hold a `STARTED` run (23505); (2) two sources of different accounts can;
  (3) the backfill writes the meter's `account_key` for a metered source and `'#source:<id>'` for an
  unmetered one, and a second application changes nothing; (4) the catalog check passes, and
  `crm_app` gains no privilege.
- **Real-Postgres:** one case per AC.
  - AC 1: one refusal (23505).
  - AC 2: one permission.
  - AC 3: the backfill applied twice over a seeded mix of metered and unmetered sources.
  - AC 4: the generated catalog check run after the migration, against the same database.
- **Model:** opus (Drizzle migration). **security-reviewer mandatory.**

### T3 — run ledger (the core of this ADR)

- **Files:**
  - a new `job-sourcing/ownership/` module, `JobRunLedger`, with `claimDue`, `claimSource`,
    `heartbeat`, `assertOwned`, `savePage`, `finish`, `recoverExpired`, `settleStaleUncertain`,
    `sweepOrphanReservations`, `openCycle` (called by T5's daily handlers), and the ledger
    functions T9's ADMIN actions call (`resetFailures`);
  - `createAccountMeter` and `AccountMeterBinding`. They gain `ownerToken` and call `assertOwned` inside
    `reserve`, `markSent` **and `reconcile`**, after the meter lock and before the reservation lock;
  - a new store function `recoverRun(tx, runId)`, also used by `finish` for its open reservations;
  - `reserve`, which writes `run_id` from the asserted run row, not from `binding.runId`;
  - `COLLECTION_ERROR_CODES` in `providers/reporting-provider.ts`;
  - the 3.5a integration spec's characterisation case (AutoTest zone; Master assigns that edit);
  - the aging helpers in `src/test/` (`ageRun`, `ageHostPause`, `ageReservation`) that specs use
    to move time.
- **New error codes (one owner).** `COLLECTION_ERROR_CODES` is a closed list in `apps/api`, not in
  `packages/shared`, and `job_collection_runs.error_code` is checked only for its `UPPER_SNAKE`
  shape, so the new codes need no migration.
  - **T3 adds all three in one edit: `RUN_FENCED`, `LEASE_EXPIRED` and `NOT_MARKED_SENT`.** T3 raises
    the first two. T7 raises `NOT_MARKED_SENT` but does not edit the list.
  - The claim's refusal reasons (`MANIFEST_ENTRY_MISSING`, `READINESS_BLOCKED`, `METER_MISSING`,
    `HOST_PAUSED`, `HOST_RATE_GAP`, `HOST_DAILY_CAP`) are written to `job_sources.last_error_code`,
    not to a run, so they are not run error codes. T3 defines them as a separate closed list.
- **Carries:** everything Option A specifies for the ledger:
  - the rules (`READ COMMITTED`, the DB clock, the lock order, one source per claim transaction);
  - "Claiming", including the bounded scan, the refusal write-back and the unresolvable manifest id;
  - the due predicate's "already running" term, by source and by T1b's account key;
  - `claimSource`, the manual path, which drops the cadence term only;
  - `recoverRun`'s five statements;
  - `finish` settling open reservations, and `sweepOrphanReservations`;
  - "Crash resume": the predecessor by `fencing_epoch`, `CHECKPOINT_MAX_AGE`, scope, and "produced
    by that run";
  - "Failure accounting";
  - "Who resolves `UNCERTAIN`", the automatic half;
  - `fencing_epoch = COALESCE(max, 0) + 1`;
  - "Who writes which column".

  `finish` calls T8's `recordHostBan` and `claimDue` calls T8's `claimHostSlot`. The policy behind
  each, and its acceptance criteria, are T8's. The run's **error code** is a `COLLECTION_ERROR_CODES`
  value, and its **outcome** is one of `job_collection_outcome`'s values (`STARTED`, `PARTIAL`,
  `SUCCEEDED`, `FAILED`, `CANCELLED`).

- **Depends on:** T1 (source index), T1b (corrected account index), T4 (the due predicate's scalar
  terms), T8 (host state).
- **AC:**
  1. The SR-H-1 characterisation case **fails first**, and is then replaced by an assertion that a
     second executor's `reserve`/`markSent` is refused with `RUN_FENCED`, and that spend equals
     charge.
  2. A stale owner's `savePage` after recovery is refused, and the successor's pages are intact.
  3. A `markSent`/recovery race ends in exactly one of {`SENT`→`UNCERTAIN`, `markSent` refused},
     never in a request that is both sent and released.
  4. A heartbeat with a wrong epoch changes nothing.
  5. The epoch strictly increases across successive runs of one source, and the first run's epoch
     is 1.
  6. **Write gate:** a check that fails when any file outside the module named in "Who writes which
     column" writes one of that table's columns. It excludes `*.spec.ts` and `src/test/**`.
  7. A fenced-out executor's `reconcile` is refused with `RUN_FENCED`, and leaves the row as
     recovery set it.
  8. After recovery, the expired run is `FAILED` / `LEASE_EXPIRED`, its `RESERVED` rows are
     `RELEASED` and its `SENT` rows `UNCERTAIN`. The next claim is a different row, whose `started_at`
     is later than the recovered run's.
  9. `RUN_FENCED`, `LEASE_EXPIRED` and `NOT_MARKED_SENT` are members of `COLLECTION_ERROR_CODES`.
  10. **Crash resume:** a run that crashes after page `k` is durable is followed by a run that starts
      at page `k + 1`. The fixture server sees each of pages `1..k` exactly once and page `k + 1`
      at most twice, and the meter's `used` plus `uncertain` equals the pages served times the
      per-page cost.
  11. **Failure cap:** after `MAX_CONSECUTIVE_FAILURES` consecutive no-progress failures, the source
      is claimed by neither path. Only T9's recorded ADMIN reset clears it; a successful run clears
      the counter only below the cap.
  12. **`recoverRun` counters:** for a run holding one `RESERVED` and one `SENT` reservation of
      amount `a`, recovery lowers `reserved` by `2a` and raises `uncertain` by `a`, and `used` is
      unchanged.
  13. **`settleStaleUncertain`:** an `UNCERTAIN` hold whose `sent_at` is older than
      `UNCERTAIN_MAX_AGE` becomes `USED` at the full amount and is never `RELEASED`, and a hold from
      a past window does not raise the current window's `used`.
  14. A claim refuses a metered type with a NULL `account_meter_id`, a source whose `readinessAt`
      blocks it, and a `manifest_id` that resolves to no entry. None of these consumes a slot, and
      none throws.
  15. **No head-of-line starvation:** with a persistently refused source at the head of the queue
      and a claimable source behind it, one `claimDue` call claims the second source. The refused
      source's `next_attempt_at` moves forward, and its `last_error_code` names the reason.
  16. **`finish` with an open reservation:** a run that finishes while holding one `RESERVED` and
      one `SENT` reservation leaves `reserved` lowered by both amounts and `uncertain` raised by the
      `SENT` amount. `sweepOrphanReservations` does the same for a reservation whose run is already
      terminal.
  17. **Failure classes:** a `COST_STOP` or `PAGE_CAP` run leaves `consecutive_failures` unchanged;
      a run that persisted one page and then hit `LEASE_EXPIRED` resets it to 0; a no-progress
      `PARSE_DRIFT` increments it and sets `cooldown_until`; and `claimSource` is refused inside
      that cooldown.
  18. **Checkpoint copy:** a cursor the provider rejects (the run fails before any page) is copied
      to the next run once and not to the run after it. A predecessor older than
      `CHECKPOINT_MAX_AGE`, or older than the latest ADMIN reset, is not copied.
- **Real-Postgres:**
  - N concurrent claimers (N ≥ 4, two pools, the "replica" case) against one due source get exactly
    one claim;
  - a crash after page `k` is persisted (kill between `savePage` and `finish`, recover, re-claim),
    with the **request count asserted at the fixture server** (AC 10);
  - `MAX_CONSECUTIVE_FAILURES` failures in a row, then a scheduled and a manual claim (AC 11);
  - `recoverRun` with counter values (AC 12);
  - **a `reserve` in flight during `recoverRun`** on a run whose account has two unit meters
    (`REQUEST` and `RECORD`): either the reservation is settled by recovery, or the `reserve` is
    refused with `RUN_FENCED`. No reservation is left `RESERVED` on a terminal run;
  - the refused head row followed by a claimable row (AC 15);
  - `finish` with open reservations (AC 16);
  - the failure-class table (AC 17);
  - the poison cursor (AC 18);
  - stale-owner writes;
  - bounded attempts at the limit and one past it;
  - **two claim loops, one `recoverExpired`, one `settleStaleUncertain` and a stream of
    `reserve`/`markSent` calls, concurrently, for 1,000 iterations, with no deadlock**, which
    exercises the lock order.

  Time is moved by the aging helpers, never by an injected clock. All cases run as `crm_app`.

- **Model:** opus, high. **security-reviewer mandatory** (meter, money-adjacent).

### T4 — due policy (pure, plus one query)

- **Files:** a new `job-sourcing/scheduling/` module (`isDue`, `dueSourcesPredicate`); the existing
  `sourceAcceptsTrigger` (moved, not rewritten); `JobSourcingService.collectAll`'s signature.
- **`onlyTypes` / `excludeTypes` are NEW, not moved.** They exist in no code on `d0f876f33`
  (`git grep -n -E 'onlyTypes|excludeTypes' origin/main -- apps/api/src` finds nothing). They appear
  only in the superseded 2026-10-04 plan. The r5 plan says to "keep" them, which reads as if they
  already existed. T4 introduces them, because T5's two schedules (05:00 API, 02:30 HTML) need them:
  each handler selects its own type set.
- **Carries:** due = persisted `next_attempt_at` / `cooldown_until` + enabled + **readiness from
  `readinessAt(subject, clock)`, never the stored `job_sources.readiness` column** (PR #1132
  SPEC-L-2 / SR-M-2) + trigger policy. The scalar terms of "The due predicate" (Option A) are T4's:
  `enabled`, `manifest_id IS NOT NULL` (**no manifest entry, never due**), `next_attempt_at`,
  `cooldown_until`, and `consecutive_failures < MAX_CONSECUTIVE_FAILURES`. **A manual trigger skips
  the cadence term and nothing else.** A host pause is not cadence. Neither are a cooldown,
  readiness, entitlement, cost, a missing meter, the failure cap or a current owner, so each of them
  refuses a manual run too. `enabled` is administrative permission. Pause, health, reason and state
  history are separate, and an ADMIN enable never clears an unresolved policy or credential block.
  The host-level conditions (ban pause, request rates, the `min_interval_hours` floor) are **T8's**,
  and the "already running" term is **T3's** (it needs T1b's account key). T4's predicate takes both
  as inputs. `cooldown_until` also carries the failure backoff, which T3 writes; T4 only reads it.
- **Depends on:** T2 (sequencing only: both edit `JobSourcingService`; T4 starts after T2 merges).
- **AC:** (1) a seeded `CANDIDATE` source past `RECRUITEE_TOKEN_DEADLINE` is not due even though its
  stored column still says `CANDIDATE`; (2) a manual run under cooldown or cost block is refused with
  a reason; (3) the legacy 10-minute early-due slack never overrides quota or cooldown;
  (4) `collectAll` with `onlyTypes` runs no source outside the set, and with `excludeTypes` runs
  none inside it; (5) a row with `manifest_id IS NULL` is never due, by schedule or by manual
  trigger; (6) a row at `MAX_CONSECUTIVE_FAILURES` is never due; (7) a manual trigger is due exactly
  when the scheduled predicate minus the cadence term is true.
- **Real-Postgres:** the due query over a seeded mix, compared against the pure `isDue` over the same
  rows. The mix includes enabled and disabled rows, a cooled-down row, a deadline-crossed row, a
  row with no manifest entry, a row at the failure cap, and a manual trigger on each.
- **Model:** sonnet, medium.

### T8 — host-level state: stop-on-ban and request rates (migration)

Added in review round 1 (CR-M-2, CR-M-3). Nothing on `d0f876f33` can store a host-level fact.
`job_sources` has no host or pause column
(`git show origin/main:apps/api/src/database/schema/job-sourcing.ts | grep -n -i -E 'host|pause'`
finds only comments). The per-source `cooldown_until` cannot express "board B is paused because board
A was banned" without writing a sibling row the ledger does not own. The Remotive adapter's own
header states that pacing between its entries "belongs to the scheduler (Task 2.5)". T1 was already
dispatched with a fixed scope, so the storage is a new task rather than a larger T1.

- **Files:** the Drizzle schema (`job-sourcing.ts`): a new table `job_source_hosts` (`host_key`
  text primary key, `paused_until`, `pause_reason`, `pause_source_id`, `last_claimed_at`) and a
  `job_sources.host_key` column; a new `apps/api/drizzle/manual/<date>_job_source_hosts.sql`; its
  line in `deploy.yml`'s ordered list (a DevOps-zone line, so the dispatch names it); the privileges
  manifest (`privilege-classes.ts`, a class for the new table); a per-type host-rate declaration in
  the manifest (`hostRate: { perMinute, perDay }`, a new manifest field); a new
  `job-sourcing/scheduling/host-state.ts` (`recordHostBan`, `claimHostSlot`, `hostOpenPredicate`,
  `readHostPause` (the lock-free read T7 uses), and `clearHostPause` (called by T9)); the
  seed-delta generator `manifest.seed-sql.ts` (a new generated delta file for the backfill).
- **Pause duration (round 4, SR-H-3).** `recordHostBan(hostKey, reason, sourceId, retryAfter?)`
  writes `paused_until = GREATEST(paused_until, clock_timestamp() + HOST_BAN_PAUSE)`. Here
  `HOST_BAN_PAUSE` is the largest of three values: 24 hours, the longest `minIntervalHoursFloor` of
  any type on the host, and `retryAfter`. It is capped at `HOST_BAN_PAUSE_MAX`, which is 30 days, a
  named constant. A write never shortens a pause. Only expiry or T9's recorded ADMIN clear lifts
  one.
- **Who writes and who reads.** The ledger's `finish` (T3) calls `recordHostBan` in its terminal
  transaction when the run's **error code** (a `COLLECTION_ERROR_CODES` value, not a run outcome)
  is `ACCESS_POLICY` or `RATE_LIMIT`. The run's outcome is then `FAILED` or `PARTIAL`. The ledger's
  `claimDue` (T3) calls `claimHostSlot`, which, **on the locked host row**, refuses the claim:
  - if `paused_until > clock_timestamp()` (round 3, SR-H-1). The due `SELECT` may run on a snapshot
    older than a ban's commit, so the pause is re-read here, under the lock that `recordHostBan`
    also takes. A claim racing a ban therefore sees it;
  - if it is inside the per-minute gap;
  - if it is over the daily count.

  A manual trigger goes through the same `claimHostSlot`. The daily count is computed from
  `job_collection_runs.started_at` for the host's sources in the trailing 24 h, so no counter can
  drift. T4's `dueSourcesPredicate` is extended with `hostOpenPredicate`.

  Two more callers (round 4, SR-H-3). T7's `fetchText` wrapper calls `recordHostBan` on 403 and
  429 (and on 451 once T6 surfaces the status), and T7's `markSent` wrapper and heartbeat loop call `readHostPause`, a lock-free
  read. T9 calls `clearHostPause`. Only this module writes `job_source_hosts`.

- **(a) How `host_key` is derived and backfilled.** The value is the request host the adapter
  contacts. The manifest gains a per-type `requestHost(config)` function, for example
  `api.smartrecruiters.com` for every SmartRecruiters board and `remotive.com` for every Remotive
  category, so sources that share a host share a key. DOU's legacy entry gets `jobs.dou.ua`, so the ban
  rule is uniform.
  - The column is added **nullable**, because a migration cannot run manifest code. The backfill is
    a **new generated seed-delta file**, produced by `manifest.seed-sql.ts` in the same style as
    Task 3.7's: one dollar-quoted `jsonb` literal read through `jsonb_to_recordset`, then
    `UPDATE job_sources SET host_key = … WHERE manifest_id = … AND host_key IS NULL`. It is
    idempotent and never overwrites a value. It is applied by `deploy.yml` after the migration.
    Every later generated seed delta that **inserts** a source row sets `host_key` in the same
    insert, so a new source is never left on a NULL key.
  - A row with no `manifest_id` (an unclaimed legacy row) keeps `host_key = NULL`.
    `hostOpenPredicate` is written as `s.host_key IS NOT NULL AND NOT EXISTS (…)`, with the null
    test **first**. A bare `NOT EXISTS (… h.host_key = s.host_key …)` is TRUE for a NULL key and
    would fail open. `claimHostSlot` refuses a NULL key explicitly, rather than letting a
    primary-key error abort the claim.
  - The manifest's drift test asserts that every manifest entry yields a non-empty host and that the
    generated delta sets it.
- **(b) How the host row exists before it is locked.** `claimHostSlot` runs inside `claimDue`'s
  transaction and does two statements. First,
  `INSERT INTO job_source_hosts (host_key) VALUES ($1) ON CONFLICT (host_key) DO NOTHING`. Then
  `SELECT … FROM job_source_hosts WHERE host_key = $1 FOR UPDATE`. The seed delta also inserts a row
  for every manifest host, but correctness does not rest on the seed. This is race-free under
  `READ COMMITTED`, which T3 pins explicitly. A second claimer's conflicting insert waits on the
  first transaction's uncommitted index entry, and the first claimer holds that entry until its
  whole claim transaction ends. **So the two claimers serialize at the `INSERT`.** The second then
  does nothing, and its `SELECT … FOR UPDATE` takes a fresh statement snapshot and finds the
  committed row. Exactly one row exists either way, and the two claims are serialized. The
  per-minute check reads `last_claimed_at` under that lock and writes it in the same transaction.
- **(c) `started_at` and re-claims.** A recovered run is never re-claimed (T3, Option A): the next
  claim inserts a new row whose `started_at` is its own claim time, and no code updates
  `started_at`. So each claim is counted exactly once in the trailing-24 h count. A run that fails
  before sending still counts, which over-counts in the safe direction.
- **Carries:** **cross-run stop-on-ban** (PR #1139 SR-M-2), **storage and claim half**: a ban from
  a host pauses every source on that host until `paused_until`, and no new run of it is claimed. The
  rule is "use it until banned, never evade": an ADMIN enable does not clear it, and only expiry or
  T9's recorded ADMIN clear does. **The in-flight half** (runs already running stop sending) is
  T7's, through `readHostPause` and the ban-at-observation call; see Option A, "Stop-on-ban for runs
  in flight". **Rates the manifest
  cannot enforce** (#1139 SR-L-3): Remotive's "at most about 4 requests a day and never more than 2
  a minute" (Remotive adapter header), enforced at runtime across its three entries and across
  manual runs. Also an admin-edited `min_interval_hours` below the manifest's
  `minIntervalHoursFloor` is clamped to the floor and reported.
- **`hostRate.perDay` counts claims, not requests (round 3, SR-L-4).** It is valid only for an
  adapter that makes exactly one request per run. Remotive's header says one run is one request per
  entry. The manifest's drift test refuses a type that declares `perDay` with `requestsPerRun`
  other than 1. A multi-request adapter needs a request-level counter, which is not built here.
- **Depends on:** T1b (migration order in `deploy.yml`, after T1 and T1b), T4 (extends its
  predicate).
- **AC:** (1) a 403 on board A makes board B on the same host not due until `paused_until`;
  (2) an ADMIN enable of board B during the pause leaves it not due; (3) three Remotive entries due
  in the same minute produce at most 2 claims in that minute, and the third is claimed after the
  gap; (4) a fifth Remotive claim inside 24 h is refused, and so is a manual run once the 4 are
  used; (5) `min_interval_hours` below the floor runs at the floor; (6) the catalog check passes and
  `crm_app` holds only the manifest-declared privileges on the new table; (7) after the seed delta,
  every manifest-owned `job_sources` row has the `host_key` its manifest entry yields, and a second
  application changes no row; (8) a source with `host_key IS NULL` is never due; (9) two claimers on
  a host that has no `job_source_hosts` row yet leave exactly one row, and their claims serialize
  (the second sees the first's `last_claimed_at`); (10) a recovered run followed by a new claim
  counts as two in the 24 h count, and the recovered row's `started_at` is unchanged; (11) **a ban
  committed between a claimer's due `SELECT` and its `claimHostSlot` refuses that claim**;
  (12) **a manual run on a paused host is refused**; (13) the drift test refuses `perDay` on a type
  whose `requestsPerRun` is not 1; (14) `recordHostBan` sets `paused_until` to at least 24 hours
  ahead, honours a longer `Retry-After` up to 30 days, and never shortens an existing pause.
- **Real-Postgres:**
  - concurrent claimers for two sources on one host (the per-minute gap holds under a race, because
    both lock the host row);
  - the 24-hour count at the limit and one past it;
  - the ban written by `finish` and read by the due query in the next tick;
  - **the ban race (AC 11):** claimer B runs its due `SELECT`, `finish` of a sibling commits a ban,
    then B calls `claimHostSlot`, and B is refused, driven step by step with two connections;
  - **a manual trigger during a pause (AC 12);**
  - **a NULL `host_key` (AC 8)** under both a scheduled and a manual trigger;
  - one case per item (a)–(c): the generated delta applied twice to a seeded database (AC 7), two
    concurrent `claimHostSlot` calls on a missing host row (AC 9), and a crash, recovery and new
    claim, then the count (AC 10);
  - the pause arithmetic (AC 14), with time moved by `ageHostPause`.

  Run as `crm_app`.

- **Model:** opus (Drizzle migration). **security-reviewer mandatory.**

### T7 — production `CollectionContext` builder and run worker

- **Files:** a new `job-sourcing/runtime/` module (`buildCollectionContext`, `JobRunWorker`);
  `JobSourcingService.collectSource` / `collectAll` (they route reporting adapters through the
  worker; DOU stays on the legacy path); `quota-credentials` (it feeds `secrets`); the
  SmartRecruiters adapter's detail-request path; the `markSent` failure branch of
  `collectJsonPages` in `api-json.provider.ts`; the production `fetchText` and `markSent` wrappers,
  which carry the in-flight stop-on-ban.
- **`markSent`: its home (CR-H-1).** The call site in `collectJsonPages` already exists (F2). This
  task owns the guarantee that it fires at the moment every request leaves:
  - **Structurally.** `buildCollectionContext` wraps `meter` and `fetchText` together. For a
    context bound to a meter, each committed `markSent` grants exactly one send permit, and
    `fetchText` consumes one. Without a permit, `fetchText` throws `NOT_MARKED_SENT` **before any
    I/O**. (T3 adds the code `NOT_MARKED_SENT`, together with `RUN_FENCED`, to
    `COLLECTION_ERROR_CODES`; T7 only raises them and does not edit the list.) A caller that bypasses the loop is then refused by the production context, not trusted
    to remember.
  - **At the one bypassing caller.** The SmartRecruiters detail request gains an awaited
    `ctx.meter.markSent(reservation)` immediately before its `ctx.fetchText`. A rejection there
    means not sent, and the reservation is reconciled `RELEASED`, matching `collectJsonPages`.
  - **When `markSent` is refused with `RUN_FENCED` mid-run** (T3 fenced this executor out): the
    request is not sent and the run stops at once. It is reported as `RUN_FENCED`, not
    `PERSISTENCE` (today's label for a failed `markSent`), because the cause is ownership, not our
    storage. No `reconcile` is attempted, since it would be refused as well (T3 AC 7). The
    reservation is settled by recovery (`recoverRun`), or by `sweepOrphanReservations` if the run
    is already terminal.
- **Stop-on-ban, the in-flight half (round 4, SR-H-3).** As specified in Option A, "Stop-on-ban for
  runs in flight":
  - the `fetchText` wrapper calls T8's `recordHostBan` on the transport's `SourceBlockedError` (403)
    and `SourceRateLimitedError` (429), **before** it rethrows to the adapter (451 follows in T6);
  - the `markSent` wrapper reads `readHostPause` lock-free before every request, and on a paused host
    rejects with `ACCESS_POLICY`, sending nothing;
  - the worker reads it after every heartbeat, and on a paused host aborts the run's `signal` with
    `ACCESS_POLICY`.
- **Carries:** every port backed in production:
  - `run`, with the ledger's owner and epoch;
  - `meter` = `createAccountMeter`, bound with the owner token and with the **`account_key` read from
    the claimed run row, never recomputed from the source** (round 4, SR-L-11). `recoverRun`'s
    complete-meter-set argument rests on this;
  - `checkpoints.load` returning the checkpoint the claim chose, and `checkpoints.savePage` =
    the ledger's `savePage`;
  - `cache`, `secrets`, and `signal`, which is aborted by a failed heartbeat or a host pause;
  - the heartbeat loop at interval `H`, on its own reserved connection (pool `N + 1`), with
    page-write transactions bounded to `H` (Option A, "Lease, heartbeat and page writes");
    **the per-run `deadline`** (#1138 SR-M-1 makes this task its owner). `fetchText` uses
    `boundedFetchText` **at default caps only**, because transport options are T6's job and arrive
    after T0. **Free-plan meters** (owner-verified): TheirStack is bound with unit `RECORD`, limit 200,
    calendar-month window. **Bounded worker pool** (size `N` from config, with a ceiling). One
    source's failure never blocks another. **Run telemetry persists even if the DTO fails.** Empty
    and partial runs record honestly.
- **Depends on:** T2, T3, T8 (T8's `readHostPause` and `recordHostBan`).
- **AC:** (1) `grep` finds a `CollectionContext` producer outside `src/test/`; (2) a reporting
  adapter runs end to end against a local fixture server; (3) a TheirStack run that would exceed
  200 records stops with `COST_STOP`; (4) a throwing source leaves the others' runs `SUCCEEDED`;
  (5) a DTO serialization failure still leaves the run row terminal with its counts; (6) in a
  metered production context, `fetchText` called without a preceding committed `markSent` throws
  `NOT_MARKED_SENT`, and the fixture server records zero requests; (7) every SmartRecruiters detail
  request has a reservation in `SENT` or later before the fixture server sees it; (8) a `markSent`
  refused with `RUN_FENCED` sends nothing, stops the run, and is reported as `RUN_FENCED`; (9) **every** metered
  reporting adapter, run once through the production context against a fixture server, completes
  without `NOT_MARKED_SENT`. One parametrised test, failing on the first adapter that reaches
  `fetchText` without a committed `markSent`. **AC 6 and AC 9 are the enforcing instruments.** A
  grep cannot tell whether a call site is preceded by an awaited `markSent`. The list of
  `ctx.fetchText(` call sites outside `src/test/` (two on `d0f876f33`) is a reading aid for the
  reviewer, not a gate; (10) **in-flight stop-on-ban:** two runs on one host, A and B. A receives a
  403, and B's every request whose pause check follows the ban's commit is refused. Measured at the
  fixture server, **B sends zero further requests** after its next check; (11) a heartbeat after a
  ban aborts the run with `ACCESS_POLICY` before its next subrequest; (12) a request refused by the
  pause check leaves its reservation `RELEASED`, never `SENT`; (13) the meter binding's account key
  equals the run row's `account_key`, and building a binding with a window from another account is refused, even when the source's `account_meter_id` changed after the
  claim; (14) a heartbeat queued behind a page write lands before the lease expires, with a page
  write held to its `H` budget.
- **Real-Postgres:**
  - two workers on one source: one wins, using the ledger rather than a mock;
  - an empty run and a partial run;
  - a deadline overrun stops before the next subrequest;
  - a worker fenced out between `reserve` and `markSent` (its lease recovered by a second worker)
    sends nothing, and the account is charged exactly what the successor sent;
  - **the in-flight ban (AC 10)**, with two runs on one host against one fixture server;
  - the heartbeat-behind-page-write bound (AC 14).
- **Model:** opus, high (cross-zone, meter).

### T5 — cron: enqueue only

- **Files:** `JobSourcingCronService`; `JobSourcingModule`.
- **Carries:** the existing `@Cron('0 5 * * *')` and a new 02:30 HTML schedule, **both with
  `timeZone: 'Europe/Kyiv'`** (F7: today there is none). The two daily handlers only **enqueue**:
  each calls the ledger's `openCycle(trigger, types)`, which creates the cycle row and brings
  `next_attempt_at` forward for the selected types. The handlers write no `job_sources` column
  themselves ("Who writes which column").

  **A one-minute ledger tick** (added on the round-4 adversarial re-read) runs the work, each step in
  its own try/catch: `recoverExpired`, `settleStaleUncertain`, `sweepOrphanReservations`, then
  `claimDue` through the worker. Without it, two things break with a daily cron only. A crash at
  05:10 would not be recovered until the next day. And a source refused for the per-minute host gap,
  whose `next_attempt_at` was pushed by seconds, would wait a day rather than a minute.

  All handlers keep the try/catch-never-rethrow convention (C-23). DST and restarts are repaired by
  due-work reconciliation and idempotent claims.

- **Depends on:** T7.
- **AC:** (1) both decorators carry the zone; (2) a handler that throws inside does not rethrow;
  (3) two ticks in one minute create no second claim; (4) each ledger tick calls `recoverExpired`,
  `settleStaleUncertain` and `sweepOrphanReservations` before `claimDue`, and a failure in any of
  them does not prevent the claim step; (5) an expired lease is recovered by the next ledger tick,
  not the next daily cron.
- **Real-Postgres:** a double tick; a lease aged past expiry by `ageRun` and recovered by the next
  ledger tick (AC 5). **No clock is injected into the ledger** (Option A, "The clock is the
  database's"). The DST case is tested on the pure side: the cron expression resolved in
  `Europe/Kyiv` across both 2027 transitions, with an injected clock. Its effect on the database is
  only which types are made due, and a fixture of aged rows tests that.
- **Model:** sonnet, low–medium.

### T6 — transport wiring (after T0)

- **Files:** `transportOptionsFor` and `boundedFetchText` in `http/bounded-fetch.ts`;
  `buildCollectionContext`'s `fetchText`; each reporting adapter's declaration (`allowedHosts`).
- **Carries:** **backlog 319**: `fetchText` calls `transportOptionsFor`, so declared `maxBytes`
  reach the transport. **`allowedHosts`** (PR #1138 SR-M-2): Arbeitnow pinned to exactly
  `www.arbeitnow.com`, and the equivalent pinned host for every other adapter (none declares one
  today), with a test proving `maxBytes` reaches the fetch call. The **pre-parse node bound
  decision** (#1138 SR-M-1): record whether T0's fix suffices for the worst-case transient memory
  per page, or add the cheap pre-parse bound to the shared bounded-JSON reader. **404 and status
  policy** (#1139 delta LOW 2): the transport surfaces the HTTP status, so an adapter's "a detail 404
  is an answer" path is reachable, decided together with the retry policy. With the status
  surfaced, T7's ban-at-observation call extends to **HTTP 451**, which today is a plain `Error`.
- **Depends on:** T0 (gate), T7.
- **AC:** (1) a spy shows each adapter's declared `maxBytes` and `allowedHosts` arrive at the fetch;
  (2) a redirect or request to an unlisted host is refused; (3) a body one byte over the cap is
  refused before parse, and one at the cap is accepted; (4) a detail 404 is classified as the
  adapter's answer, not `TRANSIENT_NETWORK`; (5) an HTTP 451 records a host ban exactly as a 403
  does.
- **Real-Postgres:** not needed for the transport. Run one end-to-end run per raised-cap source
  (Greenhouse, Ashby, Arbeitnow) against a fixture server.
- **Model:** opus, high (security surface). **security-reviewer mandatory.**

### T9 — ADMIN controls for excluded sources (round 4, CR-M-15)

A source at the failure cap is never claimed, so a successful run cannot clear it, and a ban pause
lifts only on expiry. Both therefore need an administrative exit. Without one, an implementer would
add a back door or leave capped sources dead. Both are state changes on paid sources, so they are
**ADMIN only**.

- **Files:** `JobSourcingController`, with new endpoints under the existing job-sourcing route;
  calls into the ledger (`resetFailures`) and into T8's host-state module (`clearHostPause`); the
  store operation for a precise `UNCERTAIN` settle (a thin call into `reconcile`'s arithmetic).
- **Endpoints:**
  - `GET` excluded sources, each with its reason (failure cap with `last_error_code`, host pause
    with `paused_until`, refusal reason) and every open `UNCERTAIN` hold with its age;
  - `POST` reset the failure cap of one source;
  - `POST` clear the pause of one host;
  - `POST` settle one `UNCERTAIN` reservation with an observed provider figure.
- **RBAC:** `@Roles('ADMIN')` **and** a role check in the service body. `RolesGuard` is a no-op on a
  handler without `@Roles` (the `security-review` skill, "no-op RolesGuard"), so the decorator alone is not trusted.
- **Writes, through the ledger and host-state functions only.** Locks follow the global order:
  source, then host.
  - `resetFailures` sets `consecutive_failures = 0` and `cooldown_until = NULL`, and appends a
    RESET entry with the actor to `admin_state_history`. That entry also stops the checkpoint copy
    ("Crash resume").
  - `clearHostPause` sets `paused_until = NULL` and records the actor and reason in an audit row
    T9 defines.
  - An ADMIN `enabled` toggle clears neither, as T8 states.
- **Depends on:** T3 (`resetFailures`, the ledger), T8 (`clearHostPause`).
- **AC:** (1) each endpoint answers 403 to every non-ADMIN role, tested against the real backend,
  not a mocked E2E; (2) a reset makes a capped source claimable at the next tick, and writes one
  `admin_state_history` entry naming the actor; (3) after a reset, the predecessor's checkpoint is
  not copied; (4) a clear makes a paused host's sources due at the next tick, and is recorded with
  the actor; (5) the `UNCERTAIN` settle accepts an observed figure within the reservation, refuses
  one above it, and refuses a second, different figure (first conversion wins); (6) the `GET`
  listing includes a capped source, a paused host and an `UNCERTAIN` hold seeded for the test.
- **Real-Postgres:** AC 2–5 against a scratch database, as `crm_app`; AC 1 against the running API.
- **Model:** opus (RBAC on paid sources). **security-reviewer mandatory.**

### Constraint ledger: every appended constraint in exactly one task

| Constraint (source)                                                                                                                      | Task         |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 318 before transport wiring (PR #1119 security axis)                                                                                     | T6 gate (T0) |
| `readinessAt`, not the stored column (PR #1132 SPEC-L-2 / SR-M-2)                                                                        | T4           |
| `allowedHosts` + `maxBytes` reaches fetch (PR #1138 SR-M-2)                                                                              | T6           |
| Transient memory: per-run deadline (PR #1138 SR-M-1)                                                                                     | T7           |
| Transient memory: pre-parse node bound decision (PR #1138 SR-M-1)                                                                        | T6           |
| Free-plan meters, TheirStack 200 RECORD/month                                                                                            | T7           |
| Cross-run stop-on-ban (PR #1139 SR-M-2), storage and claim half: pause storage, duration, claim-time refusal                             | T8           |
| Cross-run stop-on-ban (PR #1139 SR-M-2), in-flight half: ban at observation, pause check per request and per heartbeat (round 4, SR-H-3) | T7           |
| Rates the manifest cannot enforce (PR #1139 SR-L-3): Remotive per-minute and daily, `min_interval_hours` floor                           | T8           |
| Evidence is not permission (PR #1139)                                                                                                    | T2           |
| `Object.freeze` of the SmartRecruiters decision and its four siblings (#1139 delta LOW 1)                                                | T2           |
| 404 policy with retry policy (#1139 delta LOW 2)                                                                                         | T6           |
| Backlog 319 (`transportOptionsFor` in `fetchText`)                                                                                       | T6           |
| One live executor per attempt; replace the SR-H-1 case                                                                                   | T3           |
| `RESERVED`/`SENT` recovery with an entry point                                                                                           | T3           |
| `markSent` fires when every request leaves (brief): send-permit guard, SmartRecruiters call site, `RUN_FENCED` mid-run                   | T7           |
| Registry seam, legacy map fate (brief)                                                                                                   | T2           |
| Production `CollectionContext` builder with the 3.5a meter as `meter` (brief)                                                            | T7           |
| ADMIN-only exits from the failure cap and the host pause; "ADMIN enable never clears an unresolved block" (plan; round 4, CR-M-15)       | T9           |

Two review items have two separable halves, and each half lands in exactly one task. The
transient-memory finding splits into the deadline (T7) and the parse bound (T6). Cross-run
stop-on-ban splits into storage and claim (T8) and runs in flight (T7). The brief's note says the two LOW items should
also be "recorded in backlog in the docs follow-up". This ADR assigns them to tasks instead, so the
backlog entry, if Master writes one, should point here rather than duplicate them.

## What this ADR does not decide

- **The numeric values of most constants.** These are the lease length `L`, the heartbeat interval
  `H`, the pool size `N`, the per-run deadline, the backoff cap, `MAX_CONSECUTIVE_FAILURES`,
  `UNCERTAIN_MAX_AGE`, `CHECKPOINT_MAX_AGE`, `REFUSAL_RECHECK` and `MAX_CLAIM_SCAN`. The plan
  freezes them after MP-05 measurements. This ADR fixes only their relations:
  - each is a config value with a ceiling;
  - `H ≤ L / 3`, and a page-write transaction ends within `H`;
  - `L` exceeds the per-request timeout plus the pool's acquire timeout;
  - `UNCERTAIN_MAX_AGE` is at least 7 days;
  - `CHECKPOINT_MAX_AGE` is at most the cadence plus the backoff ceiling.

  The host-ban pause **is** decided here: at least 24 hours, at most 30 days (T8).

- **The UI for ADMIN controls.** T9 builds the endpoints and their RBAC; any screen over them is a
  separate, design-gated task.
- **A lint ban on direct HTTP in adapters (follow-up, round 3, SR-L-5).** T7's send-permit guard
  works in-process, on calls that go through the production `CollectionContext`. An adapter that
  bypassed the context, calling `fetch` or an HTTP client directly, would send requests that no
  reservation records. After recovery releases its `RESERVED` row, that cost is then under-counted.
  On `d0f876f33` no reporting adapter does this. There are exactly two non-test
  `ctx.fetchText(` call sites. The only direct `fetch(` calls under `job-sourcing/` are the
  transport (`boundedFetchText`) and the legacy `DouRssProvider`, which uses no account meter and
  stays on the legacy path. Run
  `git grep -n -E "(^|[^.a-zA-Z])fetch\(" origin/main -- apps/api/src/job-sourcing ':!*.spec.ts'`
  to check. The proposed follow-up is an ESLint rule (`no-restricted-imports` /
  `no-restricted-globals` over `providers/**`) refusing `fetch`, `undici` and `node:http(s)`
  outside the transport module. It is recorded here, not assigned, because it is a lint-config
  change in the Coder's and DevOps' zones.
- **Whether T0's fix makes a pre-parse node bound unnecessary.** T6 records that decision.
- **The 404 and retry policy itself.** T6 decides it. This ADR says only that it is decided
  together with status propagation.
- **The worker topology** (in-process, or a separate `crm_collector` process). The ledger works in
  either. The least-privilege ADR already reserves `crm_collector`.
- **`job_dirty_work` claims** (recompute, Phase 4). They use the same columns and the same pattern
  would apply, but this ADR covers collection runs only.
- **pg-boss for other workloads.** See "When to reopen".

## Rollback

This PR is documentation only.

- **To undo the ADR:** run `git revert <merge sha>` on `main`. Afterwards, the two files under
  `docs/architecture/` are gone and nothing else has changed. To verify, run
  `git show --stat <revert sha>`. It lists exactly `2026-10-24-job-source-run-ownership.md` and
  `2026-10-24-pg-boss-research.md`.
- **If the owner picks B later:** supersede this ADR with a new one. **Kept unchanged:** T1, T1b,
  T2, T4 and T8. These are the tasks "Autonomy classification" lets start before the answer, and
  each is needed under either option. The indexes remain a valid backstop, and the registry, the due
  policy and the host state are pg-boss-independent. T6's transport wiring is also unchanged in
  substance. **Changed:** T3 and T7, which are built on the ledger; T9, which calls ledger
  functions; and T5, whose cron would call `send`. B's production DDL path is the five steps in
  "Option B", and choosing it is an A3 decision.
- **Per-task rollback** belongs to each task's PR. T1's migration is additive: dropping the two
  indexes and the column restores today's schema, through the same `deploy.yml` path. T1b reverts by
  restoring T1's column type and backfill. T8 reverts by dropping `job_source_hosts` and
  `job_sources.host_key`. T9 adds no DDL; its audit rows, if a table, revert with T9's own PR.

## Verification

This one command confirms that what the ADR claims about the repository is still true:

```bash
git grep -n -e 'new Map<JobSourceType, JobSourceProvider>' -e 'CALLER PRECONDITION, not a guarantee' -e 'const ctx: CollectionContext = {' -e "@Cron('0 5" -e 'fencingEpoch: 1' -e "'owner_token'" -e "'lease_expires_at'" origin/main -- apps/api/src ':!*.spec.ts'
```

F1–F4 and F7 still hold exactly when its output shows all of these:

- the `providers` map in `job-sourcing.service.ts`;
- the precondition in `account-meter.store.ts`;
- `const ctx: CollectionContext` only under `src/test/`;
- `@Cron('0 5 * * *')` with no `timeZone`;
- `owner_token` and `lease_expires_at` only in the schema file.

When Task 2.5 lands, the map and the precondition disappear, and a `CollectionContext` producer
appears outside `src/test/`. That change is the expected signal that "Context" has become history.

For F5: `grep -c '^REVOKE CREATE ON SCHEMA public FROM PUBLIC'
apps/api/drizzle/manual/2026-10-18_db_roles.sql` prints `1` for as long as the least-privilege
regime stands. The pattern is anchored to the start of the line: unanchored, the same text also
matches a comment above the statement, and the grep returns two lines.

For T1b's facts (round 4, CR-L-5), run:

```bash
git grep -n -e "accountKey: text('account_key')" -e "uq_job_account_meters_identity" -e "accountMeterId: uuid('account_meter_id')" -e "JOB_PUBLIC_ID_PATTERN = " origin/main -- apps/api/src/database/schema
```

The output shows four things. A meter's `account_key` is `text`. A meter row is unique per
`(accountKey, unit, window)`, so one account has several rows. `job_sources.account_meter_id` is a
`uuid` naming **one** row. And the meter-key pattern starts with `[a-z0-9]` and never admits `#`. If
those four lines change, re-check T1b's key and its `'#source:'` prefix.

For the pg-boss facts, see the research file's "Shelf life".

## Sources

- Plan r5, "Task 2.5: Registry, cadence, durable work ownership, cron":
  `docs/superpowers/plans/2026-10-10-vacancy-sourcing-plan.r5.md`.
- The Task 2.5 brief and its "Added 2026-10-24" sections (Master's task file, gitignored), read
  2026-10-24.
- Code facts F1–F4, F6 and F7: `origin/main` at `d0f876f33`, with symbols as named in each fact.
- F3 schema: the Drizzle files `job-collection.ts` and `job-sourcing.ts`, plus a read-only `psql`
  session on the scratch database `crm_scratch_manifest37`. The local `crm_db` held no tables
  (measured; see Context).
- F5: `docs/architecture/2026-10-17-db-least-privilege-roles.md` and the manual SQL files
  `2026-10-18_db_roles.sql`, `2026-10-18_db_grants.sql` and `2026-10-18_db_privileges_check.sql`.
- Option B: `docs/architecture/2026-10-24-pg-boss-research.md`. Its sources are the npm registry and
  the `pg-boss@12.38.0` tarball, both read 2026-10-24, and
  [pgboss.io/api/constructor](https://pgboss.io/api/constructor), retrieved 2026-10-24.
- Method: the skills `codebase-design` (deletion test, design it twice) and `external-research`.
