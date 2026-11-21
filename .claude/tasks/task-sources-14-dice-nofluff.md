# Task sources-14 — Dice and No Fluff Jobs (listing-embedded data + JSON-LD detail)

## Why

Owner decision 2026-11-20 (A3, recorded): "Подключай, риск я принимаю для всех площадок". Record each decision in the
owner-decisions record with date 2026-11-20 and the classification. External GETs to these sites are owner-approved.

| Site | Terms |
| --- | --- |
| Dice | Terms and Conditions (LAST UPDATED 12/03/2025) §8.2 j) and aa): bans robots/spiders that store or reproduce site content -> PROHIBITED, owner overrode |
| No Fluff Jobs | regulamin not readable without JS -> UNCLEAR, owner accepted |

## Facts (research 2026-11-20; VPS probes 200, no challenge)

- **Dice:** no job sitemap. `https://www.dice.com/jobs` (~346 KB) embeds Next.js RSC data (`self.__next_f`):
  `jobList.data[]` 30 items, `meta.pageSize: 30`, `totalResults` ~113 765. Item keys: `id, guid, detailsPageUrl,
  companyName, employmentType, jobLocation{city,state,country,displayName}, postedDate, modifiedDate, salary,
  summary (truncated), title, isRemote`. `jobs?page=N` UNTESTED — test it with one GET first. robots disallows the
  `jobs?q*` query form, `feed`, `rss` and the bare `job` prefix, and explicitly allows `jobs` and `job-detail`;
  check every URL you use against robots in code. Detail `https://www.dice.com/job-detail/UUID` (~233 KB) JSON-LD
  JobPosting with url and baseSalary (free text: keep raw; no model). Fetch only the first N listing pages + details
  of unseen jobs.
- **No Fluff Jobs:** `https://nofluffjobs.com/pl/` embeds `script id="serverApp-state" type="application/json"`
  with `postings` (20) incl. `id, title, name (company), location.places[], fullyRemote, salary{from,to,type,
  currency,period}, posted (epoch ms), url (slug)`. `?page=2` returned the same 20, so coverage is the listing /
  category pages reachable without the API (robots disallows `api`, `posting` and the `job/job` form). Find whether
  robots-allowed SSR category or location listing pages give more distinct postings; state the coverage you reach.
  Detail `https://nofluffjobs.com/pl/job/SLUG` has JSON-LD; canonical from `link rel="canonical"`.

## Do

Reuse the JSON-LD detail path and source plumbing that sources-12 builds (branch of PR "feat(job-sourcing): Next
Level Jobs source (sitemap + JSON-LD)"; start from it if not merged, rebase onto `origin/main` once it is). Add only
the listing extractors (Dice RSC payload, NFJ serverApp-state) as deterministic parsers with fixtures. Steps 2-7, AC
and Rules as in `task-sources-12-nextleveljobs.md` (same directory). Scratch DB `crm_qa_s14`. Draft PR
`feat(job-sourcing): Dice and No Fluff Jobs sources`.
