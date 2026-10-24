# Source fetch strategy: how often, when and how safely each source is read (DRAFT PROPOSAL)

**Status:** Proposal (2026-10-25), not decided. Written at the owner's request: HR applies, receives one email
digest a day at 09:00, and every other source is fetched "as often as we safely can", each platform with its own
timing (working hours of its region). Nothing here runs today: no source is runnable until Task 2.5's chain
(T3, T7, T6, T5) is merged. **Every provider fact below is either taken from this repository (marked REPO) or is an
assumption that must be verified against the provider's own documentation before the source is enabled
(marked VERIFY).** Companion: `2026-10-24-job-source-run-ownership.md` (the ledger, host state, due predicate).

## 1. What the owner asked for

1. **09:00 daily (Europe/Kyiv):** one sweep over ALL enabled sources, a refetch of known vacancies (availability),
   and a digest email to HR.
2. **Between sweeps:** every other source is polled as often as it safely can be, to collect fresh vacancies; each
   platform has its own timing, and its working-hours window follows its region.
3. Applying is done by HR, so the goal is "HR sees the vacancy soon", not unattended submission.

## 2. The shape of the mechanism (one design for every source)

A per-source **fetch profile**, declared in the manifest (data, not code), and a pure function that turns it into the
next allowed attempt time:

| Field                   | Meaning                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `activeIntervalMinutes` | polling interval inside the source's active window                                    |
| `offIntervalMinutes`    | interval outside the window (nights, weekends); `null` = do not poll                  |
| `window`                | `{ timeZone, days, from, to }` in the provider's region, not Kyiv                     |
| `jitterPercent`         | random spread (default 20) so many boards never fire on the same second               |
| `providerFloorMinutes`  | the provider's own minimum gap (REPO: Remotive 6 h)                                   |
| `hostBudget`            | requests per minute and per day on the host (T8's `claimHostSlot` enforces it)        |
| `conditional`           | `ETag` / `If-Modified-Since` if the host supports it (VERIFY per host)                |
| `scope`                 | which part to read on a fast poll (for example only page 1 of a feed) vs a full sweep |

- **`nextAttemptAt` is computed when a run ends** (`finish`, T3) as `nextSlot(now, profile)`: pure, unit-testable,
  daylight-saving safe (IANA zones). The due predicate (T4) stays as it is: it only compares timestamps.
- **A frequent handler (every 5 minutes)** asks the ledger for due sources; **the 09:00 handler** opens a cycle that
  makes every enabled source due once, then **the digest job** runs when the sweep is complete. The ADR deleted the
  one-minute tick to remove a loop risk; it can come back safely now because failures are counted by how a run ended,
  a source stops being due after 3 consecutive failures, and one host never has two runs at once.
- **Never faster than the floors:** the strictest of provider floor, host budget, quota, ban pause and the failure cap wins.
- **Safety rules inherited from the owner's decisions:** free sources only; stop on 403/429 and never evade; no
  authentication, no writes; an `UNCLEAR` source runs only with its recorded owner decision; one run per host.
- **Freshness is measured, not promised:** record `first_seen_at - published_at` per source (REPO: both fields exist);
  where the provider gives no trustworthy publish date, `first_seen_at` is the clock and the first sweep of a source
  never counts as fresh (`INITIAL_SWEEP`).

## 3. Strategy per source

Intervals are proposals for the active window; outside it, use the off interval. Region windows are working hours of
the employer's or platform's region (08:00-19:00 local, Mon-Fri) unless stated.

### 3.1 Employer boards (public, no key): the freshest class

Today the manifest holds only 13 boards (REPO: Greenhouse 3, Lever 2, Ashby 2, Workable 2, Personio 2, Recruitee 1,
SmartRecruiters entries per its definition). Request volume is trivial; **what limits freshness is the list of
employers we watch**, which is a product decision (a watchlist kept by seniors/HR, plus boards that produced matches).

| Source          | Facts (REPO)                                                                                                                                                      | Active / off                       | Notes                                                                                                                                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Greenhouse      | board API, `first_published` is the publish date, `updated_at` is an update and differs for 712 of Stripe's 720 jobs; `content=true` pages are 2.7-8 MB per board | 15 min / 60 min, weekends 120 min  | Fast polls must NOT download `content=true` every time (about 5 MB x 60 a day x boards): poll the list without content (about 147 KB measured for Airbnb) and fetch content only for new or changed ids. Needs an adapter change (list then detail). |
| Lever           | `createdAt` epoch ms is the only date (a proxy for publication)                                                                                                   | 10-15 min / 60 min                 | Cheap pages; employer evidence from posting text (`TEXT_PARTIAL` on some boards).                                                                                                                                                                    |
| Ashby           | `publishedAt` = last publish, a re-publish moves it (accepted churn); boards up to 13.9 MB                                                                        | 15 min / 60 min                    | Same list-then-detail concern as Greenhouse for large boards.                                                                                                                                                                                        |
| Workable        | `published_on` is a date only (UTC midnight); every tenant calls `apply.workable.com`                                                                             | 15-30 min / 90 min                 | One host key for all tenants: the host budget is shared across tenants, so many tenants means a longer interval each. Intraday freshness is unknowable from the date: use `first_seen_at`.                                                           |
| Recruitee       | `published_at`, `updated_at`, `close_at`; the tenant is part of the host; **free access ends 2027-02-10** (token is the employer's)                               | 15 min / 90 min until the deadline | The adapter stops by itself at the deadline; plan to lose this source after that date. `banScope` per tenant.                                                                                                                                        |
| Personio        | XML feed, `createdAt` only (can precede publication); language-keyed                                                                                              | 30 min / 120 min                   | Cheap XML; one feed per tenant and language.                                                                                                                                                                                                         |
| SmartRecruiters | accepted-risk source (robots.txt disallows us); up to 400 requests per attempt; **no real payload capture yet** (`NO_API_CAPTURE`)                                | 120 min, working hours only        | First call is a controlled smoke, not a poll. Stop at the first 403/429 and keep the host paused. Use small boards only.                                                                                                                             |

### 3.2 Public feeds with a delay or a short window: hard limits decide the interval

| Source                      | Facts (REPO)                                                                                                 | Active / off                                              | Notes                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remotive                    | **publication delay 24 h**; vendor limit about 4 requests a day, 2 a minute; floor 6 h; attribution required | 4 fixed runs: 09:00, 13:00, 17:00, 21:00 Kyiv             | It can never be fresh (24 h late); the 09:00 sweep plus three more is the ceiling. Hold the 4-a-day limit across all 3 category entries together (`hostRate`). |
| Jobicy                      | last 7 days, **3 h publication delay**, cursor trusted 23 h, status calls metered                            | 120 min / none                                            | Polling faster than the delay adds nothing. Status refresh stays bounded (Task 4.6).                                                                           |
| Himalayas                   | browse cursor, up to 20 per page, `pubDate` is the last UPDATE, not publication                              | 60 min / 180 min                                          | `first_seen_at` is the clock; at most the first 2-3 pages on a fast poll. Terms require the tracked apply URL.                                                 |
| RemoteOK                    | newest feed, legal object first, attribution with link                                                       | 60 min / 180 min                                          | One request; VERIFY the terms' rate guidance.                                                                                                                  |
| Arbeitnow                   | feed **re-ordered hourly**, up to 300 items a page, page 1 about 4.2 MB, newest on the big pages             | 60-120 min (pages 1-2 only) / 240 min                     | A full 5-page sweep (about 15-20 MB) only at 09:00. VERIFY conditional requests.                                                                               |
| We Work Remotely (RSS)      | the feed holds only the 10 newest per category; the measured age gap of the busiest category was **57.4 h**  | 30-60 min / 180 min                                       | The interval must stay far below the 57.4 h bound; re-measure before widening. `pubDate` is not a posting date for renewed listings.                           |
| Djinni (RSS)                | the newest **100** postings per filter, about 3.1 h of postings at peak, no employer in the feed             | 30-60 min in Kyiv 08:00-20:00 / 120 min                   | **A gap longer than about 3 h loses postings**: this is an upper bound on the interval, not a preference.                                                      |
| Hacker News "Who is hiring" | one thread a month, comments arrive over days; accepted-risk decision                                        | 2 requests every 2 h on days 1-4 of the month, then daily | Selected by title, never by position; stale after 45 days.                                                                                                     |
| Jobgether                   | paged, at most 10 pages x 25; rate 60/min, robots `Crawl-delay: 2`; accepted-risk (ML clause)                | 120 min / none                                            | Keep to pages the budget allows; never exceed the documented rate.                                                                                             |

### 3.3 Key or quota APIs (free-only rule): not polling sources

| Source     | Facts                                                                   | Strategy                                                                                                                 |
| ---------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| JSearch    | **200 requests a MONTH**, hard (about 6 a day); owner: spot checks only | No schedule. Manual runs only, one request at a time.                                                                    |
| TheirStack | **200 credits a month**, 1 credit per job returned (about 6 jobs a day) | No schedule. Use for discovery of NEW employers to add to the watchlist (hard filters, `limit` 5-10), not for freshness. |
| Jooble     | quota unpublished ("set per key"), no real payload captured yet         | Smoke once; then at most the 09:00 sweep until the quota is known.                                                       |
| Reed       | UK only, quota unpublished, no real payload captured yet                | Smoke once; then the 09:00 sweep only.                                                                                   |

### 3.4 Not runnable, or legacy

| Source                  | State                                                                                           | Strategy                                                                                                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DOU (RSS, legacy path)  | the only LIVE source today; runs once at 05:00; own fetch path                                  | The best first candidate for a faster cadence (30-60 min, Kyiv 08:00-20:00) because HR works in Kyiv hours; needs its own terms check and care for its legacy `lastCollectedAt` semantics (the plan's compatibility barrier first). |
| The Muse                | blocked: permission (terms require a registered app); rate 500 requests an hour unauthenticated | Skip until the owner decides.                                                                                                                                                                                                       |
| Working Nomads          | blocked: no documented permission                                                               | Skip.                                                                                                                                                                                                                               |
| EU Remote Jobs          | blocked: the committed feed is the wrong one (zero items)                                       | Needs the right feed URL first.                                                                                                                                                                                                     |
| The seven `_HTML` types | blocked, phase 5                                                                                | Out of scope here.                                                                                                                                                                                                                  |

## 4. The 09:00 sweep and the digest (the owner's rule 1)

1. At 09:00 Kyiv a cycle opens (`openCycle`, T5) and makes every enabled, ready source due once; per-source floors,
   quotas, host budgets and pauses still apply, so a source that may not be fetched at 09:00 is skipped and says why.
2. The sweep includes a bounded availability refetch of known vacancies (Task 4.6: 404/410 closure only under a tested
   adapter contract; quota sources never).
3. When the cycle is complete (or after a fixed deadline), the digest job selects what HR may see (new since the last
   digest, by the same eligibility rules as the queue), renders it in the recipient's locale and sends one email per
   HR. It is idempotent per day and names sources that could not be refreshed. Delivery uses the existing email path.
4. Between sweeps, fresh items that pass eligibility appear in the queue immediately (evaluation is event-driven by the
   dirty-work worker, Task 4.6); a separate push for "fresh and strong match" is an option, not part of this proposal.

## 5. What would need to be built (none of it exists)

1. **Fetch profile in the manifest** and a data migration that replaces `min_interval_hours` (whole hours, no window)
   with minutes plus a window; seed per source from this document.
2. **`nextSlot(now, profile)`** in the ledger's `finish`, with tests over daylight-saving transitions and the failure
   backoff.
3. **A frequent handler (5 minutes) and the 09:00 cycle** (extension of T5) and the **digest job** (new).
4. **List-then-detail** for Greenhouse and Ashby (adapter change), conditional requests where the host supports them.
5. **Per-source freshness metric** and an adaptive rule: lengthen the interval for a source that has posted nothing for
   a week, shorten it (within floors) after a burst.
6. A **watchlist** of employer boards, with a region (time zone) per board; a product decision.

Suggested order: after T3/T7/T6/T5 are merged, then 1-2, then 3, then the adapter changes, DOU first because it is live.

## 6. Limits that no design removes

- Sources with a publication delay (Remotive 24 h, Jobicy 3 h) and feeds that hold a short window (Djinni about 3 h,
  WWR 10 per category) cannot be made "within 15-30 minutes".
- "Fresh" depends on a trustworthy publish date; where only `updated_at` exists, `first_seen_at` is the clock.
- The free-only rule removes quota APIs from the polling set.
- A faster poll raises the chance of a ban; the accepted-risk sources (SmartRecruiters, Jobgether, HN, Remotive) get the
  longest intervals and stop at the first refusal.
- Every number here is a proposal until verified against the provider's own documentation (VERIFY) and the first
  measured freshness lag.
