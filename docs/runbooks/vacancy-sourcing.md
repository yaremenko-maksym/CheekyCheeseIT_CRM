# Vacancy sourcing — operations runbook

**For:** the owner, DevOps and any agent operating, activating or rolling back external vacancy sourcing
(collection → records → opportunities → `/job-queue`).
**Plan:** `docs/superpowers/plans/2026-10-10-vacancy-sourcing-plan.r5.md` (Phase 8) and its `-design.r5.md` sibling.
**Measurements:** `docs/runbooks/vacancy-sourcing-measurements.md`. **Human-only steps:** `docs/runbooks/human-only.md`
items 9–12.
**Addresses:** symbols and file paths, never line numbers. Find a symbol with `grep -rn <symbol> apps/api/src`.

---

## 0. What is live, in one paragraph

Only the **legacy DOU path** is meant to run in production: one `DOU_RSS` source, collected daily at 05:00 Kyiv by
`JobSourcingCronService.collectLegacyDou` into the legacy `job_postings` / `job_suggestions` tables. Every other source
type is registered as data only (`createProductionRegistry` registers `LegacyDouAdapter` alone), every activation flag
defaults to `false`, and the new store (`job_source_records`, `job_opportunities`, queue tables) is empty. The
`/job-queue` UI is mounted for ADMIN and HR and shows the new store, so it is empty in production. **Nothing in this
file is switched on by reading it.** Activation is Task 8.2 and needs the owner (A3).

Production state measured 2026-11-14 (read-only, §13): see §13.3. That run found **schema drift that breaks the DOU
path and the ADMIN source list** (§13.3, decision brief item 1).

## 1. Components and ownership

| Stage             | Symbols (entry points)                                                                                                      | Owner of the decision |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Schedule          | `JobSourcingCronService` (`job-sourcing.cron.ts`), `CRON_TIME_ZONE = 'Europe/Kyiv'`                                         | code                  |
| Cycle and claims  | `JobRunLedger` (`openCycle`, `claimDue`, `claimSource`, `recoverExpired`, `sweepOrphanReservations`), `ledger-policy.ts`    | code                  |
| Execution         | `runCollectionWindow` (`runtime/collection-window.ts`), `JobRunWorker` (`runtime/job-run-worker.ts`)                        | code                  |
| Adapters          | `createProductionRegistry` (`registry/production-registry.ts`); 23 reporting providers in `providers/sources/*.provider.ts` | owner (activation)    |
| Source catalog    | `MANIFEST_DEFINITIONS` (`providers/manifest.definitions.ts`, 31 types), generator `job-sources:manifest:generate`           | owner (policy)        |
| Records           | `buildSourceObservation`, the source-record and canonical stores, `job_source_records` / `_revisions` / `job_run_records`   | code                  |
| Identity          | `identity/resolver.ts` → `job_opportunity_sources`, `job_opportunities`                                                     | code; ADMIN for split |
| Derived work      | `job_dirty_work` → `RecomputeWorker` (matches), the availability consumer                                                   | flags (owner)         |
| Queue             | `JobQueueService`, `queue-generation.ts`, `JobQueueController` (`/job-queue`)                                               | code; RBAC by role    |
| DOU bridge        | the bridge branch of `JobSourcingService` (flag `JOB_QUEUE_BRIDGE_ENABLED`), `job_bridge_deliveries`                        | owner (flag)          |
| Health and alerts | `JobSourceHealthService.runDetectorPass`, `SourceHealthAlertService`, `SourceHealthWeeklyReportCron`                        | code; thresholds code |
| Model extraction  | `packages/inference` router; worker env in `extraction-worker/schema.ts`; API link `model-extraction-wiring.ts`             | owner (keys, budget)  |
| ADMIN UI          | `/admin/sources`, `/admin/sources/$sourceId`; HR UI `/job-queue`                                                            | —                     |

**Two paths, never mixed.** DOU goes through `JobSourcingService.collectAll` → `DouRssProvider` → legacy tables and
never through ledger claims (`claimGate` refuses `LEGACY`). Every other type goes through the ledger. With
`JOB_QUEUE_BRIDGE_ENABLED=true` the DOU run additionally opens a cycle, claims a legacy run (`claimLegacyRun`), enqueues
`job_bridge_deliveries` and stores DOU observations in the new store; the flag on without a ledger throws at startup.

**Why a source does not run** — the claim refusals in `ledger-policy.ts`: `MANIFEST_ENTRY_MISSING`, `NOT_ACTIVATABLE`,
`READINESS_BLOCKED`, `TRANSPORT_NOT_WIRED`, `METER_MISSING`, `HOST_KEY_MISSING`, `HOST_PAUSED`, `HOST_BUSY`,
`HOST_RATE_GAP`, `HOST_DAILY_CAP`, `HOST_REQUEST_BUDGET`, `NOT_SCHEDULED`. Activation status (`registry/activation.ts`)
is `UNREGISTERED` > `BLOCKED` > `NOT_VERIFIED` > `ACTIVATABLE`; **an `enabled` flag alone never activates a source.**

## 2. Scheduling (Europe/Kyiv) and catch-up

| Cron                   | Expression     | What it does                                                                                             | State in production                 |
| ---------------------- | -------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `API_COLLECTION_CRON`  | `0 5 * * *`    | legacy DOU + retention; opens no cycle                                                                   | runs (see §13.3)                    |
| `HTML_COLLECTION_CRON` | `30 2 * * *`   | `*_HTML` types                                                                                           | claims nothing (all BLOCKED)        |
| `TICK_CRON`            | `*/10 * * * *` | due API types (`tick:<Kyiv date>T<HH:M0>`, window `TICK_WINDOW_MS` 9 min), then the health detector pass | opens an empty cycle each tick      |
| `SWEEP_CRON`           | `0 8 * * *`    | every enabled sweepable API source once (`sweep:<date>`)                                                 | claims nothing                      |
| `DETAIL_PASS_CRON`     | `30 8 * * 1-5` | `DETAIL_ONLY` pass                                                                                       | inert until a source is `ON_DEMAND` |
| `WEEKLY_REPORT_CRON`   | `0 9 * * 1`    | `SourceHealthWeeklyReportCron`                                                                           | —                                   |

Server-time crons (no `timeZone`): match reconciliation `17 */6 * * *`, availability reconciliation `37 */6 * * *`,
queue-action retention `15 4 * * *`, generation retention `25 4 * * *`, legacy vacancy retention `0 3 * * *` and
`0 4 * * 1`. Each is gated by its flag (§9) except queue-action retention, which is statutory and always runs.

**Catch-up is not a replay.** A missed slot is not re-run; the next tick picks the source up through
`next_attempt_at` (`scheduling/due-policy.ts`, `next-slot.ts`; early slack `MAX_EARLY_DUE_SLACK_MS` 10 min). The repeated
DST fall-back hour finds its cycle already closed by `trigger_key`. The collection window is `JOB_COLLECTION_WINDOW_MS`
(default 1 h, ceiling 2 h).

**Leases and limits** (`DEFAULT_LEDGER_OPTIONS`, `DEFAULT_WORKER_OPTIONS`): lease 5 min (ceiling 1 h), run max age 2 h,
refusal recheck 6 h, claim scan 50, claim lock timeout 2 s, back-off 1 h doubling to 1 day,
`MAX_CONSECUTIVE_FAILURES` 3 (ceiling 5); worker pool 2 (ceiling 8), heartbeat 60 s, run deadline 60 min + 2 min grace.
Single flight per source and per account: `uq_job_collection_runs_one_started_per_source` / `_per_account`. Dirty
work: lease 5 min, 5 attempts, batch 200. **These values are code constants, not a frozen policy; Task 8.2 freezes them
after MP-05.**

## 3. Run, coverage and status meanings

- **Run outcome** (`job_collection_outcome`): `STARTED`, `SUCCEEDED` (a valid empty feed is a success), `PARTIAL`
  (a designed stop: `PAGE_CAP`, `COST_STOP`, `DEADLINE`), `FAILED` (any other `COLLECTION_ERROR_CODES` value),
  `CANCELLED` (ADMIN disable; neutral, no back-off).
- **Coverage** (`job_collection_coverage`): `FULL_INVENTORY`, `WINDOW`, `PARTIAL`. Only `FULL_INVENTORY` feeds
  inventory-miss closure; `PARTIAL` never claims inventory.
- **Error codes that change state:** `ACCESS_POLICY` (`AUTH_PAUSE_CODE`) pauses the source until an ADMIN resets
  failures; `RATE_LIMIT`, `UPSTREAM`, `TRANSIENT_NETWORK` raise `slowdown_level` by one (0..4), a clean run lowers it.
- **Cooldown:** `job_sources.cooldown_until`, `consecutive_failures`, `next_attempt_at`. **Host pause:**
  `job_source_hosts.paused_until` (24 h to 720 h).
- **Checkpoint:** `job_collection_runs.checkpoint` (bounded cursors); a `config_version` bump invalidates it.
- **Readiness** (`job_source_readiness`): `CANDIDATE`, `VERIFIED`, `BLOCKED`. The stored value is a seed-time snapshot;
  live readiness is computed by `manifest.activation.ts` at `now`. The seed never writes `VERIFIED`: it is earned by a
  smoke run.
- **Admin state:** `ACTIVE`, `PAUSED`, `RETIRED`; history in `admin_state_history` (`ENABLED`, `DISABLED`,
  `RESET_FAILURES`).
- **Health** (`HEALTH_STATE_VALUES`): `BLOCKED`, `CAPPED`, `PAUSED`, `FAILING`, `EMPTY`, `DEGRADED`, `SILENT`,
  `HEALTHY`; the current state is the latest `TRANSITION` row in `job_source_health_events`, there is no state column.
- **Availability:** `OPEN`, `UNKNOWN`, `CLOSED`, `EXPIRED`. **Generation:** `BUILDING`, `PUBLISHED`, `INVALIDATED`.

## 4. ADMIN operations and their limits

All ADMIN-only, checked both by `@Roles('ADMIN')` and in the service body.

| Operation                  | Route                                                 | Throttle | Notes                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enable / disable a source  | `PATCH /job-sourcing/sources/:id` `{enabled}`         | 30/min   | `JobRunLedger.setEnabled`; enable refused `JOB_SOURCE_NOT_READY` / `JOB_SOURCE_AUTH_PAUSED`; disable cancels `STARTED` runs and fences their owner, keeps scheduling columns |
| Reset failures             | `POST /job-sourcing/admin/sources/:id/reset-failures` | 10/min   | reason 1..500 chars; zeroes failures, clears cooldown and an `ACCESS_POLICY` error                                                                                           |
| Note                       | `POST /job-sourcing/admin/sources/:id/notes`          | 10/min   | `JOB_SOURCE_NOTE_MAX` 500                                                                                                                                                    |
| Health overview            | `GET /job-sourcing/admin/sources/health`              | —        | 14-day window                                                                                                                                                                |
| Manual DOU collect         | `POST /job-sourcing/collect`                          | 10/min   | `collectAllAsActor`; 503 when every source failed                                                                                                                            |
| Recompute matches          | `POST /job-queue/recompute`                           | 6/min    |                                                                                                                                                                              |
| Suppress an opportunity    | `POST /job-queue/:id/suppress`                        | 30/min   |                                                                                                                                                                              |
| Grant / revoke team triage | `POST /job-queue/:id/team-triage`, `DELETE …/:teamId` | 30/min   | `expiresAt` in the future; see backlog 425, 426                                                                                                                              |
| Triage subscriptions       | `POST/DELETE /job-queue/team-triage-subscriptions`    | 30/min   |                                                                                                                                                                              |

**Not built** (do not look for them): ADMIN unlink / split of an association, ADMIN reopen, a per-source re-cadence
action. Split recovery exists only inside the resolver (`revokedPairs`); reopen happens automatically
(`record-reopen-updater.ts`).

## 5. Quota and cost

- **Meters:** `job_account_meters` (unit `REQUEST` / `RECORD` / `MODEL_CALL` / `USD_MICROS`; window `DAY` / `MONTH` /
  `LIFETIME`; `NULL` limit = unlimited) and `job_account_meter_reservations`
  (`RESERVED` → `SENT` → `USED` | `UNCERTAIN`; `RESERVED` → `RELEASED`; `UNCERTAIN` → `USED`).
- **Capacity:** `used + reserved + uncertain + cost <= limit`; a refusal ends the run `PARTIAL` with `COST_STOP`.
  The reservation (`<attemptId>#<unit>#<n>`) is committed before any I/O; a window reset keeps reserved and uncertain.
- **Uncertain debit:** at end of run `RESERVED` is released, `SENT` and `UNCERTAIN` are booked as `USED` at full
  amount; no uncertain hold outlives its run. `sweepOrphanReservations` runs in every handler.
- **No meter row exists** in any migration or seed: credentialed quota sources are refused `METER_MISSING` until the
  owner freezes a quota (Task 8.2) and a meter row is inserted by a deploy step.
- **Reconciliation against provider usage pages: not built.** Uncertain is booked conservatively instead.
- **Legacy per-source budget:** `job_sources.budget_*`; the DOU run charges one unit.
- **Model budget:** `HTML_MODEL_CALLS_PER_CYCLE` 20, in memory per cycle (`InMemoryModelBudget`). A daily model budget
  is not built; plan rule: it stays disabled until the owner approves a value.

## 6. Source policy, attribution and credentials

- **Catalog:** 31 `job_source_type` values; production holds 36 `job_sources` rows (1 DOU, 35 manifest rows, all
  disabled). Dispositions: `DOU_RSS` legacy; 23 reporting types; 7 `*_HTML` types `BLOCKED` until Task 5.6.
- **Blocked by status constant** (`*_SOURCE_STATUS`): Jooble, JSearch, Reed, TheirStack (key required); Muse,
  Working Nomads (terms unclear). Owner-accepted risk (2026-10-24): Jobgether, HN Hiring, Remotive
  (`providers/owner-decisions.ts`).
- **Attribution** (`Attribution`): `LINK_BACK_REQUIRED` (RemoteOK, Remotive, Arbeitnow, Muse), `CREDIT_REQUIRED`
  (Himalayas, Jobicy), else `NONE_RECORDED`; `checkAttribution` checks fixtures. Whether the UI renders the
  attribution is **not verified** — check before a `LINK_BACK_REQUIRED` source is enabled.
- **Credentials** (human-only item 10): `JOOBLE_API_KEY`, `RAPIDAPI_KEY` (JSearch), `THEIRSTACK_API_KEY`,
  `REED_API_KEY`; read only by `quota-credentials.ts`; not written by `deploy.yml`. One real request per key:
  `scripts/devops/check-job-source-credentials.sh`.
- **Dice:** `DICE_HTML` is blocked like every HTML type; its denied route stays off — no adapter will be written for it.

**Review dates** (no code enforces them; the owner's calendar does):

| Date       | What                                                                                |
| ---------- | ----------------------------------------------------------------------------------- |
| 2027-01-10 | Recruitee: `DEADLINE_NEAR` fires 30 days before `RECRUITEE_TOKEN_DEADLINE`          |
| 2027-01-15 | Catalog review: re-read terms of every enabled source and every owner-accepted risk |
| 2027-02-10 | `RECRUITEE_TOKEN_DEADLINE` — public board requires an employer token from this date |

Earlier triggers for a catalog review: any `ACCESS_CHANGED` transition, a terms page change found by a human, a
`BOARD_GONE`, or a new source proposed.

## 7. Availability, retention, generations and recovery

- **Availability** (flag `JOB_AVAILABILITY_RECONCILE_ENABLED`): closure needs 3 inventory misses over at least 24 h on
  at least half the inventory (`derive-availability.ts`); window expiry and reopen updaters run under the same
  consumer. Detail-gone closure (Greenhouse only) has its own flag `JOB_DETAIL_GONE_CLOSURE_ENABLED`; do not enable it
  before a source is `ON_DEMAND`. **Precondition:** `uq_job_sources_inventory_type_namespace`
  (`manual-staged/2026-11-02_job_sources_inventory_uniqueness.sql`) — **absent in production** (§13.3).
- **Retention:** legacy postings 90 days (`purgeStalePostings`, after the 05:00 DOU run). Queue actions: two years,
  deleted at expiry (`JobQueueActionRetentionCronService`, daily). New-store cleanup is disabled
  (`NEW_STORE_CLEANUP_DISABLED`) until the owner freezes durations from MP-07.
- **Generations** (immutable browsing snapshots): `GENERATION_POLICY` ttl 15 min, 5000 entries; purge flag
  `JOB_QUEUE_GENERATION_PURGE_ENABLED`. The cursor is signed with `SESSION_SECRET`; without it the queue answers 503
  `JOB_QUEUE_POLICY_UNAVAILABLE`. A stale generation answers `JOB_QUEUE_REFRESH_REQUIRED`: the client reloads.
- **Match reconciliation / backfill of evaluation columns:** flag `JOB_MATCH_RECONCILIATION_ENABLED`, pages of 200,
  at most 500 pages, stop after 3 failed periods.
- **Legacy recovery:** the DOU bridge is forward-only; there is no backfill of old DOU postings into the new store.
- **Claim conflicts:** expired leases end `LEASE_EXPIRED` via `recoverExpired`; a fenced writer gets `RUN_FENCED`. In
  the queue, a possible duplicate answers 409 `JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED` until the HR confirms; a stale card
  answers `JOB_QUEUE_VERSION_CONFLICT`; a reused idempotency key with a different body answers
  `JOB_QUEUE_IDEMPOTENCY_CONFLICT`.

## 8. Model endpoint and engines

- **Hosted models only** (owner decision 2026-11-08, MP-04 failed): Gemini, Groq and OpenRouter `:free`. No local
  runtime on the server, ever, for extraction.
- **Separation:** `GEMINI_API_KEY`, `GROQ_API_KEY` are worker-only (`WORKER_ONLY_ENV_KEYS`); the API refuses to boot with
  them. The API reaches the worker through `EXTRACTION_WORKER_URL` + `EXTRACTION_WORKER_SECRET`; both absent = no model
  path (the production state). The API's own `OPENROUTER_API_KEY` / `JEV_API_KEY` serve resumes and relevance, not
  vacancy extraction.
- **Rotation:** routes rotate in process memory on failure; credential rotation is a human step (human-only item 10).
  Limits come from each provider's free tier; exhaustion pauses the route, and the cycle stops `PARTIAL` with its
  checkpoint kept.
- **Engine:** no browser service exists in any compose file. The extraction compose project
  (`docker-compose.extraction.yml`) was removed from production; `docs/runbooks/extraction-worker.md` is historical
  for its local-runtime parts.

## 9. Flags and environment (activation switches)

All boolean flags are read from `apps/api/src/config/env.ts`, default `false`, and are **not written by
`deploy.yml`**; a value in production exists only if set by hand in `/opt/crm/.env.production`.

| Key                                  | Turns on                                  | Rollback by        |
| ------------------------------------ | ----------------------------------------- | ------------------ |
| `JOB_QUEUE_BRIDGE_ENABLED`           | DOU bridge into the new store             | flag off + restart |
| `JOB_MATCH_RECONCILIATION_ENABLED`   | match recompute and reconciliation writes | flag off           |
| `JOB_AVAILABILITY_RECONCILE_ENABLED` | availability consumer                     | flag off           |
| `JOB_DETAIL_GONE_CLOSURE_ENABLED`    | Greenhouse detail-gone closure            | flag off           |
| `JOB_QUEUE_GENERATION_PURGE_ENABLED` | generation purge                          | flag off           |
| `JOB_COLLECTION_WINDOW_MS`           | window length (default 1 h, max 2 h)      | unset              |
| `JOB_MATCH_THRESHOLD`                | match threshold (default 0.2)             | unset              |

There is no feature flag for the HR queue UI: the route is always mounted. Per-source activation is the ADMIN switch
(§4), never an env key.

## 10. Alerts and health (v1)

**What exists.** The detector pass (`runDetectorPass`, end of each tick) writes `job_source_health_events` only on a
change, and `SourceHealthAlertService.alertOnTransition` notifies active ADMINs on entry into `FAILING`, `CAPPED`,
`BLOCKED`, `EMPTY`, `PAUSED`, `DEGRADED` (at most 3 emails per source per Kyiv day, in-app beyond). An unchanged state
emits nothing, so notifications are suppressed by construction. Thresholds: `HEALTH_THRESHOLDS`
(`health/detectors.ts`) — volume drop 0.3 over 7 days of history, silence 4× the cadence, 2 empty runs, 10 % invalid
records, slowdown 3×, deadline 30 days. Access: the latest 401/403/451 → `ACCESS_CHANGED`, 429 → `THROTTLED` and a host
pause. Model health flags: `job_model_health_flags`. Weekly report: Monday 09:00 Kyiv.

**Plan v1 alerts not built:** missing heartbeat, unreconciled costly requests, growing backlog, exhausted budget,
isolation errors, parse-validity collapse beyond `SCHEMA_DRIFT`, a rising 403/429 **share** (MP-11). Thresholds are a
code constant, not a versioned policy with an owner and a version. There is deliberately no "20 % daily errors" gate.
Each missing alert blocks only the activation wave that needs it (§11).
