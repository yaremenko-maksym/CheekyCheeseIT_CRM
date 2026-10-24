# Source fetch strategy: timing, safety and health tracking per source (DRAFT PROPOSAL)

**Status:** Proposal (2026-10-25), not decided. Written at the owner's request. Nothing here runs today: no source is
runnable until Task 2.5's chain (T3, T7, T6, T5) is merged. **Every provider fact below is either taken from this
repository (REPO) or is an assumption to verify against the provider's own documentation before the source is enabled
(VERIFY).** Companion: `2026-10-24-job-source-run-ownership.md` (the ledger, host state, due predicate).

## 1. What the owner asked for

1. **09:00 daily (Europe/Kyiv):** one sweep over ALL enabled sources, a refetch of known vacancies (availability) and a
   digest email to HR. HR applies; submission is not automated.
2. **Between sweeps:** every other source is fetched regularly to collect fresh vacancies. **The owner's working
   baseline: once an hour.** Each platform can have its own timing, and its working-hours window follows its region.
3. **Safety first:** the rate must be safe and sources must not drop away.
4. **Health tracking:** we must know when a source starts to disappear (degrade, go silent, fail) and be able to trace the
   cause.

## 2. The mechanism (one design for every source)

A per-source **fetch profile** in the manifest (data, not code) and a pure function that turns it into the next allowed
attempt time.

| Field                  | Meaning                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `intervalMinutes`      | the interval inside the active window; **default 60** (the owner's baseline)                    |
| `offIntervalMinutes`   | interval outside the window (nights, weekends); `null` = do not poll; default 180               |
| `window`               | `{ timeZone, days, from, to }` in the provider's region (default 08:00-19:00 Mon-Fri), not Kyiv |
| `providerFloorMinutes` | the provider's own minimum gap (REPO: Remotive 6 h)                                             |
| `hostBudget`           | requests per minute and per day on the host (T8's `claimHostSlot` enforces it)                  |
| `staggerMinute`        | a fixed offset per source (hash of the id modulo the interval) so sources never fire together   |
| `conditional`          | `ETag` / `If-Modified-Since` where the host supports it (VERIFY per host)                       |
| `scope`                | what a routine poll reads (for example only the first pages of a feed) vs the full 09:00 sweep  |

- `nextAttemptAt` is computed when a run ends (`finish`, T3) as `nextSlot(now, profile)`: pure, unit-testable,
  daylight-saving safe (IANA zones), with the failure backoff applied. The due predicate (T4) keeps comparing timestamps.
- **One handler every 10 minutes** asks the ledger for due sources (an hourly baseline needs no faster tick: each source
  is due once an hour at its own stagger slot). **The 09:00 handler** opens a cycle that makes every enabled source due
  once, and **the digest job** runs when that sweep is complete. This replaces T5's two daily handlers.
- **The strictest limit wins:** provider floor, host budget, quota, ban pause, failure cap.
- **Inherited rules (owner decisions):** free sources only; stop on 403/429 and never evade; no authentication, no writes;
  an `UNCLEAR` source runs only with its recorded owner decision; one run per host.
- **Freshness is measured, not promised:** `first_seen_at - published_at` per source (both exist). Where the provider
  gives no trustworthy publish date, `first_seen_at` is the clock; the first sweep of a source never counts as fresh.

## 3. Strategy per source (hourly baseline; exceptions only where a hard limit forces them)

Intervals are for the active window; outside it, the off interval. Windows are working hours of the employer's or
platform's region unless stated.

### 3.1 Employer boards (public, no key): the freshest class

Today the manifest holds 13 boards (REPO: Greenhouse 3, Lever 2, Ashby 2, Workable 2, Personio 2, Recruitee 1,
SmartRecruiters per its definition). Volume is trivial; **freshness is limited by the list of employers we watch**, a
product decision (a watchlist kept by seniors/HR, plus boards that produced matches).

| Source          | Facts (REPO)                                                                                                                                  | Interval                    | Notes                                                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Greenhouse      | `first_published` is the publish date; `updated_at` is an update (differs for 712 of Stripe's 720 jobs); `content=true` is 2.7-8 MB per board | 60 min, weekends 180        | Hourly fetches must not download `content=true` each time: poll the list without content (about 147 KB measured for Airbnb) and fetch content for new or changed ids only (adapter change). |
| Lever           | `createdAt` epoch ms is the only date (a proxy)                                                                                               | 60 min                      | Cheap pages.                                                                                                                                                                                |
| Ashby           | `publishedAt` = last publish, a re-publish moves it (accepted churn); boards up to 13.9 MB                                                    | 60 min                      | Same list-then-detail concern for large boards.                                                                                                                                             |
| Workable        | `published_on` is a date only; all tenants call `apply.workable.com`                                                                          | 60 min                      | One host key for all tenants: the budget is shared, so many tenants may need a longer interval each.                                                                                        |
| Recruitee       | `published_at`, `updated_at`, `close_at`; the tenant is in the host; **free access ends 2027-02-10**                                          | 60 min until the deadline   | The adapter stops by itself at the deadline.                                                                                                                                                |
| Personio        | XML feed, `createdAt` only; language-keyed                                                                                                    | 60 min                      | Cheap XML.                                                                                                                                                                                  |
| SmartRecruiters | accepted-risk (robots.txt disallows us); up to 400 requests per attempt; **no real payload capture yet**                                      | 180 min, working hours only | The first call is a controlled smoke. Stop at the first 403/429. Small boards only.                                                                                                         |

### 3.2 Public feeds with a delay or a short window: limits decide

| Source                 | Facts (REPO)                                                                                        | Interval                                       | Notes                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Remotive               | **24 h publication delay**; vendor limit about 4 requests a day, 2 a minute; floor 6 h; attribution | 4 fixed runs: 09:00, 13:00, 17:00, 21:00 Kyiv  | Hourly is NOT allowed here. It can never be fresh. The 4-a-day limit is shared by its 3 category entries. |
| Jobicy                 | last 7 days, **3 h publication delay**, cursor trusted 23 h, status calls metered                   | 120 min                                        | Hourly adds nothing under a 3 h delay.                                                                    |
| Himalayas              | browse cursor, 20 per page, `pubDate` is the last UPDATE                                            | 60 min, first 2-3 pages                        | `first_seen_at` is the clock. Terms require the tracked apply URL.                                        |
| RemoteOK               | newest feed, legal object first, attribution                                                        | 60 min                                         | One request; VERIFY the terms' rate guidance.                                                             |
| Arbeitnow              | feed **re-ordered hourly**, up to 300 items a page, page 1 about 4.2 MB                             | 60-120 min, pages 1-2                          | A full 5-page sweep (about 15-20 MB) only at 09:00. VERIFY conditional requests.                          |
| We Work Remotely (RSS) | holds only the 10 newest per category; measured age gap of the busiest category **57.4 h**          | 60 min                                         | Far below the bound; re-measure before widening.                                                          |
| Djinni (RSS)           | the newest **100** postings per filter, about 3.1 h at peak, no employer in the feed                | 60 min, Kyiv 08:00-20:00; 120 min off          | **A gap over about 3 h loses postings**: this is an upper bound on the interval. Hourly is safe.          |
| Hacker News            | one thread a month; accepted-risk                                                                   | every 2 h on days 1-4 of the month, then daily | Chosen by title, never by position.                                                                       |
| Jobgether              | paged, at most 10 x 25; rate 60/min, robots `Crawl-delay: 2`; accepted-risk                         | 120 min                                        | Never exceed the documented rate.                                                                         |

### 3.3 Key or quota APIs (free-only rule): not polling sources

| Source     | Facts                                                   | Strategy                                                                              |
| ---------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| JSearch    | **200 requests a MONTH**, hard; owner: spot checks only | No schedule. Manual runs only.                                                        |
| TheirStack | **200 credits a month**, 1 per job returned             | No schedule. Discovery of NEW employers for the watchlist (hard filters, limit 5-10). |
| Jooble     | quota unpublished, no real capture yet                  | Smoke once; then the 09:00 sweep only until the quota is known.                       |
| Reed       | UK only, quota unpublished, no real capture yet         | Smoke once; then the 09:00 sweep only.                                                |

### 3.4 Legacy and blocked

| Source                  | State                                                                              | Strategy                                                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DOU (RSS, legacy)       | the only LIVE source; runs once a day at 05:00 on its own path                     | First candidate for an hourly cadence (Kyiv 08:00-20:00); needs its own terms check and the plan's compatibility barrier (its `lastCollectedAt` semantics). |
| The Muse                | blocked: terms require a registered app; rate 500 requests an hour unauthenticated | Skip until the owner decides.                                                                                                                               |
| Working Nomads          | blocked: no documented permission                                                  | Skip.                                                                                                                                                       |
| EU Remote Jobs          | blocked: the committed feed is the wrong one (zero items)                          | Needs the right feed URL.                                                                                                                                   |
| The seven `_HTML` types | blocked, phase 5                                                                   | Out of scope.                                                                                                                                               |

## 4. Safety: how sources are kept from falling away

Layers, from the cheapest to the strictest. Each is a rule the system enforces, not a convention.

1. **Be a polite client.** One run per host, a per-host request budget (T8), a stagger offset and jitter so there are no
   bursts, conditional requests where supported, a fixed identifying `User-Agent`, honour `Retry-After`, never exceed a
   documented limit, a response size cap per source (REPO: 8-10 MiB, pre-parse node bound).
2. **Slow down before stopping.** On a 429 or repeated 5xx the source's interval doubles (up to a cap) and recovers one
   step after each clean run, before the failure cap is reached.
3. **Stop on refusal, never evade.** 401/403/451/429 ends the run, records a ban pause on the host (24 h minimum, 30 days
   cap), and no sibling run sends anything after it.
4. **Cap repeated failure.** Three consecutive failures take the source out of the schedule until an ADMIN resets it
   (T9). A source never retries in a loop.
5. **Isolate bad data.** An invalid record is quarantined without stopping the source; a body that is too large, too
   deep or malformed is refused before it is parsed.
6. **Evidence before enabling.** A source with no real payload capture is not activatable; its first call is a smoke.
7. **A schedule that matches the provider's own rhythm.** Delays and short windows (section 3.2) set the interval, not
   our wish.

## 5. Source health and root-cause tracking

The goal: know that a source has begun to disappear, and be able to say why and since when.

### 5.1 What we already record (REPO: `job_collection_runs`)

Per run: `outcome`, `coverage`, counters `received`, `created`, `revised`, `unchanged`, `duplicates`, `invalid`,
`persistenceErrors`, `errorCode` (one of ACCESS_POLICY, RATE_LIMIT, TRANSIENT_NETWORK, UPSTREAM, PARSE_DRIFT,
INVALID_RECORD, PERSISTENCE, COST_STOP, CANCELLED, DEADLINE, PAGE_CAP, CURSOR_CYCLE, PAYLOAD_TOO_LARGE,
ADAPTER_INVARIANT), `errorMessage`, `adapterVersion`, `configVersion`, a snapshot of the source config and timestamps.
So health can be computed from data that already exists. **To add (small):** `durationMs`, `requestCount`,
`bytesRead`, `lastHttpStatus`, `oldestItemAgeHours`, and `envelopeFingerprint` (a hash of the set of field names the
response carried, to see a provider changing its format before parsing fails).

### 5.2 Health states

`HEALTHY`, `DEGRADED` (partial: invalid share up, slower, throttled), `SILENT` (technically fine, but no new vacancies
for far longer than usual), `EMPTY` (the provider answered with nothing: the wrong-feed case), `FAILING` (consecutive
failures), `PAUSED` (ban pause), `CAPPED` (failure cap reached), `BLOCKED` (policy, deadline or missing evidence).

### 5.3 Detectors (pure functions over the run history; thresholds are proposals)

| Detector           | Rule                                                                                                                | Reason code                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Volume drop        | `received` over 24 h below 30% of the 14-day median for the same weekday, source with a stable baseline             | `VOLUME_DROP`                 |
| Silence            | no `created` for several times the usual gap between new items (from the source's own history) while `received` > 0 | `NO_NEW_ITEMS`                |
| Empty answer       | `received` = 0 on a source that normally returns items                                                              | `EMPTY_RESPONSE`              |
| Format drift       | `PARSE_DRIFT`, `invalid / received` above 10%, or a changed `envelopeFingerprint`                                   | `SCHEMA_DRIFT`                |
| Access change      | 401/403/451, a robots.txt change, repeated 429                                                                      | `ACCESS_CHANGED`, `THROTTLED` |
| Slowdown or growth | duration or bytes over 3x the baseline                                                                              | `SLOW`, `PAYLOAD_GROWTH`      |
| Stale answer       | the newest item older than the provider's own delay allows (a cached or reordered feed)                             | `STALE_FEED`                  |
| Board gone         | an employer board returns 404 or zero jobs after having had some                                                    | `BOARD_GONE`                  |
| Deadline           | a policy deadline (for example Recruitee 2027-02-10) approaching                                                    | `DEADLINE_NEAR`               |

### 5.4 Tracing the cause

An append-only **health event log** per source (new table): each state change records the time, `from` and `to` state,
the reason code, the evidence (run ids, metric values against the baseline), `first_bad_run_id` and `last_good_run_id`,
the adapter and config version at that moment, the HTTP status and an error sample, and the deploy commit. The source
page shows the run timeline, the event log and the difference between the last good and the latest response shape, with
correlation hints: "began after deploy X", "began after config version N", or "began with no change on our side"
(a provider-side change). A person can add a note (for example a provider announcement).

### 5.5 Alerts

- ADMIN: an immediate email on `FAILING`, `CAPPED`, `BLOCKED`, `SCHEMA_DRIFT`, `EMPTY`, and a weekly source report.
- HR: the 09:00 digest carries a line "sources that could not be refreshed today" with the reason, not an alarm.
- One incident per problem (open and close it), de-duplicated, quiet while a known incident is open.

## 6. What would need to be built (none of it exists)

1. The fetch profile in the manifest and a migration replacing `min_interval_hours` (whole hours, no window).
2. `nextSlot(now, profile)` in `finish`, with the failure backoff and the slow-down rule; the 10-minute handler and the
   09:00 cycle (extension of T5); the digest job (new).
3. Run metrics columns, the detectors, the health event table, the ADMIN source page (extends T9's listing) and alerts.
4. List-then-detail for Greenhouse and Ashby; conditional requests where supported.
5. A watchlist of employer boards with a region per board (product decision).

Suggested order: after T3, T7, T6, T5; then 1-2; then 3 (health) next to it, because a source we cannot see is a source
we will lose; then the adapter changes; DOU first because it is live.

## 7. Limits no design removes

- Sources with a publication delay (Remotive 24 h, Jobicy 3 h) and feeds with a short window (Djinni about 3 h, WWR 10
  per category) cannot be made fresh by polling faster.
- "Fresh" needs a trustworthy publish date; otherwise `first_seen_at` is the clock.
- The free-only rule removes the quota APIs from the polling set.
- A faster poll raises the ban risk; the accepted-risk sources get the longest intervals and stop at the first refusal.
- Every number here is a proposal until verified against the provider's documentation and measured freshness.
