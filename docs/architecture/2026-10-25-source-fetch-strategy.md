# ADR: Source fetch strategy — per-source timing, safety and health tracking

## Status

**Proposed (2026-10-26).** The owner gave the direction a green light on 2026-10-26 ("launch the source-fetch
strategy"). He has decided none of the forks in "Decision brief" below, and every number in this document is
a proposal until he does. This file replaces the draft proposal of 2026-10-25 that stood at the same path;
the draft is in git history.

Companions:

- `2026-10-24-job-source-run-ownership.md` (Accepted): the run ledger, host state, due predicate (T4), host
  budget (T8), the two daily handlers (T5) this ADR partly replaces.
- `2026-10-26-source-fetch-provider-research.md`: what each provider's own documentation says, with an
  expiry date. Every provider number below cites a row of that file as **R<n>**, or says REPO (a fact
  already in this repository) or UNVERIFIED.

## Context

### What the owner asked for (2026-10-25)

1. **09:00 daily (Europe/Kyiv):** one sweep over all enabled sources, a refresh of known job opportunities
   (are they still open), and a digest email to HR. HR applies on the source site; a **submission** is a
   recorded fact, never sent by the CRM.
2. **Between sweeps:** every source is fetched regularly to collect new job opportunities. **The owner's
   working baseline is once an hour.** Each platform may have its own timing, and its working-hours
   window follows its region.
3. **Safety first:** the rate must be safe, and sources must not fall away.
4. **Health tracking:** know when a source starts to disappear (degrades, goes silent, fails), and be
   able to trace why and since when.

### What exists on `main` (measured 2026-10-26, after T5, PR #1169)

Each fact names a symbol so a `grep` confirms it.

- **Cadence is whole hours, with no window.** The ledger's `account` (inside `endRun`, called by
  `finish`) writes `next_attempt_at = clock_timestamp() + cadence`, where the cadence is
  `cadenceHoursAtFloor(stored min_interval_hours, minIntervalHoursFloor, entry.intervalHours)`. Every
  ordinary manifest entry declares `intervalHours: DAILY` (24). A failure also writes
  `cooldown_until` from `backoffMs`. A `COST_STOP` waits for the meter reset.
- **`min_interval_hours` has no writer but the seed.** `generateSeedDelta` writes it from
  `entry.intervalHours`; no route edits it (the `@crm/shared` `jobSourceSchema` carries it only in the
  read-only `GET sources` listing, shown by the web `SourceBudgetPanel`). The admin listing
  (`JobSourceAdminService`) also derives its "next due" from it.
- **Two daily handlers** in `JobSourcingCronService`, both `timeZone: 'Europe/Kyiv'`:
  `handleDailyCollection` at 05:00 (API types, plus the legacy DOU `collectAll`) and
  `handleHtmlCollection` at 02:30 (the `_HTML` types, all blocked until phase 5). Each opens a cycle
  keyed `<name>:<Kyiv date>`, recovers, sweeps orphan reservations, then runs `runCollectionWindow`
  for `JOB_COLLECTION_WINDOW_MS` (default 1 h).
- **`countDue`'s look-ahead is clamped to `MAX_EARLY_DUE_SLACK_MS` (10 minutes)**, the widest the due
  predicate may look forward; the claim itself uses no slack.
- **Host state (T8):** `claimHostSlot` refuses `HOST_PAUSED`, `HOST_BUSY` (one run per host) and
  `HOST_RATE_GAP` / the daily count for a type with `hostRate` (only Remotive declares one:
  `{ perMinute: 2, perDay: 4 }`, with `minIntervalHoursFloor: 6`). `recordHostBan` pauses a host for at
  least 24 h, at most 30 days, on 403 / 429 / 451 (`banScope: 'SOURCE'` narrows a 403 to one source).
- **Failure cap:** `MAX_CONSECUTIVE_FAILURES` (3) excludes a source until an ADMIN calls the T9 reset.
- **Per run** (`job_collection_runs`): `outcome`, `coverage`, `received`, `created`, `revised`,
  `unchanged`, `duplicates`, `invalid`, `persistence_errors`, `error_code`, `error_message`,
  `adapter_version`, `config_version`, `source_config_snapshot`, `started_at`, `ended_at`. Duration is
  therefore already derivable (`ended_at - started_at`).
- **Freshness inputs exist:** `job_source_records.first_seen_at`, the revision's `published_at`, and
  `availability`, `availability_evidence`, `availability_checked_at` on the source record.
- **Email:** the notifications module already sends email through an outbox (`notification-email-outbox`,
  `NotificationEmailCronService`, `MAX_EMAIL_ATTEMPTS` 5) over Resend (`RESEND_API_KEY`). No second
  mailer is needed.

### What the provider documentation changed (research file)

- **Himalayas refreshes its data once a day** (R17), and unkeyed callers share one pooled allowance
  (R18). An hourly poll gains nothing and raises our 429 risk.
- **Remotive** confirms "more than 2x per minute will be blocked", "max. 4 times a day", and a 24 h delay
  (R13–R14). Its three category entries share those 4 requests.
- **Jobicy** says polling "must not exceed once per hour" and keeps a 3 h delay (R15–R16).
- **Greenhouse** documents the list without `content` (R2): list-then-detail is a documented shape.
- **Ashby** documents only the full board (R6): list-then-detail is not available from its docs.
- **No ATS provider publishes a read rate** (R3, R4, R6, R7, R9–R11). Conservative numbers stay.
- **Conditional requests are documented by nobody.** They can be learned only from response headers.
- **Four terms questions** (DOU R29, Jobgether R26, Arbeitnow R20, Remotive R14) go to the legal agent.
  This ADR changes no cadence of a source whose terms question is open.

## Decision

### 1. The fetch profile: manifest data, not a database column

Each manifest **entry** (with a per-type default) declares a `fetchProfile`. It replaces `intervalHours`.

```ts
interface FetchProfile {
  /** Minutes between attempts inside the active window. */
  readonly intervalMinutes: number
  /** Minutes between attempts outside it; null = no attempt outside the window. */
  readonly offIntervalMinutes: number | null
  /** The active window in the provider's or employer's region; null = always active. */
  readonly window: {
    readonly timeZone: string // IANA, e.g. 'Europe/Berlin'
    readonly days: readonly ('MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN')[]
    readonly from: string // 'HH:MM', local
    readonly to: string // 'HH:MM', local, exclusive
  } | null
  /** Fixed local times instead of an interval (Remotive). Mutually exclusive with the interval grid. */
  readonly fixedSlots?: { readonly timeZone: string; readonly times: readonly string[] }
  /** How many pages a routine (non-sweep) run reads; undefined = the adapter's own limit. */
  readonly routinePages?: number
}
```

What is **not** in the profile, because it already exists: the provider floor (`minIntervalHoursFloor`),
the host budget (`hostRate`), the ban scope (`banScope`), the quota (`quota` and the account meters), the
trigger mode (`triggerMode`: a quota API stays `MANUAL`, so it has no schedule at all). The stagger is
**derived**, not declared (see 2). Conditional-request support is an adapter capability, not a schedule
fact (see 7).

- **Confidence HIGH** that the profile belongs in the manifest: the manifest is already the single
  source for every per-type policy fact (floor, host rate, ban scope, quota), and a drift test checks it
  at build time. A database copy would need a seed delta per change and a production deploy per
  interval tweak.
- The drift test refuses: a profile whose interval is below the provider floor; an unknown IANA zone
  (`Intl.DateTimeFormat` throws a `RangeError` on one); `from >= to`; an empty `days`; a `fixedSlots`
  combined with an interval; and a Remotive schedule whose daily attempts across its entries exceed
  `hostRate.perDay`.

### 2. `nextSlot(now, profile, policy)`: a pure function

```ts
function nextSlot(
  now: Date, // the database clock, read inside the finishing transaction
  profile: FetchProfile,
  policy: { floorMinutes: number; slowdownLevel: number; staggerKey: string },
): Date
```

- **The grid.** Inside the window, slots fall at `window.from + stagger + k * intervalMinutes` (local
  time, on `window.days`), before `window.to`. Outside the window, slots fall at
  `00:00 + stagger + k * offIntervalMinutes` (local time), skipping any that lie inside the window; none
  when `offIntervalMinutes` is null. `fixedSlots` replaces the grid with its listed local times.
  `stagger = hash(staggerKey) mod intervalMinutes`, in whole minutes, with `staggerKey` the
  `manifest_id`, so sources on one interval never fire on the same minute and a source keeps its minute
  across deploys.
- **The result** is the first grid slot strictly after `now + gap`, where
  `gap = max(floorMinutes, effectiveInterval × (2^slowdownLevel − 1))` and `effectiveInterval` is the
  interval of the period `now` falls in. At level 0 with no floor the gap is 0, so a run that ends at
  10:06 on a 10:05 / 11:05 grid is next due at 11:05, never 12:05. Level 1 skips one slot, level 2
  three, and so on (see 4).
- **DST safety.** Local times are converted with `Intl.DateTimeFormat` offset resolution (the pattern of
  `@crm/shared`'s `kyiv-day`; no new dependency). A local slot that does not exist (the spring-forward
  gap) moves to the first instant after the gap. A local slot that occurs twice (fall-back) is taken
  once, at its first occurrence. The function searches at most 8 local days ahead and throws
  `RangeError` if it finds no slot (a profile the drift test should have refused).
- **No clock is injected into the ledger** (T5's rule). The ledger reads `clock_timestamp()` once in the
  finishing transaction, passes it to `nextSlot`, and writes the absolute result.
- **Confidence HIGH** on purity and testability; **MED** on the 8-day bound (a weekly-only profile is
  the longest case the data has).

### 3. How it composes with what exists — the strictest limit wins

`nextSlot` only decides **when a source next becomes due**. Every other term stays where it is:

| Limit                   | Owner on `main`                                     | Change                                           |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------ |
| Cadence (`next_attempt_at`) | `account` via `cadenceHoursAtFloor`             | **`nextSlot`**; `min_interval_hours` no longer read |
| Provider floor          | `minIntervalHoursFloor` → `floorHours`              | none (passed to `nextSlot` as minutes)           |
| Failure backoff         | `cooldown_until` from `backoffMs`                   | none                                             |
| Host ban pause          | `recordHostBan`, `hostOpenPredicate`                | none                                             |
| Host budget             | `claimHostSlot` (`hostRate`, `HOST_BUSY`)           | none                                             |
| Quota / cost            | account meters, `COST_STOP` → meter reset           | none (`GREATEST(nextSlot, resets_at)`)           |
| Failure cap             | `MAX_CONSECUTIVE_FAILURES`, T9 reset                | none                                             |
| Readiness, admin state  | `readinessAt`, `admin_state`                        | none                                             |

The due predicate (T4) keeps comparing timestamps. Claims use **no slack**: a slot is exact, so
`MAX_EARLY_DUE_SLACK_MS` stays in use only for `countDue`'s look-ahead.

### 4. Slow down before stopping

- **A refusal still stops.** 401 / 403 / 451 / 429 end the run and pause the host (T8, unchanged). That is
  the owner's rule, and nothing here evades it.
- **The slow-down is what happens around a refusal and before the failure cap.** A new
  `job_sources.slowdown_level` (0..4) multiplies the interval by `2^level`:
  - **+1** when a run ends `RATE_LIMIT`, `UPSTREAM` or `TRANSIENT_NETWORK`, and once more when a host
    pause on the source's host expires (the first run after a ban runs at half speed);
  - **−1** after each clean run (`SUCCESS` effect), never below 0;
  - the interval it produces is capped at 24 hours.
- So a flaky provider is asked less often **before** three failures cap it. **Confidence MED**: the
  increments are a proposal; the cap and the direction are not.

### 5. Handlers: a 10-minute tick, a sweep cycle, a digest job

| Handler                    | Cron (all `Europe/Kyiv`) | What it does                                                                                                     |
| -------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **tick** (new)             | `*/10 * * * *`           | Opens a cycle keyed `tick:<Kyiv date>T<HH:MM>`, recovers, then `runCollectionWindow` over the API types for at most **9 minutes**, so two ticks of one replica never overlap |
| **sweep** (new)            | `0 8 * * *` (proposal; see brief Q3) | Opens a cycle keyed `sweep:<Kyiv date>`; claims with the **sweep predicate** (below) until every enabled API-type source has run once in this cycle or `JOB_COLLECTION_WINDOW_MS` passes |
| **digest** (new)           | `0 9 * * *`              | Builds and enqueues the HR digest (section 9)                                                                    |
| `handleDailyCollection`    | `0 5 * * *`              | **Keeps only** the legacy DOU collection and retention; the API types leave it                                   |
| `handleHtmlCollection`     | `30 2 * * *`             | **Unchanged** (its types are blocked until phase 5)                                                              |

- **Why 10 minutes.** The finest interval any profile proposes is 60 minutes, and staggers are whole
  minutes, so a 10-minute tick claims every source within 10 minutes of its slot. A 1-minute tick was
  deleted in T5 round 5 for cost; this ADR does not bring it back.
- **The sweep predicate** is the scheduled due predicate **minus the cadence term**, plus "this source
  has no run in this cycle" (`NOT EXISTS` a `job_collection_runs` row with the sweep's `cycle_id`). It is
  the manual-trigger rule of T4 ("a manual trigger skips the cadence term and nothing else") applied to
  one cycle, so it bypasses no ban, budget, quota, readiness or cap. The runs are recorded with trigger
  `SCHEDULED`: **no enum value is added** (no DDL). A quota source stays out, because its trigger mode is
  `MANUAL`.
- **The sweep reads a source in full** (all pages its adapter allows), where a tick reads
  `routinePages`. A sweep run's `finish` sets the next slot like any run.
- **Per-tick cycle keys** avoid backlog 341's "a handler retriggered the same Kyiv day after its cycle
  closed gets no claims". Two replicas firing one tick share the key and so the cycle. Cost: 144 cycle
  rows a day per replica set (about 53,000 a year); retention of closed cycles is noted in Consequences.

### 6. Availability refresh in the sweep

The sweep re-lists each source; it sends **no per-opportunity request**. A source record seen in the list
has its `last_observed_at` moved. Absence is evidence of closure **only for a complete-board source** (an
ATS board, which lists every open posting): a feed with a rolling window (Jobicy's 7 days, R16; WWR's 10
newest; Djinni's 100 newest) proves nothing by absence, and Jobicy says so in as many words. Writing
`availability` from that evidence is phase 4's store rule; this ADR only guarantees the observation.

### 7. Conditional requests: observe first, then use

No provider documents `ETag` or `If-Modified-Since` (research, "What could not be established"), and
learning it needs a request. So:

1. Every run records whether a response carried a validator (`ETag` or `Last-Modified`) in the new run
   column `validators_seen`. This costs no request: it reads headers of requests that happen anyway.
2. An adapter whose host has shown validators stores them in its run `checkpoint` (already per source,
   inherited by the next run, bounded at 8192 characters) and sends them on the next routine run. A
   `304` is a clean run with `received = 0` that does **not** count toward the `EMPTY_RESPONSE`
   detector.
3. Until a host has shown validators, nothing changes for it.

### 8. Strategy per source (proposal; the owner's Q1 and Q2 decide it)

Intervals are minutes inside the window / outside it. "Window" is local working hours of the employer's
or platform's region, `08:00–19:00 Mon–Fri` unless stated. **Hourly is the baseline wherever no
documented limit or delay makes it pointless.**

| Source                          | Profile                                                       | Why (research row or REPO)                                                                                        |
| ------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Greenhouse, Lever, Workable, Recruitee, Personio boards | 60 / 180, window in the **board's** region | No published read rate (R3, R4, R7, R9, R10): owner baseline. Recruitee stops itself at 2027-02-10 (R7) |
| Ashby boards                    | 60 / 180; large boards (over 5 MB) 180 / off                  | Only the full board is documented (R6); boards up to 13.9 MB (REPO)                                               |
| SmartRecruiters (accepted risk) | 180 / off                                                     | robots.txt disallows us (REPO); stop at the first refusal; first call is a smoke                                  |
| Remotive (3 entries)            | `fixedSlots` 09:00, 13:00, 17:00 Kyiv, **one entry per slot** | 4 a day for the host (R13); 3 used, 1 left for a manual run; 24 h delay means it is never fresh (R14)             |
| Jobicy                          | 120 / 240                                                     | No more than hourly (R15); 3 h delay makes hourly pointless (R16)                                                 |
| Himalayas                       | sweep only (once a day)                                       | Data refreshed every 24 h (R17); pooled public allowance (R18)                                                    |
| RemoteOK                        | 60 / 180                                                      | One request; no published rate (R23)                                                                             |
| Arbeitnow                       | 120 / off, `routinePages: 1`; full pages only in the sweep    | Page 1 about 4.2 MB (REPO); no published rate (R21); terms question open (R20)                                    |
| We Work Remotely                | 180 / 360                                                     | 10 newest per category, 57.4 h age gap measured (REPO): 3 h loses nothing                                         |
| Djinni                          | 60 / 120, window Kyiv 08:00–20:00 every day                   | 100 newest, about 3.1 h at peak (REPO): **any gap over about 3 h loses postings**, so the off interval stays 120  |
| Hacker News                     | 120 on days 1–4 of the month, then sweep only                 | One thread a month (REPO); limit known only from a secondary source (R24)                                          |
| Jobgether (accepted risk)       | 120 / off                                                     | 10 × 25 cap (R25); terms forbid bots and ML use (R26), legal question open                                        |
| DOU (legacy, the only live one) | **unchanged: 05:00 daily**                                    | Terms forbid automated collection without consent (R29); no change before the legal answer                        |
| JSearch, TheirStack, Jooble, Reed | no schedule (`triggerMode: MANUAL`)                         | Free-only rule; quota APIs are not polling sources (REPO)                                                         |
| The Muse, Working Nomads, EU Remote Jobs, `_HTML` types | none                                | Blocked (REPO)                                                                                                    |

**Request volume at these numbers** (a weekday, per source): a 60 / 180 profile with an 11-hour window is
11 + 5 = 16 runs, plus the sweep. For a Greenhouse board without `content` (about 147 KB, REPO) that is
about 2.5 MB a day. Arbeitnow at 120 minutes, page 1 only, is about 6 × 4.2 MB plus a 15–20 MB sweep.

### 9. Freshness is measured, not promised

- **Freshness of a source record** = `first_seen_at − published_at` of its first revision. Reported per
  source as the median and the 90th percentile over 7 days.
- **Excluded:** records first seen in the source's **first** run (the backlog, not news); records of a
  source whose `published_at` is an update or re-publish time (Himalayas `pubDate`, R17; Ashby
  `publishedAt`, R6), which the manifest marks `publishedAtMeaning: 'UPDATED'` and whose freshness is
  reported as "not measurable" rather than as a misleading number.
- Freshness is a report on the source page and in the weekly ADMIN report, not an alert.

### 10. Health: states, detectors, an append-only event log

**States**, in precedence order (the first that applies wins):

| State      | Meaning                                                                          |
| ---------- | -------------------------------------------------------------------------------- |
| `BLOCKED`  | policy, deadline (`readinessAt`), missing evidence, or `admin_state` not ACTIVE |
| `CAPPED`   | at `MAX_CONSECUTIVE_FAILURES`, waiting for the ADMIN reset                      |
| `PAUSED`   | its host is under a ban pause                                                   |
| `FAILING`  | one or more consecutive failures, below the cap                                 |
| `EMPTY`    | the provider answered with nothing where it normally returns items              |
| `DEGRADED` | partial: format drift, invalid share up, slower, throttled, payload growth      |
| `SILENT`   | technically fine, but no new items for far longer than its own history predicts |
| `HEALTHY`  | none of the above                                                               |

`SCHEMA_DRIFT` is a **reason** that puts a source in `DEGRADED`, not a state of its own; the alert rule
names it explicitly (section 11).

**Detectors** are pure functions over a source's run history and its manifest facts. Thresholds are
constants in one module, tunable without a migration (proposals, **confidence MED**):

| Detector           | Rule                                                                                                        | Reason            |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------- |
| Volume drop        | `received` over 24 h below 30% of the 14-day median for the same weekday, given 7 days of history           | `VOLUME_DROP`     |
| Silence            | no `created` for 4 × the source's median gap between new items, while `received` > 0                       | `NO_NEW_ITEMS`    |
| Empty answer       | `received` = 0 (not a `304`) on two consecutive runs of a source whose 14-day median is above 0            | `EMPTY_RESPONSE`  |
| Format drift       | an ending `PARSE_DRIFT`, `invalid / received` above 10%, or a changed `envelope_fingerprint`               | `SCHEMA_DRIFT`    |
| Access change      | 401 / 403 / 451, or a 429 (each already pauses the host)                                                   | `ACCESS_CHANGED`, `THROTTLED` |
| Slowdown, growth   | duration or `bytes_read` over 3 × the 14-day median                                                         | `SLOW`, `PAYLOAD_GROWTH` |
| Stale answer       | `newest_item_published_at` older than the provider's own delay allows (24 h Remotive, 3 h Jobicy)          | `STALE_FEED`      |
| Board gone         | an employer board answers 404 or zero jobs after having had some                                            | `BOARD_GONE`      |
| Deadline           | a policy deadline (Recruitee 2027-02-10) less than 30 days away                                            | `DEADLINE_NEAR`   |

**Where they run.** One detector pass at the end of each tick window, over every reporting source (about
40 rows; one aggregate query over 14 days of runs). It writes an event **only on a change of state or
reason**, so the log does not grow with time, only with change.

**The health event log** — a new append-only table `job_source_health_events` (no `UPDATE`, no
`DELETE`; the append-only trigger pattern of `job_queue_actions`):

| Column                                   | Content                                                           |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `id`, `source_id`, `at`                  | `at` from the database clock                                      |
| `kind`                                   | `TRANSITION` or `NOTE`                                            |
| `from_state`, `to_state`, `reason_code`  | `TRANSITION` only                                                 |
| `evidence`                               | bounded JSON: the metric values against the baseline, run ids     |
| `first_bad_run_id`, `last_good_run_id`   | the runs that bracket the change                                  |
| `adapter_version`, `config_version`      | at the moment of the change                                       |
| `http_status`, `error_sample`            | the last status, a bounded sample (500 characters, no PII)        |
| `actor_id`, `note`                       | `NOTE` only: an ADMIN's note (a provider announcement, a decision) |

The **current** state of a source is its latest `TRANSITION` event; no state column is stored. The
source page (unit U7) shows the run timeline, the events, and a correlation hint: "began with adapter
version X", "began with config version N", or "began with no change on our side" (a provider-side
change).

**New run columns** on `job_collection_runs` (additive, nullable): `request_count`, `bytes_read`,
`last_http_status`, `newest_item_published_at`, `envelope_fingerprint` (a hash of the sorted set of field
names a response carried, to see a format change before parsing fails), `validators_seen`. Duration is
not a column: it is `ended_at − started_at`.

### 11. Alerts and the HR digest

- **ADMIN, immediately:** a notification (in-app, and email through the existing outbox) to every active
  ADMIN when a source **enters** `FAILING`, `CAPPED`, `BLOCKED`, `EMPTY`, or `DEGRADED` with reason
  `SCHEMA_DRIFT`. Proposed addition (brief Q6): `PAUSED`, because a ban is the event the owner most
  wants to see. **One alert per transition** — an incident is the span between entering and leaving the
  state, so a source that stays `FAILING` sends nothing more. **At most 3 alert emails per source per
  Kyiv day**; further transitions that day appear only in-app and in the weekly report.
- **ADMIN, weekly** (Monday 09:00 Kyiv): per source, the state, transitions of the week, runs, freshness
  median and p90, request and byte totals.
- **HR, daily digest** at 09:00 Kyiv: per HR user, the new job opportunities in **their own team's**
  queue since the previous digest, plus one line "sources that could not be refreshed today" with the
  reason. It is information, not an alarm. The digest reads the recruiter queue phase 4 publishes; it is
  scoped exactly like the queue (an HR user sees what their team's seniors match, never another team's).
  Copy in `uk` and `en` by the recipient's locale, through Lingui.

## What changes in merged code

| Merged piece                                      | Change                                                                                      | Unit |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---- |
| Manifest `EntryDefinition.intervalHours`          | replaced by `fetchProfile` (per-type default, per-entry override)                           | U1b  |
| `cadenceHoursAtFloor` in `account`                | replaced by `nextSlot`; `min_interval_hours` **no longer read** (column kept)                | U1b  |
| `JobSourceAdminService` next-due derivation       | from `nextSlot`'s inputs, not `min_interval_hours`                                          | U1b  |
| `generateSeedDelta`                               | keeps writing `min_interval_hours` (as `ceil(intervalMinutes / 60)`) so the listing stays truthful until U7 | U1b  |
| `JobSourcingCronService.handleDailyCollection`    | keeps DOU and retention only; the API types move to tick and sweep                          | U3   |
| `JobSourcingCronService.handleHtmlCollection`     | unchanged                                                                                   | —    |
| `dueSourcesPredicate`, `claimDue`, `countDue`     | gain the sweep variant (cycle-scoped, cadence term skipped); slack stays 0 for claims       | U3   |
| `job_sources`                                     | **+ `slowdown_level`** (DDL)                                                                | U2   |
| `job_collection_runs`                             | **+ six metric columns** (DDL)                                                              | U2   |
| new `job_source_health_events`                    | **new table** (DDL)                                                                         | U4   |
| `@crm/shared` `jobSourceSchema.minIntervalHours`  | replaced by a profile summary on the source page                                            | U7   |
| `job_sources.min_interval_hours`                  | **dropped only on the owner's separate word** (brief Q9)                                     | U9   |

## Consequences

- **More runs.** About 16 a weekday per hourly source instead of 1; every one passes the same ledger,
  host and quota gates, so no new safety path is opened. The request volume per host is in section 8.
- **More rows.** 144 tick cycles a day; runs grow about 16 ×. Retention of closed cycles and old runs is
  not specified anywhere today; it becomes a backlog item when U3 merges (it needs a decision on how long
  run history must live for the 14-day detectors: at least 28 days).
- **The cron load overlaps the UTC retention crons** more often than T5's single 05:00 window did
  (backlog 341). Moving those crons to `Europe/Kyiv` or staggering them is a prerequisite of U3, not an
  option.
- **Health becomes visible before it becomes automatic.** The detectors only record and alert; none of
  them disables a source. Disabling stays with the failure cap and the ban pause.
- **Freshness stays bounded by providers**: Remotive 24 h, Jobicy 3 h, Himalayas 24 h, Djinni's 3 h
  window and WWR's 10 items cannot be made fresher by asking more often.
- **What the owner loses:** an hourly cadence on Himalayas (it gives nothing), on Jobicy (the delay),
  on WWR and SmartRecruiters (safety), and any DOU change until the legal answer.

## Rollback

Each unit is one PR; each rollback is listed with its expected state and how to verify it.

| Unit | Undo                                                                                                       | Expected state after                                                    | Verify                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| U1a  | `git revert <merge>`                                                                                       | `nextSlot` gone; nothing calls it yet                                   | `grep -rn nextSlot apps/api/src` empty                                                      |
| U1b  | `git revert <merge>`; the column was never dropped, so `cadenceHoursAtFloor` reads it again                | daily cadence from `min_interval_hours`                                 | a run's `next_attempt_at` is `ended_at + 24 h` on a scratch database                        |
| U3   | `git revert <merge>`                                                                                       | the two T5 handlers as merged in #1169                                  | `grep -n "@Cron" job-sourcing.cron.ts` shows exactly `0 5` and `30 2`                       |
| U2   | `git revert` the code; the columns are additive and nullable, so they stay (no down-migration needed)     | columns present, unwritten                                              | new runs have NULL in the six columns; `slowdown_level` stays 0                             |
| U4   | `git revert` the code; the table stays (append-only data is evidence, not dropped)                        | no new events                                                           | `SELECT max(at) FROM job_source_health_events` stops moving                                 |
| U5   | `git revert`; queued outbox rows of the reverted types are cancelled by the outbox's own skip path        | no alerts, no digest                                                    | no outbox rows of the new types after the revert                                            |
| U6   | `git revert` per adapter                                                                                   | the adapter reads the full board again                                  | the adapter spec's fixture run requests the `content=true` URL                              |
| U7   | `git revert`                                                                                               | the old listing                                                         | the source page route returns 404                                                           |
| U8   | a seed delta that sets the board's `enabled = false` (never a `DELETE`: runs reference sources)            | the board is never due                                                  | `isDue` false for it on a scratch database                                                  |
| U9   | **none**: a dropped column cannot be restored with its values. That is why it is A3 and last              | —                                                                       | —                                                                                           |
