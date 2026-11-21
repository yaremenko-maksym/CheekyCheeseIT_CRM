# The seven HTML job sources and the three blocked ones: access path, terms, decision, prod state

**Date:** 2026-11-20 (research), prod state as of 2026-11-21. **Why:** on 2026-11-19 the owner asked to
connect every source on the list except EU Remote Jobs, including the seven HTML sites that had no
adapter. This file records, per site, how it was reached, what its terms say, what the owner decided,
which technical block (if any) stopped it, and where it ended on production. It closes the
"connect-all" phase of 2026-11-19 .. 2026-11-21.

**Method and limits:** read-only research on 2026-11-20, one plain probe per site from the production
server plus local reads, no proxy, no changed User-Agent, no headless browser (the NO_EVASION rule: a
403, a 429 or a Cloudflare / bot challenge ends the attempt). Terms were read as published; where a
terms page could not be read without running its JavaScript, it is recorded as not read. An absence
of a prohibition is not a permission. The earlier assessment of the non-HTML `UNCLEAR` sources is
`2026-11-16-unclear-source-permissions.md`.

**Shelf life:** recheck a site when its terms page changes its date, when the collector starts
receiving 403 / 429 / a challenge from it, or when the provider contacts us; in any case every 3 months
(next: 2027-02).

## Terms status, in this file

- **PROHIBITED**: the terms explicitly forbid automated extraction, robots or storing the content.
- **UNCLEAR**: the terms are silent on automation, or could not be read.

The owner accepted the legal risk for every site whose only obstacle was its terms ("connect, I accept
the risk for all platforms", 2026-11-20). A technical block was never worked around.

## Short answer

| Source                | Access path used                               | Terms                       | Owner decision                  | Technical block                  | Prod 2026-11-21          |
| --------------------- | ---------------------------------------------- | --------------------------- | ------------------------------- | -------------------------------- | ------------------------ |
| Next Level Jobs       | `/jobs/sitemap.xml` + JSON-LD on each job page | UNCLEAR (silent)            | connect, risk accepted          | none                             | CONNECTED (#1443)        |
| The Hub               | jobs sitemap + JSON-LD                         | PROHIBITED                  | connect, risk accepted          | none                             | CONNECTED (#1444)        |
| JustJoin.it           | sitemap + JSON-LD                              | PROHIBITED                  | connect, risk accepted          | none                             | CONNECTED (#1444)        |
| Landing.jobs          | sitemap + JSON-LD                              | PROHIBITED                  | connect, risk accepted          | none                             | CONNECTED (#1444)        |
| Dice                  | job pages with JSON-LD                         | PROHIBITED                  | connect, risk accepted          | none                             | CONNECTED (#1445)        |
| No Fluff Jobs         | first server-rendered listing page only        | UNCLEAR (not read)          | connect, risk accepted          | no full listing path (see below) | CONNECTED (#1445)        |
| Welcome to the Jungle | none                                           | PROHIBITED                  | excluded by the technical block | 403 from CloudFront              | NOT CONNECTED            |
| DOU                   | none (RSS feeds refused)                       | not assessed                | none needed yet                 | Cloudflare challenge             | NOT CONNECTED, paused    |
| The Muse              | public API (#1429)                             | registered-app precondition | enabled by ADMIN                | Cloudflare challenge             | NOT CONNECTED, paused    |
| EU Remote Jobs        | none                                           | PROHIBITED                  | excluded by the owner           | no job feed, 401                 | NOT CONNECTED (decision) |

Every new source is seeded `enabled = false`; an ADMIN switches it on with the enable switch on the
admin sources page (#1442). The connected HTML sources above were enabled by an ADMIN through the audited admin API after their deploys; the admin page switch (#1442) does the same.

## Per source

### Next Level Jobs

- **Access:** `/jobs/sitemap.xml` (2 787 jobs on 2026-11-20) plus the JSON-LD `JobPosting` on each job
  page; robots.txt allows `/`.
- **Terms:** silent on automated collection (UNCLEAR). The site itself collects ATS pages, so it
  overlaps our own ATS sources; ATS-first dedup by the linked ATS URL ships with the adapter.
- **Owner decision (2026-11-20):** connect, risk accepted.
- **Prod:** `NEXTLEVELJOBS_HTML`, first run 2026-11-21 SUCCEEDED, coverage PARTIAL (detail budget),
  25 received / 25 created / 0 invalid, 26 requests, about 4.4 MB.

### The Hub

- **Access:** the jobs sitemap (1 343 jobs on 2026-11-20) plus JSON-LD.
- **Terms (dated 2024-08-08):** personal, non-commercial use only; copying or saving without prior
  written consent is not allowed (PROHIBITED).
- **Owner decision (2026-11-20, asked twice, warned of the terms and the EU database right):** connect,
  legal risk accepted.
- **Prod:** `THEHUB_HTML`, first run 2026-11-21 SUCCEEDED PARTIAL, 25 / 25 / 0, 26 requests,
  about 1.8 MB. The enable-time fetch was first refused `POOL_FULL` while the other two new sources
  held the pool; an ADMIN off/on toggle triggered the run.

### JustJoin.it

- **Access:** sitemap (11 054 jobs on 2026-11-20) plus JSON-LD.
- **Terms (PDF dated 2026-11-04), §11.3:** automated extraction is not allowed without written consent
  (PROHIBITED).
- **Owner decision (2026-11-20):** connect, risk accepted.
- **Prod:** `JUSTJOIN_HTML`, first run 2026-11-21 SUCCEEDED PARTIAL, 20 / 20 / 0, 24 requests,
  about 15.9 MB. The detail budget is 20 jobs a run against about 11 000 active jobs, so the inventory
  never drains; raising it is an owner decision.

### Landing.jobs

- **Access:** sitemap plus JSON-LD.
- **Terms (dated 2026-11-13), §5.7 and §8.2(vii):** scraping and storing the content are not allowed
  (PROHIBITED).
- **Owner decision (2026-11-20):** connect, risk accepted.
- **Prod:** `LANDINGJOBS_HTML`, first run 2026-11-21 SUCCEEDED PARTIAL, 25 / 25 / 0, 26 requests,
  about 2.5 MB.

### Dice

- **Access:** job pages with JSON-LD; the server answered 200 with no challenge.
- **Terms (dated "12/03/2025" as printed), §8.2 j) and aa):** robots that store or reproduce the content are not
  allowed (PROHIBITED).
- **Owner decision (2026-11-20):** connect, risk accepted.
- **Prod:** `DICE_HTML`, first run 2026-11-21 SUCCEEDED PARTIAL, 25 / 25 / 0, 29 requests, about 7.4 MB,
  no 403 / 429 / challenge.

### No Fluff Jobs

- **Access:** only the first server-rendered listing page (about 20 jobs). There is no sitemap, the
  server-rendered pagination ignores `?page`, and `/api/` is disallowed by robots.txt, so no allowed
  path reaches the full listing.
- **Terms:** the regulations page renders only with JavaScript and was not read without a headless
  browser (UNCLEAR, not read).
- **Owner decision (2026-11-20):** first "the owner reads the regulations", then folded into "connect,
  I accept the risk for all platforms".
- **Prod:** `NOFLUFF_HTML`, first run 2026-11-21 SUCCEEDED PARTIAL, 25 / 25 / 0, 34 requests,
  about 22.5 MB, no 403 / 429 / challenge.

### Welcome to the Jungle

- **Access:** none. The site answers 403 from CloudFront both from the production server and locally.
- **Terms (dated 2026-04-27):** an explicit anti-scraping clause (PROHIBITED).
- **Decision:** not connected. The owner's risk acceptance covers terms only; a 403 is a technical
  block under NO_EVASION.
- **Prod:** no adapter.

### DOU

- **Access:** none. A dry run from the production server on 2026-11-19 got `403 Forbidden` with
  `server: cloudflare` and `cf-mitigated: challenge` ("Just a moment..."). Eight plain GETs the same day
  (the `jobs.dou.ua` root feed, three category feeds, a company feed, the site root and robots.txt) all
  got the same challenge. `dou.ua/feed/` answers 200 but carries editorial posts, no vacancies. DOU has
  no public jobs API.
- **Terms:** not assessed in this phase; the block is technical.
- **What shipped (#1427):** a challenge or 403 now pauses the source row with the `ACCESS_POLICY`
  reason and puts the host on a ban, instead of failing silently; recovery is the ADMIN reset failures.
- **Owner options:** ask DOU to allowlist the server or grant partner feed access, or accept that DOU
  stays off.
- **Prod:** `DOU_RSS` enabled and paused `ACCESS_POLICY`.

### The Muse

- **Access:** the public API, connected by #1429 and enabled by an ADMIN on 2026-11-20.
- **Terms:** section 2.2 asks for a registered application (a precondition, see the 2026-11-16 file).
- **Technical block:** the first run FAILED `ACCESS_POLICY`, 403 with `server: cloudflare` and
  `cf-mitigated: challenge` on the production server's IP (one diagnostic GET confirmed it).
- **Prod:** `MUSE_API` left enabled; it pauses itself like DOU. Not connected under NO_EVASION.

### EU Remote Jobs

- **Access:** none; there is no job feed and the endpoint answers 401.
- **Terms:** §10 forbids automated collection (PROHIBITED).
- **Owner decision (2026-11-19):** excluded from the connect-all request.
- **Prod:** `EUREMOTEJOBS_RSS` stays disabled, readiness `BLOCKED`.

## What follows from it

- HTML sources run 4 times a day (owner decision 2026-11-21; the cron change is task sources-15).
- The sitemap core does not yet check robots.txt in code or refuse redirects, a 410 on a detail page ends
  the run, one fetch can produce two request reports, and the Next Level Jobs apply-button regex is
  quadratic on a large page: task sources-16.
- A structured salary field (sources-17) and cross-source dedup by normalized title + company
  (sources-18) were ordered by the owner on 2026-11-21; The Hub and Landing.jobs link no ATS job, so
  until then their copies are not deduplicated against ATS sources.
