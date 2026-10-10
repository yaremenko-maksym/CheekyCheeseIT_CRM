# Vacancy auto-sourcing — design r5 delta (corrections to the r4 design)

**Revision:** r5, 2026-10-10 · **Status:** reviewable proposal for a DEFERRED feature — not owner acceptance, not an
authorization to implement, deploy, purchase, provision credentials or contact sources.
**Base:** the colleague's r4 design (`2026-10-10-vacancy-sourcing-design.r4.md`, supplied as an upload; not in this
repository). r4 remains the normative design text **except** where a numbered delta below overrides it. Section
numbers refer to r4's sections. The companion plan is
`docs/superpowers/plans/2026-10-10-vacancy-sourcing-plan.r5.md`; its §0 holds the repository evidence (C-01…C-30)
cited here.
**Prior version:** `docs/superpowers/specs/2026-10-04-vacancy-sourcing-design.md` (superseded).

A short delta rather than a rewritten design: r4's architecture (native identity, egress/SSRF boundary, access
hygiene, availability ↔ workflow split, durable PostgreSQL work ownership, immutable rank generations, migration
ledger, Europe/Kyiv cron, measurement plan) survives contact with the code. What changes is the inventory of what
already exists, four names, and a handful of mechanics that r4 described as present but that are not.

---

## D-01 — §5 "Provider abstraction": what exists and what does not (C-01, C-02, C-03)

r4: "Keep the existing DOU `JobSourceProvider.collect(config) → NormalizedPosting[]` contract … Reuse `ApiJsonProvider`,
`RssProvider`, and `FirecrawlHtmlProvider` as bounded acquisition helpers."

r5:

- `apps/api/src/job-sourcing/job-source.provider.ts:JobSourceProvider` and `dou.provider.ts:DouRssProvider` are the
  **only** provider surface; the registry is a `Map` inside `job-sourcing.service.ts:JobSourcingService`. The three
  helper bases, `HTML_SOURCE_TYPES`, `computeDedupeKey`, `evaluatePosting` and `PostingRepository` **do not exist** and
  are created by the plan, not reused.
- Already shipped and to be extended, not re-created: the shared normalizer
  `normalize/build-posting.ts:buildNormalizedPosting` (PR #785) and the hardened fetch
  `http/bounded-fetch.ts:boundedFetchText` with typed `SourceBlockedError`/`SourceRateLimitedError` (PR #786).
- `boundedFetchText` has **no production caller**; `DouRssProvider.readFeed` still uses raw `fetch`. New adapters use
  the shared fetch (A1n); DOU migrates only behind the Task 4.6 golden-fixture gate. The r4 sentence "current code
  already uses manual redirects" is true of the helper, not of the live collector.
- The legacy RSS scanner `rss.ts:parseRssItems` is deliberately dependency-free and DOU-only; the new RSS/Atom helper is
  a reviewed dependency decision (C-20).

## D-02 — §8 "Dedup + data model": the Phase-1 columns already exist and are the legacy projection (C-01, C-04, C-16)

r4: "Keep `job_postings` and `job_suggestions` as the legacy DOU projection … New durable source records use
`(provider, namespace, native ID)`."

r5 adds the fact r4 could not see: PR #770 already added to `job_postings` the columns `dedupe_key` (partial unique
index `uq_job_postings_dedupe_key WHERE dedupe_key IS NOT NULL`), `also_seen_on`, `matched_senior_ids`,
`matched_keywords`, `seniority`, `stack_unknown`, `rank_score`, `queue_status`, `taken_by`, `taken_at`, `last_seen_at`,
plus `job_posting_signals`, `job_sources.min_interval_hours`/`disabled_reason`, and the 31-member `job_source_type`
enum — all on prod via `2026-10-05_vacancy_sourcing_schema.sql`. **No code reads or writes these columns**
(`collectSource` reports `merged: 0, filtered: 0`; `persistPostings` never sets `dedupe_key`). They are additive,
unused, and stay that way: the new store is separate tables; nothing in the new queue depends on them. The seed
`2026-10-05_vacancy_sources_seed.sql` (16 disabled rows keyed by the unique `(type, config)` pair) is immutable; its
header's "append rows here later" is superseded by forward deltas + the migration ledger. A stable manifest ID is a
new column, because `(type, config)` identity means a config edit creates a second row.

## D-03 — Naming: the canonical external entity is not a "vacancy" (C-14)

r4 names the canonical entity `job_vacancies` (and `job_vacancy_sources`, `job_vacancy_matches`,
`job_vacancy_team_triage`). `CONTEXT.md` reserves **Vacancy** (`vacancies`, `vacancyApplications`,
`api-errors/vacancies.ts`) for the studio's own landing postings, and defines **Job source** / `jobPostings` /
`jobSuggestions` for the external feed family; reusing a glossary term for a second concept is a review finding.

r5: code identifier **job opportunity** — `job_opportunities`, `job_opportunity_sources`, `job_opportunity_matches`,
`job_opportunity_team_triage` (the rest of the r4 names — `job_source_records`, revisions, runs, cycles, generations,
assignments, dismissals, actions, meters — are unchanged). HR-facing copy may still read «вакансія» / "vacancy"; the
glossary entry is added to `CONTEXT.md` by the implementing PR. The final identifier is an **A2 owner decision** with
this recommendation.

## D-04 — §6.1 Engine: the cron that exists, and the one that does not (C-07, C-23)

r4: "Cron only enqueues due source work … 05:00 API/RSS and 02:30 HTML keep their original clock times."

r5: only `job-sourcing.cron.ts:JobSourcingCronService.handleDailyCollection` (`@Cron('0 5 * * *')`, no `timeZone`)
exists, and it currently runs collection **and** `purgeStalePostings` inline. 02:30 is a proposal. Both schedules get
`timeZone: 'Europe/Kyiv'` (A1m; evidence that Kyiv is the business zone: `packages/shared/src/utils/kyiv-day.ts`,
`finance/nbu-currency.service.ts`). The repository's cron convention — handler body in try/catch, never rethrow — is
kept regardless of whether an unhandled rejection really stops other schedulers.

## D-05 — §6.2 HTML minority: heading, model route and environment keys (C-21)

r4's heading "self-hosted Firecrawl + Claude" is a traceability address only; the model route is OpenRouter or a
self-hosted local model behind one OpenAI-compatible structured-output port (owner, 2026-10-10), extraction only.

r5 adds: `apps/api/src/config/env.ts` already carries `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_AI_TOKEN`, but they belong
to résumé generation (`resumes/resume-ai.service.ts`). The withdrawn Cloudflare Workers AI route must not be
reintroduced by reusing them; extractor secrets are **new optional keys** read only by the worker process, which runs
in a separate compose project/profile with its own network and never joins the prod `backend` network where
`postgres`/`redis` live (`docker-compose.prod.yml`). The engine decision (single pinned headless Chromium vs Firecrawl)
is taken after MP-01; the Firecrawl service list, AGPL scope and Web Bot Auth status are external claims flagged
**open** in the plan.

## D-06 — §13 Legal/risks and §10 budgets: egress boundary and metering, as shipped vs required (C-06, C-22)

r4 (correctly) requires DNS resolution/pinning, private-range denial, disabled auto-redirects, browser-subrequest
coverage and a least-privileged worker DB role.

r5 records the gap precisely: `boundedFetchText` enforces HTTPS-only exact-authority allow-lists, manual redirects
with per-hop re-validation, 2 MiB/15 s/1 s defaults and 10 MiB/60 s/3-redirect ceilings, 403/429 typed stops — but
**never resolves DNS** (IP literals and `.local/.internal/.localhost` names are rejected; a public name resolving to a
private address is not), returns only the body text (no status/headers/validators), and keeps per-host spacing in an
in-process `Map`. The egress proxy / `connect`-hook pinning, the result envelope and PostgreSQL-shared rate state are
therefore new work on top of a shipped helper. The collector UA
`CheekyCheeseIT-CRM/1.0 (job sourcing; +https://cheekycheese.tech)` exists in two copies (`bounded-fetch.ts`,
`dou.provider.ts`); the bot-page UA replaces both, and the `/bot` page lives on `apps/landing` (Coder zone, A2).

Budgets: the legacy one-unit-per-`collectSource` charge (`chargeBudget`, compare-and-set ×3, typed deliberate-stop
errors, DAY/MONTH windows) stays for DOU; new sources use the r4 account meter/reservation model. The seeded quota
numbers (Jooble 6/MONTH, JSearch 3 × 60/MONTH, TheirStack 8/MONTH) are the 2026-10-04 assumptions r4 already declares
non-authoritative.

## D-07 — §11 HR UI: what the web app already has (C-11, C-12, C-13)

r4 describes the queue screen as new (correct) and references existing pieces by approximate names.

r5 fixes the inventory: the markdown renderer with explicit `urlTransform`/`img`/`a` props (no `rehype-raw`) is
**inline** in `components/job-sourcing/JobSuggestionDialog.tsx` and is extracted into `PostingMarkdown.tsx`; the
safe-open helper is `components/job-sourcing/open-original.ts:openOriginalPosting`; hooks live in
`apps/web/app/hooks/use-job-sourcing.ts`; `SourceBudgetPanel.tsx` exists; route roles come from
`lib/route-access.ts:ROUTE_ACCESS` + `navRolesFor`. The legacy per-senior entry point is hidden by
`routes/_authenticated/interviews/index.tsx:JOB_SOURCING_ENTRY_ENABLED = false` (owner, 2026-09-24); its fate when
`/job-queue` ships is an A2 question and the flag is not flipped implicitly. i18n: Lingui `sourceLocale: 'uk'`, CI step
"i18n catalogs are in sync (lingui extract --clean)", cyrillic guard `scripts/devops/check-no-russian-letters.mjs`
(excludes the legacy `job-sourcing` directory, guards the new `job-queue` one); API refusals use per-domain error-code
files (`packages/shared/src/schemas/api-errors/*`), of which job sourcing has none yet.

## D-08 — §12 Owner decisions and provenance (C-18, C-27, C-28)

- The research files (`job-sources-research.md` ~95 sources, `job-sources-ats-seed.md` 171 ATS endpoints) were
  session-scratchpad artifacts and were never committed; PR #767 did not attach them. "Absent in the reviewed
  checkout" is therefore "never a repository artifact". The gate is unchanged: rebuild a typed manifest with
  provenance before activation; the old files may be inputs, never verification.
- Language: the repository rule is English for code/docs/agent output and `uk`/`en` for the product
  (`.claude/rules/common/russian-language.md`, 2026-10-05). The 2026-10-04 plan/spec were translated in PR #810.
- There is no PM agent; Master orchestrates.
- Node is pinned by `.nvmrc` (22) and `engines` (`>=22.19 <23`); no host-specific paths in any document.

## D-09 — §4 Data flow: the retention and the existing deploy model (C-08, C-15)

r4's flow is unchanged. Two repo facts sharpen it: (1) retention today loads every decided posting ID into memory
(`purgeStalePostings` + `notInArray`) — the `NOT EXISTS` rewrite is a real fix, not a style note; (2) prod DDL is
applied by `deploy.yml` with a bare `psql -v ON_ERROR_STOP=1 < file` per file on every deploy, guarded by
`scripts/devops/check-prod-ddl-wiring.py` (copy + apply must both be wired) and by a hard-required file list mirrored
in `docs/runbooks/deployment.md` §9; `drizzle-kit` is not in the prod image. The migration ledger ADR must satisfy or
extend that guard.

## D-10 — §15 Shelf life (unchanged, with the open list)

Catalog review 2027-01-15 and the earlier triggers stand. Everything in r4 that depends on a vendor document
(Recruitee token deadline, Dice/NoFluffJobs robots, Remotive attribution, TheirStack billing, Firecrawl service list,
Web Bot Auth draft, Content-Signal format, pg-boss version, OpenRouter parameters) is **open** until refreshed with
`external-research` at resumption.

---

## What this delta does not change

r4 §§1–3 (goal, boundaries, source families), §7 (layered relevance with unknown ≠ contradictory ≠ incompatible and
ADMIN triage), §8's identity rules (native `(provider, namespace, nativeId)`, ATS job-URL keys, possible-duplicate
confirmation, content-addressed text blobs, no company+title uniqueness), §9 (integer rank, immutable generations,
initial-sweep freshness 0), §10 (reservation/reconciliation, Retry-After, pause ≠ disable), §13's access-hygiene rules
and §14's deferred list are carried as written. The feature stays deferred; a separate adversarial audit pass follows
on r5.
