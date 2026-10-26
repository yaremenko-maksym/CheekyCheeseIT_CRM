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
