# ADR: Source fetch strategy — per-source timing, safety and health tracking

## Status

**Accepted (2026-10-26).** Proposed the same day; the owner answered the decision brief on 2026-10-26
(section "Owner decisions of 2026-10-26"). Nine of ten questions are decided; **question 6 (ADMIN alerts)
is pending, re-asked in plain words**, and the units that depend on it wait. Two new questions arose from
his answers (11 and 12). This file replaces the draft proposal of 2026-10-25 that stood at the same path;
the draft is in git history.

## Amendments

**2026-10-26 (facts learned while implementing U1a and U6a).**

- **Source of truth for what the merged Task 2.5 delivered:** the PR list #1153 (T8 + package B), #1160
  (T3), #1161 (T9), #1162 (T7), #1165 (T6), #1169 (T5). The production registry holds DOU only, so the
  windows collect only DOU until a reporting adapter is registered (see the run-ownership ADR).
- **U1a (merged, PR #1175) went beyond this ADR in these decisions:**
  - The in-window stagger is taken modulo `min(intervalMinutes, window length)`, not modulo
    `intervalMinutes`. A valid profile therefore always has a slot inside an active window; the "no slot
    within 8 days" `RangeError` is unreachable through `nextSlot` for a valid profile and is demonstrated
    through the exported `firstSlotAfter` on a hand-built shape (section 2 and U1a AC 8 amended).
  - A window never crosses midnight.
  - `window: null` means always active, on UTC days.
  - The off grid restarts at local midnight with offset `stagger % offIntervalMinutes`.
  - `fixedSlots` ignores the stagger and excludes window and off grid.
  - Slow-down gap: `gap = max(floorMinutes, effectiveInterval x (2^slowdownLevel - 1))` as in section 2,
    with the cap of AC 6 (level 4 caps at 24 h).
  - Interval bounds are 1..10080 minutes; the floor is capped at one year.
  - Offset zones such as `+05:00` are accepted by `Intl`, so they pass as zones.
- **U6a (merged, PR #1176):** see the precondition added to section 6a and unit U10.

## Owner decisions of 2026-10-26

| #   | Question                     | Decision                                                                                                                                                                                                                                                         |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Intervals between sweeps     | As recommended: section 8.                                                                                                                                                                                                                                       |
| 2   | Working hours per region     | As recommended: 08:00–19:00 Mon–Fri in each board's own time zone, every 3 h outside; the time zone is a required field of each board.                                                                                                                           |
| 3   | Sweep and digest times       | Sweep 08:00 Kyiv, digest 09:00 Kyiv.                                                                                                                                                                                                                             |
| 4   | What the sweep re-reads      | Option A: every enabled source is listed once, no per-opportunity request in the sweep. **New requirement:** a job opportunity's **detail** is fetched only on demand, just before it is shown to HR or put into the digest, cached, once (section 6a).          |
| 5   | HR digest                    | One email a day per HR user; **not on Saturday or Sunday** (Europe/Kyiv); skipped on a day with nothing new and no failed source.                                                                                                                                |
| 6   | ADMIN alerts                 | **Pending, re-asked** in plain words (section "Open questions"). The recommendation stands.                                                                                                                                                                      |
| 7   | Watchlist of employer boards | **"Everything we can get"**: no cap; every board reachable on the public no-key ATS APIs (Greenhouse, Lever, Ashby, Recruitee, Personio, Workable). The first live request of each board stays a supervised smoke (section 8a).                                  |
| 8   | Accepted-risk sources        | SmartRecruiters, Jobgether and Hacker News are connected **at the very end**. Their adapters stay in code; they are not scheduled and not in the enabled set (section 8).                                                                                        |
| 9   | `min_interval_hours`         | As recommended: stop reading it now (U1b, reversible); drop the column only after the source page has shipped and one release has passed, and ask again then.                                                                                                    |
| 10  | Provider terms               | **No legal-agent run.** The owner accepts as a known risk: DOU's automated-collection clause, Jobgether's machine-learning clause, Arbeitnow's non-commercial licence, Remotive's third-party clause. DOU stays as it runs today. Revisit if a provider objects. |

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
- **Four terms clauses** (DOU R29, Jobgether R26, Arbeitnow R20, Remotive R14) are a known risk the owner
  accepted on 2026-10-26 without a legal review. DOU's cadence is not changed; revisit if a provider objects.
- **What the store already persists** (for detail on demand): each revision may carry
  `description_sha256`, content-addressed into `job_text_blobs`; revisions are immutable; the canonical
  store's `job_dirty_work` queue (`DirtyWorkStore`) has claims, leases, fencing, attempts, a free-text
  `reason` and the entity kind `SOURCE_RECORD`. Evaluation reads the description (`layer1` reads
  `descriptionMd`; `tech-match` reads it too).
- **Which adapters fetch per-posting detail today:** Greenhouse reads the whole board with
  `content=true` (2.7–8 MB, REPO); SmartRecruiters fetches a detail per new or changed posting, cached
  by a list fingerprint; Workable asks `details=true`; Ashby has only the full board (R6); every feed
  carries the description in its list.

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
- **A `null` profile means "never scheduled"** (by tick, sweep or detail pass); it is how the three
  deferred accepted-risk types are kept out (Q8). `nextSlot` is never called with one.
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
  `stagger = hash(staggerKey) mod min(intervalMinutes, window length)` inside the window (amended
  2026-10-26, see "Amendments"), in whole minutes, with `staggerKey` the `manifest_id`, so sources on one
  interval never fire on the same minute and a source keeps its minute across deploys.
- **The result** is the first grid slot strictly after `now + gap`, where
  `gap = max(floorMinutes, effectiveInterval × (2^slowdownLevel − 1))` and `effectiveInterval` is the
  interval of the period `now` falls in. At level 0 with no floor the gap is 0, so a run that ends at
  10:06 on a 10:05 / 11:05 grid is next due at 11:05, never 12:05. Level 1 skips one slot, level 2
  three, and so on (see 4).
- **DST safety.** Local times are converted with `Intl.DateTimeFormat` offset resolution (the pattern of
  `@crm/shared`'s `kyiv-day`; no new dependency). A local slot that does not exist (the spring-forward
  gap) moves to the first instant after the gap. A local slot that occurs twice (fall-back) is taken
  once, at its first occurrence. The function searches at most 8 local days ahead and throws
  `RangeError` if it finds no slot. Amended 2026-10-26: for a valid profile that branch is unreachable
  through `nextSlot`, because the in-window stagger is taken modulo `min(interval, window length)` and so
  a valid profile always has a slot inside an active window. It is demonstrated through the exported
  `firstSlotAfter` on a hand-built shape.
- **No clock is injected into the ledger** (T5's rule). The ledger reads `clock_timestamp()` once in the
  finishing transaction, passes it to `nextSlot`, and writes the absolute result.
- **Confidence HIGH** on purity and testability; **MED** on the 8-day bound (a weekly-only profile is
  the longest case the data has).

### 3. How it composes with what exists — the strictest limit wins

`nextSlot` only decides **when a source next becomes due**. Every other term stays where it is:

| Limit                       | Owner on `main`                           | Change                                              |
| --------------------------- | ----------------------------------------- | --------------------------------------------------- |
| Cadence (`next_attempt_at`) | `account` via `cadenceHoursAtFloor`       | **`nextSlot`**; `min_interval_hours` no longer read |
| Provider floor              | `minIntervalHoursFloor` → `floorHours`    | none (passed to `nextSlot` as minutes)              |
| Failure backoff             | `cooldown_until` from `backoffMs`         | none                                                |
| Host ban pause              | `recordHostBan`, `hostOpenPredicate`      | none                                                |
| Host budget                 | `claimHostSlot` (`hostRate`, `HOST_BUSY`) | none                                                |
| Quota / cost                | account meters, `COST_STOP` → meter reset | none (`GREATEST(nextSlot, resets_at)`)              |
| Failure cap                 | `MAX_CONSECUTIVE_FAILURES`, T9 reset      | none                                                |
| Readiness, admin state      | `readinessAt`, `admin_state`              | none                                                |

The due predicate (T4) keeps comparing timestamps. Claims use **no slack**: a slot is exact, so
`MAX_EARLY_DUE_SLACK_MS` stays in use only for `countDue`'s look-ahead.

### 4. Slow down before stopping

- **A refusal still stops.** 401 / 403 / 451 / 429 end the run and pause the host (T8, unchanged). That is
  the owner's rule, and nothing here evades it.
- **The slow-down is what happens around a refusal and before the failure cap.** A new
  `job_sources.slowdown_level` (0..4) multiplies the interval by `2^level`:
  - **+1** when a run ends `RATE_LIMIT`, `UPSTREAM` or `TRANSIENT_NETWORK`. The run a 429 refused ends
    `RATE_LIMIT`, so the first run after that ban's pause expires already runs at half speed;
  - **−1** after each clean run (`SUCCESS` effect), never below 0;
  - the interval it produces is capped at 24 hours.
- So a flaky provider is asked less often **before** three failures cap it. **Confidence MED**: the
  increments are a proposal; the cap and the direction are not.

### 5. Handlers: a 10-minute tick, a sweep cycle, a digest job

| Handler                 | Cron (all `Europe/Kyiv`)         | What it does                                                                                                                                                                             |
| ----------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **tick** (new)          | `*/10 * * * *`                   | Opens a cycle keyed `tick:<Kyiv date>T<HH:MM>`, recovers, then `runCollectionWindow` over the API types for at most **9 minutes**, so two ticks of one replica never overlap             |
| **sweep** (new)         | `0 8 * * *` (owner, Q3)          | Opens a cycle keyed `sweep:<Kyiv date>`; claims with the **sweep predicate** (below) until every enabled API-type source has run once in this cycle or `JOB_COLLECTION_WINDOW_MS` passes |
| **detail pass** (new)   | `30 8 * * 1-5`                   | Opens a cycle keyed `detail:<Kyiv date>`; claims only sources that have pending detail requests, with run scope `DETAIL_ONLY` (section 6a), so the 09:00 digest has its details          |
| **digest** (new)        | `0 9 * * 1-5` (owner, Q3 and Q5) | Builds and enqueues the HR digest (section 11); no digest on Saturday or Sunday                                                                                                          |
| `handleDailyCollection` | `0 5 * * *`                      | **Keeps only** the legacy DOU collection and retention; the API types leave it                                                                                                           |
| `handleHtmlCollection`  | `30 2 * * *`                     | **Unchanged** (its types are blocked until phase 5)                                                                                                                                      |

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

### 6a. Detail on demand (owner, Q4)

**The rule:** a run reads the **list**. A job opportunity's **detail** (the description and whatever the
list lacks) is fetched only when the opportunity is about to be shown to HR or put into the digest,
once, and never for one already enriched.

**Which sources it applies to.** Only those whose list lacks the detail, declared per type as
`detailMode: 'ON_DEMAND'` in the manifest (the default is `'IN_LIST'`):

| Source                                 | Mode                                      | Why                                                                                                          |
| -------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Greenhouse                             | **ON_DEMAND**                             | The list without `content` is documented (R2); today's `content=true` costs 2.7–8 MB a board (REPO)          |
| SmartRecruiters                        | ON_DEMAND when connected (Q8: at the end) | It already fetches a detail per new posting eagerly; switched when it is connected                           |
| Workable                               | IN_LIST for now                           | Whether the list without `details=true` lacks the description is UNVERIFIED; learned at a supervised capture |
| Ashby                                  | IN_LIST                                   | Only the full board is documented (R6); there is no list to read instead                                     |
| Lever, Recruitee, Personio, every feed | IN_LIST                                   | The description arrives in the list; there is nothing to fetch later                                         |

**The flow.** No new table and no DDL: the queue and the cache already exist.

1. **Ingest.** A run of an ON_DEMAND source reads the list only and stores a revision without a
   description (`description_sha256` NULL).
2. **Want.** Evaluation runs on what the list carries (title, location, tags). When an opportunity backed
   by such a record comes out `LEAD` or `TRIAGE` for any senior, the evaluation enqueues one
   `job_dirty_work` row: kind `SOURCE_RECORD`, reason `DETAIL_FETCH`, `target_version` = the record's
   current version. The unique key `(kind, entity, version, reason)` makes a second enqueue a no-op:
   **fetch once**. An HR user opening an opportunity whose detail is missing enqueues the same row (a
   database write, never an external call).
3. **Fetch.** Only inside a ledger run of the record's own source, so every rule of a run applies: the
   host budget and `HOST_BUSY` (`claimHostSlot`), the ban pause, fencing, the byte caps, the request
   meter. After its list phase, a run claims up to `detailPerRun` (manifest, per type) of the pending
   `DETAIL_FETCH` rows whose record has its own type and namespace, oldest first, and fetches each detail. A sweep or routine run does this as a tail;
   the 08:30 **detail pass** runs it alone (scope `DETAIL_ONLY`, no list request) for sources that have
   pending rows, so the 09:00 digest is enriched.
4. **Cache.** The detail is written through the existing source-record store as a new immutable
   revision, the text content-addressed in `job_text_blobs`. The record's next revision triggers
   re-evaluation through the dirty-work queue, which may drop the opportunity. **It is fetched again
   only** when the list shows the posting changed (a new list version, for Greenhouse its `updated_at`)
   and the opportunity is still wanted, or when the stored detail is older than **14 days** and still
   wanted. That is the TTL.
5. **Failure.** A 401, 403, 429 or 451 ends the run and pauses the host (T8, unchanged); the claimed row
   is recovered on lease expiry and retried after the pause. A 404 is the adapter's answer: the posting
   is gone, recorded as availability evidence, never retried. Anything else counts an attempt; after
   `DIRTY_MAX_ATTEMPTS_DEFAULT` (5) the row is `FAILED` and stays so.
6. **Degrade.** The HR list, the opportunity view and the digest never call a provider. An opportunity
   without its detail is shown with the list's fields, a link to the original posting, and "description
   not loaded yet" (or "could not be loaded" once `FAILED`). Nothing waits on a provider.

**What it costs and saves.** A Greenhouse board's routine run falls from 2.7–8 MB to about 147 KB (the list,
REPO). Details are fetched only for the share of new postings that pass evaluation on list fields; the
remaining requests are counted in the host budget like any other.

**One rule changes in evaluation** (phase 4's `evaluate`): an opportunity whose description is absent
**because its detail is pending** is never `EXCLUDED` on stack grounds; at worst it is `TRIAGE` with the
stack unknown, so it is enriched and evaluated again. Title-level exclusions still apply. Without this
rule, list-only sources would lose every match the description would have found.

**Precondition for switching any source to `ON_DEMAND`** (added 2026-10-26 from the U6a security review,
SR-M-1). The rule above must be **implemented and tested before any source's manifest `detailMode` becomes
`'ON_DEMAND'`**. The tests: a posting with an empty body, a department tag and a title without a stack
keyword is not `EXCLUDED`; `lowInformation` is false when a tag exists, and `coreMismatch` then wins.
Without the rule, an `ON_DEMAND` source silently loses matches. Also required of U10: `FOUND.fields` goes
through `buildNormalizedPosting` and never straight to a store or a renderer; U10 confirms the adapter
version `greenhouse-2` (the revision identity changes once the mode flips); the JSON parser's error
fragment (up to 200 characters in a `PARSE_DRIFT` detail) stays out of logs and persistence. State at
2026-10-26: Greenhouse U6a landed (PR #1176) as list-only `ON_DEMAND`-capable, and the manifest keeps it
`IN_LIST`.

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

### 8. Strategy per source (owner, Q1, Q2 and Q8)

Intervals are minutes inside the window / outside it. "Window" is local working hours of the employer's
or platform's region, `08:00–19:00 Mon–Fri` unless stated. **Hourly is the baseline wherever no
documented limit or delay makes it pointless.**

| Source                                                  | Profile                                                                                                | Why (research row or REPO)                                                                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Greenhouse, Lever, Workable, Recruitee, Personio boards | 60 / 180, window in the **board's** region                                                             | No published read rate (R3, R4, R7, R9, R10): owner baseline. Recruitee stops itself at 2027-02-10 (R7). Greenhouse lists only; details on demand (6a). At scale the host budget stretches the interval (8a) |
| Ashby boards                                            | 60 / 180; large boards (over 5 MB) 180 / off                                                           | Only the full board is documented (R6); boards up to 13.9 MB (REPO)                                                                                                                                          |
| SmartRecruiters (accepted risk)                         | **not scheduled** until connected at the end (Q8); then 180 / off                                      | robots.txt disallows us (REPO); stop at the first refusal; first call is a smoke                                                                                                                             |
| Remotive (3 entries)                                    | `fixedSlots` 09:00, 13:00, 17:00 Kyiv, **one entry per slot**                                          | 4 a day for the host (R13); 3 used, 1 left for a manual run; 24 h delay means it is never fresh (R14)                                                                                                        |
| Jobicy                                                  | 120 / 240                                                                                              | No more than hourly (R15); 3 h delay makes hourly pointless (R16)                                                                                                                                            |
| Himalayas                                               | sweep only (once a day)                                                                                | Data refreshed every 24 h (R17); pooled public allowance (R18)                                                                                                                                               |
| RemoteOK                                                | 60 / 180                                                                                               | One request; no published rate (R23)                                                                                                                                                                         |
| Arbeitnow                                               | 120 / off, `routinePages: 1`; full pages only in the sweep                                             | Page 1 about 4.2 MB (REPO); no published rate (R21); terms clause accepted as a risk (R20, Q10)                                                                                                              |
| We Work Remotely                                        | 180 / 360                                                                                              | 10 newest per category, 57.4 h age gap measured (REPO): 3 h loses nothing                                                                                                                                    |
| Djinni                                                  | 60 / 120, window Kyiv 08:00–20:00 every day                                                            | 100 newest, about 3.1 h at peak (REPO): **any gap over about 3 h loses postings**, so the off interval stays 120                                                                                             |
| Hacker News (accepted risk)                             | **not scheduled** until connected at the end (Q8); then 120 on days 1–4 of the month, sweep only after | One thread a month (REPO); limit known only from a secondary source (R24)                                                                                                                                    |
| Jobgether (accepted risk)                               | **not scheduled** until connected at the end (Q8); then 120 / off                                      | 10 × 25 cap (R25); terms forbid bots and ML use (R26), accepted as a risk (Q10)                                                                                                                              |
| DOU (legacy, the only live one)                         | **unchanged: 05:00 daily**                                                                             | Terms forbid automated collection without consent (R29); accepted as a risk, cadence unchanged (Q10)                                                                                                         |
| JSearch, TheirStack, Jooble, Reed                       | no schedule (`triggerMode: MANUAL`)                                                                    | Free-only rule; quota APIs are not polling sources (REPO)                                                                                                                                                    |
| The Muse, Working Nomads, EU Remote Jobs, `_HTML` types | none                                                                                                   | Blocked (REPO)                                                                                                                                                                                               |

**How "not scheduled" is enforced (Q8).** The three accepted-risk types keep their adapters, manifest
entries and owner decisions, but declare `fetchProfile: null`. A null profile is never due by schedule,
sweep or detail pass (the drift test pins it for exactly these three types), and their rows stay
`enabled = false`. Connecting them is the last unit (U12), on the owner's word.

**Request volume at these numbers** (a weekday, per source): a 60 / 180 profile with an 11-hour window is
11 + 5 = 16 runs, plus the sweep. For a Greenhouse board listing without `content` (about 147 KB, REPO)
that is about 2.5 MB a day, instead of 43–128 MB with `content=true`. Arbeitnow at 120 minutes, page 1
only, is about 6 × 4.2 MB plus a 15–20 MB sweep. **The sweep** lists each enabled source once: one
request per board, a few per feed, and **no detail requests** (details come from the 08:30 pass, only for
wanted opportunities). For the watchlist at scale, see 8a.

### 8a. The watchlist at scale (owner, Q7: "everything we can get")

**Boards are data, not hand-written code.** One data file per provider under the manifest's providers
directory (for example `boards/greenhouse.boards.json`), one line per board:

```json
{
  "token": "acme",
  "employer": "Acme Inc",
  "domain": "acme.com",
  "timeZone": "Europe/Berlin",
  "addedBy": "discovery",
  "evidence": null
}
```

- **A generator** in the manifest builder turns every line into an `EntryDefinition` with the id
  `<provider>.board.<token>`, the provider's default `fetchProfile` with `window.timeZone` set to the
  board's `timeZone` (required: Q2), and the host key the type already derives. The drift test validates
  every line (token pattern, a known IANA zone, no duplicate token).
- **The database rows** come from the existing seed-delta generator (`generateSeedDelta`): idempotent
  inserts of the new ids, `enabled = false`. One staged delta per batch, wired once by DevOps (U8-D);
  later batches regenerate the same file kind and reuse the wiring.
- **The evidence rule stays.** A board line enters with `evidence: null` and its row disabled. It is
  enabled only after its **first live request**, a **supervised smoke**: one list request, made by an
  agent under the owner's supervision, at the host budget, stopping the batch at the first refusal. The
  smoke records the capture as the evidence the manifest already requires (status 200, an employer that
  matches the line). A board that fails stays disabled with the reason.

**Discovery without asking job sites.** Board tokens are found in data we already hold, so discovery
sends no request:

1. Every stored source record's `original_url`, `display_url` and `application_url` is matched against
   the six providers' public board URL shapes (`boards.greenhouse.io/<token>`, `jobs.lever.co/<token>`,
   `jobs.ashbyhq.com/<token>`, `<token>.recruitee.com`, `<token>.jobs.personio.de`,
   `apply.workable.com/<token>`). A read-only query lists tokens not yet in a board file, with how many
   opportunities and matches each produced.
2. Seniors and HR may propose an employer; an ADMIN adds the line.
3. TheirStack (quota API, manual runs only) can be used by hand to find employers in a niche.

The candidate list is reviewed and appended to the board files as a PR; the time zone comes from the
employer's location in the stored record, or is set by the reviewer.

**The host budget holds at any scale.** All boards of one provider share one host key (T8). Today
`HOST_BUSY` lets one run per host at a time, and `hostRate` counts claims, which is valid only for one
request a run. At scale the budget must count **requests**: a per-host `hostRequestBudget
{ perMinute, perHour }`, enforced in `claimHostSlot` from `request_count` of recent runs (U2) plus the
expected requests of the run being claimed (U11). A board refused for budget is simply claimed later;
the due order (`next_attempt_at`, oldest first) makes that a fair round-robin. **The effective interval
is therefore `max(profile interval, boards on the host / hourly budget)`**: freshness degrades gracefully
with scale instead of the request rate growing.

**The arithmetic** (per provider host, weekday, list requests only; details add the wanted share):

| Boards on one host | Runs a day at 60 / 180 | Average in the window | Sweep (one list each)     | With a budget of 120 an hour (proposed) |
| ------------------ | ---------------------- | --------------------- | ------------------------- | --------------------------------------- |
| 13 (today)         | about 210              | about 0.2 a minute    | 13                        | hourly, budget not reached              |
| 200                | about 3,200            | about 3 a minute      | 200 (about 2 h at 2/min)  | every 1.7 h in the window               |
| 1,000              | about 16,000           | about 15 a minute     | 1,000 (over 8 h at 2/min) | every 8.3 h in the window               |

Bytes at 1,000 Greenhouse boards listing hourly would be about 2.4 GB a day; at the proposed budget,
about 0.4 GB. **Ban risk** grows with the sustained request rate per host, not with the number of
boards; no provider publishes its limit (research), so the budget starts low, a refusal pauses the whole
host for at least 24 h (T8), and the slow-down (4) acts before the cap. The sweep at 1,000 boards cannot
finish in the one-hour window at 2 a minute: at scale the sweep lists what the budget allows and the
rest is covered by routine runs. The budget numbers are question 11.

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

| State      | Meaning                                                                         |
| ---------- | ------------------------------------------------------------------------------- |
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

| Detector         | Rule                                                                                              | Reason                        |
| ---------------- | ------------------------------------------------------------------------------------------------- | ----------------------------- |
| Volume drop      | `received` over 24 h below 30% of the 14-day median for the same weekday, given 7 days of history | `VOLUME_DROP`                 |
| Silence          | no `created` for 4 × the source's median gap between new items, while `received` > 0              | `NO_NEW_ITEMS`                |
| Empty answer     | `received` = 0 (not a `304`) on two consecutive runs of a source whose 14-day median is above 0   | `EMPTY_RESPONSE`              |
| Format drift     | an ending `PARSE_DRIFT`, `invalid / received` above 10%, or a changed `envelope_fingerprint`      | `SCHEMA_DRIFT`                |
| Access change    | 401 / 403 / 451, or a 429 (each already pauses the host)                                          | `ACCESS_CHANGED`, `THROTTLED` |
| Slowdown, growth | duration or `bytes_read` over 3 × the 14-day median                                               | `SLOW`, `PAYLOAD_GROWTH`      |
| Stale answer     | `newest_item_published_at` older than the provider's own delay allows (24 h Remotive, 3 h Jobicy) | `STALE_FEED`                  |
| Board gone       | an employer board answers 404 or zero jobs after having had some                                  | `BOARD_GONE`                  |
| Deadline         | a policy deadline (Recruitee 2027-02-10) less than 30 days away                                   | `DEADLINE_NEAR`               |

**Where they run.** One detector pass at the end of each tick window, over every reporting source (about
40 rows; one aggregate query over 14 days of runs). It writes an event **only on a change of state or
reason**, so the log does not grow with time, only with change.

**The health event log** — a new append-only table `job_source_health_events` (no `UPDATE`, no
`DELETE`; the append-only trigger pattern of `job_queue_actions`):

| Column                                  | Content                                                            |
| --------------------------------------- | ------------------------------------------------------------------ |
| `id`, `source_id`, `at`                 | `at` from the database clock                                       |
| `kind`                                  | `TRANSITION` or `NOTE`                                             |
| `from_state`, `to_state`, `reason_code` | `TRANSITION` only                                                  |
| `evidence`                              | bounded JSON: the metric values against the baseline, run ids      |
| `first_bad_run_id`, `last_good_run_id`  | the runs that bracket the change                                   |
| `adapter_version`, `config_version`     | at the moment of the change                                        |
| `http_status`, `error_sample`           | the last status, a bounded sample (500 characters, no PII)         |
| `actor_id`, `note`                      | `NOTE` only: an ADMIN's note (a provider announcement, a decision) |

The **current** state of a source is its latest `TRANSITION` event; no state column is stored. The
source page (unit U7) shows the run timeline, the events, and a correlation hint: "began with adapter
version X", "began with config version N", or "began with no change on our side" (a provider-side
change).

**New run columns** on `job_collection_runs` (additive, nullable): `request_count`, `bytes_read`,
`last_http_status`, `newest_item_published_at`, `envelope_fingerprint` (a hash of the sorted set of field
names a response carried, to see a format change before parsing fails), `validators_seen`. Duration is
not a column: it is `ended_at − started_at`.

### 11. Alerts and the HR digest

- **ADMIN, immediately (question 6 pending; this is the recommendation):** a notification (in-app, and
  email through the existing outbox) to every active ADMIN when a source **enters** `FAILING`, `CAPPED`,
  `BLOCKED`, `EMPTY`, `PAUSED`, or `DEGRADED` with reason `SCHEMA_DRIFT`. **One alert per transition** —
  an incident is the span between entering and leaving the state, so a source that stays `FAILING` sends
  nothing more. **At most 3 alert emails per source per Kyiv day**; further transitions that day appear
  only in-app and in the weekly report.
- **ADMIN, weekly** (Monday 09:00 Kyiv): per source, the state, transitions of the week, runs, freshness
  median and p90, request and byte totals.
- **HR, daily digest** (owner, Q5) at 09:00 Kyiv, **Monday to Friday only**: per HR user, the new job
  opportunities in **their own team's** queue since the previous digest (so Monday's covers the weekend),
  plus one line "sources that could not be refreshed today" with the reason. **No email** on a day with
  nothing new and no failed source. It is information, not an alarm. The digest reads the recruiter queue
  phase 4 publishes and is scoped exactly like it (an HR user sees what their team's seniors match, never
  another team's). An opportunity whose detail is still missing or failed is listed with its list fields
  and its original link (6a). Copy in `uk` and `en` by the recipient's locale, through Lingui.

## What changes in merged code

| Merged piece                                     | Change                                                                                                                                                                                                                  | Unit |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Manifest `EntryDefinition.intervalHours`         | replaced by `fetchProfile` (per-type default, per-entry override; `null` for the three deferred types)                                                                                                                  | U1b  |
| `cadenceHoursAtFloor` in `account`               | replaced by `nextSlot`; `min_interval_hours` **no longer read** (column kept)                                                                                                                                           | U1b  |
| `JobSourceAdminService` next-due derivation      | from `nextSlot`'s inputs, not `min_interval_hours`                                                                                                                                                                      | U1b  |
| `generateSeedDelta`                              | writes `min_interval_hours` for **new** rows as `ceil(intervalMinutes / 60)`; existing rows keep their stored value, which nothing reads after U1b. No seed delta is produced by U1b, so it has no production data step | U1b  |
| `JobSourcingCronService.handleDailyCollection`   | keeps DOU and retention only; the API types move to tick and sweep                                                                                                                                                      | U3   |
| `JobSourcingCronService.handleHtmlCollection`    | unchanged                                                                                                                                                                                                               | —    |
| `dueSourcesPredicate`, `claimDue`, `countDue`    | gain the sweep variant (cycle-scoped, cadence term skipped); slack stays 0 for claims                                                                                                                                   | U3   |
| the same, plus the run worker                    | gain the detail-pass variant ("has pending `DETAIL_FETCH`") and run scope `DETAIL_ONLY`                                                                                                                                 | U10  |
| Greenhouse adapter                               | lists without `content`; a detail-by-id function; manifest `detailMode`, `detailPerRun`                                                                                                                                 | U6a  |
| `DirtyWorkStore` and `evaluate`                  | reason `DETAIL_FETCH` (no DDL: `reason` is free text); a claim filtered by source; pending detail never excludes on stack grounds                                                                                       | U10  |
| `claimHostSlot`                                  | a request-counting host budget beside `hostRate`                                                                                                                                                                        | U11  |
| manifest builder                                 | board data files plus a generator                                                                                                                                                                                       | U8a  |
| `job_sources`                                    | **+ `slowdown_level`** (DDL)                                                                                                                                                                                            | U2   |
| `job_collection_runs`                            | **+ six metric columns** (DDL)                                                                                                                                                                                          | U2   |
| new `job_source_health_events`                   | **new table** (DDL)                                                                                                                                                                                                     | U4   |
| `@crm/shared` `jobSourceSchema.minIntervalHours` | replaced by a profile summary on the source page                                                                                                                                                                        | U7   |
| `job_sources.min_interval_hours`                 | **dropped only on the owner's separate word** (Q9)                                                                                                                                                                      | U9   |

## Consequences

- **More runs.** About 16 a weekday per hourly source instead of 1; every one passes the same ledger,
  host and quota gates, so no new safety path is opened. The request volume per host is in sections 8
  and 8a.
- **More rows.** 144 tick cycles a day; runs grow about 16 ×. Retention of closed cycles and old runs is
  not specified anywhere today; it becomes a backlog item when U3 merges (it needs a decision on how long
  run history must live for the 14-day detectors: at least 28 days).
- **The collection load overlaps the UTC retention crons permanently**, where T5's overlap was one
  window a day (backlog 341). With a tick every 10 minutes no stagger avoids it; the bound is the worker's
  slot limit (`freeSlots`), which caps concurrent runs whatever the tick does. The backlog 341 item stays
  open as a tuning item, not a prerequisite.
- **The listing's `minIntervalHours` is stale between U1b and U7**: it shows the stored value, which no
  longer drives the cadence. Accepted for that span; U7 replaces the field.
- **Detail on demand trades recall risk for bytes.** List-only sources are evaluated on title, location
  and tags first. The evaluation rule in 6a (pending detail never excludes on stack grounds) keeps that
  from losing matches, at the price of more `TRIAGE` until the detail arrives.
- **HR may see an opportunity before its description** (up to one routine interval, or until the 08:30
  pass for the digest). Shown with the list fields and the original link, never blocked on a provider.
- **At scale, freshness per board falls as the watchlist grows**, by design: the host budget, not the
  board count, sets the request rate (8a).
- **Health becomes visible before it becomes automatic.** The detectors only record and alert; none of
  them disables a source. Disabling stays with the failure cap and the ban pause.
- **Freshness stays bounded by providers**: Remotive 24 h, Jobicy 3 h, Himalayas 24 h, Djinni's 3 h
  window and WWR's 10 items cannot be made fresher by asking more often.
- **Accepted, known risks** (owner, Q10): four providers' terms clauses, with no legal review. Revisit if
  a provider objects.

## Rollback

Each unit is one PR; each rollback is listed with its expected state and how to verify it.

| Unit | Undo                                                                                                  | Expected state after                                           | Verify                                                                |
| ---- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| U1a  | `git revert <merge>`                                                                                  | `nextSlot` gone; nothing calls it yet                          | `grep -rn nextSlot apps/api/src` empty                                |
| U1b  | `git revert <merge>`; the column was never dropped, so `cadenceHoursAtFloor` reads it again           | daily cadence from `min_interval_hours`                        | a run's `next_attempt_at` is `ended_at + 24 h` on a scratch database  |
| U3   | `git revert <merge>`                                                                                  | the two T5 handlers as merged in #1169                         | `grep -n "@Cron" job-sourcing.cron.ts` shows exactly `0 5` and `30 2` |
| U2   | `git revert` the code; the columns are additive and nullable, so they stay (no down-migration needed) | columns present, unwritten                                     | new runs have NULL in the six columns; `slowdown_level` stays 0       |
| U4   | `git revert` the code; the table stays (append-only data is evidence, not dropped)                    | no new events                                                  | `SELECT max(at) FROM job_source_health_events` stops moving           |
| U5   | `git revert`; queued outbox rows of the reverted types are cancelled by the outbox's own skip path    | no alerts, no digest                                           | no outbox rows of the new types after the revert                      |
| U6a  | set the Greenhouse `detailMode` back to `IN_LIST` (one line), or `git revert`                         | the adapter reads `content=true` again                         | the adapter spec's fixture run requests the `content=true` URL        |
| U10  | `git revert`; pending `DETAIL_FETCH` rows stay and are never claimed                                  | no detail fetches; the store keeps the details already fetched | no run claims a `DETAIL_FETCH` row on a scratch database              |
| U11  | `git revert`                                                                                          | `HOST_BUSY` and `hostRate` only, as T8                         | the U11 spec's budget refusal no longer happens                       |
| U7   | `git revert`                                                                                          | the old listing                                                | the source page route returns 404                                     |
| U8a  | `git revert`                                                                                          | the 13 hand-written boards only                                | the drift test counts 13 board entries                                |
| U8c  | a seed delta that sets the boards' `enabled = false` (never a `DELETE`: runs reference sources)       | the boards are never due                                       | `isDue` false for them on a scratch database                          |
| U9   | **none**: a dropped column cannot be restored with its values. That is why it is A3 and last          | —                                                              | —                                                                     |

## Decomposition

### Order and parallelism

```
NOW (no DDL, no open question):
  U1a nextSlot (pure) ─────► U1b profile + ledger ─► U3 tick + sweep ─► U2 metrics + slowdown (DDL) ─► U4 health log (DDL)
  U6a Greenhouse list + detail-by-id (behind detailMode, stays IN_LIST)
                                 │                        │                  │                               │
                                 └► U8a board files + generator ─► U8b discovery query     ├► U2-D (DevOps)   ├► U4-D (DevOps)
                                                                                          ├► U6b conditional requests
                                                                                          └► U11 request-counting host budget (needs Q11)
  U10 detail on demand  ◄── U3, U6a, phase 4's evaluation worker (Task 4.6 S4a)
  U5a ADMIN alerts      ◄── U4 + Q6 (pending)        U5b HR digest ◄── U5a, U10, phase 4's published queue
  U7 source page        ◄── U4
  U8c board batches (prod data) ◄── U8a, U11, Q12; each board's supervised smoke ─► U8-D (DevOps, once)
  U9 drop min_interval_hours    ◄── U7 merged + one release + the owner's word
  U12 connect SmartRecruiters, Jobgether, Hacker News ◄── everything above + the owner's word (Q8)
```

**May start now (no DDL, no open question, no unmerged dependency):**

- **U1a** — `nextSlot`. **Not affected by the redesign**: detail on demand and the watchlist change what
  is fetched and how many sources share a host, never when a single source is next due. The only
  addition the redesign makes to the profile is a `null` profile for the deferred types, which U1b
  handles (a null profile is never passed to `nextSlot`).
- **U6a** — the Greenhouse list and detail-by-id, merged with `detailMode` still `IN_LIST`, so nothing
  changes in behaviour until U10.

**Next, with no DDL and no open question:** U1b (after U1a), then U3, then U8a (after U1b).

**Waiting:**

| Unit   | Waits on                                                                           |
| ------ | ---------------------------------------------------------------------------------- |
| U2, U4 | their predecessor in the chain; production DDL with DevOps companions U2-D, U4-D   |
| U5a    | U4 and **question 6** (pending)                                                    |
| U5b    | U5a, U10, and phase 4 publishing the recruiter queue                               |
| U10    | U3, U6a, and phase 4's evaluation worker (`job_dirty_work` consumer, Task 4.6 S4a) |
| U11    | U2 (`request_count`) and **question 11** (the budget numbers)                      |
| U8c    | U8a, U11, **question 12** (how supervised smokes are approved), DevOps U8-D        |
| U9     | U7 merged, one release, the owner's separate word                                  |
| U12    | everything else, and the owner's word                                              |

- **Routing** (`orchestration-routing.md`): **single pipeline**. U1b, U3, U2, U10 and U11 all edit
  `JobRunLedger` or the claim path, and U5a and U5b both edit the notification registry, so they are
  sequential by file overlap. Pairs may run side by side when their files are disjoint (U1a with U6a;
  U8a with U3; U5a with U7). Never three disjoint tasks at once, so no wave fan-out and no
  `routing_decision` line.
- **Gate before U3 merges:** T5's own preconditions still hold (T6 transport wiring is merged, PR #1165).
  U3 switches unattended collection from once a day to every 10 minutes; every not-yet-enabled source's
  first live request still needs the owner's word.
- **Production DDL (prod data path, backlog 337 lesson):** U2, U4 and U8c ship their SQL **staged** in
  `apps/api/drizzle/manual-staged/`, and each has a **DevOps companion** (U2-D, U4-D, U8-D) that, in one
  change: moves the file to `manual/`; adds its apply step to `scripts/devops/deploy-stack-on-vps.sh`
  **after its predecessor** (the store migration for U2, U2's file for U4); passes `--single-transaction`;
  adds it to the hard-required file list and the scp source list; and adds the runbook entry. The
  wiring gate `check-prod-ddl-wiring.py` then enforces it. **U10 needs no DDL** (the dirty-work `reason`
  is free text, the entity kind `SOURCE_RECORD` exists); U10 verifies this on a scratch database before
  writing code, and if it is wrong it becomes a staged file with a companion.
- **Real-Postgres** in every DB unit means a scratch database built from the migrations, connected **as
  `crm_app`** (the least-privilege role), with `DATABASE_URL` set inline; never `crm_db`.

### Units

**U1a — `nextSlot` (pure).** New `job-sourcing/scheduling/next-slot.ts` (`nextSlot`, the `FetchProfile`
type, the stagger hash). No caller yet. **Model:** sonnet, medium. **Reviewers:** code, spec.
AC (each a unit test that fails before the code exists):

1. Profile 60 / 180, window `Europe/Berlin` 08:00–19:00 Mon–Fri, stagger 7: `now` Tuesday 10:20 Berlin →
   11:07 Berlin.
2. `now` Tuesday 18:30 Berlin → the first off-grid slot at or after 19:00 (stagger 7, step 180).
3. `offIntervalMinutes: null`, `now` Friday 18:30 → Monday 08:07.
4. `Europe/Kyiv` 2027-03-28 (spring forward): a 03:30 local slot resolves to 04:00 local.
5. `Europe/Kyiv` 2027-10-31 (fall back): a 03:30 local slot is returned once; a call just after its first
   occurrence returns the next grid slot, not the repeated 03:30. The same two cases for
   `America/New_York` (2027-03-14, 2027-11-07).
6. Level 1 skips exactly one slot; level 4 caps at 24 h; a floor larger than the gap pushes past a slot.
7. `fixedSlots` returns the next listed local time.
8. An unknown zone throws `RangeError` through `nextSlot`. The no-slot branch (no slot within 8 local days)
   throws `RangeError` too, but is demonstrated through the exported `firstSlotAfter` on a hand-built
   shape, not through `nextSlot` (amended 2026-10-26: a valid profile always has a slot).
9. Over 1,000 seeded-random `now` values across 2027 in three zones: the result is after `now`, lies on
   the grid, and at level 0 with no floor never skips a slot.
10. The spec runs under the `tz:Europe/Kyiv` and `tz:America/Los_Angeles` projects of `apps/api`.

**U6a — Greenhouse list at ingest, detail by id.** The adapter gains the list request without `content`
(R2) and a function that fetches one posting's detail by id (address built from the validated board and
id, never from response text). The manifest gains `detailMode` (`IN_LIST` | `ON_DEMAND`) and
`detailPerRun` per type; Greenhouse stays `IN_LIST` (`content=true`) until U10 switches it. Fixtures
only: **no live request**. **Model:** sonnet, medium. **Reviewers:** code, spec; specs by AutoTest.
AC: (1) in `ON_DEMAND` mode against a fixture board of 3 jobs, a run makes exactly 1 request and stores 3
revisions with no description; (2) the detail function against a fixture returns the description and a
detail 404 is the adapter's answer (T6's status policy), not `TRANSIENT_NETWORK`; (3) in `IN_LIST` mode
the request is the `content=true` URL, byte for byte as today; (4) a list over the byte cap is refused
before parse.

**U1b — the profile in the manifest, `nextSlot` in the ledger.** `EntryDefinition` and `TypeDefinition`
gain `fetchProfile` (section 1; `null` for SmartRecruiters, Jobgether and Hacker News) and lose
`intervalHours`; `manifest.definitions.ts` gets section 8's values; the ledger catalog carries the
profile; `JobRunLedger`'s `account` calls `nextSlot` with `clock_timestamp()` read **once** in the
finishing transaction and used for both `ended_at` and `now`; `JobSourceAdminService`'s next-due
derivation follows; the drift test gains section 1's refusals. **Depends on:** U1a. **Model:** opus, high
(the ledger is where phase 3's hardest defects were). **Reviewers:** code, spec.
AC:

1. Real-Postgres as `crm_app`: a finished run of a source with a 60-minute Berlin profile has
   `next_attempt_at = nextSlot(ended_at, profile, …)` exactly.
2. Setting that row's `min_interval_hours` to 1 changes nothing (the column is not read).
3. A `COST_STOP` ending still waits for the meter reset (`GREATEST`); a failure still writes
   `cooldown_until`.
4. The drift test refuses each case in section 1 (one test per refusal), including a Remotive schedule
   whose daily attempts exceed `hostRate.perDay`, and fails if any of the three deferred types has a
   non-null profile.
5. Real-Postgres: a source with a `null` profile is never due by schedule.
6. The admin listing's next-due equals the ledger's next slot for a seeded row.

**U3 — tick, sweep, and the 05:00 handler narrowed.** `JobSourcingCronService` gains the tick and the
sweep (section 5); `handleDailyCollection` keeps DOU and retention only; the due predicate,
`claimDue` and `countDue` gain the sweep variant. **Depends on:** U1b. **Model:** opus, high (claim
predicates under concurrency). **Reviewers:** code, spec.
AC:

1. The decorators: tick `*/10 * * * *`, sweep `0 8 * * *`, both `Europe/Kyiv`; the 05:00 handler claims
   no API-type source (spy on `startDue`).
2. A tick window ends within 9 minutes even while work is due (fake monotonic clock).
3. Real-Postgres as `crm_app`: a sweep claims every enabled API-type source with a non-null profile
   exactly once, including one whose `next_attempt_at` is tomorrow; a second sweep call the same Kyiv day
   claims none.
4. Real-Postgres: the sweep claims none of: a source on a paused host, at the failure cap, under
   cooldown, past its `readinessAt` deadline, `PAUSED` / `RETIRED`, with trigger mode `MANUAL`, or with
   a `null` profile.
5. Real-Postgres: two concurrent ticks with the same key create one cycle and no second claim of any
   source.
6. Real-Postgres: a tick claims a source whose slot passed and not one whose slot is one minute ahead.

**U8a — board data files and the generator.** One data file per ATS provider; the generator in the
manifest builder; the 13 existing boards moved into the files with their regions; drift-test
validation of every line. No database change: a new line yields a manifest entry whose row does not exist
until U8c. **Depends on:** U1b (the profile). **Model:** sonnet, medium. **Reviewers:** code, spec.
AC: (1) the generated entries for the 13 moved boards equal today's entries field for field, except the
profile; (2) a line with an unknown zone, a bad token or a duplicate token fails the drift test; (3) a
line with `evidence: null` yields an entry the readiness rules keep from being due.

**U8b — discovery query (read-only).** A query over stored source records' URLs that lists board tokens
of the six providers not yet in a board file, with counts of opportunities and matches. Sends no request.
**Depends on:** U8a. **Model:** sonnet, medium. **Reviewers:** code, spec.
AC: against seeded records with URLs of each of the six shapes plus a non-matching URL, the query returns
the six tokens and not the seventh; a token already in a board file is not returned.

**U2 — run metrics and the slow-down (DDL).** A staged SQL file adding the six run columns and
`job_sources.slowdown_level smallint NOT NULL DEFAULT 0 CHECK (slowdown_level BETWEEN 0 AND 4)`
(`IF NOT EXISTS`, re-runnable); the Drizzle schema; the run context counts requests, bytes, the last
status and validators; `savePage` keeps the newest `published_at` seen; the bounded JSON and XML readers
yield the envelope fingerprint; `account` moves `slowdown_level` (section 4) and `nextSlot` reads it.
**Depends on:** U3 (both edit `JobRunLedger`). **Model:** opus, high. **Reviewers:** code, spec,
**security (mandatory: a Drizzle migration)**. **Companion:** U2-D.
AC:

1. The SQL applies twice on a scratch database without error, and the catalog check passes with
   `crm_app` able to write the new columns through its existing grants and nothing more.
2. A fixture run of 3 requests records `request_count` 3 and `bytes_read` equal to the three bodies.
3. A run ending `RATE_LIMIT` raises `slowdown_level` by 1, a clean run lowers it by 1, it never leaves
   0..4, and the CHECK refuses 5 (as `crm_app`).
4. Two responses whose field names differ give different fingerprints; the same names in another order
   give the same one.

**U2-D, U4-D, U8-D — deploy wiring (DevOps).** Each does the five steps listed under "Production DDL" for
its file. **Model:** sonnet, medium. **Reviewers:** code, **security (mandatory: production DDL)**.
AC: the wiring gate lists the file; a CI check fails if its apply line lacks `--single-transaction`
(backlog 337's "check on closing"); the apply step comes after its predecessor.

**U4 — the health event log, detectors and the pass (DDL).** A staged SQL file for
`job_source_health_events` with append-only triggers; the privilege manifest class (`SELECT`, `INSERT`
only); `job-sourcing/health/` with the pure detectors and `classifyHealth`; the detector pass at the end
of each tick window. **Depends on:** U2, U3. **Model:** opus, high. **Reviewers:** code, spec,
**security (mandatory: a Drizzle migration and an append-only table)**. **Companion:** U4-D.
AC:

1. One unit test per detector, each from a seeded run history that triggers it and one that does not.
2. Precedence: a source both `CAPPED` and `SILENT` is `CAPPED`.
3. Real-Postgres as `crm_app`: two passes over unchanged data write one event, not two; `UPDATE` and
   `DELETE` on the table are refused.
4. A `304` run does not count toward `EMPTY_RESPONSE` (with U6b; until then, a seeded `304` ending).
5. `error_sample` is bounded at 500 characters and the `evidence` JSON at 8192.

**U6b — conditional requests.** The shared fetch sends `If-None-Match` / `If-Modified-Since` from the
checkpoint for a host that has shown validators, and maps `304` to a clean run with `received = 0`.
**Depends on:** U2. **Model:** sonnet, medium. **Reviewers:** code, spec.
AC: against a fixture server, the second request carries the stored validator and a `304` ends the run
clean without touching any source record.

**U10 — detail on demand.** Section 6a: the `DETAIL_FETCH` reason and a claim filtered by source in
`DirtyWorkStore`; the enqueue from evaluation, and the evaluation rule (pending detail never excludes on
stack grounds); the run worker's detail tail and scope `DETAIL_ONLY`; the 08:30 weekday detail pass and
its predicate variant; Greenhouse switched to `ON_DEMAND`. **Depends on:** U3, U6a, and phase 4's
evaluation worker. **Model:** opus, high (claims, fencing, external requests). **Reviewers:** code, spec.
**Precondition (SR-M-1 of the U6a review, 2026-10-26):** the evaluation rule is implemented and tested
**before** any source is switched to `detailMode: 'ON_DEMAND'` (empty body + a department tag + a title
without a stack keyword is not excluded; `lowInformation` false when a tag exists, `coreMismatch` wins).
U10 sends `FOUND.fields` through `buildNormalizedPosting`, never straight to a store or renderer; confirms
adapter version `greenhouse-2`; keeps the parser error fragment (up to 200 characters of a `PARSE_DRIFT`
detail) out of logs and persistence. See section 6a.
AC:

1. Real-Postgres as `crm_app`: an evaluation that yields `TRIAGE` for a list-only record enqueues one
   `DETAIL_FETCH` row; a second evaluation of the same version enqueues none.
2. A run of a Greenhouse source with 2 pending rows and `detailPerRun` 1 fetches exactly 1 detail after
   its list request; the fetched detail lands as a new revision with `description_sha256` set, and the
   row is `DONE`.
3. A record with a detail fetched for its current list version gets no new row; a changed list version
   for a still-wanted opportunity gets one.
4. A detail answered 403 ends the run, pauses the host, and the row is claimable again only after the
   pause; a 404 records availability evidence and the row is not retried.
5. The detail pass claims only sources with pending rows and sends no list request.
6. An HR read of an opportunity with no detail returns the list fields and the original link and sends no
   request to any provider (a spy on the transport).
7. An opportunity with a pending detail and no stack in its title is `TRIAGE`, never `EXCLUDED`.

**U11 — request-counting host budget.** `hostRequestBudget { perMinute, perHour }` per host in the
manifest; `claimHostSlot` refuses `HOST_REQUEST_BUDGET` when the requests of the trailing window (from
`request_count`, plus the expected requests of runs still `STARTED`, plus the claim's own) would exceed
it. **Depends on:** U2, question 11. **Model:** opus, high (T8's claim path). **Reviewers:** code, spec,
security (the claim path that holds the ban-risk line).
AC: (1) Real-Postgres as `crm_app`: with a budget of 4 a minute and 6 one-request boards due, at most 4
are claimed in a minute and the rest are claimed later in the order of `next_attempt_at`; (2) a running
run's expected requests count against the budget; (3) a host with no declared budget behaves as T8.

**U5a — ADMIN alerts and the weekly report.** New notification types in the registry, `uk` and `en`
copy through Lingui, recipients = active ADMIN users, the per-source daily cap of 3 emails, the weekly
report cron. **Depends on:** U4 and **question 6**. **Model:** sonnet, high. **Reviewers:** code, spec,
**security (mandatory: who receives operational data)**, copy.
AC: (1) entering `FAILING` enqueues one notification per active ADMIN and none to any other role; (2)
staying `FAILING` across passes enqueues nothing more; (3) a fourth alerting transition of one source in
one Kyiv day is in-app only; (4) a deactivated ADMIN receives nothing. **Before writing:** check whether
the database constrains the notification type; if it does, the type is DDL and U5a gains a staged file
and a DevOps companion.

**U5b — the HR digest.** A 09:00 Kyiv job, Monday to Friday; per HR user, the team's new queue entries
since the previous digest and the source line; email through the outbox by the recipient's locale.
**Depends on:** U5a (registry), U10, and phase 4 publishing the recruiter queue (outside this ADR).
**Model:** opus, high (team-scoped data). **Reviewers:** code, spec, **security (mandatory: team
scoping)**, copy.
AC: (1) against the real backend, an HR user's digest contains only their own team's opportunities (a
seeded second team's entry is absent); (2) an HR user with nothing new and no source problem gets no
email; (3) a source that failed today appears in the line with its reason; (4) the cron fires on a
seeded Friday and not on a seeded Saturday or Sunday in `Europe/Kyiv`, and Monday's digest includes the
weekend's entries; (5) an entry whose detail is pending is listed with its list fields and link.

**U7 — the source page.** ADMIN-only endpoints (list with state and freshness; one source's runs and
events; `POST` a note, a bounded string through Zod `.parse()`), `@Roles('ADMIN')` **and** a role check in
the service body (the no-op `RolesGuard` lesson), `@Throttle` on the `POST`; the web page; `@crm/shared`
replaces `minIntervalHours` with a profile summary. **Depends on:** U4. **Model:** opus (RBAC).
**Reviewers:** code, spec, **security (mandatory: RBAC)**, design (design gate: UI), copy, manual QA.
AC: (1) every endpoint answers 403 to each non-ADMIN role against the real backend; (2) a note is stored
as a `NOTE` event with the actor and cannot be edited; (3) the page renders at the four responsive
breakpoints.

**U8c — board batches (production data).** For each approved batch from U8b: the lines appended to the
board files, the staged seed delta (`enabled = false`), then the supervised smoke of each board (one list
request at the host budget, stop at the first refusal), then a delta enabling the boards that passed
with their evidence. **Depends on:** U8a, U11, question 12, DevOps U8-D (once). **Model:** sonnet,
medium. **Reviewers:** code, spec, **security (production data)**.
AC: a board without recorded evidence is never due; a refusal during a batch's smokes stops the batch
and leaves every untried board disabled.

**U9 — drop `min_interval_hours` (DDL, irreversible).** Only after U7 has removed the last reader and one
release has passed, and only on the owner's separate word. **Model:** opus. **Reviewers:** code,
**security (mandatory)**.

**U12 — connect the deferred sources (Q8).** SmartRecruiters (switched to `ON_DEMAND` detail), Jobgether
and Hacker News get their section 8 profiles; each first call is a supervised smoke. **Depends on:**
everything above and the owner's word. **Model:** opus. **Reviewers:** code, spec, security.

## Open questions

🟠 Decisions from you — 3 · source fetch strategy · PR #1172
Everything else is decided. U1a and U6a start now; nothing listed below blocks them.

❓ 6 (pending, re-asked) — Should the admins get an email when a job source breaks?
What happens: the CRM checks all job sources every 10 minutes. When a source goes from "working" to
"broken", **every admin** gets one message inside the CRM and one email. While it stays broken, no more
emails come; when it works again and later breaks again, a new one comes. No more than 3 emails a day
about the same source. Every **Monday at 09:00** each admin also gets one summary email: how every
source did last week.
"Broken" means one of these, for example:

- **Failing:** a site errored three times in a row and the CRM stopped asking it until an admin resets it.
- **Empty:** a site we read every hour suddenly returns zero jobs.
- **Changed format:** a site changed how it sends jobs and we can no longer read them.
- **Blocked:** a site answered "too many requests" or "access denied", so the CRM paused it for a day.
- **Not allowed:** a source can no longer run, for example Recruitee after its free access ends.

➡️ I recommend: yes, exactly as described, to all admins.
🔓 Reversible · ⏱ silence until 2026-10-29 12:00 Kyiv → I take the recommendation, rollback = one PR.

❓ 11 — How fast we may ask one job site when we watch hundreds of its employers
With "everything we can get", one site (Greenhouse, for example) may host hundreds of boards. Asking each
hourly means 15 requests a minute to that site all day, and nobody publishes the limit. A per-site limit
keeps us safe; boards are then asked less often as the list grows (200 boards: every 1.7 h; 1,000:
every 8 h).
➡️ I recommend: start at 2 requests a minute per site (120 an hour), raise it in steps after two weeks
without a refusal.
🔓 Reversible · ⏱ silence until 2026-10-29 12:00 Kyiv → I take it, rollback = one number.

❓ 12 — Approving the first request to new boards in batches
Your rule is that each board's first live request is supervised. At hundreds of boards, asking you per
board is not workable.
➡️ I recommend: you approve a **batch** (for example 50 boards from the discovery list) in one message;
an agent sends one request per board at the site limit, stops the whole batch at the first refusal, and
reports which boards passed.
🔒 Each first request to a site is irreversible in the sense of your rule. Without an answer no new board
is contacted.

## Assumptions (A1, decided and recorded)

- The fetch profile is manifest code, not a database column or a seed delta.
- Time-zone arithmetic uses `Intl.DateTimeFormat` offset resolution (the `kyiv-day` pattern); no new
  date dependency.
- The stagger is derived from a hash of `manifest_id`, not declared.
- The tick is 10 minutes with a 9-minute window and per-tick cycle keys; no enum value is added (sweep
  and detail-pass runs are `SCHEDULED`).
- `handleDailyCollection` keeps DOU and retention at 05:00; `handleHtmlCollection` is unchanged.
- Claims use no early-due slack; `MAX_EARLY_DUE_SLACK_MS` remains only `countDue`'s look-ahead.
- `SCHEMA_DRIFT` is a reason within `DEGRADED`, not a state.
- The current health state is derived from the latest event; no state column.
- Duration is `ended_at − started_at`; no column.
- Conditional-request validators live in the run checkpoint; no column.
- Detector thresholds are constants in one module (section 10).
- The slow-down cap is level 4 and 24 hours.
- No new environment variable; the sweep and the detail pass reuse `JOB_COLLECTION_WINDOW_MS`.
- Detail on demand reuses `job_dirty_work` (reason `DETAIL_FETCH`) as its queue and immutable revisions
  plus `job_text_blobs` as its cache; the detail TTL is "list version changed, or older than 14 days".
- The sweep runs every day (availability); the detail pass and the digest run Monday to Friday.
- Workable stays `IN_LIST` until a supervised capture shows its list without `details=true`.
- Board discovery reads only URLs already stored; it never contacts a provider.
- The deferred types are kept out by a `null` profile and `enabled = false`, not by deleting anything.

## What this ADR does not decide

- Whether the four terms clauses are lawful to rely on: the owner accepted them as a known risk without a
  legal review (Q10). Revisit if a provider objects.
- How `availability` is written from the sweep's evidence (phase 4's store).
- How phase 4's evaluation worker and recruiter queue are built (U10 and U5b depend on them).
- Retention of cycles and runs (a backlog item when U3 merges).
- Phase 5's HTML sources.

## Verification

Each claim about `main` above names a symbol; this checks the load-bearing ones on any later commit:

```bash
grep -n "cadenceHoursAtFloor" apps/api/src/job-sourcing/ownership/job-run-ledger.ts   # U1b removes it
grep -n "@Cron" apps/api/src/job-sourcing/job-sourcing.cron.ts                        # 0 5, 30 2 until U3
grep -n "MAX_EARLY_DUE_SLACK_MS =" apps/api/src/job-sourcing/scheduling/due-policy.ts
grep -n "minIntervalHours" packages/shared/src/schemas/job-sourcing.ts                 # U7 removes it
grep -rn "first_seen_at" apps/api/drizzle/manual/2026-10-17_job_opportunities_store.sql
```

The provider facts are verified by re-reading the pages listed in the research file, before its expiry.

## Sources

- The owner's request (2026-10-25), green light and answers to the decision brief (2026-10-26), relayed
  by Master.
- `docs/architecture/2026-10-24-job-source-run-ownership.md`: T3, T4, T5, T8, T9.
- `docs/architecture/2026-10-26-source-fetch-provider-research.md`: rows R1–R29.
- `.claude/tasks/BACKLOG-followups.md` entries 337, 340, 341.
- `main` at `3c545f619` (2026-10-26): `JobSourcingCronService`, `runCollectionWindow`, `JobRunLedger`
  (`countDue`, `claimDue`, `account`), `cadenceHoursAtFloor`, `claimHostSlot`, `recordHostBan`,
  `generateSeedDelta`, `JobSourceAdminService`, `jobSourceSchema`, the 2026-10-17 store migration
  (`job_source_records`, `job_source_record_revisions.description_sha256`, `job_text_blobs`,
  `job_dirty_work`), `DirtyWorkStore`, the `layer1` and `tech-match` description inputs, the Greenhouse,
  SmartRecruiters, Workable and Ashby adapters' list and detail modes, the notification email outbox.
- `CONTEXT.md` (Job source, Job opportunity, Submission), `.claude/rules/common/autonomy-levels.md`,
  `orchestration-routing.md`, `model-routing.md`, `doc-durability.md`.
