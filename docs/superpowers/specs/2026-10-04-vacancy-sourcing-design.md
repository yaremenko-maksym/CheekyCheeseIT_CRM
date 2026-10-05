# Vacancy auto-sourcing — design v1

**Date:** 2026-10-04 · **Status:** under owner review · **Author:** Master session (grill-me grilling)
**Catalog source:** `scratchpad/job-sources-research.md` (fable research, ~95 sources, HTTP probing)

> **The scope of this spec is ONLY vacancy sourcing + a relevance queue for HR.**
> Matching to a specific senior, AI résumé tailoring and auto-apply are **separate future phases**, not designed here.

---

## 1. Goal

An outstaff studio places its **senior engineers** into international companies. Once a day the system
collects EXTERNAL vacancies from all available sources, filters down to those relevant to our bench,
deduplicates, and puts them into a **prioritized queue** where HR, with one button, opens a vacancy and
works further. Downstream (pick a senior → tailor the résumé → apply) — the next phases.

## 2. v1 boundaries

**In scope:** ingest from API/RSS/cooperative HTML; a layered relevance filter; dedup; a ranked
queue; HR list/card UI; per-source budget/cadence.

**NOT in scope (deferred):**

- Protected giants (LinkedIn/Indeed/Glassdoor/Work.ua/robota.ua — behind Cloudflare/DataDome, confirmed
  by probing). Access to them — later, via a paid bridge (JSearch/TheirStack) or an official API.
- Matching to a specific senior (profile↔vacancy precisely), AI résumé tailoring, auto-apply.
- The "platform weight by validity history" feedback loop — **v1 starts simpler** (equal weight + signal log),
  the loop is turned on as a second step once history accumulates.
- HR filters at the apply stage (company blacklist, etc.) — the next phase.

## 3. Sources (from the research)

**We start with the WHOLE in-reach set (~55), not just the top 10.** Three classes of adapters:

- **API/JSON (simple, data structured, AI not needed):** RemoteOK, Remotive, Himalayas, Jobicy,
  Arbeitnow, Working Nomads, Jobgether, HN "Who is hiring" (Algolia), + **company ATS endpoints**
  (Greenhouse/Lever/Ashby/Workable/SmartRecruiters/Recruitee/Personio — per a seed list of target product
  companies). Quota APIs on a reduced cadence: Jooble (500/lifetime → once a week), JSearch (200/mo),
  TheirStack (200/mo), Muse, Reed.
- **RSS (simple):** Djinni, DOU, We Work Remotely (needs a browser UA), EU Remote Jobs.
- **Cooperative HTML via Firecrawl + Claude (a minority):** JustJoin.it, NoFluffJobs, Landing.jobs,
  NextLevelJobs.eu, Dice, The Hub, Djinni detail (JSON-LD), WTTJ (Algolia, a gray area — we try it, banned so banned).

**Excluded:** Adzuna (after 14 days — a paid commercial license).
**Deferred (anti-bot):** LinkedIn, Indeed, Glassdoor, ZipRecruiter, Monster, Wellfound, Work.ua, robota.ua, Upwork, Toptal, etc.

## 4. Data flow (high level)

```
cron (per-source cadence)
  └─ Collector → JobSourceProvider.collect(config) → NormalizedPosting[]
        ├─ API/RSS provider: HTTP → already structured
        └─ HTML provider: self-hosted Firecrawl (fetch→markdown) → Claude structures → fields
  → Layer 1 filter (remote/fulltime/seniority/freshness)  [free]
  → Layer 2 filter (tech ∩ union(seniors.tech_stack))     [free, keyword]
  → Dedup (fingerprint) → upsert into job_postings, merge copy-sources
  → Rank recompute → relevance queue
  → HR UI (list by rank + card with multi-links)
```

## 5. Provider abstraction (reuse the old seam)

The old module `apps/api/src/job-sourcing/` already gives `JobSourceProvider.collect(config) → NormalizedPosting[]`

- `job_sources`/`job_postings`/budgets (DAY/MONTH) in the schema. We extend:

* `JobSourceType` enum: add members for each source (currently only `DOU_RSS`).
* Three base helper classes: `ApiJsonProvider`, `RssProvider`, `FirecrawlHtmlProvider` — each
  concrete source = a thin subclass (endpoint + field mapping). Outward — a single interface.
* **Strictly:** the provider does NOT throw on a single malformed record (skip), MAY throw if the source is unavailable
  (the collector catches it, logs as a failed run). Content from the provider is UNTRUSTED (as marked in the schema).

## 6. Engine: two paths

### 6.1 API/RSS (the majority) — pure NestJS cron

A scheduled HTTP request, mapping into `NormalizedPosting`. No AI, no browser, no anti-bot risk.
That's ~80% of coverage. Cheap, reliable, testable.

### 6.2 HTML minority — self-hosted Firecrawl + Claude

Firecrawl OSS (Docker: api+worker+playwright+redis, ≥1–2 GB RAM) fetch→markdown; Claude structures the
markdown→vacancy fields. **AGPL-3.0:** modifications of a network service must be published — for us this means
NOT forking Firecrawl (use it as is, via their API contract), or keeping the fork public.

**DECISION A (HTML structuring) — on the owner's subscription.**
Claude via the **owner's subscription** (scheduled headless Claude / Agent SDK). The volume is small (HTML —
a minority of sources), the quota load is limited. RISK (accepted): a shared limit with dev work —
we hit the weekly limit in this session. Mitigation: process the HTML batch in small portions, outside peaks
of dev activity; the Claude API remains a documented fallback if the limit starts to hit prod.

**DECISION B (where Firecrawl + egress go) — the main prod VPS.**
Firecrawl OSS and the scrape egress — on the main VPS (cheap, no extra box). RISK (accepted): a scrape ban
could hit the prod-CRM IP. Mitigation: a polite rate-limit to cooperative sites, respecting robots.txt,
a conservative cadence; if the prod-CRM IP starts getting flagged — reconsider (a separate egress proxy, phase 2).

## 7. Layered relevance filter (AI outside ingest)

1. **Layer 1 (free, structural/keyword):** remote-only · fulltime (not freelance) · seniority
   ∈ {Middle, Middle+, Senior, Techlead} (by keywords in title/description) · new since the last run.
2. **Layer 2 (free, keyword):** the vacancy's stack ∩ `union(all users.tech_stack)` ≥ 1 match.
   `users.tech_stack` — a structural array (chip-input), AI for the senior side is NOT needed.
   For HTML sources the text is already obtained via Firecrawl+Claude; for API/RSS — a direct keyword match on the description.
3. **AI only** at step 6.2 (HTML structuring), not on the filter.
4. **A precise match to a specific senior — NOT here** (a future tailoring phase).

Seniority/stack not recognized by keyword (rare) → conservative: let it into the queue with a low rank, do not lose it.

## 8. Dedup + data model

- **Fingerprint** (as in the old `computePostingFingerprint`): `normalizeCompanyName(company)` + the normalized
  title + (opt.) location. The same fingerprint from different sources = ONE record.
- The canonical copy = from the platform with the greater weight; the other sources are kept as a list
  `also_seen_on: [{source, url}]` (JSONB) → in the HR card "also open on: [links]".
- Tables: we extend `job_postings` (external_id, url, title, company, company_normalized, location,
  description_md, published_at, fingerprint, source_type, also_seen_on JSONB, matched_senior_ids[],
  rank_score, status, first_seen_at, last_seen_at). `job_sources` — source config + weight + budget.
- All `job_postings` content is UNTRUSTED (validation on read, no raw HTML — markdown).

## 9. Relevance queue + rank (v1 simple)

`rank_score` = f(freshness, number of matches, platform weight):

- **Freshness:** newer is higher, exponential decay by days since `published_at`/`first_seen_at`.
- **Number of matches:** how many of our seniors fit by stack (more — higher).
- **Platform weight v1:** EQUAL for all (a simple start). Validity signals (HR opened/applied / dead
  link / spam) are **logged** from v1, but for now the weight enters the formula as a constant. The feedback loop (weight by history) — phase 2.
- Rank recompute on every run + when the senior roster changes (the union tech_stack changes → matches change).

## 10. Per-source budget/cadence

We reuse `job_source_budgets` (DAY/MONTH windows). Each source — its own cadence:

- Free-unlimited JSON/RSS: daily.
- Quota APIs: stretch out (Jooble once a week; JSearch/TheirStack — budget/mo, evenly).
- HTML/Firecrawl: accounting for the stack load + a polite rate-limit (do not tease the anti-bot of cooperative sites).
- The budget guard (from the old module) prevents exceeding the source's quota.

## 11. HR UI

- A list-queue by `rank_score` (new/relevant on top).
- A vacancy card: title, company, stack (matches with our seniors highlighted), location=remote,
  seniority, description (markdown), `published_at`, **"also open on: [links]"**, the number/list of match-seniors.
- **A single "Open / Take into work" button** → transition to downstream (a future phase) + a record status change.
- RBAC: HR access (+ ADMIN). Design gate: the screen is new → Tier 1 (Claude Design + ui-ux-designer).

## 12. Owner decisions (2026-10-04) — closed

- **A** — HTML structuring: **owner's subscription** (Claude API — fallback). ✓
- **B** — Firecrawl/egress: **the main prod VPS** (with the rate-limit/robots mitigation; a separate egress — phase 2 if the IP is flagged). ✓
- **ATS company seed list:** we take it **from the research**; additional research on fable (a parallel task) concretizes
  the list of target product companies + their ATS boards (Greenhouse/Lever/Ashby/…) and clarifies API terms.
  For v1 the starting seed is hardcoded from the research; UI management of the list — the next phase.
- **v1 scope** (only sourcing + queue, downstream deferred) — approved.

## 13. Legal / risks

- **AGPL-3.0 Firecrawl:** use as is, do not fork (or keep the fork public).
- **Gray areas (WTTJ Algolia, etc.):** we try; on a ban — disable the source, do not escalate circumvention.
- **robots.txt / politeness:** respected on cooperative sites (rate-limit, User-Agent).
- **IP ban:** isolate the scraping egress (sub-fork B).
- UNTRUSTED vacancy content: strict validation, markdown without raw HTML (XSS in the HR UI).

## 14. Deferred → separate tasks

- **fable additional research** (a separate task per the owner's decision): polish the source catalog
  (the ATS company seed list, clarification of API terms, young boards), update `job-sources-research.md`.
- Future phases: match-to-senior → AI résumé tailoring to the vacancy → auto-apply (the hardest:
  each site has its own form/flow) → HR apply filters (blacklist) → access to the giants via a paid bridge.
- Phase 2: the platform-weight feedback loop by validity history.

## 15. Shelf life

The source/anti-bot catalog — review by 2027-01-15 or on triggers (403/429 on a source in the set).
The design — a revision when moving to the downstream phases.
