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
columns. Its interface is five operations. Every one of them is a short transaction, and none holds
a lock across network I/O.

| Operation                            | What it does, in one transaction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claimDue(limit, owner, now)`        | `SELECT … FROM job_sources WHERE <due> ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT n`. For each row it locks the account's `job_account_meters` row (`FOR UPDATE`, when `account_meter_id` is set), then checks that no `STARTED` run exists for the source (any `config_version`) or the account. It then inserts or re-claims the `job_collection_runs` row with a fresh `owner_token`, `fencing_epoch = max(epoch for this source) + 1` and `lease_expires_at = now() + L`. It **commits before any I/O**. |
| `heartbeat(run, owner, epoch)`       | `UPDATE … SET lease_expires_at = now() + L WHERE id = $run AND owner_token = $owner AND fencing_epoch = $epoch AND outcome = 'STARTED' AND lease_expires_at > now()`. If zero rows change, the worker is fenced out: abort the `AbortSignal` and stop.                                                                                                                                                                                                                                                                  |
| `assertOwned(tx, run, owner, epoch)` | `SELECT 1 FROM job_collection_runs WHERE <same predicate> FOR UPDATE`, called **first inside every page write** (`checkpoints.savePage`) and inside the meter's `reserve` and `markSent`. If no row comes back, the transaction rolls back and the worker raises `RUN_FENCED`.                                                                                                                                                                                                                                          |
| `finish(run, owner, epoch, outcome)` | The terminal transition under the same predicate. It writes `job_sources` state (`last_attempt_at`, `last_success_at`, `last_nonempty_at`, `next_attempt_at`, `cooldown_until`, `consecutive_failures`) in the same transaction.                                                                                                                                                                                                                                                                                        |
| `recoverExpired(now)`                | For each `STARTED` run with `lease_expires_at < now()` (`FOR UPDATE SKIP LOCKED`), it moves that attempt's `SENT` reservations to `UNCERTAIN` and leaves `RESERVED` ones for the replay walk. It then either re-queues the source (`next_attempt_at = now()`) and marks the run `FAILED` with `LEASE_EXPIRED`, or re-claims it under a new epoch.                                                                                                                                                                       |

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

**The rejected option's strongest argument, stated fully.** The defects that hurt phase 3 were in
hand-rolled lifecycle arithmetic. pg-boss's claim, expiry, retry and singleton paths have years of
production use behind them, and adopting it would take that arithmetic out of our hands. **Answer:**
under the plan's requirement to keep the epoch, the arithmetic that actually failed in phase 3
(epoch, reservation states, lease versus write ordering) stays ours under either option. Option A
limits that risk by **locality** instead: one module is the only writer of the ownership columns
(enforced by a grep gate in its task), and every transition has a real-Postgres multi-worker case.
That is the verification bar the brief sets anyway.

**When to reopen.** If a later task needs features pg-boss does well and we lack (DAG flows, cron
with rrule, dead-letter queues across many job types), reopen it for that work, not for run
ownership. Also reopen if `apps/api` moves to `module: node16`.

### Autonomy classification (`autonomy-levels.md`)

- **The choice of A over B is A2.** The ADR is reversible (one PR), but redoing an implemented
  ledger is expensive. The **owner** confirms, in the phase's decision brief. Only T3 (the
  ledger) and T7 (which consumes it) depend on the choice. T1, T2, T4, T5 and T6 are the same under
  both options, so they can start before the owner answers.
- **T1's migration** (two partial unique indexes and an `account_key` column) is a Drizzle migration
  in a critical-path zone. It goes through the normal full pipeline with a mandatory
  security-reviewer. It changes no privilege.
- **Had the recommendation been B, it would be A3.** B adds a schema and new grants to `crm_app`
  under the least-privilege ADR, and that ADR's text is the owner's. The owner would decide before
  any code.

## Consequences

- **No new dependency.** `version-pins.md` is untouched. The ESM question does not arise.
- **The least-privilege boundary stays where the least-privilege ADR drew it.** The only DDL is
  additive, in `public`, and arrives through the existing manual-migration path.
- **The ledger becomes a critical module.** Its tests are the proof of exclusivity. The 3.5a
  characterisation case is deleted and replaced, not adjusted (F4).
- **Lifecycle constants (`L`, heartbeat interval, `N`, per-run deadline) are config with
  ceilings**, frozen after MP-05, as the plan requires.
- **A single API process** is today's deployment. The design does not assume one: two processes
  claiming concurrently is the first case in T3's spec (replica overlap, from the plan's test list).
- **Cost:** about 300–450 lines of ledger code (estimate). In exchange there is no external schema to
  keep in step on every upgrade.

## Decomposition of Task 2.5

Seven tasks plus one external prerequisite. Files are named by module and symbol. Path fragments are
given only where a file does not exist yet. "Real-Postgres" means an integration spec against a
scratch database, never `crm_db` (`live-db-access.md`), and **run as `crm_app`** wherever the claim
is about privileges. That matches the least-privilege ADR's finding that specs run as `crm_user`
prove nothing about `crm_app`.

### Order and parallelism

```
T0 (backlog 318, parallel PR — external) ─────────────────────────────┐
T1 migration ──┐                                                       │
T4 due policy ─┼─► T3 run ledger ─► T7 context builder + run worker ─┬─► T6 transport wiring
T2 registry ───┘                                                     └─► T5 cron
```

- **Wave 1, in parallel:** T1, T2, T4. Their file sets are disjoint: schema plus migration, registry
  plus service map, and a new due-policy module.
- **Wave 2:** T3, which needs T1's indexes and T4's due predicate.
- **Wave 3:** T7, which needs T2's registry and T3's ledger.
- **Wave 4, in parallel:** T5 and T6. Their file sets are disjoint: the cron file, versus `http/`,
  the context builder's `fetchText` and adapter host lists. **T6 also waits for T0** (backlog 318).
  Constraint (a): no `transportOptionsFor` wiring before 318 is fixed.
- **Not parallel:** T3 with T7 (T7 consumes the ledger's interface), and T2 with T5 (both edit
  `JobSourcingModule`).

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

### T3 — run ledger (the core of this ADR)

- **Files:** a new `job-sourcing/ownership/` module (`JobRunLedger`: `claimDue`, `heartbeat`,
  `assertOwned`, `finish`, `recoverExpired`); `createAccountMeter` and `AccountMeterBinding` (they
  gain `ownerToken` and call `assertOwned` inside `reserve` and `markSent`); the 3.5a integration
  spec's characterisation case (AutoTest zone; Master assigns that edit).
- **Carries:** `FOR UPDATE SKIP LOCKED` claim; owner token and epoch committed before I/O; epoch =
  max for the source + 1; heartbeats for the same owner and epoch only; epoch verified in every page
  write and meter call; one active fetch per source and per account (claim check, plus T1's
  backstop); no lock held across I/O; **lease recovery moves `SENT` → `UNCERTAIN`, leaves
  `RESERVED` to the now-sound replay walk, and re-queues the source**, with `recoverExpired` as the
  named entry point (called by T5's tick and at worker start). `finish` writes the `job_sources`
  state: attempts persist on empty and on error, `last_success_at` ≠ `last_nonempty_at`, and DOU's
  legacy `lastCollectedAt` semantics are preserved. Bounded attempts: `consecutive_failures`
  drives a capped backoff.
- **Depends on:** T1 (indexes), T4 (the due predicate `claimDue` filters on).
- **AC:** (1) the SR-H-1 characterisation case **fails first** and is then replaced by an assertion
  that a second executor's `reserve`/`markSent` is refused with `RUN_FENCED` and that spend equals
  charge; (2) a stale owner's `savePage` after recovery is refused, and the successor's pages are
  intact; (3) a `markSent`/recovery race ends in exactly one of {`SENT`→`UNCERTAIN`, `markSent`
  refused}, never in a request that is sent and released; (4) heartbeat with a wrong epoch changes
  nothing; (5) the epoch strictly increases across re-claims of one source; (6) a grep gate: no file
  outside the ledger writes `owner_token`, `fencing_epoch` or `lease_expires_at`.
- **Real-Postgres:** N concurrent claimers (N ≥ 4, two pools, the "replica" case) against one due
  source get exactly one claim. Also: a crash after a page is persisted (kill between `savePage` and
  `finish`, then recover); stale-owner writes; manual run overlapping a scheduled one; bounded
  attempts at the limit and one past it. All run as `crm_app`.
- **Model:** opus, high. **security-reviewer mandatory** (meter, money-adjacent).

### T4 — due policy (pure, plus one query)

- **Files:** a new `job-sourcing/scheduling/` module (`isDue`, `dueSourcesPredicate`,
  `hostPauseOf`); the `onlyTypes`/`excludeTypes` options and `sourceAcceptsTrigger` (moved, not
  rewritten).
- **Carries:** due = persisted `next_attempt_at` / `cooldown_until` + enabled + **readiness from
  `readinessAt(subject, clock)`, never the stored `job_sources.readiness` column** (PR #1132
  SPEC-L-2 / SR-M-2) + trigger policy. Manual runs skip cadence but not cooldown, entitlement, cost,
  or a current owner. `enabled` is administrative permission. Pause, health, reason and state
  history are separate, and an ADMIN enable never clears an unresolved policy or credential block.
  **Cross-run stop-on-ban** (PR #1139 SR-M-2): `ACCESS_POLICY` / `RATE_LIMIT` from a host pauses
  every source on that host until a recorded time ("use it until banned, never evade"). **Rates the
  manifest cannot enforce** (#1139 SR-L-3): Remotive's documented daily and per-minute limits and an
  admin-edited `min_interval_hours` are bound by the manifest's ceiling, so a DB value below the
  floor is clamped and reported.
- **Depends on:** nothing.
- **AC:** (1) a seeded `CANDIDATE` source past `RECRUITEE_TOKEN_DEADLINE` is not due even though its
  stored column still says `CANDIDATE`; (2) a 403 on board A makes board B (same host) not due;
  (3) `min_interval_hours` below the manifest floor runs at the floor; (4) a manual run under
  cooldown or cost block is refused with a reason; (5) the legacy 10-minute early-due slack never
  overrides quota or cooldown.
- **Real-Postgres:** the due query over a seeded mix (enabled/disabled, paused, cooled down,
  deadline-crossed), compared against the pure `isDue` over the same rows.
- **Model:** sonnet, medium.

### T7 — production `CollectionContext` builder and run worker

- **Files:** a new `job-sourcing/runtime/` module (`buildCollectionContext`, `JobRunWorker`);
  `JobSourcingService.collectSource` / `collectAll` (they route reporting adapters through the
  worker; DOU stays on the legacy path); `quota-credentials` (it feeds `secrets`).
- **Carries:** every port backed in production: `run` with the ledger's owner and epoch, `meter` =
  `createAccountMeter` bound with the owner token, `checkpoints.savePage` calling `assertOwned`
  first in its transaction, `cache`, `secrets`, `signal` aborted by a failed heartbeat, and
  **the per-run `deadline`** (#1138 SR-M-1 makes this task its owner). `fetchText` uses
  `boundedFetchText` **at default caps only**, because transport options are T6's job and arrive
  after T0. **Free-plan meters** (owner-verified): TheirStack is bound with unit `RECORD`, limit 200,
  calendar-month window. **Bounded worker pool** (size `N` from config, with a ceiling). One
  source's failure never blocks another. **Run telemetry persists even if the DTO fails.** Empty
  and partial runs record honestly.
- **Depends on:** T2, T3.
- **AC:** (1) `grep` finds a `CollectionContext` producer outside `src/test/`; (2) a reporting
  adapter runs end to end against a local fixture server; (3) a TheirStack run that would exceed
  200 records stops with `COST_STOP`; (4) a throwing source leaves the others' runs `SUCCEEDED`;
  (5) a DTO serialization failure still leaves the run row terminal with its counts.
- **Real-Postgres:** two workers on one source, one wins, using the ledger rather than a mock; an
  empty run and a partial run; a deadline overrun stops before the next subrequest.
- **Model:** opus, high (cross-zone, meter).

### T5 — cron: enqueue only

- **Files:** `JobSourcingCronService`; `JobSourcingModule`.
- **Carries:** the existing `@Cron('0 5 * * *')` and a new 02:30 HTML schedule, **both with
  `timeZone: 'Europe/Kyiv'`** (F7: today there is none). Handlers only enqueue (create the cycle and
  call `recoverExpired`, then `claimDue` through the worker), and keep the try/catch-never-rethrow
  convention (C-23). DST and restarts are repaired by due-work reconciliation and idempotent claims.
- **Depends on:** T7.
- **AC:** (1) both decorators carry the zone; (2) a handler that throws inside does not rethrow;
  (3) two ticks in one minute create no second claim.
- **Real-Postgres:** a DST-shift catch-up case (clock injected) and a double tick.
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
  is an answer" path is reachable, decided together with the retry policy.
- **Depends on:** T0 (gate), T7.
- **AC:** (1) a spy shows each adapter's declared `maxBytes` and `allowedHosts` arrive at the fetch;
  (2) a redirect or request to an unlisted host is refused; (3) a body one byte over the cap is
  refused before parse, and one at the cap is accepted; (4) a detail 404 is classified as the
  adapter's answer, not `TRANSIENT_NETWORK`.
- **Real-Postgres:** not needed for the transport. Run one end-to-end run per raised-cap source
  (Greenhouse, Ashby, Arbeitnow) against a fixture server.
- **Model:** opus, high (security surface). **security-reviewer mandatory.**

### Constraint ledger: every appended constraint in exactly one task

| Constraint (source)                                                               | Task         |
| --------------------------------------------------------------------------------- | ------------ |
| 318 before transport wiring (PR #1119 security axis)                              | T6 gate (T0) |
| `readinessAt`, not the stored column (PR #1132 SPEC-L-2 / SR-M-2)                 | T4           |
| `allowedHosts` + `maxBytes` reaches fetch (PR #1138 SR-M-2)                       | T6           |
| Transient memory: per-run deadline (PR #1138 SR-M-1)                              | T7           |
| Transient memory: pre-parse node bound decision (PR #1138 SR-M-1)                 | T6           |
| Free-plan meters, TheirStack 200 RECORD/month                                     | T7           |
| Cross-run stop-on-ban (PR #1139 SR-M-2)                                           | T4           |
| Rates the manifest cannot enforce (PR #1139 SR-L-3)                               | T4           |
| Evidence is not permission (PR #1139)                                             | T2           |
| `Object.freeze` of the SmartRecruiters decision (#1139 delta LOW 1)               | T2           |
| 404 policy with retry policy (#1139 delta LOW 2)                                  | T6           |
| Backlog 319 (`transportOptionsFor` in `fetchText`)                                | T6           |
| One live executor per attempt; replace the SR-H-1 case                            | T3           |
| `RESERVED`/`SENT` recovery with an entry point                                    | T3           |
| `markSent` call site (already on the port, 3.5b): no `fetchText` outside the loop | T7           |
| Registry seam, legacy map fate                                                    | T2           |

The transient-memory finding is one review item with two separable halves: the deadline and the
parse bound. Each half lands in exactly one task. The brief's note says the two LOW items should
also be "recorded in backlog in the docs follow-up". This ADR assigns them to tasks instead, so the
backlog entry, if Master writes one, should point here rather than duplicate them.

## What this ADR does not decide

- **The numeric values** of the lease length `L`, the heartbeat interval, the pool size `N`, the
  per-run deadline, and the backoff cap. The plan freezes them after MP-05 measurements. This ADR
  fixes only that they are config values with ceilings.
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
- **If the owner picks B later:** supersede this ADR with a new one. Only T3 and T7 change. T1's
  indexes remain a valid backstop under B. B's production DDL path is the five steps in
  "Option B", and choosing it is an A3 decision.
- **Per-task rollback** belongs to each task's PR. T1's migration is additive: dropping the two
  indexes and the column restores today's schema, through the same `deploy.yml` path.

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

For F5: `grep -n "REVOKE CREATE ON SCHEMA public FROM PUBLIC"
apps/api/drizzle/manual/2026-10-18_db_roles.sql` returns one line for as long as the least-privilege
regime stands. For the pg-boss facts, see the research file's "Shelf life".

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
