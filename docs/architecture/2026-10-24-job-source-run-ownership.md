# ADR: Job-source run ownership — hand-written Postgres claims vs `pg-boss` (Task 2.5)

## Status

Proposed (skeleton — sections are filled one push at a time).

## Context — the measured facts

Plan r5, Task 2.5, requires PostgreSQL-backed run ownership and tells the implementer to compare the
hand-written version against `pg-boss` first. Four of phase 3's hardest defects were in hand-rolled
lifecycle arithmetic, so this comparison is a real one. Every fact below was re-measured on
`origin/main` at `d0f876f33` (2026-10-24), not copied from the brief. Each one is phrased so that a
`grep` for the named symbol confirms it (see "Verification").

**How the facts were obtained.** Codegraph MCP was not in this agent's tool set, so code facts come
from `grep` and reading files at that commit. Schema facts come from the Drizzle schema plus a
read-only `psql` session (`default_transaction_read_only=on`). A finding about the database itself:
**the local `crm_db` on port 5432 (docker-compose, PostgreSQL 16.15) holds no user tables at all.**
It has zero relations outside the system schemas. `SELECT current_database(), version()` confirmed
the target. The job-sourcing tables exist only in scratch databases built from the migrations, so the
live column list was read from `crm_scratch_manifest37` (read-only). Production was not read.

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
(`load`, `savePage`) and `cache`. Two code paths construct a value of that type, and both are test
helpers: `test/fake-collection-context.ts` and `test/quota-harness.ts`. The only production
implementation behind any port is the 3.5a meter store, `createAccountMeter` in
`metering/account-meter.store.ts`. It already exposes `markSent`. Task 3.5b landed that, so this task
inherits the **call site in the transport**, not the port method.

`transportOptionsFor` and `boundedFetchText` exist in `http/bounded-fetch.ts`, and production calls
neither. That is why every adapter's declared `maxBytes` is inert today (backlog 319; PR #1138 SR-M-2).

### F3 — The ownership columns exist, and nothing writes them

| Table                 | Ownership columns                                                                   | Uniqueness the database enforces                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `job_collection_runs` | `owner_token` (bounded text), `fencing_epoch` (bigint, default 1, `> 0`), `lease_expires_at` | `uq_job_collection_runs_running_owner`: one `STARTED` row per **(source_id, config_version)**; `uq_job_collection_runs_attempt`: (source_id, attempt_id) |
| `job_dirty_work`      | `claim_owner`, `claimed_at`, `lease_expires_at`, `fencing_epoch`, `retry_count`     | `uq_job_dirty_work_entity_target`; a CHECK pairs `CLAIMED` with owner + lease                                                                    |
| `job_sources`         | none: `next_attempt_at`, `cooldown_until`, `consecutive_failures`, `last_attempt_at`, `last_success_at`, `last_nonempty_at`, `readiness`, `admin_state`, `account_meter_id` | —                                                                                                                                                |

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
columns. Its interface is five operations. Every one of them is a short transaction, and none holds
a lock across network I/O.

| Operation                       | What it does, in one transaction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claimDue(limit, owner, now)`   | `SELECT … FROM job_sources WHERE <due> ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT n`. For each row it locks the account's `job_account_meters` row (`FOR UPDATE`, when `account_meter_id` is set), then checks that no `STARTED` run exists for the source (any `config_version`) or the account. It then inserts or re-claims the `job_collection_runs` row with a fresh `owner_token`, `fencing_epoch = max(epoch for this source) + 1` and `lease_expires_at = now() + L`. It **commits before any I/O**. |
| `heartbeat(run, owner, epoch)`  | `UPDATE … SET lease_expires_at = now() + L WHERE id = $run AND owner_token = $owner AND fencing_epoch = $epoch AND outcome = 'STARTED' AND lease_expires_at > now()`. If zero rows change, the worker is fenced out: abort the `AbortSignal` and stop.                                                                                                                                                                                                                                                                                                |
| `assertOwned(tx, run, owner, epoch)` | `SELECT 1 FROM job_collection_runs WHERE <same predicate> FOR UPDATE`, called **first inside every page write** (`checkpoints.savePage`) and inside the meter's `reserve` and `markSent`. If no row comes back, the transaction rolls back and the worker raises `RUN_FENCED`.                                                                                                                                                                                                                                                                      |
| `finish(run, owner, epoch, outcome)` | The terminal transition under the same predicate. It writes `job_sources` state (`last_attempt_at`, `last_success_at`, `last_nonempty_at`, `next_attempt_at`, `cooldown_until`, `consecutive_failures`) in the same transaction.                                                                                                                                                                                                                                                                                                          |
| `recoverExpired(now)`           | For each `STARTED` run with `lease_expires_at < now()` (`FOR UPDATE SKIP LOCKED`), it moves that attempt's `SENT` reservations to `UNCERTAIN` and leaves `RESERVED` ones for the replay walk. It then either re-queues the source (`next_attempt_at = now()`) and marks the run `FAILED` with `LEASE_EXPIRED`, or re-claims it under a new epoch.                                                                                                                                                                       |

**Why this makes F4 false.** The meter binding gains `ownerToken` and calls `assertOwned` inside its
own transaction. A second live executor of the same `attemptId` holds a different token, or the
superseded epoch, so its `reserve` and `markSent` are refused before anything leaves the process.
Recovery and `markSent` lock the same run row, so they serialize. Either `markSent` commits `SENT`
first, and recovery turns it into `UNCERTAIN` (a hold, the safe direction), or recovery commits
first and `markSent` is refused, so the request is never sent. With the fence in place, the replay
walk's reading of `RESERVED` as "never sent" becomes sound.

**One active fetch per source and per account.** The claim checks this under row locks, and the
database enforces it as a backstop with two partial unique indexes over `outcome = 'STARTED'`: one
on `source_id` alone (today's index is per `(source_id, config_version)`, F3), and one on an
`account_key` column (the meter id, or the source id when it has none). This is the only DDL
Option A needs. It is **additive**, it lives in `public`, it changes no privilege, and it goes
through the existing `deploy.yml` path.

**Bounded worker pool.** An in-process semaphore of size `N` per API process. The claim's `LIMIT` is
the free slots, never more. `N`, `L`, the heartbeat interval and the per-run deadline are config
values with ceilings, frozen after MP-05.

**Cost of A** (estimate, not measured). The ledger is about 300–450 lines plus real-Postgres specs.
The arithmetic it owns is the lease predicate, the epoch increment, the recovery transitions, and
the due-time computation (cooldown, cadence, readiness). Due time is needed under Option B too.
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

**What pg-boss does not give.** It does not recover our meter reservations (`RESERVED`/`SENT` →
replay or `UNCERTAIN`). It does not evaluate readiness through `readinessAt`, cooldown, cadence,
`min_interval_hours`, or the host-level stop-on-ban across sources. It provides no epoch check on
our writes, and it does not keep `job_sources` state (last success versus last non-empty). All of
that is hand-written under either option.

**Bounded review of the new dependency.** 7 new packages (`pg-boss`, `cron-parser`, `luxon`,
`rrule-temporal`, `temporal-spec`, `serialize-error` with `non-error` and `type-fest`, plus the
non-optional peer `@opentelemetry/api`). `pg` is already present. All are MIT, and none has an
install script. Release cadence is high (14 releases between 2026-09-17 and 2026-10-13) and there is one
maintainer. That makes the upgrade policy an exact pin, a Renovate ignore, and a reviewed bump with
its migration file. The package would need its own row in `version-pins.md`.

**Strongest argument for B.** Claim, expiry, retry with backoff, singleton enforcement and attempt
fencing are battle-tested, years-old code paths with a large user base. Phase 3's worst defects were
exactly this kind of lifecycle arithmetic, written by us. Upstream's own attempt fence exists
because of issue #925, a stale-settle defect of the same shape we guard against. When the fix landed
was not established. That cuts both ways: the library is maintained, and its long history did not
prevent this defect.

## Decision

_Pending._

## Consequences

_Pending._

## Decomposition of Task 2.5

_Pending._

## What this ADR does not decide

_Pending._

## Rollback

_Pending._

## Verification

_Pending._

## Sources

_Pending._
