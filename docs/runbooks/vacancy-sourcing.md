# Vacancy sourcing — operations runbook

**For:** the owner, DevOps and any agent operating, activating or rolling back external vacancy sourcing
(collection → records → opportunities → `/job-queue`).
**Plan:** `docs/superpowers/plans/2026-10-10-vacancy-sourcing-plan.r5.md` (Phase 8) and its `-design.r5.md` sibling.
**Measurements:** `docs/runbooks/vacancy-sourcing-measurements.md`. **Human-only steps:** `docs/runbooks/human-only.md`
items 8–11.
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
`job_bridge_deliveries` and stores DOU observations in the new store; the flag on without a wired ledger makes each DOU
run throw (`JOB_QUEUE_BRIDGE_ENABLED is on but no run ledger is wired`) — at run time, not at startup.

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
`0 4 * * 1`. Match and availability reconciliation and generation retention are gated by their flags (§9);
queue-action retention is statutory and always runs; the legacy vacancy retention crons (`VacanciesRetentionCronService`)
have no flag and always run.

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
  Working Nomads (terms unclear). Owner-accepted risk (2026-10-24): Jobgether, HN Hiring, Remotive,
  SmartRecruiters (`providers/owner-decisions.ts`).
- **Attribution** (`Attribution`): `LINK_BACK_REQUIRED` (RemoteOK, Remotive, Arbeitnow, Muse), `CREDIT_REQUIRED`
  (Himalayas, Jobicy), else `NONE_RECORDED`; `checkAttribution` checks fixtures. Whether the UI renders the
  attribution is **not verified** — check before a `LINK_BACK_REQUIRED` source is enabled.
- **Credentials** (human-only item 9): `JOOBLE_API_KEY`, `RAPIDAPI_KEY` (JSearch), `THEIRSTACK_API_KEY`,
  `REED_API_KEY`; read only by `quota-credentials.ts`; not written by `deploy.yml`. One real request per key with
  `scripts/devops/check-job-source-credentials.sh <jooble|adzuna|careerjet|rapidapi>` — it covers only those four;
  `THEIRSTACK_API_KEY`, `REED_API_KEY` and the worker's model keys have **no** check script yet. RapidAPI has a hard
  cap of 200 requests a month: run the check once per rotation, never in a loop.
- **Dice:** `DICE_HTML` is blocked like every HTML type; its denied route stays off — no adapter will be written for it.

**Review dates** (no code enforces them; the owner's calendar does):

| Date       | What                                                                                |
| ---------- | ----------------------------------------------------------------------------------- |
| 2027-01-11 | Recruitee: `DEADLINE_NEAR` fires 30 days before `RECRUITEE_TOKEN_DEADLINE`          |
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
- **Rotation:** routes rotate in process memory on failure; credential rotation is a human step (human-only item 9).
  Limits come from each provider's free tier; exhaustion pauses the route, and the cycle stops `PARTIAL` with its
  checkpoint kept.
- **Engine:** no browser service exists in any compose file. The extraction compose project
  (`docker-compose.extraction.yml`) was removed from production; `docs/runbooks/extraction-worker.md` is historical
  for its local-runtime parts.

## 9. Flags and environment (activation switches)

All boolean flags are read from `apps/api/src/config/env.ts`, default `false`, and are **not written by
`deploy.yml`**; a value in production exists only if set by hand in `/opt/crm/.env.production`. The API reads that file
through compose `env_file` when its container is **created**, so a change takes effect only after the container is
recreated: `cd /opt/crm && docker compose -f docker-compose.prod.yml -f docker-compose.ghcr.yml up -d --no-deps api`. A plain `docker restart crm-api-1` keeps the old values. "Recreate" below means
this command.

| Key                                  | Turns on                                  | Rollback by         |
| ------------------------------------ | ----------------------------------------- | ------------------- |
| `JOB_QUEUE_BRIDGE_ENABLED`           | DOU bridge into the new store             | flag off + recreate |
| `JOB_MATCH_RECONCILIATION_ENABLED`   | match recompute and reconciliation writes | flag off + recreate |
| `JOB_AVAILABILITY_RECONCILE_ENABLED` | availability consumer                     | flag off + recreate |
| `JOB_DETAIL_GONE_CLOSURE_ENABLED`    | Greenhouse detail-gone closure            | flag off + recreate |
| `JOB_QUEUE_GENERATION_PURGE_ENABLED` | generation purge                          | flag off + recreate |
| `JOB_COLLECTION_WINDOW_MS`           | window length (default 1 h, max 2 h)      | unset               |
| `JOB_MATCH_THRESHOLD`                | match threshold (default 0.2)             | unset               |

There is no feature flag for the HR queue UI: the route is always mounted. Per-source activation is the ADMIN switch
(§4), never an env key.

## 10. Alerts and health (v1)

**What exists.** The detector pass (`runDetectorPass`, end of each tick) writes `job_source_health_events` only on a
change, and `SourceHealthAlertService.alertOnTransition` notifies active ADMINs on entry into `FAILING`, `CAPPED`,
`BLOCKED`, `EMPTY`, `PAUSED`, `DEGRADED` — `DEGRADED` alerts only with reason `SCHEMA_DRIFT` (`health-alert-policy.ts`); its other reasons are
recorded but notify nobody (at most 3 emails per source per Kyiv day, in-app beyond). An unchanged state
emits nothing, so notifications are suppressed by construction. Thresholds: `HEALTH_THRESHOLDS`
(`health/detectors.ts`) — volume drop 0.3 over 7 days of history, silence 4× the cadence, 2 empty runs, 10 % invalid
records, slowdown 3×, deadline 30 days. Access: the latest 401/403/451 → `ACCESS_CHANGED`, 429 → `THROTTLED` and a host
pause. Model health flags: `job_model_health_flags`. Weekly report: Monday 09:00 Kyiv.

**Plan v1 alerts not built:** missing heartbeat, unreconciled costly requests, growing backlog, exhausted budget,
isolation errors, parse-validity collapse beyond `SCHEMA_DRIFT`, a rising 403/429 **share** (MP-11). Thresholds are a
code constant, not a versioned policy with an owner and a version. There is deliberately no "20 % daily errors" gate.
Each missing alert blocks only the activation wave that needs it (§11).

## 11. Phased activation checklist (Task 8.2 — prepared, nothing enabled)

**Who:** the owner decides each step (A3); DevOps executes the env and deploy parts; an ADMIN flips the source switch.
**Rule:** the full portfolio is preserved; a small first wave is risk control, not scope reduction. "The queue filled
up" is not acceptance. Each configuration is enabled only after its terms, auth, fixture, identity, coverage, cost,
security and quality gates pass. An unknown value blocks only the feature that needs it.

### 11.0 Preconditions (block every wave)

- [ ] Production schema matches the code: every object of `apps/api/drizzle/manual-staged/` that the running code reads
      is applied through a `deploy.yml` step (human-only item 1), and §13.1 shows no missing object. **Open on
      2026-11-14 (§13.3).**
- [ ] §13.2 finds no `42703` (undefined column) or `42P01` (undefined table) in the API log for a full day.
- [ ] The DOU legacy run of 05:00 Kyiv completes and `job_postings` receives rows (§13.3: zero rows on 2026-11-14).
- [ ] The owner decisions of the Phase 8 decision brief that the wave depends on are recorded in this file.

### 11.1 Policy freeze (before the first non-DOU source)

Record each value here with owner, reviewer, version and date. A value copied from the 2026-10-04 trial or from a
provider's marketing page is not an entitlement.

| Policy                                                                        | Source of the value        | Frozen value | Owner / version |
| ----------------------------------------------------------------------------- | -------------------------- | ------------ | --------------- |
| Cadence, attempt, retry, lease, concurrency, window                           | MP-05, code defaults §2    | —            | —               |
| Coverage per source (`FULL_INVENTORY` / `WINDOW`)                             | adapter contract, MP-02    | —            | —               |
| Account quota: units, limit, reset, uncertainty handling                      | provider terms             | —            | —               |
| Expiry, recheck, missing-observation rule                                     | §7 defaults                | —            | —               |
| Browsing generations (ttl, entries, retention)                                | MP-13                      | —            | —               |
| New-store retention durations                                                 | MP-07, legal memo          | —            | —               |
| Quality and alert thresholds                                                  | MP-08, `HEALTH_THRESHOLDS` | —            | —               |
| Model daily budget                                                            | stays disabled             | disabled     | —               |
| Canonical authority, triage grant validity, cycle membership, cursor contract | backlog 425, 426           | —            | —               |

### 11.2 Waves

| Wave | Configurations                                                                                       | Minimum observation                      | Gate to the next wave            |
| ---- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------- |
| 1    | verified DOU bridge + Greenhouse / Lever / Ashby boards + one ready free API (Arbeitnow recommended) | 24 h non-HTML                            | §11.3 metrics, no safety failure |
| 2    | other ready JSON / RSS / ATS sources                                                                 | 24 h each                                | same                             |
| 3    | credentialed quota APIs, only after meters reconcile                                                 | 24 h; enough requests for sparse sources | meters reconciled                |
| 4    | permitted HTML, one source at a time (needs MP-01 and an engine decision)                            | 3 nights each                            | same                             |

Health does not require non-empty results. Dice's denied route stays off in every wave.

### 11.3 Steps inside a wave

1. Disabled-by-default deploy (the code is already in this state).
2. Scratch environment: backfill and shadow comparison against fixtures (`DATABASE_URL` inline, never the live DB).
3. ADMIN-only review of the queue for the wave's sources.
4. Limited HR teams and sources.
5. Expand by metrics: false merges, extraction accuracy and completeness, relevance false negatives, precision@10 and
   @20, usable active opportunities, discovery latency, wasted HR time, cost. The triage share and backlog age (MP-09)
   ceiling blocks expansion.
6. Per-configuration yield (MP-10); a low-yield configuration is re-cadenced or disabled through an audited ADMIN
   action.

**Safety tests, every wave:** zero unauthorized visibility (real HR, no-team and foreign-team requests; UI mocks are
not evidence), no exclusion leaks, no legacy DOU regression, no identity corruption.

**Evaluation corpus:** authentic permitted samples with recorded capture and adapter versions, independent labels,
stratified, split by employer and job lineage, thresholds frozen before validation.

### 11.4 Per-source enable procedure (ADMIN, after the owner's "go" for that source)

1. The source's ADMIN card under `/admin/sources`: readiness is not `BLOCKED`; attribution is rendered if
   `LINK_BACK_REQUIRED`.
2. Credentialed source: the key is in `/opt/crm/.env.production` (human-only item 9) and a meter row exists.
3. Toggle on. A refusal (`JOB_SOURCE_NOT_READY`, `JOB_SOURCE_AUTH_PAUSED`) is the gate working; do not work around it.
4. After the first tick: the §13.2 run aggregates show a run for that source; record the run id in the measurement log.
5. Rollback: toggle off (§14). History and records are kept.

## 12. Dry-run instructions (disposable environments only)

Each is exercised on a scratch database and a local stack, never on production. Record the run id in the measurement
log.

- **Restoration:** restore a production backup into a scratch database, start the API against it, open
  `/admin/sources` and `/job-queue` as ADMIN; both load without a database error.
- **Cleanup:** `NEW_STORE_CLEANUP_DISABLED` is a code constant (`retention.ts`), not an env key: in a scratch build only,
  pass a policy with `newStoreCleanupEnabled: true`, run the retention crons by hand and
  compare row counts before and after; queue actions younger than two years are untouched.
- **Claim conflict:** two HR sessions take the same opportunity; the second gets `JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED`
  or `JOB_QUEUE_VERSION_CONFLICT`, and `job_queue_actions` holds exactly one `TAKEN` row.
- **Partial-run recovery:** kill the API during a run; after restart `recoverExpired` ends it `LEASE_EXPIRED`, and the
  next tick claims the source again from its checkpoint.
- **Generation refresh:** keep a list open past the 15 min ttl; the next page answers `JOB_QUEUE_REFRESH_REQUIRED` and
  the client reloads to a new generation.
- **Egress denial and restart controls** (when a worker or engine is introduced): reuse the "Checks" section of
  `docs/runbooks/extraction-worker.md` on an equivalent isolated host.

## 13. Post-deploy checks (Task 8.3, read-only)

Production access is the owner's (`ssh crm-vps`); an agent runs these only with the owner's explicit permission in the
chat. Every query runs in a read-only session, and the first line proves where it connected:

```bash
ssh crm-vps 'docker exec -i -e PGOPTIONS="-c default_transaction_read_only=on" crm-postgres-1 \
  psql -U crm_user -d crm_db -At -F "|" -v ON_ERROR_STOP=1' < checks.sql
```

`checks.sql` is a local file assembled from the §13.1 and §13.2 queries; it is not versioned. The read-only setting is a
session default, not a guarantee: a `SET`, `BEGIN READ WRITE` or `SET TRANSACTION READ WRITE` in the file switches it
off. Read the file before you pipe it, and it must contain only `SELECT`.

```sql
SELECT current_database(), current_setting('default_transaction_read_only');  -- expect crm_db|on
```

Aggregates only. No row-level personal data leaves the server.

### 13.1 Build fingerprint and schema

- `GET https://app.cheekycheese.tech/api/health` answers `{ status, timestamp, commit, buildTime }`. The field is
  `commit` (built from the `GIT_COMMIT` build argument). It must equal the short sha of the merged `main` head, and
  `docker ps` must show the same tag on `crm-api-1` and `crm-nginx-1`.
- **There is no migration ledger** (planned by ADR `2026-10-17-db-least-privilege-roles`, not built), so applied
  migration versions and checksums cannot be read from a table. The check is object presence: for each file in
  `apps/api/drizzle/manual-staged/` and the newest files in `manual/`, query `information_schema.columns`,
  `information_schema.tables` and `pg_indexes` for the objects the file creates. Row counts alone are insufficient.
- The source catalog agrees with the typed manifest: `job_sources` grouped by `type`, `enabled`, `readiness`, compared
  with `MANIFEST_DEFINITIONS` (31 types; 36 rows on 2026-11-14).

### 13.2 Aggregates

```sql
-- sources: last attempt / success / nonempty / cooldown / failures
SELECT type, enabled, readiness, admin_state, last_attempt_at, last_success_at, last_nonempty_at,
       cooldown_until, consecutive_failures, last_error_code
FROM job_sources ORDER BY type;
-- runs by outcome and coverage, last 7 days
SELECT outcome, coverage, count(*) FROM job_collection_runs
WHERE started_at > now() - interval '7 days' GROUP BY 1, 2;
-- checkpoints held by partial runs
SELECT count(*) FROM job_collection_runs WHERE checkpoint <> '{}'::jsonb AND outcome = 'PARTIAL';
-- accounts: used / reserved / uncertain
SELECT account_key, unit, window_kind, limit_amount, used, reserved, uncertain, resets_at FROM job_account_meters;
-- uniqueness (each must return 0)
SELECT count(*) FROM (SELECT attempt_id FROM job_collection_runs GROUP BY 1 HAVING count(*) > 1) d;
SELECT count(*) FROM (SELECT source_type, namespace, identity_key FROM job_source_records
                      GROUP BY 1, 2, 3 HAVING count(*) > 1) d;
-- active associations
SELECT count(*) FROM job_opportunity_sources WHERE unlinked_at IS NULL;
-- cycles that should have closed
SELECT count(*) FROM job_collection_cycles WHERE status = 'OPEN' AND started_at < now() - interval '3 hours';
-- DOU bridge
SELECT status, outcome, count(*) FROM job_bridge_deliveries GROUP BY 1, 2;
```

API log, last day (`docker logs --since 24h crm-api-1`): count `db_state=42703`, `db_state=42P01` and
`Job sourcing cron step failed`. Each must be 0 before any wave. `docker logs` covers only the current container, so
after a deploy the window starts at the restart.

**Not checkable yet (not built):** DOU shadow decisions against fixtures, backfill checksums and decision joins, cost
against provider usage. Each becomes a check when its feature lands; until then the plan's 8.3 items that need them are
open, not passed.

### 13.3 Recorded run — 2026-11-14 (production, read-only, owner-permitted)

- `/api/health` `commit` = `5a22902` = `origin/main`; `crm-api-1` and `crm-nginx-1` run tag `5a22902`.
- `job_sources`: 36 rows — 1 enabled (`CANDIDATE`, the DOU row), 20 disabled `CANDIDATE`, 15 disabled `BLOCKED`.
  `DOU_RSS` has `last_attempt_at` empty and 0 failures.
- New store: 0 records, 0 opportunities, 0 active associations, 0 assignments, 0 queue actions, 0 bridge deliveries,
  0 meters, 0 reservations, 0 runs; 2084 closed cycles (one per tick), 0 open.
- Legacy store: `job_postings` 0 rows, `job_suggestions` 0 rows. Cause not established.
- **Schema drift — objects absent in production that the code expects:**
  - `job_sources.slowdown_level` and the run metrics columns (`request_count`, `bytes_read`, `last_http_status`, …) of
    `manual-staged/2026-10-31_job_run_metrics_slowdown.sql`;
  - the table of `2026-10-31_job_source_health_events.sql`;
  - the partial indexes of `2026-11-02_job_dirty_work_pending_partial.sql` and
    `2026-11-03_job_dirty_work_partition_partial.sql`;
  - `uq_job_sources_inventory_type_namespace` of `2026-11-02_job_sources_inventory_uniqueness.sql`;
  - the tables of `2026-11-06_job_model_health.sql`.
- Present although staged: the columns of `2026-11-04_job_opportunities_evaluation_verdict.sql`,
  `2026-11-04_job_queue_submissions_per_senior.sql` (with `uq_job_queue_assignments_opportunity_senior`),
  `2026-11-05_job_opportunities_manual_team.sql` and `2026-11-05_job_opportunities_role_family.sql`. How they were
  applied is not recorded (no ledger).
- **Effect observed:** every tick logs `Job sourcing cron step failed [tick: health detector pass]` with
  `db_state=42703 … column 'bytes_read' does not exist`.
- **Effect inferred, not yet seen in a log:** `JobSourcingService.collectAll` (the 05:00 DOU run and the manual
  collect) and `listSources` (`/admin/sources`) select every `job_sources` column, `slowdown_level` included, so they
  fail with `42703` since #1200 was deployed. The API container had restarted minutes before the check, so no 05:00 log
  was available. Verify: the API log after 05:00 Kyiv, or open `/admin/sources` as ADMIN.

## 14. Rollback (all of v1)

**Order:** ADMIN disable / fence new source owners → disable queue and consumer flags → stop isolated browser or model
workers and revoke only their secrets → redeploy a compatible old API / UI only if needed. Reservations for sent
requests stay conservative until reconciled; source records, revisions, tombstones and legacy IDs stay intact. No
blanket revert without checking new-schema / old-binary and enum compatibility.

| Component       | Action                                                                                     | Evidence it worked                                                                   |
| --------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| One source      | ADMIN switch off (`PATCH /job-sourcing/sources/:id`)                                       | `admin_state_history` has `DISABLED`; its `STARTED` runs end `CANCELLED`; no new run |
| New portfolio   | switch off every non-DOU source                                                            | §13.2: no run except DOU; the DOU legacy path untouched                              |
| New queue       | flags off (§9) and recreate; the route stays mounted and authorized                        | assignment, dismissal and `job_queue_actions` row counts unchanged                   |
| Projection      | `JOB_MATCH_RECONCILIATION_ENABLED`, `JOB_AVAILABILITY_RECONCILE_ENABLED` off               | `job_dirty_work` stops moving; DOU delivery continues; replay later                  |
| DOU bridge      | `JOB_QUEUE_BRIDGE_ENABLED` off and recreate                                                | the 05:00 run completes on the legacy path; `job_bridge_deliveries` stops growing    |
| Schema          | none: additive DDL stays; no DROP, no type or decision rollback                            | —                                                                                    |
| Model worker    | stop its compose project only, revoke its keys                                             | the API keeps running; never a whole-stack `compose down`                            |
| Bad association | not built as an ADMIN action: a Coder task (unlink / split, rebuild facts, hold conflicts) | —                                                                                    |

Exercise rollback drills on the scratch environment of §12 first; a drill must preserve shadow decisions and backfill
checksums once those exist.

## 15. Spec coverage (self-check, 2026-11-14)

| Plan item                                                                           | Where                      | State                                          |
| ----------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------- |
| 8.1 components, scheduling, catch-up                                                | §1, §2                     | documented                                     |
| 8.1 run / coverage / status meanings; manual and ADMIN limits                       | §3, §4                     | documented                                     |
| 8.1 quota units, reconciliation, uncertain debit                                    | §5                         | documented; reconciliation not built           |
| 8.1 source policy, attribution, auth expiry                                         | §6                         | documented; UI attribution not verified        |
| 8.1 update, reopen, retention, generations, backfill, merge / split, claim conflict | §7, §12                    | documented; ADMIN split and reopen not built   |
| 8.1 aggregate-only queries                                                          | §13.2                      | documented                                     |
| 8.1 scratch / load / egress / rollback checks with run ids                          | §12, measurement log       | instructions only; no run yet                  |
| 8.1 capacity and credentials human-only                                             | `human-only.md` items 8–11 | documented                                     |
| 8.1 pinned engine services, digests, licence                                        | §8                         | no engine exists                               |
| 8.1 model endpoint separation, key rotation, limits                                 | §8                         | documented                                     |
| 8.1 v1 alerts, frozen thresholds, suppression                                       | §10                        | partly built; gaps listed                      |
| 8.1 catalog review 2027-01-15, Recruitee deadline                                   | §6                         | dates recorded; no code reminder               |
| 8.2 phased activation                                                               | §11, decision brief        | checklist prepared; nothing enabled            |
| 8.3 build fingerprint and migrations                                                | §13.1, §13.3               | run 2026-11-14; schema drift found             |
| 8.3 aggregates                                                                      | §13.2, §13.3               | run 2026-11-14                                 |
| 8.3 shadow decisions, backfill checksums, rollback drills                           | §13.2, §14                 | not checkable: not built                       |
| 8.3 egress, reopen, partial recovery, generation, claim audit, alert delivery       | §12                        | instructions only; no run yet                  |
| 8.3 quality report                                                                  | measurement log            | no sample yet; nothing called production-ready |
| Rollback                                                                            | §14                        | documented; drills not run                     |
