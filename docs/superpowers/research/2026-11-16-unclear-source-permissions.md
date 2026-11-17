# Do the six UNCLEAR job sources permit scheduled automated collection and internal storage?

**Date:** 2026-11-16 · **Why:** the source catalogue records Ashby, Djinni, We Work Remotely,
Working Nomads, The Muse and EU Remote Jobs as permission `UNCLEAR`. The owner decided on
2026-11-16 to accept the risk for every source where no explicit prohibition and no hard
precondition is found, and to enable those. This file answers, per source: is there an explicit
prohibition of automated collection / storage / aggregation (`FORBIDDEN`), a hard precondition
such as a registered app or a key (`PRECONDITION`), an explicit grant (`ALLOWED`), or neither
(`UNCLEAR-accepted`)? It also states whether a working public feed or API exists at all.

**Shelf life:** recheck every source when its terms page changes its "last updated" date, and
in any case every 3 months (next: 2027-02). Recheck immediately if an endpoint starts answering
401/403 to our collector, if a provider adds a Cloudflare challenge to its feed, or if a provider
contacts us. The We Work Remotely terms were updated on 2026-10-23, so that one moves.

**Method and limits:** one normal fetch per page (`curl` with its default User-Agent, or
WebFetch) on 2026-11-16, no proxy, no spoofed User-Agent, no headless browser, no login, no
registration, no contact with any provider. Where the live page answered a Cloudflare challenge,
the Wayback Machine copy is used and its snapshot date is given. A page that could not be read is
listed as "not read". An absence of a prohibition is not a permission.

## Short answer

| Source               | Verdict                   | Working public endpoint (2026-11-16)                             |
| -------------------- | ------------------------- | ---------------------------------------------------------------- |
| Ashby posting API    | UNCLEAR-accepted          | yes: `linear` board 200 `application/json` (484 574 bytes)       |
| Djinni RSS           | UNCLEAR-accepted          | yes: `/jobs/rss/` 200 `application/rss+xml`                      |
| We Work Remotely RSS | **ALLOWED** (attribution) | yes: `/remote-jobs.rss` 200 `application/rss+xml`                |
| Working Nomads API   | UNCLEAR-accepted          | yes: `/api/exposed_jobs/` 200 `application/json`                 |
| The Muse API         | **PRECONDITION**          | not re-fetched; registration required for any use beyond testing |
| EU Remote Jobs       | **FORBIDDEN**             | **none**: job feed and REST API answer 401                       |

Two sources change state: We Work Remotely gets an explicit grant, and EU Remote Jobs has an
explicit prohibition. The Muse cannot be enabled without registering an app, which the hard rules
of this research forbid us to do. The other three stay `UNCLEAR` and fall under the owner's
risk acceptance.

## 1. Ashby public job posting API — UNCLEAR-accepted

**Endpoint:** `https://api.ashbyhq.com/posting-api/job-board/{JOB_BOARD_NAME}`, no credentials.
`https://api.ashbyhq.com/posting-api/job-board/linear?includeCompensation=true` answered 200
`application/json`, 484 574 bytes, 2026-11-16.

**Facts:**

- The API is documented as the board owner's own tool: "This API allows you to get data for all
  currently published Job Postings for your organization. If you host your own careers page, you
  can use this data to populate it." It states no authentication, no rate limit, no usage
  restriction and links no terms. —
  [Ashby Job Postings API](https://developers.ashbyhq.com/docs/public-job-posting-api), 2026-11-16
- Ashby documents a separate, sanctioned channel for third parties that ingest postings: "Ashby
  can provision a dedicated job posting feed for a partner interested in ingesting job postings.
  Once the integration is live, Ashby customers can opt-in to sharing their jobs with the
  partner's service by enabling the partner's integration in the Admin section of the Ashby app."
  and "If you are interested in obtaining a dedicated feed, contact" Ashby. —
  [Dedicated Partner Job Feeds](https://developers.ashbyhq.com/docs/dedicated-partner-job-feeds),
  2026-11-16
- The only terms document reachable from `ashbyhq.com/terms` (redirects to `/resources/terms`) is
  the "Ashby Customer Terms of Service, Last updated September 29, 2025". It binds "Customer" (the
  entity that buys or logs into the Service). Its §5.1(d) forbids a Customer to "access the
  Service in order to build a competitive product or service". It never mentions the posting API,
  scraping, crawling or robots. — [Ashby Customer Terms of Service](https://www.ashbyhq.com/resources/terms),
  2026-11-16
- The legal index [Terms and Policies](https://www.ashbyhq.com/resources/terms-and-policies)
  lists: terms, privacy, SLA, GDPR, AI-features terms, referral agreement, design-partner terms,
  product-specific terms, modern-slavery statement, security, report abuse, vulnerability
  disclosure. No website or API terms of use for non-customers. The
  [Product Specific Terms](https://www.ashbyhq.com/resources/product-specific-terms) ("Last
  updated June 24, 2026") "apply in addition to your Terms of Service or Master Services Agreement
  with Ashby", i.e. to customers, and do not mention the posting API. — 2026-11-16
- `https://www.ashbyhq.com/robots.txt` is `User-agent: * / Allow: /`;
  `https://api.ashbyhq.com/robots.txt` answers HTTP 401 (body 12 bytes). — fetched 2026-11-16

**Why not FORBIDDEN:** no text prohibits a non-customer from calling the documented
unauthenticated endpoint. The customer terms do not bind us (we are not an Ashby customer).

**Why not ALLOWED:** the docs frame the API as "for your organization", and Ashby names the
partner feed as the route for third-party ingestion. That is the strongest signal against us
found in this research, though it is not a prohibition.

**Smallest owner decision:** accept as UNCLEAR (already done on 2026-11-16), or, for a clean
permission, the owner contacts Ashby about a dedicated partner feed (outside this research: no
contact allowed here).

## 2. Djinni RSS — UNCLEAR-accepted

**Endpoint:** `https://djinni.co/jobs/rss/` answered 200 `application/rss+xml`, 488 049 bytes,
2026-11-16. The public `/jobs/` page links it as its RSS feed.

**Facts:**

- The binding Terms of Use were located this time. There are two pages, both titled
  "Terms of Use – Djinni":
  - Candidate terms, [djinni.co/terms-of-use](https://djinni.co/terms-of-use?lang=en): profile
    accuracy, communication rules ("correspondence with recruiters on Djinni is private, do not
    share it on third-party resources"), hire reporting, account blocking. Nothing on automated
    access, RSS, copying or aggregating vacancies. — 2026-11-16
  - Employer terms, [djinni.co/pricing.html](https://djinni.co/pricing.html?lang=en) (the
    "complete version" linked from [guide.djinni.co/terms-of-use](https://guide.djinni.co/terms-of-use)):
    success-fee pricing, verification, communication rules (English page read whole). Nothing on
    automated access to vacancies or RSS. Two employer-side lines are relevant: "Djinni does not
    cooperate with recruiting agencies and freelancers.", and among the grounds to block an
    employer account: "obtaining contacts and personal data of candidates by parsing, phishing or
    posting fake jobs". The second forbids parsing **candidate** data by an employer account; it
    does not address the public vacancy RSS feed. — 2026-11-16
  - Services Agreement template (`Djinni - Services Agreement .docx`, linked from
    [guide.djinni.co/legal](https://guide.djinni.co/legal)): a bilingual contract for paying
    customers who ask for a signed contract. It defines the "Contractor's Database" as "djinni.co
    website ... with dataset which is created and maintained (updated) by the Contractor based on
    the publicly available sources". It binds only signatories; a keyword search (scraping,
    automated, robot, crawl, parsing, copy, RSS, aggregate, licence) found no clause on automated
    access. — 2026-11-16
- Neither page carries a "last updated" date.
- `https://djinni.co/robots.txt` disallows only `/jobs2`, `/q`, `/developers`, `/free-jobs`,
  `/set_lang`; `/jobs/rss/` is not disallowed. — 2026-11-16
- `djinni.co/terms` answers 404. — 2026-11-16

**Why UNCLEAR:** the binding terms are now read and are silent on automated access; the feed is
published and linked by Djinni itself. There is no grant either.

**Note for the owner (not a permission question):** the employer-side lines about recruiting
agencies and about parsing candidate data matter if the CRM ever posts vacancies, contacts
candidates or reads candidate profiles on Djinni; they do not change the RSS verdict.

**Smallest owner decision:** none beyond the 2026-11-16 risk acceptance. Update the fixture
`termsUrl` from the guide page to `https://djinni.co/pricing.html` and
`https://djinni.co/terms-of-use`.

## 3. We Work Remotely RSS — ALLOWED (with attribution)

**Endpoint:** `https://weworkremotely.com/remote-jobs.rss` answered 200 `application/rss+xml`,
2 298 133 bytes, 2026-11-16 (the feed itself is not behind the challenge). Category feeds are
listed on the RSS page.

**Facts:**

- Live `/remote-job-rss-feed` and `/terms` answered HTTP 403 with a Cloudflare "Just a moment..."
  page to a normal `curl` and to WebFetch on 2026-11-16 — **not read live**; no bypass attempted.
- The RSS page, Wayback snapshot of 2026-10-25 10:25:19 UTC: "We Work Remotely Public RSS Feed.
  Looking to fill a remote job feed and want to use openings listed on WWR? No problem! Our public
  rss feed can help you with that. Anyone can use the feed, all we ask is that you attribute the
  links back to We Work Remotely." —
  [web.archive.org/web/20261025102519/https://weworkremotely.com/remote-job-rss-feed](https://web.archive.org/web/20261025102519/https://weworkremotely.com/remote-job-rss-feed),
  fetched 2026-11-16
- The Terms and Conditions ("Updated October 23, 2026"), Wayback snapshot of 2026-11-13 08:58:56
  UTC, have no clause on scraping, robots, RSS, automated access, or a personal / non-commercial
  use limit (case-insensitive search). The IP clause grants a
  "non-transferable, non-sublicensable, non-exclusive, revocable, limited-purpose right to access
  and use the Materials that we make available to you." —
  [web.archive.org/web/20261113085856/https://weworkremotely.com/terms-and-conditions](https://web.archive.org/web/20261113085856/https://weworkremotely.com/terms-and-conditions),
  fetched 2026-11-16
- The terms defer to the Community Guidelines for appropriate uses; the
  [Wayback copy of 2026-06-10](https://web.archive.org/web/20260610084146/https://weworkremotely.com/community-guidelines)
  (3 257 characters of text) is about posting and applying for jobs and says nothing on feeds or
  automated access. — fetched 2026-11-16
- `robots.txt` allows `/` and disallows only account, admin and token paths. — 2026-11-16
- The WWR "API" (Wayback 2023-06-01) is a job-**posting** API that needs "a special token"; it
  is not a reading channel and is not relevant to collection.

**Condition attached to the grant:** every posting we show must link back to its We Work Remotely
URL (the RSS `link`/`guid` already is that URL). The grant does not mention storage; storing the
feed items to display them internally is the ordinary use of a feed and nothing in the terms
forbids it.

**Smallest owner decision:** none for permission. Confirm the UI shows the WWR link for each
WWR posting, and record `PUBLIC_FEED` (or the catalogue's equivalent) with the snapshot URL as
evidence. Fixture `termsUrl` should move from `/terms` to `/terms-and-conditions`.

## 4. Working Nomads API — UNCLEAR-accepted

**Endpoint:** `https://www.workingnomads.com/api/exposed_jobs/` answered 200 `application/json`,
173 554 bytes, 2026-11-16. The site footer labels it "API". No documentation page was found.

**Facts:**

- The terms moved: `https://www.workingnomads.com/terms` (the fixture's `termsUrl`) now answers
  404; the current page is
  [workingnomads.com/terms-and-conditions](https://www.workingnomads.com/terms-and-conditions),
  "Terms of Service, Last updated: 11 March 2025". — 2026-11-16
- The terms bind anyone: "By accessing or using the Service (including any free portions) ... you
  accept and agree to be bound by these Terms".
- §3.1 Prohibited Activities, verbatim: "You agree not to (and not to permit others to): a) Make
  the Service available to anyone who is not authorized under your Subscription type. b) Resell,
  sublicense, or otherwise commercially exploit the Service (for example, by sharing your premium
  account with others). c) Reverse engineer, decompile, disassemble, or hack any part of the
  Service. d) Access or use the Service to build a competitive product or service. e) Circumvent
  or breach any security measures or use the Service through invalid credentials. ..."
- No clause on scraping, robots, crawling, the API or reuse of listings, and no personal /
  non-commercial / internal-use limit, no download or systematic-retrieval clause (case-insensitive
  search over the whole page). The only licence clause is §4.7 "License to Us" (users' content to
  Working Nomads). The only "automated" mention is "We do not use automated decision-making tools
  ... to moderate content."
- `robots.txt` is `User-agent: * / Disallow:` (empty), i.e. allows everything. — 2026-11-16

**Why not FORBIDDEN:** §3.1(b) "commercially exploit the Service" is the closest clause; its own
example is account sharing, and internal use of listings by recruiters is not reselling the
Service. §3.1(d) targets building a competing job board; an internal CRM that does not republish
is not one. Both are readings, not certainties: a strict reader could apply (b) to commercial
internal use.

**Smallest owner decision:** none beyond the 2026-11-16 risk acceptance, which should name
§3.1(b) as the accepted residual risk. Update the fixture `termsUrl`.

## 5. The Muse public API — PRECONDITION (registered app)

**Endpoint:** `https://www.themuse.com/api/public/jobs`. Not re-fetched for this research
(fixtures 2026-10-24 show it answering without a key).

**Facts:**

- Live `/developers/api/v2` and `/developers/api/v2/terms` answered HTTP 403 with a Cloudflare
  challenge on 2026-11-16 — **not read live**. The Wayback copies were used.
- API Terms, "Last Modified: 7/25/2015", Wayback snapshot of 2025-04-23 22:30:32 UTC —
  [web.archive.org/web/20250423223032/https://www.themuse.com/developers/api/v2/terms](https://web.archive.org/web/20250423223032/https://www.themuse.com/developers/api/v2/terms),
  fetched 2026-11-16, verbatim:
  - §2.2 "In order to access The Muse API, you are required to register your App at
    https://www.themuse.com/developers/api/v2/apps using your Muse account."
  - §3.1 grants a "limited, non-exclusive, non-transferable, non-sublicensable, revocable right
    and license to access and use the API solely for the purpose of (a) using and making calls to
    the API to develop, implement and distribute the Apps; (b) obtaining, using, distributing and
    transmitting Muse Content to the extent needed to format and display Muse Content through the
    Apps in accordance with these Terms; (c) developing and testing the Apps for use with the API;
    ..."
  - §3.3 "You will not ... (g) clone Muse Content provided through the API."
  - §3.4 "any Muse Content provided through the Apps by utilizing the Muse API will link back to
    The Muse Website"
  - §4.2 "will not violate any rate limits on calling the API."
  - §4.3 "(d) not to use web scraping, web harvesting, or web data extraction methods to extract
    data from The Muse."
- Developer page, Wayback snapshot of 2026-07-16 11:46:05 UTC —
  [web.archive.org/web/20260716114605/https://www.themuse.com/developers/api/v2](https://web.archive.org/web/20260716114605/https://www.themuse.com/developers/api/v2),
  fetched 2026-11-16: "Note: Make sure to register your app! Registration is required for any use
  beyond testing." and "If you don't register your app and provide an api_key query parameter,
  you're limited to 500 requests per hour."

**Storage:** §3.1(b) licenses content only "to the extent needed to format and display Muse
Content through the Apps"; it does not mention storing. Storing postings for internal display is
not expressly granted, and §3.3(g) "clone Muse Content" is the clause a strict reader would use
against a persistent copy. Short-lived storage whose only purpose is display, with a link back
(§3.4), is the reading most consistent with §3.1(b).

**Why PRECONDITION and not UNCLEAR:** scheduled production collection is "use beyond testing",
which the provider says requires registration, and §2.2 makes registration a condition of
access. Collecting without a registered app is outside the terms whatever the key-less rate limit
allows technically.

**Smallest owner decision:** either (a) the owner registers an app at
`themuse.com/developers/api/v2/apps` under a Muse account (A3: an external sign-up), after which
the precondition is met; storage stays unaddressed by §3.1(b) and exposed to §3.3(g), so it would
then fall under the owner's risk acceptance like the UNCLEAR sources, with a link back (§3.4); or
(b) keep The Muse disabled.

## 6. EU Remote Jobs — FORBIDDEN (and no feed exists)

**Endpoint:** none usable.

- `https://euremotejobs.com/?feed=job_feed` answered HTTP 401 with WordPress `wp_die` "Not
  available."; `https://euremotejobs.com/wp-json/wp/v2/job-listings` answered 401
  `{"code":"rest_forbidden","message":"Not available."}`. — 2026-11-16
- `/feed/` is the blog posts feed (15 items, posts such as "Why every job seeker needs a mentor"),
  and `/jobs/feed/` is a comments feed (fixture). Neither carries job listings.
- `/sitemap.rss` is an All in One SEO sitemap that lists job page URLs and titles only; it is not
  a job data feed, and using it to collect postings would mean fetching job pages, which the
  terms below prohibit.

**Facts:**

- [euremotejobs.com/tos/](https://euremotejobs.com/tos/) (linked "Terms of Service" in the site
  footer; no date shown), §10 Intellectual Property, verbatim: "All job listings, company
  information, curated content, website design, functionality, and any other materials available
  on EU Remote Jobs constitute our proprietary intellectual property or that of our partners and
  affiliates. This includes our curated database of remote job opportunities and associated
  metadata. Prohibited Activities You are expressly prohibited from: – Copying, reproducing,
  distributing, transmitting, displaying, performing, publishing, licensing, creating derivative
  works from, transferring, or selling any content, information, or functionality obtained from EU
  Remote Jobs – Using any automated systems including but not limited to robots, spiders,
  scrapers, crawlers, data mining tools, APIs, or other automated devices or manual processes to
  monitor, extract, or copy content from our platform" and further "We actively monitor for
  unauthorized use and reserve the right to take technical measures to prevent scraping and
  content theft." — 2026-11-16
- The operator is "EEA Remote Employment Services Ltd, trading as ¨EU Remote Jobs¨", Ireland
  (same page).

**Smallest owner decision:** none. Disable the source and record `FORBIDDEN` with the quote. The
owner's risk acceptance does not cover it: it was limited to sources without a prohibition.

## Applicability to us

Our use: a scheduled server-side collector on a Hetzner VPS, postings stored in our database and
shown only to internal recruiters, not republished. Against each verdict:

- WWR's grant ("Anyone can use the feed") covers that use; its one condition, a link back, is
  met if the UI keeps the posting URL.
- The Muse grant is display-scoped and conditioned on a registered app; our use is production
  collection, so the precondition applies.
- EU Remote Jobs prohibits "monitor, extract, or copy" by any automated system, which is exactly
  scheduled collection; "internal only" does not help, since copying is itself prohibited.
- For Ashby, Djinni and Working Nomads no text addresses our use; the owner's 2026-11-16 risk
  acceptance applies. The residual risks to name in that acceptance: Ashby's "for your
  organization" framing plus its partner-feed route; Working Nomads §3.1(b) "commercially exploit
  the Service".

## What could not be established

- **Not read live (Cloudflare challenge, HTTP 403, 2026-11-16):** `weworkremotely.com/terms`,
  `weworkremotely.com/remote-job-rss-feed`, `themuse.com/developers/api/v2`,
  `themuse.com/developers/api/v2/terms`. Their text above is from Wayback snapshots (dates given).
  A change after those snapshots would not be seen here. The Muse terms snapshot is from
  2025-04-23; the page says "Last Modified: 7/25/2015", so a change since is unlikely but not
  verified.
- **Ashby:** the Terms and Policies index lists no website or API terms for non-customers; no
  such document was found anywhere else either.
- **Djinni:** neither Terms of Use page carries a date, so the version in force cannot be pinned.
- **EU Remote Jobs:** the ToS page carries no date.
- **The Muse endpoint** was not re-fetched on 2026-11-16 (moot while the precondition is unmet);
  its working state rests on the 2026-10-24 fixtures.
