# Task sources-13 — The Hub, JustJoin.it, Landing.jobs (sitemap + JSON-LD sources)

## Why

Owner decision 2026-11-20 (A3, recorded): "Подключай, риск я принимаю для всех площадок" — connect every site whose
only obstacle is its terms; the owner accepts the legal risk. Technical blocks (403 / Cloudflare challenge) stay
excluded (NO_EVASION). Record each site's decision in the owner-decisions record with date 2026-11-20, the
classification PROHIBITED, and the quoted clause below. External GETs to these sites are owner-approved.

| Site | Terms (quote, date) |
| --- | --- |
| The Hub | https://thehub.io/terms (Last Updated 08.08.2024): "you may view and print the contents … for personal, non-commercial use only. You may not otherwise copy, save or otherwise reproduce … without our prior written consent." |
| JustJoin.it | Users' ToS PDF (2026-11-04) §11.3: "no one may automatically extract any data from the Website without our express written consent." (Polish Database Protection Act; civil and criminal liability cited) |
| Landing.jobs | https://landing.jobs/tos (13 Nov 2026) §8.2(vii): "Use … scripts, robots … to access, monitor, scrape or copy the Platform"; §5.7 no download/store |

## Facts (research 2026-11-20; all VPS probes 200, no challenge)

- **The Hub:** `https://thehub.io/sitemap-jobs.xml` (~240 KB, 1 343 job URLs `thehub.io/jobs/ID`, lastmod). Job page
  ~63 KB, JSON-LD `JobPosting` (title, datePosted, validThrough, hiringOrganization, employmentType, identifier,
  jobLocation, HTML description). No salary in JSON-LD (only `window.__NUXT__`, not JSON: leave empty). robots: only
  the joblistwidget path is disallowed.
- **JustJoin.it:** `https://justjoin.it/sitemaps/active-jobs.xml` 307-redirects to an index whose single part is
  `https://public.justjoin.com/justjoinit/sitemaps/active-jobs/part0.xml` (~2.6 MB, 11 054 `job-offer` URLs,
  lastmod = datePosted). Job page ~681 KB, JSON-LD with title, hiringOrganization, jobLocation, jobLocationType
  TELECOMMUTE, applicantLocationRequirements, baseSalary (currency/min/max/unit), datePosted, validThrough,
  employmentType, HTML description; canonical from `link rel="canonical"`. robots disallows the `api` and
  `oferty-pracy` paths — do not use them. Volume: 11 054 × 681 KB ≈ 7.5 GB for a full sweep, so a strict per-run
  detail cap; newest by lastmod first; backfill across days.
- **Landing.jobs:** `https://landing.jobs/sitemap.xml` (~147 KB, 890 locs; 75 job pages under the `at` prefix
  (company + slug); ignore the `jobs` listing pages and the blog). Job page ~94 KB, JSON-LD (title,
  hiringOrganization, jobLocation, datePosted, validThrough, employmentType, identifier, HTML description; no salary
  in sample). robots disallows `api` and `jobs/search`.

## Do

Same steps 1-7, AC and Rules as `task-sources-12-nextleveljobs.md` (same directory), for these three sites.
**Reuse the sitemap + JSON-LD adapter that sources-12 builds** (branch of PR "feat(job-sourcing): Next Level Jobs
source (sitemap + JSON-LD)"): start from that branch if it is not merged, rebase onto `origin/main` once it is. Each
site is a config/definition on that adapter, not a new framework; only per-site differences (sitemap index
redirect, URL filter, canonical source) get code. Conservative per-host budgets; state the numbers per site.
Scratch DB `crm_qa_s13`. Draft PR `feat(job-sourcing): The Hub, JustJoin.it, Landing.jobs sources (sitemap + JSON-LD)`.
