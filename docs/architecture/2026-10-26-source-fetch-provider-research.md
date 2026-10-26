# What each job source's own documentation says about request rate, freshness and automated access

**Date:** 2026-10-26 · **Why:** the intervals, the host budgets and the stop rules in the ADR
`2026-10-25-source-fetch-strategy.md` (the ADR that replaced the draft at that path). The ADR cites row `#n` below as **Rn**.
**Shelf life:** recheck on **2027-01-26** (three months), and earlier on any of these signals: a source is
about to be enabled for the first time; a source answers 401, 403, 429 or 451; a provider announces an API
change; the Recruitee token deadline (2027-02-10) is less than 30 days away. A provider's terms page is
not versioned, so a recheck means re-reading the page, not diffing a file.

## How this was gathered

- **Documentation pages only.** No request was sent to any provider's API host or feed endpoint, no job
  page was opened, nothing was logged into. The owner's rule is that external requests to job sites need
  his explicit word, and he has not given it for this work. Every page below is a documentation, terms or
  help page.
- Pages were read on 2026-10-26 through a fetch that converts a page to text; quotes are as that text
  rendered them. A page that rendered only by JavaScript returned an empty body and is marked so.
- **REPO** marks a fact already recorded in this repository (adapter headers, fixture provenance, the
  manifest) and not re-read today. **UNVERIFIED** marks a question the provider's own documentation does
  not answer; the conservative number is kept for it.
- **Conditional requests (`ETag` / `If-Modified-Since`) are UNVERIFIED for every provider.** No
  documentation page mentions them, and the only way to learn it is to look at response headers, which
  needs a request. The ADR therefore records the headers passively on runs that happen anyway, and only
  then sends conditional requests (see the ADR, "Conditional requests").

Confidence: **HIGH** = quoted from the provider's own page; **MED** = the provider's own page, read
through a search engine's rendering because the direct fetch was refused; **LOW** = secondary source
only.

## Short answer

1. **Himalayas refreshes its data once every 24 hours**, so the draft's hourly poll buys nothing: one
   run a day.
2. **Remotive and Jobicy confirm their limits**: Remotive blocks more than 2 requests a minute, advises
   at most 4 a day and delays jobs by 24 h; Jobicy says polling "must not exceed once per hour" and
   keeps a 3 h delay.
3. **DOU's terms forbid automated access and "automatic collection" without the site's consent**
   (section 2.5). DOU is the only source live in production. Polling it more often is a legal question,
   not a scheduling one: it goes to the legal agent before any cadence change.
4. **Jobgether's terms forbid bots and scrapers, and the use of its content to "operate
   machine-learning models"**. Jobgether is already an accepted-risk source; the machine-learning clause
   is new and touches the relevance step.
5. **Arbeitnow's terms grant a "personal, non-commercial" licence in section 2 and an API section that
   asks for a link back in section 11.** The two read against each other; legal question.
6. **No provider publishes a read rate limit for an ATS board (Greenhouse, Lever, Ashby, Workable,
   Recruitee, Personio, SmartRecruiters).** The conservative numbers stay.

## Facts

### Employer boards (ATS)

| #   | Provider        | Fact                                                                                                                                                                                                                                                           | Source                                                                                                        | Confidence                                   |
| --- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1   | Greenhouse      | "Job Board data is publicly available, so authentication is not required for any GET endpoints."                                                                                                                                                               | [Job Board API](https://docs.greenhouse.io/job-board.html), 2026-10-26                                        | HIGH                                         |
| 2   | Greenhouse      | The list endpoint without `content` returns a summary per job (`id`, `title`, `updated_at`, `location`, `absolute_url`); `content=true` adds "the full post description, department, and office". So list-then-detail is a documented shape, not a workaround. | same, 2026-10-26                                                                                              | HIGH                                         |
| 3   | Greenhouse      | No rate limit, no caching statement, no conditional-request statement. `first_published` appears only in an example and is not defined.                                                                                                                        | same, 2026-10-26                                                                                              | UNVERIFIED (rate, conditional); REPO (dates) |
| 4   | Lever           | Only application POSTs are limited ("more than 2 application POST requests per second" returns 429). No limit is stated for the read endpoints. "All job postings in the `published` state are publicly viewable. These jobs may be scraped by third parties." | [lever/postings-api README](https://github.com/lever/postings-api), 2026-10-26                                | HIGH (statement); UNVERIFIED (read rate)     |
| 5   | Lever           | The list paginates with `skip` and `limit`.                                                                                                                                                                                                                    | same, 2026-10-26                                                                                              | HIGH                                         |
| 6   | Ashby           | `publishedAt` is "ISO DateTime when the job was last published" (so a re-publish moves it). No rate limit, no caching statement.                                                                                                                               | [Public job posting API](https://developers.ashbyhq.com/docs/public-job-posting-api), 2026-10-26              | HIGH (field); UNVERIFIED (rate)              |
| 7   | Recruitee       | "Deadline for introducing the token to calls is 10 February 2027"; "Calls without the authorization header will return the 401 Unauthorized error". No rate limit stated.                                                                                      | [Authentication](https://docs.recruitee.com/reference/authentication-1), 2026-10-26                           | HIGH (deadline); UNVERIFIED (rate)           |
| 8   | Recruitee       | The offers operation declares no security and is not marked deprecated.                                                                                                                                                                                        | [Offers](https://docs.recruitee.com/reference/offers), 2026-10-26                                             | HIGH                                         |
| 9   | Personio        | The open-positions page speaks only of TLS 1.2 for the XML feed; nothing on rate, update frequency or polling.                                                                                                                                                 | [Integration of open positions](https://developer.personio.de/docs/integration-of-open-positions), 2026-10-26 | UNVERIFIED                                   |
| 10  | Workable        | The terms forbid using the services "to circumvent Website limitations, including but not limited to fair usage limitations" (4.5.4). No published read rate for the public widget endpoint.                                                                   | [Terms](https://www.workable.com/terms), 2026-10-26                                                           | HIGH (clause); UNVERIFIED (rate)             |
| 11  | SmartRecruiters | The endpoints page describes the postings list ("Lists active postings published by given company") and states no rate limit and no authentication rule.                                                                                                       | [Endpoints](https://developers.smartrecruiters.com/docs/endpoints), 2026-10-26                                | UNVERIFIED (rate)                            |
| 12  | SmartRecruiters | robots.txt on the API host disallows us; the owner accepted the risk (2026-10-24).                                                                                                                                                                             | REPO (manifest owner decision, fixture provenance)                                                            | REPO                                         |

### Public feeds

| #   | Provider              | Fact                                                                                                                                                                                                                                                                        | Source                                                                                                                                  | Confidence                          |
| --- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 13  | Remotive              | "excessive requests (more than 2x per minute) will be blocked"; "we advise max. 4 times a day"                                                                                                                                                                              | [remote-jobs-api README](https://github.com/remotive-io/remote-jobs-api) (`remotive.com/api-documentation` redirects there), 2026-10-26 | HIGH                                |
| 14  | Remotive              | "Jobs displayed are delayed by 24 hours". Link back and name Remotive, or "we'll terminate your API access". "Please do not submit Remotive jobs to third Party websites".                                                                                                  | same, 2026-10-26                                                                                                                        | HIGH                                |
| 15  | Jobicy                | RSS polling "must not exceed once per hour"; automated sync passes no more often than once per hour; on 429, defer the retry.                                                                                                                                               | [Jobs API and RSS feed](https://jobicy.com/jobs-rss-feed), 2026-10-26                                                                   | HIGH                                |
| 16  | Jobicy                | The publication boundary "retains the 3-hour delay"; the API returns listings "published in the last 7 days"; `count` 1–200; a cursor "is valid for 24 hours"; "jobs disappearing from the 7-day feed are not necessarily closed"; credit Jobicy and link.                  | same, 2026-10-26                                                                                                                        | HIGH                                |
| 17  | Himalayas             | "The data is cached and refreshed every 24 hours." `limit` maximum is 20. `pubDate` is "When the job was last updated".                                                                                                                                                     | [Remote jobs API docs](https://himalayas.app/docs/remote-jobs-api), 2026-10-26                                                          | HIGH                                |
| 18  | Himalayas             | "Requests without a key share one public allowance with every other caller"; "Responses served from our cache are free and do not count". Keyed: 60/min and 10,000 per UTC day (a key is out of scope under the free-only rule).                                            | same, 2026-10-26                                                                                                                        | HIGH                                |
| 19  | Himalayas             | Terms: "stay within your request limits"; "We set and may change request limits"; every Apply must use `applicationLink`; clause 30A exempts "use of our public API … in line with their published documentation and rate limits" from the anti-scraping clauses.           | [Terms](https://himalayas.app/terms), 2026-10-26                                                                                        | HIGH                                |
| 20  | Arbeitnow             | API section 11: "You also agree to providing a link back to Arbeitnow.com"; "We may revoke the permission to use API at any time." Section 2 licence: "for personal, non-commercial transitory viewing only". No rate limit stated.                                         | [Terms](https://www.arbeitnow.com/terms), 2026-10-26                                                                                    | HIGH (clauses); UNVERIFIED (rate)   |
| 21  | Arbeitnow             | The API blog post and its linked Postman documentation state no rate, update frequency or page size (the Postman page rendered empty).                                                                                                                                      | [Job board API](https://www.arbeitnow.com/blog/job-board-api), 2026-10-26                                                               | UNVERIFIED                          |
| 22  | We Work Remotely      | The official feed page says anyone may use the feed with links attributed back to We Work Remotely. The direct fetch returned 403; read through the search engine's rendering of the same page. No rate limit stated.                                                       | [Remote job RSS feed](https://weworkremotely.com/remote-job-rss-feed), 2026-10-26                                                       | MED (permission); UNVERIFIED (rate) |
| 23  | RemoteOK              | The terms travel inside the feed (the first, "legal" object): link back with a followed link and name Remote OK. No documentation page outside the feed was found; no rate limit is published.                                                                              | REPO (adapter header, fixture provenance)                                                                                               | REPO; UNVERIFIED (rate)             |
| 24  | Hacker News (Algolia) | The documentation page renders by JavaScript and returned an empty body. A per-IP limit of 10,000 requests an hour is reported only by a third-party library.                                                                                                               | [HN Search API](https://hn.algolia.com/api), 2026-10-26                                                                                 | LOW (secondary only)                |
| 25  | Jobgether             | The API docs: results per page "capped at 25", page "Capped at 10"; "fetches of this endpoint should not be served from the tool's own cache"; "Intended for AI agents/assistants answering user job-search queries".                                                       | [Jobs API docs](https://jobgether.com/astroapi/ai/jobs/docs), 2026-10-26                                                                | HIGH                                |
| 26  | Jobgether             | Terms 4.5: "refrain from accessing the Platform or extracting its content by automated means (bots, scrapers, crawlers)" "and from using Platform content to train, fine-tune or operate machine-learning models"; section 9 prohibits "extraction, data mining, scraping". | [Terms of use](https://jobgether.com/terms-of-use), 2026-10-26                                                                          | HIGH                                |
| 27  | Jobgether             | 60 requests a minute and robots `Crawl-delay: 2`; the owner accepted the risk.                                                                                                                                                                                              | REPO (manifest owner decision)                                                                                                          | REPO                                |
| 28  | Djinni                | The terms summary page says nothing on RSS or automated access; the full terms page it links could not be found (`djinni.co/terms` is 404). The feed's 100-item window is REPO.                                                                                             | [Terms summary](https://guide.djinni.co/terms-of-use), 2026-10-26                                                                       | UNVERIFIED                          |
| 29  | DOU                   | Terms 2.5: access "exclusively through the user interface"; "not … through automated software tools"; no "automatic collection of information posted on the site without the Administration's consent". 3.2: non-commercial use under CC BY-NC-SA. RSS is not mentioned.    | [Rules of use](https://dou.ua/legal/), 2026-10-26                                                                                       | HIGH                                |

### Quota and blocked sources (not in the polling set; not re-read)

JSearch, TheirStack, Jooble, Reed, The Muse, Working Nomads and EU Remote Jobs keep the facts the draft
recorded from this repository (REPO). The free-only rule takes the first four out of the polling set, and
the last three are blocked, so no fact about them changes an interval.

## Applicability to us

- **Himalayas:** one run a day inside the 09:00 sweep. More is wasted traffic against a pooled public
  allowance shared with every other unkeyed caller (fact 18), which raises the chance of a 429 for us
  without any fresher data.
- **Remotive:** the manifest's `hostRate { perMinute: 2, perDay: 4 }` and `minIntervalHoursFloor: 6` match
  facts 13–14. The three Remotive category entries share the 4-a-day budget, so each entry runs once a day
  (three staggered slots), leaving one request for a manual run.
- **Jobicy:** 60 minutes is the documented minimum; the ADR keeps 120 because a 3 h delay makes hourly
  pointless.
- **Greenhouse:** list-then-detail is documented (fact 2), so the adapter change is low-risk.
- **Ashby:** `publishedAt` moving on re-publish is documented (fact 6); accepted churn as before.
- **Recruitee:** the deadline is confirmed; the adapter's own stop and `readinessAt` already carry it.
- **DOU, Jobgether, Arbeitnow, Remotive's "third party websites" clause:** legal questions, routed to the
  legal agent in the ADR's decision brief. Not decided here.

## What could not be established

- A published read rate for any ATS provider, Arbeitnow, We Work Remotely, RemoteOK and Hacker News.
- Whether any host honours conditional requests (needs a response header; no request was allowed).
- Djinni's full terms (the linked page was not found).
- The Hacker News Search limit from its owner (the page renders by JavaScript).
- We Work Remotely's page by direct fetch (403); its content is known through a search engine rendering.
