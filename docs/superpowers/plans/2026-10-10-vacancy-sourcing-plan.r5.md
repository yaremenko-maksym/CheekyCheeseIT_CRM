# Vacancy auto-sourcing v1 — Implementation Plan (r5, reconciled with the repository)

**Revision:** r5, 2026-10-10 · **Status:** reviewable proposal for a DEFERRED feature — not owner acceptance, not an
authorization to implement, deploy, purchase, provision credentials or contact sources.
**Base:** the colleague's audited r4 plan (`2026-10-10-vacancy-sourcing-plan.r4.md`) and r4 design
(`2026-10-10-vacancy-sourcing-design.r4.md`), both supplied as uploads and **not committed to this repository**;
the r4 "evidence bundle" (`docs/superpowers/reviews/2026-10-10-vacancy-sourcing/`) referenced by r4 does not exist in
this checkout either. r5 carries r4's content and corrects it against the code on `main` as of commit `cff2ea12`.
**Design:** r4 design + `docs/superpowers/plans/2026-10-10-vacancy-sourcing-design.r5.md` (delta).
**Prior version:** `docs/superpowers/plans/2026-10-04-vacancy-sourcing-plan.md` + `docs/superpowers/specs/2026-10-04-vacancy-sourcing-design.md`
(superseded by r4/r5; kept for traceability — task numbering below matches them).

**Owner decisions carried (2026-10-04 + 2026-10-10):** DECISION A revised — model extraction uses **OpenRouter or a
self-hosted local model behind one OpenAI-compatible structured-output port; model use is extraction only**; the
Claude-subscription CLI route and the Cloudflare Workers AI route are **withdrawn**. DECISION B retained — main prod
VPS, separate egress only if measured isolation/capacity fails. Sourcing + HR queue only; matching, résumé
tailoring and auto-apply stay deferred.

> Every correction in §0 cites the repository by `path:symbol`. No line numbers (doc-durability rule). Where r4
> relies on facts outside the repository (vendor terms, robots files, draft RFCs) r5 keeps the claim and flags it as
> **open** — verifiable only by `external-research` when the feature is resumed.

---

## 0. Corrections vs r4

| ID   | r4 said / assumed                                                                                                                                                                                                       | Repository evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | r5 correction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C-01 | Phase 1 (Tasks 1.1–1.3) and kit Tasks 2.1–2.2 are future work (dispatch map "Contracts/store 1.x", milestone M1 "1.1–1.3 store; 2.1–2.5 kit").                                                                          | PR #770 (2026-10-05) landed Phase 1: `packages/shared/src/schemas/job-sourcing.ts:jobSourceTypeSchema` (31 members), `jobQueueItemSchema`/`jobQueueCardSchema`/`jobQueueListSchema`/`jobQueueQuerySchema`/`dismissJobQueueItemSchema`; `apps/api/src/database/schema.ts:jobPostings` queue columns (`dedupeKey`, `alsoSeenOn`, `matchedSeniorIds`, `matchedKeywords`, `seniority`, `stackUnknown`, `rankScore`, `queueStatus`, `takenBy`, `takenAt`, `lastSeenAt`), `jobPostingSignals`, `jobSources.minIntervalHours`/`disabledReason`; DDL `apps/api/drizzle/manual/2026-10-05_vacancy_sourcing_schema.sql` + seed `2026-10-05_vacancy_sources_seed.sql`, both copied and applied by `deploy.yml` (`VACANCY_SCHEMA_FILE`, `VACANCY_SEED_FILE`) and pinned by `apps/api/src/database/job-queue-schema.spec.ts`. PR #785 landed Task 2.1 (`apps/api/src/job-sourcing/normalize/build-posting.ts:buildNormalizedPosting`, `parseDateish`, `RawPostingFields.keepQueryParams`). PR #786 landed Task 2.2 (`apps/api/src/job-sourcing/http/bounded-fetch.ts:boundedFetchText`, `http/source-errors.ts:SourceBlockedError`/`SourceRateLimitedError`). | §1 lists landed work. Tasks 1.1–1.3, 2.1, 2.2 become **extend-in-place** tasks. The landed Phase-1 columns are exactly the "legacy queue projection" r4 supersedes: they exist in prod schema but **no code reads or writes them** (`job-sourcing.service.ts:collectSource` returns `merged: 0, filtered: 0`; `persistPostings` never sets `dedupeKey`). They stay additive and unused by the new store (A1c/A1d).                                                                                                                                                       |
| C-02 | "Current code already uses manual redirects; preserve that" (Task 2.2) — implying the live collector is on the hardened fetch.                                                                                          | `boundedFetchText` has **no production caller**: only `http/bounded-fetch.spec.ts` imports it. `apps/api/src/job-sourcing/dou.provider.ts:DouRssProvider.readFeed` uses raw `fetch` with its own UA, 15 s `AbortController`, streamed `MAX_FEED_BYTES` cap, no host allow-list, default redirect following.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | New adapters use `boundedFetchText` (extended per Task 2.2). DOU stays on its own path until the Task 4.6 compatibility fixtures exist; migrating DOU to the shared fetch is a separate, golden-fixture-gated step, not a silent side effect.                                                                                                                                                                                                                                                                                                                            |
| C-03 | "Reuse `ApiJsonProvider`, `RssProvider`, `FirecrawlHtmlProvider`"; `HTML_SOURCE_TYPES` "retains" seven members; `computeDedupeKey`, `evaluatePosting`, `PostingRepository` are "superseded"/"may remain the seam name". | None of these symbols exist in the repo. The only provider is `dou.provider.ts:DouRssProvider`; the registry is a `Map` built in `job-sourcing.service.ts:JobSourcingService` constructor (`this.providers = new Map([[dou.type, dou]])`); `job-sourcing.module.ts` lists `DouRssProvider` as the sole provider.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | All of them are **to be created**. r4's "supersede" wording for `computeDedupeKey`/`evaluatePosting`/`PostingRepository` applies to the 2026-10-04 plan's sketches, never to shipped code.                                                                                                                                                                                                                                                                                                                                                                               |
| C-04 | `uq_job_postings_dedupe_key` must not constrain the new store; legacy inserts keep NULL.                                                                                                                                | Confirmed: `schema.ts:jobPostings` declares `uniqueIndex('uq_job_postings_dedupe_key').where(dedupe_key IS NOT NULL)`; `persistPostings` inserts without `dedupeKey`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Kept, now with evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| C-05 | Old empty-result semantics must be preserved for DOU.                                                                                                                                                                   | `collectSource` throws `Source … returned 0 usable postings` and leaves `lastCollectedAt` untouched; `collectAll` reports it as a failure (`budgetExhausted: false`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Kept. The new `collectReport` path must not route through `collectSource`'s zero-postings throw.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| C-06 | Budget: "one collect = one credit" was the old assumption.                                                                                                                                                              | `job-sourcing.service.ts:chargeBudget` charges exactly one unit per `collectSource` BEFORE the provider, with `CHARGE_BUDGET_MAX_ATTEMPTS = 3` compare-and-set and typed stops `source-budget.error.ts:JobSourceBudgetExhaustedError`/`JobSourceBudgetContentionError` (base `JobSourceDeliberateStopError`). Windows are `DAY \| MONTH` (`jobSourceBudgetWindowSchema`). Seed budgets: Jooble 6/MONTH, JSearch 3 × 60/MONTH, TheirStack 8/MONTH.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | A1h kept; the seed numbers are the historical 2026-10-04 assumptions r4 already declares non-authoritative.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| C-07 | Cron: 05:00 API/RSS and 02:30 HTML "keep their original clock times".                                                                                                                                                   | Only one cron exists: `job-sourcing.cron.ts:JobSourcingCronService.handleDailyCollection` `@Cron('0 5 * * *')` with no `timeZone`; it also runs `purgeStalePostings` in the same handler. No 02:30 cron exists. `@nestjs/schedule ^6.1.3` (`apps/api/package.json`) supports the `timeZone` option.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 05:00 is an existing fact; 02:30 is a proposal. Both get `timeZone: 'Europe/Kyiv'` (A1m). Evidence for Kyiv as the business zone: `packages/shared/src/utils/kyiv-day.ts:kyivToday` and `apps/api/src/finance/nbu-currency.service.ts`.                                                                                                                                                                                                                                                                                                                                  |
| C-08 | Retention: replace the unbounded decided-ID array with `NOT EXISTS`.                                                                                                                                                    | Confirmed: `purgeStalePostings` loads all `APPLIED/REJECTED` posting IDs into memory and uses `notInArray`; `POSTING_RETENTION_DAYS = 90`; the pure twin is `retention.ts:shouldKeepPosting`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Kept with evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| C-09 | `HrAccessService.getActiveTeamPeers` returns a de-duplicated union without team IDs.                                                                                                                                    | Confirmed: `apps/api/src/common/hr-access.service.ts:getActiveTeamPeers` → `{ userId, role }[]`. Eligible seniors today: `job-sourcing.service.ts:findEligibleSeniorIds` (SENIOR, not archived, `team_members.left_at IS NULL`). A per-user active-team lookup now exists as `apps/api/src/finance/active-teams.util.ts:findActiveTeamsForUser` (PR #872) but lives in the finance zone and returns `seniorSharePercentOverride`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Team scope (Task 6.1) needs its own query in job-sourcing or a lift of `findActiveTeamsForUser` into `common/`; do not import finance utilities into job-sourcing.                                                                                                                                                                                                                                                                                                                                                                                                       |
| C-10 | "Keep `PATCH /job-sourcing/sources/:id`".                                                                                                                                                                               | `job-sourcing.controller.ts` exposes only `GET suggestions`, `PATCH suggestions/:id/status`, `GET/POST/DELETE exclusions`, `GET sources` (ADMIN), `POST collect` (ADMIN, `@Throttle` 10/min). No PATCH on sources, no `/job-queue` controller. Guards: global `JwtAuthGuard` + `@UseGuards(RolesGuard)` + `@Roles`, plus the APP_GUARD `UserAwareThrottlerGuard`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Task 6.5 **adds** the PATCH endpoint; Task 6.4 adds the whole `/job-queue` controller.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| C-11 | Web: `openOriginal` helper; `use-job-sourcing.ts` location; `PostingMarkdown` component.                                                                                                                                | Helper is `apps/web/app/components/job-sourcing/open-original.ts:openOriginalPosting` (+ `isSafeExternalUrl`). The hook lives at `apps/web/app/hooks/use-job-sourcing.ts`. The markdown renderer is inline in `components/job-sourcing/JobSuggestionDialog.tsx` (`ReactMarkdown` with explicit `urlTransform`/`img`/`a`, no `rehype-raw`); no `PostingMarkdown` exists. `SourceBudgetPanel.tsx` exists and is rendered from `JobSuggestionDialog`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Symbol names fixed in Tasks 7.1/7.3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| C-12 | The legacy UI entry is live.                                                                                                                                                                                            | `apps/web/app/routes/_authenticated/interviews/index.tsx:JOB_SOURCING_ENTRY_ENABLED = false` (owner, 2026-09-24) hides the «Подбор вакансий» button; the dialog, hooks and API stay intact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | New A2 question: fate of the legacy per-senior dialog when `/job-queue` ships (keep hidden / re-enable / retire). Phase 7 must not flip the flag implicitly.                                                                                                                                                                                                                                                                                                                                                                                                             |
| C-13 | i18n: CI check `catalog-sync`, commit `037274c61`; cyrillic guard.                                                                                                                                                      | The CI step is named "i18n catalogs are in sync (lingui extract --clean)" in `.github/workflows/ci.yml`; `lingui.config.ts` has `sourceLocale: 'uk'`, locales `uk`/`en`, catalogs `packages/shared/src/i18n/locales/{uk,en}/messages.po`. `scripts/devops/check-no-russian-letters.mjs` **excludes the `job-sourcing` directory** (`EXCLUDED_DIRS`), so a new `job-queue` component directory is guarded while the legacy dialog is not. API error codes live per domain under `packages/shared/src/schemas/api-errors/` (`*_ERROR_CODES` / `*_ERROR_PARAMS` / `*_ERROR_MESSAGES` with `/* i18n */ { id: 'api-error.X' }`), e.g. `api-errors/vacancies.ts:VACANCIES_ERROR_CODES`; job sourcing has no error-code file yet.                                                                                                                                                                                                                                                                                                                                                                                                                       | Step names and the error-code file pattern are fixed; the commit hash is dropped (not durable). Existing Russian literals in `source-errors.ts`, `source-budget.error.ts` and the controller's UUID `BadRequestException` are the "legacy exception texts" r4 keeps.                                                                                                                                                                                                                                                                                                     |
| C-14 | New tables named `job_vacancies`, `job_vacancy_sources`, `job_vacancy_matches`, `job_vacancy_team_triage`.                                                                                                              | `CONTEXT.md` reserves **Vacancy** (`vacancies`) for the studio's own landing postings (`schema.ts:vacancies`, `api-errors/vacancies.ts`) and **Job source** (`jobSources`/`jobPostings`/`jobSuggestions`) for external feeds; a term reused for a second concept is a review finding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | The canonical external entity is named **job opportunity** in code (`job_opportunities`, `job_opportunity_sources`, `job_opportunity_matches`, `job_opportunity_team_triage`); UI copy may still say «вакансія». Final name is an **A2 owner decision** (recommendation above); the implementing PR adds the glossary entry to `CONTEXT.md`.                                                                                                                                                                                                                             |
| C-15 | deploy.yml re-applies all manual SQL on every deploy; ledger as a separate DevOps task.                                                                                                                                 | Confirmed and sharpened: every file is listed in the `copy-compose` scp `source:` lists, applied by a bare `psql -v ON_ERROR_STOP=1 < file` (each statement autocommits; no `-1`), on every deploy, no registry; `scripts/devops/check-prod-ddl-wiring.py` fails CI unless each `manual/*.sql` is both copied and applied (or listed in `KNOWN_NOT_WIRED` with a reason); the "hard-required file list" in the rollback-target verification step must mirror `docs/runbooks/deployment.md` §9 (set-difference check). `drizzle-kit` is absent from the prod image (file header + runbook §5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Each new forward file costs four edits: scp list, apply step, hard-required list, runbook §9. The ledger ADR (Task 1.3) must keep `check-prod-ddl-wiring.py` green or extend it.                                                                                                                                                                                                                                                                                                                                                                                         |
| C-16 | Seed file: "already applied October 5 files immutable".                                                                                                                                                                 | The seed header says "Later phases append rows to this same file (still ON CONFLICT DO NOTHING)".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | r5 sides with r4 (immutability + new forward deltas) and records that the seed header's guidance is superseded; the reason is the checksum ledger. Seed identity today is the unique `(type, config)` pair (`uq_job_sources_type_config`), not a stable manifest ID — Task 3.7's stable IDs need a forward column. Seed contents today: 16 disabled rows (RemoteOK, Remotive ×3, Jobicy, Arbeitnow, Working Nomads, HN, Jooble, JSearch ×3, TheirStack, Muse, Reed, EU Remote Jobs); not seeded: Himalayas, Jobgether, all seven ATS types, Djinni, WWR, all HTML types. |
| C-17 | Host Node path `/Users/kstroevsky/.nvm/versions/node/v22.22.0/bin`; the prior plan's `v22.23.1` path "unavailable".                                                                                                     | `.nvmrc` = `22`; root `package.json` `engines.node = ">=22.19 <23"`, `pnpm 7.32.4` (`.claude/rules/common/version-pins.md`). Host paths differ per machine (this host has v22.23.1 and a non-22 default).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | No host paths in docs or task files: `nvm use` / `.nvmrc`, then `node --version`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| C-18 | `scratchpad/job-sources-research.md` "absent in the reviewed checkout".                                                                                                                                                 | It was never a repository artifact: both `job-sources-research.md` (~95 sources) and `job-sources-ats-seed.md` (171 ATS endpoints) were session-scratchpad files; PR #767's body does not attach them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | The gate stands: rebuild a typed manifest with provenance before activation. Recovering the old files from a workstation is allowed as _input_, never as verification.                                                                                                                                                                                                                                                                                                                                                                                                   |
| C-19 | `jobQueueCardSchema.descriptionMd` "uses the existing `MAX_DESCRIPTION_CHARS`".                                                                                                                                         | Wire cap is `packages/shared/src/schemas/job-sourcing.ts:DESCRIPTION_MD_MAX = 50000`; ingest cap is `apps/api/src/job-sourcing/html-to-markdown.ts:MAX_DESCRIPTION_CHARS = 20_000` (applied in `buildNormalizedPosting`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Both names are used per layer; the two caps must stay ordered (ingest ≤ wire) and tested.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| C-20 | Existing RSS helper.                                                                                                                                                                                                    | `rss.ts:parseRssItems` is a deliberately hand-rolled, dependency-free RSS 2.0 scanner (no namespaces/Atom/CDATA attributes, `MAX_FEED_BYTES` 2 MiB, `MAX_ITEMS` 200, no entity expansion). `apps/api/package.json` carries no XML, robots, undici, pg-boss or model-client dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Task 2.4's new RSS/Atom helper is a dependency decision (bounded review), not an extension of `rss.ts`; `rss.ts` stays DOU-only.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| C-21 | Env/config.                                                                                                                                                                                                             | `apps/api/src/config/env.ts` already has `JOB_MATCH_THRESHOLD` (default `DEFAULT_JOB_MATCH_THRESHOLD = 0.2`) and `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_AI_TOKEN` — the latter belong to résumé generation (`apps/api/src/resumes/resume-ai.service.ts`), not to this feature.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | The withdrawn Workers-AI route must not be reintroduced by reusing those keys. Extractor secrets are new optional keys, validated in `env.ts` and read only by the worker process.                                                                                                                                                                                                                                                                                                                                                                                       |
| C-22 | Bounded fetch "ceilings currently enforced".                                                                                                                                                                            | Confirmed values in `bounded-fetch.ts`: 2 MiB / 15 000 ms / 1 000 ms gap defaults, 10 MiB / 60 000 ms / 3-redirect ceilings, HTTPS-only exact-authority allow-list, 403→`SourceBlockedError`, 429→`SourceRateLimitedError`. Not present: DNS resolution/pinning (allow-list rejects IP literals and `.local/.internal/.localhost` names only), response status/headers/validators (returns a string), per-host state is an in-process `Map`. `DEFAULT_USER_AGENT` is `CheekyCheeseIT-CRM/1.0 (job sourcing; +https://cheekycheese.tech)`; DOU carries its own copy of that string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Task 2.2 is an extension of a shipped helper; the egress proxy / DNS pinning gap is real and stays in scope. Changing the UA to the bot form touches two copies.                                                                                                                                                                                                                                                                                                                                                                                                         |
| C-23 | "Do not claim that any cron rejection necessarily kills all NestJS schedulers."                                                                                                                                         | The repo convention asserts the opposite (`job-sourcing.cron.ts` class doc: never rethrow, shared with `SalaryCronService` and the retention crons).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Keep the convention (try/catch, never rethrow) regardless of which claim is right; r4's caution is kept as "do not rely on it either way".                                                                                                                                                                                                                                                                                                                                                                                                                               |
| C-24 | Exclusions.                                                                                                                                                                                                             | `filtering.ts:findMatchingExclusion` matches COMPANY via `companyNamesMatch` (plus DOU URL-slug aliases from `companyAliases`) and KEYWORD against title and company only — deliberately **not** the description; `deriveProjectExclusions` keeps archived projects excluding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Task 4.2 reuses these as-is; the description exclusion is out of scope by design.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| C-25 | Stack matching caps and the "techword149/0/75" case.                                                                                                                                                                    | `packages/shared/src/utils/stack-keywords.ts:MAX_STACK_KEYWORDS = 60`, `MAX_STACK_KEYWORD_CHARS = 100`, `canonicalStackKeywords`, `textMentionsStackKeyword`, `stackMatchScore`. No `techword` fixture exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Caps confirmed. The "techword" case is **open** (not in the repo); Task 4.2 names its fixture explicitly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| C-26 | E2E stand.                                                                                                                                                                                                              | `apps/e2e/tests/job-sourcing-mobile.spec.ts` exists on the mocked-auth fixture (`mockAuthAs`); `POST /api/auth/dev-login` exists (`auth.controller.ts`). `docs/design/job-sourcing-suggestion.md` is the existing (degraded, retroactive) design spec; `docs/design/vacancy-queue.md`, `docs/runbooks/vacancy-sourcing.md`, `docs/runbooks/vacancy-sourcing-measurements.md` do not exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Paths kept as creation targets; the existing mobile spec is the pattern for the gesture-safety assertion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| C-27 | Language policy.                                                                                                                                                                                                        | `.claude/rules/common/russian-language.md` now holds the 2026-10-05 English policy (repo and agent output English; product `uk`/`en`). The 2026-10-04 plan/spec were translated in PR #810.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | r4's language line is right; r5 restates it with the current rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| C-28 | Dispatch "for the PM".                                                                                                                                                                                                  | There is no PM agent (removed 2026-10-05; `CLAUDE.md`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | r4 already says Master orchestrates; r5 keeps that and drops the heading.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| C-29 | Deploy/compose isolation targets.                                                                                                                                                                                       | `docker-compose.prod.yml` networks: `postgres` and `redis` on `backend`; `api` on `backend` + `frontend`; `nginx` on `frontend`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Scraper/extractor containers run in a separate compose project/profile with their own network and never join `backend`.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| C-30 | Mutation testing wording.                                                                                                                                                                                               | `.claude/rules/common/mutation-gate-integration-specs.md`: integration specs are outside the mutation gate; pure modules are what the gate sees.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Task test bullets name which side (pure vs real-DB) each assertion lives on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

**Open (not verifiable from the repository; keep as r4 external claims, refresh with `external-research` before activation):**
Recruitee token enforcement date (2027-02-10), Dice robots disallow, Remotive attribution/delay, Jobgether/Himalayas
OpenAPI shapes, TheirStack per-record billing, Firecrawl SELF_HOST service list, Web Bot Auth draft status,
Cloudflare Content-Signal format, pg-boss version/engines, OpenRouter request parameters (`zdr`, `provider`,
`limit_reset`), the "techword" matching fixture, the `~55 configurations` count, the r4 evidence bundle and original
file hashes.

---

## 1. Repository state at r5 (already on `main`)

| Area            | What exists                                                                                                                                                                                                                                 | Where                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Source enum     | 31 `job_source_type` members, pg ↔ zod parity test                                                                                                                                                                                          | `schemas/job-sourcing.ts:jobSourceTypeSchema`, `schema.ts:jobSourceTypeEnum`, `database/job-queue-schema.spec.ts` |
| Legacy store    | `job_sources` (config jsonb, budgets DAY/MONTH, trigger mode, `min_interval_hours`, `disabled_reason`, unique `(type, config)`), `job_postings` (+ unused queue columns), `job_suggestions`, `job_exclusion_filters`, `job_posting_signals` | `schema.ts`                                                                                                       |
| Collector       | DOU RSS only; `JobSourceProvider.collect(config) → NormalizedPosting[]`; budget charge → fetch → `persistPostings` (ON CONFLICT fingerprint) → `createSuggestions`; zero postings = failure                                                 | `job-source.provider.ts`, `dou.provider.ts`, `job-sourcing.service.ts`                                            |
| Identity        | `canonicalizePostingUrl(raw, keepParams)` + `computePostingFingerprint(sourceType, canonicalUrl)` = sha256                                                                                                                                  | `job-source.provider.ts`                                                                                          |
| Normalizer      | `buildNormalizedPosting` (title 500 / company 255 / location 500 / URL 2048 reject / tags 50×60 / description via `htmlToMarkdown` or neutralized text; NUL/bidi/surrogate handling; `parseDateish`)                                        | `normalize/build-posting.ts`                                                                                      |
| Fetch           | `boundedFetchText` (see C-22) — no production caller yet                                                                                                                                                                                    | `http/bounded-fetch.ts`, `http/source-errors.ts`                                                                  |
| Filters / stack | `findMatchingExclusion`, `deriveProjectExclusions`; `stackMatchScore` & caps                                                                                                                                                                | `filtering.ts`, `packages/shared/src/utils/stack-keywords.ts`                                                     |
| Retention       | 90-day purge of undecided NEW rows inside the 05:00 cron                                                                                                                                                                                    | `job-sourcing.service.ts:purgeStalePostings`, `retention.ts`                                                      |
| API             | `/job-sourcing/*` (see C-10)                                                                                                                                                                                                                | `job-sourcing.controller.ts`                                                                                      |
| Web             | Per-senior suggestion dialog (hidden by flag), hooks, `SourceBudgetPanel`, `openOriginalPosting`                                                                                                                                            | `apps/web/app/components/job-sourcing/**`, `apps/web/app/hooks/use-job-sourcing.ts`                               |
| Prod DDL        | 2026-10-05 schema + seed wired (copy + apply + hard-required list)                                                                                                                                                                          | `.github/workflows/deploy.yml`                                                                                    |
| Tests           | unit + integration (RBAC, budget race/contention, matching), mobile E2E                                                                                                                                                                     | `apps/api/src/job-sourcing/*.spec.ts`, `apps/e2e/tests/job-sourcing-mobile.spec.ts`                               |

Everything else in this plan — reporting providers, source records/revisions, canonical opportunities, matches,
generations, assignments, the `/job-queue` API, the HR screen, HTML/model path — **does not exist yet**.

---

## 2. Global constraints

Each task inherits these; meaningful behaviour is tested red→green before implementation and reviewed. Existing
compatible code (§1) is inspected and extended, not recreated from the 2026-10-04 sketches.

- **Runtime pins:** Node 22 via `.nvmrc`/`nvm use` (never a host path), pnpm 7.32.4, NestJS 11 + Fastify, PostgreSQL 16,
  Drizzle `^0.45`, Zod 4, Lingui 5.9.5 exact — `.claude/rules/common/version-pins.md`. No bumps. Parser/queue/model
  client additions get a bounded dependency/license/security review (Architect + DevOps), never a hand-rolled
  standards reimplementation (C-20).
- **All source content UNTRUSTED:** runtime schema validation at ingest and on the wire (`.parse()`), NUL/bidi/surrogate
  handling (`build-posting.ts`), explicit bounds, `https:`-only navigation URLs (`externalHttpsUrlSchema`), markdown
  without raw HTML (`html-to-markdown.ts`, `JobSuggestionDialog` renderer props). Stored navigation URLs and server
  fetch allow-lists are separate policies. No unknown data grants authorization.
- **Per-record isolation and typed batch outcomes:** one malformed item is isolated and counted; envelope, DB, network,
  cost and partial coverage are reported distinctly; valid empty feeds are successes in the new report while
  `collectSource`'s legacy zero-postings failure is preserved for DOU (C-05).
- **Constants for destinations:** no admin-stored URLs (`schema.ts:jobSources` config comment), no hidden keys, every
  hop/socket/browser subrequest through controlled egress.
- **Legacy protected:** fingerprint `sha256(sourceType|canonicalUrl)`, DOU canonicalisation, suggestions, exclusions,
  résumé ranking, trigger modes and the one-unit budget stay byte-for-byte; new records use native scoped identity;
  new sources never feed legacy suggestions automatically (A1a).
- **Repository rules:** zone-of-write (`.claude/rules/common/zone-of-write.md`), git policy (explicit `git add`, no
  `--no-verify`, `ac_verified:`, `DATABASE_URL= git push`), live-DB read-only, prod DDL only via forward manual SQL
  wired per C-15, security review for schema provenance/RBAC/ingest/CLI/egress, merge only on explicit owner approval.
- **UI gate:** `docs/design/vacancy-queue.md` Tier 1 artifact before Phase 7; dark theme; responsive classes
  320/375/768/1024/1280/1440/1920; touch ≥ 44 px; a11y; `uk` + `en` copy review (`design-gate.md`,
  `responsive-design.md`, `design-fidelity-review.md`).
- **Language:** English in the repo and agent output; product `uk` (source locale) + `en` via Lingui; legacy Russian
  exception literals (C-13) remain until replaced by API error codes in the per-domain pattern.
- **Tests:** focused `pnpm --filter @crm/api exec vitest run <path>` (shared/web equivalents), typecheck and lint;
  integration specs with inline `DATABASE_URL=<disposable scratch>` after `SELECT current_database(), version()`;
  pure classification modules are the mutation-gate surface (C-30); feature pushes follow the E2E-before-push rule,
  docs-only diffs do not.

## 3. Assumptions (A1 — decided and recorded; rollback ≤ 1 PR per task)

| ID  | r5 operational contract                                                                                                      | Disposition vs 2026-10-04                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| A1a | Legacy DOU per-senior consumer stays an independent consumer; the queue uses `users.tech_stack`                              | Preserve goal, fix the wiring that filtered legacy input |
| A1b | ADMIN studio triage; HR one validated active team per request; team-lead triage grants; no team → empty                      | Supersede "unknown-stack OR" grant                       |
| A1c | Idempotent explicit legacy backfill; decisions never reset                                                                   | Supersede permanent NULL-key exclusion                   |
| A1d | Canonical facts per field/revision/provenance; equal platform weights                                                        | Supersede "first inserted copy"                          |
| A1e | Unverifiable employer / unknown stack / contradictions → triage; unknown agency/region/work-auth → lead warnings             | Amend brittle inference                                  |
| A1f | Evidence completeness instead of the 200-character cliff                                                                     | Supersede                                                |
| A1g | Global and per-senior/team exclusions evaluated independently of stack, before access                                        | Preserve, close the unknown-stack bypass                 |
| A1h | DOU keeps one-unit budgets; new sources use real-unit account reservation/reconciliation                                     | Supersede one-collect-one-credit                         |
| A1i | Typed idempotent forward seed deltas, disabled by default, ADMIN waves, no startup writes; 2026-10-05 files immutable (C-16) | Preserve                                                 |
| A1j | Integer rank, immutable generations, keyset pagination                                                                       | Preserve ordering, amend mutable cursor                  |
| A1k | Classify AUTH/ENTITLEMENT/ACCESS/RATE; pause ≠ disable; honour Retry-After                                                   | Supersede 403-permanent / 429-ordinary                   |
| A1l | No private Algolia key / WTTJ circumvention; only independently permitted routes                                             | Preserve                                                 |
| A1m | Cron `timeZone: 'Europe/Kyiv'` on both schedules                                                                             | New (base had no zone)                                   |
| A1n | New adapters use `boundedFetchText`; DOU migration to it is a separate fixture-gated step (C-02)                             | New                                                      |

## 4. Decision brief for the owner (accumulate; one batch; no decision is inferred from silence)

| Dependency                       | Evidence/action needed before enablement                                                                                                             | Independent progress                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Model extractor route (A2)       | Pick OpenRouter vs local by MP-03/MP-04; OpenRouter: dedicated key with USD limit + reset; local: host and model within measured capacity (Task 5.2) | All deterministic work proceeds                  |
| Canonical entity name (A2, C-14) | Approve `job_opportunities` (recommended) or another non-`vacancies` identifier; glossary entry in `CONTEXT.md`                                      | Store design proceeds under the recommended name |
| Legacy dialog fate (A2, C-12)    | Keep hidden / re-enable / retire the per-senior `JobSuggestionDialog` when `/job-queue` ships                                                        | Phase 7 proceeds; the flag is not touched        |
| Quota/restricted APIs            | Account keys/terms/current quota; Reed blocked without key; Muse until live fixture; Recruitee token requirement                                     | Non-credentialed sources proceed                 |
| VPS capacity/isolation           | Measurements (MP-05) and egress containment; money decision only if an upgrade/separate host is needed                                               | API/RSS/HTTP parsing proceeds                    |
| HTML engine (A2)                 | MP-01 rendering-need measurement; single pinned headless Chromium unless several sources need rendering (Task 5.1)                                   | Deterministic HTML parsing proceeds              |
| Triage semantics (A2)            | Confirm lead-warning vs triage split; standing team triage subscriptions                                                                             | Default proceeds                                 |
| Collector identity (A2)          | Bot page on the studio domain (`apps/landing`, Coder zone), `From` mailbox, dedicated egress IP with reverse DNS, Web Bot Auth key pair (Task 2.2)   | API/RSS start with UA + `From`                   |
| Studio policy freeze             | Allowed engagement/geography/work-auth, retention, lease/retry/concurrency, generation and alert parameters                                          | Pure tests and store work proceed                |

Human-only: tokens/keys, infrastructure purchases, source activation, provider contact. None is authorized by this
document.

## 5. Not in v1 (unchanged from r4)

Protected giants (LinkedIn/Indeed/Glassdoor/ZipRecruiter/Monster/Wellfound/Work.ua/robota.ua/Upwork/Toptal) without
a licensed integration; profile↔vacancy matching, résumé tailoring, auto-apply; learned platform weights;
application-stage HR blacklists; ATS-list UI; Adzuna/Careerjet and paid bypass bridges; separate scraping VPS
purchase (owner decision only on failed isolation); Claude-subscription CLI and Cloudflare Workers AI routes
(withdrawn 2026-10-10; another provider only through the same port by a new owner decision); event sourcing, Kafka,
vector matching, fuzzy entity-resolution UI; model-assisted classification of residual UNKNOWN dimensions (owner
cost decision later; would amend "extraction only"). Basic sustained-failure/freshness/drop-off alerts are in v1.
No universal 20 % threshold.

## 6. Orchestration map

Master orchestrates (no PM agent). Writers follow zones; reviewers are independent; documentation verification is
not a readiness pass.

| Group                                 | Responsibility / prerequisite                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| Compatibility gate 4.6                | Coder/AutoTest: golden DOU fixtures before any projection change                           |
| Store 1.x                             | Coder (schema/contracts) + DevOps (forward SQL wiring per C-15); code/spec/security review |
| Kit 2.x, identity 4.5–4.6             | Coder: reporting providers, egress, leases, meters                                         |
| Adapters 3.x                          | Disjoint source groups after kit contracts; shared registry/manifest edits serialized      |
| Classification 4.1–4.4, lifecycle 1.4 | Coder/AutoTest with persisted evidence and frozen policy                                   |
| HR API 6.x                            | Coder; real RBAC/action DB tests; security review                                          |
| Design 0.1 / UI 7.x                   | ui-ux-designer → Coder → AutoTest/manual-qa → design/fidelity/copy review                  |
| HTML 5.x                              | DevOps isolated deployment + Coder deterministic/model helpers                             |
| Rollout 8.x                           | DevOps + owner                                                                             |

Fan-out ≤ 3 non-overlapping tasks; the DAG in §Execution Handoff wins over numeric order.

## 7. File structure (targets; existing files marked ✓)

| Scope              | Files                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared             | ✓ `packages/shared/src/schemas/job-sourcing.ts` (+ spec) — extend; new `packages/shared/src/schemas/api-errors/job-sourcing.ts` error codes                                                                                                                                                                                                          |
| Schema/deploy      | ✓ `apps/api/src/database/schema.ts` — extend; new dated forward SQL under `apps/api/drizzle/manual/`; `.github/workflows/deploy.yml` copy/apply/hard-required list + `docs/runbooks/deployment.md` §9                                                                                                                                                |
| Provider kit       | ✓ `apps/api/src/job-sourcing/normalize/build-posting.ts`, ✓ `http/bounded-fetch.ts`, ✓ `http/source-errors.ts`; new `providers/{api-json,rss,html}.provider.ts`, `providers/registry.ts`, `collection/{run,work,account-meter,checkpoint,source-record}.repository.ts`, `worker/` entrypoint                                                         |
| Sources            | new `providers/sources/<source>.provider.ts` (+ specs, `__fixtures__/`), `providers/sources/as.ts`, `providers/manifest.ts`                                                                                                                                                                                                                          |
| Relevance/identity | new `funnel/{layer1,tech-match,rank,evaluate}.ts`, `identity/{resolver,ats-job-key,revision,lifecycle,dirty}.service.ts`                                                                                                                                                                                                                             |
| HR API             | new `queue/{job-queue.controller,job-queue.service,queue-visibility,queue-generation,queue-cursor,queue-actions}.ts` (+ specs)                                                                                                                                                                                                                       |
| HTML               | new `structuring/{http-discovery,robots-policy,json-ld,html-structurer.port,openai-compatible.structurer}.ts`; `infra/extractor/` compose project (DevOps)                                                                                                                                                                                           |
| Environment        | ✓ `apps/api/src/config/env.ts` — new optional worker keys; worker-only secrets                                                                                                                                                                                                                                                                       |
| UI                 | new `apps/web/app/routes/_authenticated/job-queue/`, `apps/web/app/components/job-queue/**`, `apps/web/app/hooks/use-job-queue.ts`; extract `components/job-sourcing/PostingMarkdown.tsx` from ✓ `JobSuggestionDialog.tsx`; ✓ `lib/route-access.ts`, ✓ `components/crm/nav-sidebar.tsx`; `docs/design/vacancy-queue.md` + assets; `uk`/`en` catalogs |
| Tests/ops          | new `apps/e2e/tests/job-queue.spec.ts`; `docs/runbooks/vacancy-sourcing.md`, `docs/runbooks/vacancy-sourcing-measurements.md`; `docs/runbooks/human-only.md` entries                                                                                                                                                                                 |

## 8. Measurement plan (MP-01…MP-14)

Each "measured before activation" phrase resolves to one row. Each run writes a dated record to
`docs/runbooks/vacancy-sourcing-measurements.md` (question, method, sample, raw numbers, decision, consuming task).
Thresholds are frozen before the run. Measurement traffic obeys Task 2.2 access hygiene and never touches the live
CRM database.

| ID    | Question                                                    | Method                                                                                                                                                                                                                 | Unlocks                                                                                         | When                              |
| ----- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------- |
| MP-01 | Which permitted HTML routes still need JS rendering?        | ≤ 5 bounded GETs per route; check JSON-LD `JobPosting`, hydration state, server-rendered items with native IDs                                                                                                         | HTML engine (5.1)                                                                               | M1 spike                          |
| MP-02 | Response size/pagination per source?                        | Same fetches + every evidence-ready API/RSS: decoded/compressed bytes, items/page, pages, content type                                                                                                                 | Per-source byte cap or list+detail mode (2.2)                                                   | M1 spike                          |
| MP-03 | Which model route/model extracts well enough, at what cost? | 50 labelled detail pages stratified by source/language; every candidate (OpenRouter models, local) with one prompt/schema; field accuracy, grounding, invented-URL rate, schema-valid rate, p50/p95 latency, cost/page | Route, model, `zdr`/fallback settings (5.2)                                                     | Before M5                         |
| MP-04 | Can a local model run on the target host?                   | Local runtime over the MP-03 set while replaying CRM load: tokens/s, wall time, peak RAM, CPU, CRM p95 with/without                                                                                                    | Local on VPS / other host / OpenRouter (5.2)                                                    | Before M5 if local is a candidate |
| MP-05 | Host headroom and worker needs?                             | CRM p95/p99, CPU, RAM, disk I/O idle and under load; repeat with worker and with browser engine; worker benchmarks on shadow data                                                                                      | Resource caps, lease/timeout caps (2.5), classification CPU budget (4.2), recompute batch (4.6) | M1 spike; before M5               |
| MP-06 | Do unchanged postings create revisions?                     | Shadow collection: revisions/record/week per source; top churn causes                                                                                                                                                  | Normalizer fixes (2.1)                                                                          | M1 shadow                         |
| MP-07 | Storage growth?                                             | Records/day × revision rate × text size; table/index sizes                                                                                                                                                             | Retention, disk/backup budget (1.4)                                                             | M1 shadow; every wave             |
| MP-08 | Relevance good enough to expand?                            | Labelled corpus metrics (8.2)                                                                                                                                                                                          | Expansion gate                                                                                  | M1→M3                             |
| MP-09 | Triage share?                                               | Daily triage share and backlog age per scope                                                                                                                                                                           | Triage ceiling (8.2)                                                                            | M2+                               |
| MP-10 | Configurations worth their cost?                            | Leads per 100 fetched, per paid credit, per HR hour                                                                                                                                                                    | Cadence/disable (8.2)                                                                           | M3+                               |
| MP-11 | Any source close to blocking us?                            | Per host: status mix, challenge detections, Retry-After frequency, latency trend, requests/bytes per day                                                                                                               | Per-host gap/ceiling/cadence; pause rules (2.2)                                                 | Continuous                        |
| MP-12 | Associations correct?                                       | False merges / missed duplicates on labelled pairs                                                                                                                                                                     | Association rules (4.3)                                                                         | M1→M3                             |
| MP-13 | Queue queries fast at projected volume?                     | `EXPLAIN ANALYZE` list/card/count on MP-07-sized data                                                                                                                                                                  | Indexes, generation retention (6.2)                                                             | M2                                |
| MP-14 | Queue freshness?                                            | Publication → first seen → visible                                                                                                                                                                                     | Source cadence (2.5)                                                                            | M3+                               |

**M1 spike (read-only):** MP-01, MP-02, MP-05 baseline before adapters are frozen; MP-03/MP-04 before any model
extraction. A missing measurement blocks only the decision it feeds.

---

# Phase 0 — Design gate (blocks only Phase 7)

### Task 0.1: Design artifact of the «Черга вакансій» screen (Tier 1)

**Files:** create `docs/design/vacancy-queue.md`, `docs/design/assets/vacancy-queue/design.html`, `design.png`
(320 and 1440 minimum) and state screenshots. Agent: ui-ux-designer (generation in Claude Design driven by the
orchestrator → spec). Reference for tone and the existing degraded spec: `docs/design/job-sourcing-suggestion.md`.

- [ ] **Brief (mandatory content):** HR + ADMIN screen, dark theme only; frames 320/768/1024/1440 × default/empty/
      loading/error; status tabs `Нові`/`У роботі`/`Приховані` with authorized counts; rank-ordered list (title,
      company, seniority badge, stack-signal chips, «N сеньйорів мають збіг стеку» from `totalMatchedSeniorCount`,
      publication age vs first-seen/last-observed, source icon, `+N також на …` from `totalAlsoSeenOnCount`;
      mobile = card stack); card (markdown description via the extracted `PostingMarkdown`, «Також відкрито на:»
      with continuation, matched seniors — names only inside the actor's team scope, availability/uncertainty/
      attribution/evidence, updated-since-list warning, possible-duplicate warning); one primary «Взяти в роботу» +
      «Відкрити оригінал» + «Приховати» (reason menu); «вже взято» state with the name masked outside the actor's
      scope; team switcher for HR in several active teams; ADMIN source block (Tier 2) showing disabled vs paused vs
      readiness-blocked, unit/quota/reserved/uncertain, last attempt/success/nonempty, policy/auth deadline; touch
      ≥ 44 px, no hover-only actions, long-name wrapping, `max-w` at ≥ 1440; ADMIN release/reassign/suppress and
      archived/closed-but-claimed warnings.
- [ ] **Acceptance:** token-map from `globals.css` only; component list (existing shadcn/ui vs new); responsive per
      class; edge cases (empty authorized queue, 200-char title, 0 matches, triage item, unknown date); mobile frame
      present — otherwise return to the designer.
- [ ] **Commit** (zone `docs/design/**`): explicit paths, `docs(design): vacancy queue screen spec (Tier 1)`.

# Phase 1 — Data model and contracts

### Task 1.1: Shared — extend the queue schemas (extend-in-place, C-01)

**Files:** ✓ `packages/shared/src/schemas/job-sourcing.ts` + spec; new `schemas/api-errors/job-sourcing.ts`.

- Keep `jobSourceTypeSchema` (31 members, order = pg enum), `jobSeniorityLevelSchema` `MIDDLE|SENIOR|LEAD|UNKNOWN`,
  `jobQueueStatusSchema` `NEW|IN_PROGRESS|DISMISSED`, `jobSignalKindSchema` `OPENED|TAKEN|DEAD_LINK|SPAM`,
  `dismissJobQueueItemSchema` reasons `NOT_RELEVANT|SPAM|DEAD_LINK`, page default 20 / max 50, cursor ≤ 300,
  `matchedKeywords`/`matchedSeniors` ≤ 200, `alsoSeenOn` ≤ 20, `descriptionMd ≤ DESCRIPTION_MD_MAX`. Legacy DTOs stay
  backward compatible; `jobCollectionResultSchema.merged`/`filtered` keep default 0 and their meaning.
- Add: availability `OPEN|UNKNOWN|CLOSED|EXPIRED`; collection outcome `STARTED|PARTIAL|SUCCEEDED|FAILED|CANCELLED`
  (SUCCEEDED may carry zero items); coverage `FULL_INVENTORY|WINDOW|PARTIAL`; detailed internal seniority/leadership
  kept separate from the wire enum; source identity/namespace, revision/evidence, collection report, metering/
  reservation, team scope (`teamId` on every list/card/continuation/action request), why-matched reasons, score
  components, source attribution, assignment version, scoped dismissal, bounded `possibleDuplicates` preview and
  `confirmPossibleDuplicate`; `jobQueueSeniorPageSchema` `{ items, totalMatchedSeniorCount, nextCursor }` and
  `jobQueueSourcePageSchema` `{ items, totalSourceCount, totalAlsoSeenOnCount = max(totalSourceCount − 1, 0),
primarySourceRecordId, relationVersion, nextCursor }`; `jobQueueTeamTriageGrantSchema` and
  `jobQueueTeamTriageSubscriptionSchema` with create/revoke schemas (strict objects, expected revision/policy/grant
  versions, bounded reason, expiry). Application URL separate from source posting URL; navigation URLs reject
  credentials/non-HTTPS (`externalHttpsUrlSchema`); fetch destinations have a stricter server-side policy.
- Error codes follow the per-domain pattern (`VACANCIES_ERROR_CODES` shape): `JOB_SOURCING_ERROR_CODES`, params and
  `/* i18n */` messages with `uk` source text; new API refusals use codes, not literals.
- [ ] Red→green: legacy DTO parsing/defaults, exact enums and order (mirror test in `job-queue-schema.spec.ts`),
      bounds, unsafe links, scoped counts, paginated associations, empty successful batches, partial coverage,
      report consistency (one disposition per input; persistence errors ≠ invalid records).
- [ ] Focused shared spec + full shared suite; typecheck consumers; `z.infer` types only; explicit commit paths.

### Task 1.2: Drizzle schema — the new store (additive; legacy columns untouched)

**Files:** ✓ `apps/api/src/database/schema.ts` (extend), new schema/migration specs. The Phase-1 queue columns on
`job_postings` stay for binary compatibility and are **not** read by the new queue (C-01, C-04). Nothing is dropped.

UUID primary keys, UTC `timestamptz`, FK/check/index declarations mirrored in Drizzle and forward SQL. Entity names
use the `job_opportunity*` family pending the A2 naming decision (C-14).

| Entity                            | Required fields and invariants                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job_sources` (✓ extend)          | Keep type/config/enabled/budget/trigger columns. Add stable manifest ID (seed identity is currently `(type, config)` — C-16), board/account namespace, manifest/policy version, account-meter reference, readiness, last attempt/success/nonempty/next-attempt/cooldown, consecutive failures, last typed error, administrative state history. Config version changes invalidate checkpoints. Never delete provenance by removing a source. |
| `job_collection_runs`             | source/config/adapter version, trigger, outcome/coverage, times, owner token, fencing epoch, lease, subrequest checkpoints, counts, metering links, sanitized errors. One running owner per source/config; stable attempt IDs.                                                                                                                                                                                                              |
| `job_collection_cycles`           | per trigger/logical occurrence; HTML call-budget reference; runs carry cycle FK; all HTML runs of one trigger share the initial 20-call reservation; manual cycles share the daily budget.                                                                                                                                                                                                                                                  |
| `job_source_records`              | UNIQUE(provider type, namespace, identity key); identity kind/native ID/URL fallback; original/display/source/application URLs; first-seen/last-observed/latest revision; availability evidence. Discovery queries are observations, not identity.                                                                                                                                                                                          |
| `job_source_record_revisions`     | record FK, adapter/normalizer version, content hash, normalized payload + original identity fields, field provenance/evidence, raw+parsed dates, received sequence/time, bounded sample reference. UNIQUE(record, content hash, normalizer version). Description text in content-addressed `job_text_blobs(sha256, text)`.                                                                                                                  |
| `job_opportunities`               | canonical UUID, employer identity nullable/verified, selected fields + field→revision provenance, availability, revision number, first-seen. No unique company/title constraint; candidate keys indexed non-uniquely.                                                                                                                                                                                                                       |
| `job_opportunity_sources`         | record FK, opportunity FK, decision/evidence/rule version, linked/unlinked time+reason; partial UNIQUE(record) WHERE active. History preserved.                                                                                                                                                                                                                                                                                             |
| `job_opportunity_matches`         | UNIQUE(opportunity, senior); input versions (opportunity revision, senior profile version, exclusion/rule versions), outcome LEAD/TRIAGE/EXCLUDED only (plain mismatch recomputed on demand), evidence, evaluated-at; stale versions never served; per-senior invalidation (keyword→opportunity index); invalidate on archive/team change.                                                                                                  |
| `job_queue_assignments`           | UNIQUE(opportunity), claim state, actor/team, taken-at, version, release/reassign metadata.                                                                                                                                                                                                                                                                                                                                                 |
| `job_queue_dismissals`            | UNIQUE(opportunity, scope kind, scope ID); scope TEAM or STUDIO (ADMIN-only); reason/actor/version/time, undo metadata.                                                                                                                                                                                                                                                                                                                     |
| `job_opportunity_team_triage`     | UNIQUE(opportunity, team); ADMIN-assigned after restriction checks; evidence/policy/revision/expiry; revalidated on policy/source change.                                                                                                                                                                                                                                                                                                   |
| `job_team_triage_subscriptions`   | standing ADMIN triage per team: role-family/source filter, policy version, expiry, actor, audit; never covers unverifiable-employer items.                                                                                                                                                                                                                                                                                                  |
| `job_queue_actions`               | append-only: opportunity, optional source record, actor/scope/action, before/after version, idempotency key, sanitized reason; kinds OPENED/TAKEN/DEAD_LINK/SPAM + DISMISSED/UNDONE/RELEASED/REASSIGNED/SUPPRESSED/TRIAGE_GRANTED/TRIAGE_REVOKED/TRIAGE_SUBSCRIBED/TRIAGE_UNSUBSCRIBED. Legacy `job_posting_signals` untouched.                                                                                                             |
| `job_queue_generations` / entries | scope/policy signature, rules/evaluation time, expiry; immutable entries keyed (generation, opportunity) with integer score/order keys; atomic publish; invalidate before purge.                                                                                                                                                                                                                                                            |
| account meter / reservations      | account identity (no secrets), unit/window/limit/reset, used/reserved/uncertain; UNIQUE(account, attempt ID); atomic spend guard; lifetime meters distinct from DAY/MONTH.                                                                                                                                                                                                                                                                  |
| durable dirty work                | UNIQUE(entity, target version, reason); kind, claim/lease/fencing/retry, checkpoint, terminal status; written in the producer's transaction.                                                                                                                                                                                                                                                                                                |

Source configuration snapshots on runs; records survive without a known employer; no employer invented from a slug;
bounded/encrypted samples only where policy permits; tombstones keep identity + decision scope without full text.
Cycle identity created atomically per trigger (deduplicated across replicas); manual triggers get their own cycle
with request-id dedupe; every work item/run/context/model reservation carries `cycleId`; reservations before spawn;
cycle closes when all children are terminal/deferred.

- [ ] Red→green schema tests against real pg catalogs (unique/check/default/FK/index), duplicate discovery configs
      observing one native job, out-of-order revisions, association splits, independent workflow state.
- [ ] Real-DB concurrency tests before adapters expand; legacy DOU tests run unchanged on the additive schema.
- [ ] Apply Drizzle (`db:push`) to one disposable DB and forward SQL to another; compare normalized catalogs.
      `SELECT current_database(), version()` first; no live CRM DB writes.

### Task 1.3: Prod DDL and deploy wiring (DevOps)

**Files:** new uniquely dated forward files under `apps/api/drizzle/manual/`; `.github/workflows/deploy.yml`;
`docs/runbooks/deployment.md` §9; the 2026-10-05 schema and seed are immutable.

- [ ] Follow the current wiring contract exactly (C-15): scp `source:` entry, an apply step invoking
      `psql -v ON_ERROR_STOP=1 < file` (statement-level autocommit), the hard-required file list, and the runbook §9
      mirror; `scripts/devops/check-prod-ddl-wiring.py` must stay green. Two-file split when an enum value is added
      and used (the repo's own header note on `ALTER TYPE … ADD VALUE`).
- [ ] Separate DevOps task + ADR: a migration **ledger** (applied ID + checksum; mismatch fails the deploy; catalog
      validation after idempotent partial DDL; explicit deployment lock). Applies to files added from this rollout on;
      existing files keep re-apply semantics until the ADR decides; the ledger must satisfy or extend the wiring guard.
- [ ] Forward-only additive DDL for the store; staged constraints/indexes with lock/statement timeouts; concurrent
      index builds outside a transaction with explicit invalid-leftover repair.
- [ ] Apply baseline → forward → generated disabled source delta on fresh and already-expanded scratch DBs twice;
      compare catalogs/checksums; run legacy binary tests and the new schema tests.
- [ ] Gate the new worker/API behind required-file/copy/apply steps; feature flag off during backfill; rollback leaves
      additive schema and decisions in place.
- [ ] Dedicated least-privileged PostgreSQL role + connection string for the collection worker (DML on job-sourcing
      tables; SELECT on evaluation inputs — users/team memberships, project-derived exclusion inputs, legacy résumé
      inputs; no DDL; no finance/session/credential tables). The single app `DATABASE_URL` cannot satisfy Task 2.2.

### Task 1.4: Retention and `last_seen_at`

**Files:** ✓ `retention.ts`, ✓ `job-sourcing.service.ts:purgeStalePostings`; new store retention job + specs.

- [ ] Keep the 90-day legacy purge and protection of APPLIED/REJECTED, IN_PROGRESS, DISMISSED; never delete an
      actively observed record for insertion age alone.
- [ ] Separate evidence TTL, inactive-observation cleanup, canonical history, generation expiry and decision/tombstone
      retention; storage estimate (MP-07) before each wave; durations frozen by owner policy — new-store cleanup
      disabled until then.
- [ ] Extend `shouldKeepPosting` with observation/bridge/policy context; protect backfill inputs until verified.
- [ ] Replace the in-memory decided-ID array with `NOT EXISTS` (C-08); keep decision FK relationships/tombstones.
- [ ] Tests: active > 90 days, archived descriptions, rediscovery with changed tracking URL, duplicate native identity,
      reopened opportunity, expired generations, legal deletion, audit minimization; reruns never recreate rejected
      suggestions.

# Phase 2 — Provider kit

### Task 2.1: Normalization — extend `buildNormalizedPosting` with observation identity (✓ landed base)

**Files:** ✓ `normalize/build-posting.ts` + spec; new observation/date/URL policy helpers. DOU canonicalisation
and fingerprint stay byte-for-byte; the stale `job-source.provider.ts` header comment ("scraping is out of bounds") is
updated to describe policy-gated cooperative HTML in the new seam.

```ts
type ObservationIdentity = {
  provider: JobSourceType
  namespace: string
  nativeId: string | null
  identityKey: string
  identityKind: 'NATIVE' | 'URL'
}
type SourceObservation = {
  identity: ObservationIdentity
  sourcePostingUrl: string
  applicationUrl: string | null
  originalFields: BoundedOriginalFields
  normalized: NormalizedVacancyFields
  evidence: FieldEvidence[]
  adapterVersion: string
  normalizerVersion: string
  contentHash: string
}
```

Namespace = verified board/account + regional endpoint variant (not a category row); key components encoded
unambiguously (canonical JSON tuple), never delimiter concatenation; no native ID → source-specific URL fallback with
preserved identity params and collision fixtures; neither → quarantine. Display limits stay as shipped (title 500,
company 255, location 500, URL 2048 reject, tags 50×60, description `MAX_DESCRIPTION_CHARS` 20 000 ≤
`DESCRIPTION_MD_MAX` 50 000 — C-19); originals retained with truncation flags; stored links reject userinfo/unsafe
schemes/ports/IP literals; IDN normalized consistently. Adapter-specific date contracts (ISO/RFC with zone, Reed
`dd/MM/yyyy`, Unix s/ms by field); raw date and semantics (updated/released/published/expiry) preserved; future dates
= uncertainty. Content hash over a versioned canonical payload without fetch timestamps/request IDs/relative-age
phrases/tracking tokens; MP-06 measures churn.

- [ ] Red→green: native-ID/URL metamorphic cases, delimiter collisions, repeated params, Unicode skills, oversized
      fields, unknown employer, HTML/text, timezone/DST/invalid/future dates, hash stability.
- [ ] Existing DOU/provider/normalizer specs unchanged as compatibility evidence.

### Task 2.2: Bounded fetch, egress boundary, source errors, access hygiene (✓ landed base)

**Files:** ✓ `http/bounded-fetch.ts`, ✓ `http/source-errors.ts` + specs; new egress policy, HTTP result envelope.

Keep the shipped defaults/ceilings (C-22). Extend: finite non-negative gaps bounded within a cancellable deadline;
decoded-byte cap on chunked/compressed bodies (Content-Length only a pre-check); parser depth/items/CPU bounds;
content type/charset; a result envelope `{ status, headers, body, receivedAt }` so 304, validators, rate headers and
Retry-After survive; per-source byte caps from MP-02 within the 10 MiB ceiling or list-plus-detail mode; cut-off =
PARTIAL. Scheme/host/port/userinfo checked per hop; **all** A/AAAA answers resolved and pinned through the controlled
egress (today's allow-list never resolves DNS — the rebinding gap is real); private/loopback/link-local/reserved/
metadata ranges denied; automatic redirects disabled (already `redirect: 'manual'`); cross-origin hops drop
auth/cookies/body; POST semantics tested. Prefer an established CONNECT proxy (e.g. Smokescreen) used via undici
`ProxyAgent` by the worker and the browser container; Node-side pinning only in an undici `connect`/`lookup` hook
proven by rebinding fixtures. Per-host/account state shared through PostgreSQL reservations (the in-process `Map` is
not global). Scraper containers never join the `backend` network (C-29). Failure classes AUTH/ENTITLEMENT,
ACCESS_POLICY, RATE_LIMIT, TRANSIENT_NETWORK, UPSTREAM, PARSE_DRIFT, INVALID_RECORD, PERSISTENCE, COST_STOP,
CANCELLED; 401/403 pause+alert, 429 honours Retry-After, no permanent ban inferred from status; bodies drained, timers
cleared.

**Access hygiene (unchanged from r4):** permission basis per manifest entry; no logged-in collection, one studio
account per provider; identify the collector — UA `<Studio>JobsBot/<version> (+https://<studio domain>/bot)` (bot page
on `apps/landing`, an A2 item; replaces the two copies of the current UA string), `From` header, stable egress IP
with reverse DNS; Web Bot Auth signatures (RFC 9421, draft protocol — open) where useful; robots `Crawl-delay` and
`Content-Signal` (`ai-input=no` → never reaches the model); per-host concurrency 1, jittered gaps, multiplicative
slow-down, conditional requests, detail fetches only for new/changed IDs, off-peak schedules, per-host daily ceiling
from MP-11; stop at the first challenge/403-on-allowed-route/429-without-Retry-After with escalating cooldown, resume
only by audited ADMIN action; never CAPTCHA, stealth, fingerprint spoofing, alternate endpoints, proxy rotation.

- [ ] Hygiene tests: UA/`From` on every request incl. redirects; signatures verify against the key directory;
      challenge fixtures pause and never retry; `Crawl-delay`/`Content-Signal` parsing; gap growth; daily ceiling;
      no cookie jar; missing permission basis blocks activation.
- [ ] Egress tests: pre-network redirect denial, pinned DNS/rebinding, IPv6/mapped, browser resources, ports/
      userinfo, secret-bearing redirects/logs, timeout during throttle/body, compressed oversize, valid 304, HTTP-date
      Retry-After, two-worker aggregate limits; runtime egress-denial from each container (security review), not
      allow-list string snapshots; redaction before truncation at every log boundary.

### Task 2.3: `ApiJsonProvider` base (new)

**Files:** new base + spec + report interface; DOU's array contract is not widened in place.

```ts
interface CollectionBatch {
  observations: SourceObservation[]
  outcome: 'PARTIAL' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
  coverage: 'FULL_INVENTORY' | 'WINDOW' | 'PARTIAL'
  scope: SourceCoverageScope
  requests: RequestReport[]
  counts: CollectionCounts
  checkpoint: ValidatedCheckpoint | null
}
interface ReportingJobSourceProvider {
  readonly type: JobSourceType
  parseConfig(raw: unknown): ValidatedSourceConfig
  collectReport(config: ValidatedSourceConfig, ctx: CollectionContext): Promise<CollectionBatch>
}
```

Scope includes board/query/config version/window; counts raw/normalized/invalid/quarantined; request reports carry
attempt/status/timestamps/error/meter cost without credentials; context supplies run identity, abort/deadline,
policy version, reserve/reconcile, checkpoints, cached responses. Bounded page iteration; runtime envelope and item
validation; drift fails the subrequest, bad items are isolated with bounded samples; DB failure ≠ INVALID_RECORD;
distinct native IDs collapsing is an adapter invariant failure (no 50 %-duplicate heuristic); completed pages and
checkpoints persisted before continuing; one board failing = PARTIAL; 403/429/cost stops preserve completed work;
PAGE_CAP on search scope = WINDOW; mismatched checkpoints restart bounded discovery with overlap.

- [ ] Red→green: valid/invalid/empty envelope, one bad item, extractor exception, partial board/page, rate stop after
      a page, cursor cycles, namespace collision, duplicate ratio, checkpoint recovery/config change, cost reports,
      bounded JSON depth/bytes/items; failures never claim SUCCEEDED/FULL_INVENTORY.
- [ ] Clear seams for fetch/map/schema overrides; `parseConfig` validated in seed tests; `.resolves`, never
      `.rejects.not.toThrow`.

### Task 2.4: `RssProvider` base (new; `rss.ts` stays DOU-only — C-20)

Maintained XML/REP parser after dependency/license review (the no-new-package default does not justify hand-rolling
standards); if rejected, the dependent adapters stay blocked. XML: no DTD/entity expansion/external entities/network,
bounded input/depth/elements/time; namespaces, CDATA, RSS GUID `isPermaLink=false`, Atom ID/link relations,
`content:encoded`, multiple authors, explicit encoding; GUID is opaque identity (DOU keeps its legacy timestamp-query
policy via `canonicalizePostingUrl`). Same `CollectionBatch` as API providers; malformed feed = drift, valid empty =
success; honest UA, no browser impersonation; validators saved, 304 reuses cached inventory; time-limited feeds never
claim full inventory. Personio uses an XML helper, not a JSON override.

- [ ] Fixtures: authentic DOU/Djinni/WWR/EU feeds, namespaces/Atom, CDATA/entities/encoding, broken envelope, empty
      feed, GUID/URL mismatch, XML bombs/XXE, truncation, partial group, updated descriptions; golden DOU outcomes
      unchanged.

### Task 2.5: Registry, cadence, durable work ownership, cron (✓ cron exists — C-07)

**Files:** new registry/cadence/run-worker/source-state services; ✓ `job-sourcing.cron.ts`, ✓ `job-sourcing.module.ts`.

One adapter per type, duplicates rejected at startup, DOU wrapped in an explicit legacy adapter; no optional
constructor arguments that change the production pipeline. Due selection from persisted next-attempt/cooldown +
enabled/readiness + trigger policy; keep `onlyTypes`/`excludeTypes` and `sourceAcceptsTrigger`; manual runs skip
cadence but not cooldown/entitlement/cost/current owner; attempts persist even on empty/error; last-success ≠
last-nonempty; legacy `lastCollectedAt` semantics preserved for DOU.

PostgreSQL ownership: `FOR UPDATE SKIP LOCKED` claim, fencing epoch/owner token committed before I/O, heartbeats for
the same owner/epoch only, every page write verifies the epoch, lease recovery reschedules work and uncertain
reservations; bounded worker pool, one active fetch per source/account; leases/timeouts/concurrency frozen after
MP-05. No DB lock held while fetching. Before hand-writing claims, compare against `pg-boss` via the
`codebase-design` "design it twice" step (new dependency → bounded review; version/engines claim open); if adopted,
keep the fencing epoch and check every `send` result.

Cron: existing `@Cron('0 5 * * *')` and a new 02:30 HTML schedule, both with `timeZone: 'Europe/Kyiv'`; handlers
only enqueue due work; the try/catch-never-rethrow convention stays (C-23); DST/restarts repaired by due-work
reconciliation and idempotent claims; the legacy 10-minute early-due slack cannot override quota/cooldown. `enabled`
is administrative permission; pause/health/reason/state history are separate; ADMIN enable never clears an unresolved
policy/credential block; only readiness-approved adapters register for activation.

- [ ] Real-DB tests: concurrent claims/leases, crash after page persist, stale owner writes, replica/manual overlap,
      empty/partial runs, DST/catch-up, bounded attempts, manual run under cooldown/cost block; source failure never
      blocks other sources; run telemetry persists even if the DTO fails.

# Phase 3 — Adapters without AI

Common protocol: permission + official schema evidence; complete authentic bounded fixture with provenance/date/hash,
redacted and trimmed by a parser (never `head -c`); independent expected labels; config/payload/native identity
validated before acquisition; malformed/empty/partial/update/pagination/cost/recovery tests; registered disabled in
the typed manifest. HTTP 200 is not readiness. Seeded rows today (C-16) are candidates, not verified configs.

### Task 3.1: Free JSON A — RemoteOK, Remotive, Himalayas, Jobicy

`providers/sources/{remoteok,remotive,himalayas,jobicy}.provider.ts`; bounded field helpers in `sources/as.ts`.
RemoteOK: `https://remoteok.com/api`, legal/metadata object recognized by shape, native `id`/`url`, attribution
obligations. Remotive: `?category=` configs (seeded `software-dev`/`devops`/`data`), `jobs[]`, geography separate from
remote, attribution + delayed availability (open). Himalayas: search (page) vs browse (cursor), ≤ 20/page, `maxPages`
1..10 as ceiling, documented seniority values, source URL vs `applicationLink`. Jobicy: seeded `count/industry/geo`,
native fields, status endpoint for lifecycle, metered status calls.

- [ ] Authentic fixtures; red→green per mapped field vs independent expected values; metadata at moved position;
      config errors before network; pagination termination/window/cursor; native IDs/date semantics/expiry; missing
      employer/geography; partial request/report/cost. Focused suites, typecheck, lint; explicit commit paths.

### Task 3.2: Free JSON B — Arbeitnow, Working Nomads, Jobgether, HN "Who is hiring"

Arbeitnow: `job-board-api?page=n` (seeded `maxPages: 5`), `created_at` Unix seconds, `remote:false` stays false,
WINDOW unless complete scope verified. Working Nomads: blocked until documented/approved use and authentic fixture
(public JSON ≠ permission). Jobgether: OpenAPI shapes (open), ≤ 25/page, `pagination.hasMore`, detail policy for
omitted descriptions, deprecation signals. HN: Algolia `search_by_date` with `story,author_whoishiring`, `items/{id}`,
comment ID identity with `?id=` preserved via `keepQueryParams`, no "Company | Role" assumption, no current thread =
valid empty, nested replies are not vacancies, multi-role comments → explicit triage.

- [ ] Fixtures incl. missing-pipe/multi-role/location-first/remote-negated headers, non-vacancy threads, deleted/
      updated comments; identity survives title/URL changes; exact value/coverage/error/cost assertions.

### Task 3.3: ATS A — Greenhouse, Lever, Ashby

`sources/{greenhouse,lever,ashby}.provider.ts`, `ats-config.ts`. Board config is verified data (provider, namespace,
regional variant, token/slug, employer evidence); no company name from a title-cased slug; provider-specific bounded
slug schema; reject `../`, separators, dot injection, userinfo, unexpected hosts; ≤ 300 boards per manifest group,
independent checkpoints; dead board 404 is a board error. Greenhouse `boards-api…/jobs?content=true` (byte cap from
MP-02 or list+detail), `updated_at` is update evidence, decode escaped HTML once, `gh_jid` identity-bearing. Lever
`api.lever.co/v0/postings/{site}?mode=json` (+ EU variant), hosted vs apply URL, `workplaceType`. Ashby
`posting-api/job-board/{board}?includeCompensation=true`, `isListed=false` quarantined, compensation not invented.

- [ ] Verified boards; fixtures for escaped content, unknown employer, native identity, update vs publication,
      multiple locations, EU variants, unlisted/prospect posts, empty/not-found, partial multi-board; 500 ms ATS gap is
      a proposed policy.

### Task 3.4: ATS B — Workable, SmartRecruiters, Recruitee, Personio

Workable public `api/accounts/{subdomain}?details=true`, widget redirect only via reviewed hop allow-list, shortcode
identity, no `__company` injection, `/spi/v3` is a separate authorized integration. SmartRecruiters
`v1/companies/{company}/postings?limit=100&offset=n`, detail fetch for new/changed IDs within budget, canonical
posting URL from data. Recruitee `{tenant}.recruitee.com/api/offers/`, `X-Careers-Sites-Token` requirement checked
now (deadline open), no hidden site keys. Personio verified tenant XML host with language, `<position><id>`, XML
helper from 2.4, per-tenant XML enablement.

- [ ] Fixtures/metadata/permissions; public vs auth separation, token deadline, non-leaking errors, company envelope,
      detail absent/enriched, XML language/entities/XXE, variant hosts, invalid slug, partial coverage; budgets include
      detail pages.

### Task 3.5: Quota APIs — Jooble, JSearch, TheirStack, The Muse, Reed

Optional env keys in ✓ `config/env.ts` (empty → unconfigured; missing key = readiness error before budget/network;
never reuse `CLOUDFLARE_*` — C-21). Jooble POST `api/{key}` (key redacted from every log/trace/error before
truncation; billing per current agreement, not "500 lifetime"). JSearch RapidAPI host/key or official product; three
seeded queries share one account meter; page parameter billing verified. TheirStack POST `v1/jobs/search`, Bearer,
limit 1..50, per-returned-record credits (open), worst-case reservation, uncertain debit on timeout. The Muse public
`api/public/jobs` — blocked until live fixture/contract verified. Reed `api/1.0/search` Basic auth, `dd/MM/yyyy`,
UK eligibility, blocked without key.

Shared account reservation: lock account/window row, enforce `used + reserved + uncertain + maxNewCost ≤ limit`,
unique attempt reservation committed before I/O, SENT status, release only provably unsent cost, exactly-once
conversion to used, uncertain hold until reconciliation, rollover keeps outstanding reservations, repeated paid
requests get new attempts; request/record/model units never share a counter. The legacy one-unit `chargeBudget` stays
for DOU only (A1h).

- [ ] Doc fixtures are unit examples only; blocked until controlled authenticated smoke; no provider contact or secret
      provisioning in plan review. Tests: no-key/no-network, payload, calendar invalidity, native vs apply IDs,
      redacted Jooble errors, multi-worker exhaustion, records vs calls, empty/partial/timeouts, repeated cost,
      uncertain rollover, reconciliation; manifest vs account evidence.

### Task 3.6: RSS adapters — Djinni, We Work Remotely, EU Remote Jobs

Djinni `jobs/rss/?primary_keyword=…&exp_level=…` (taxonomy verified; the DOU provider note that Djinni's feed returned
1–2 items is historical evidence to re-measure), GUID/link identity, employer uncertainty retained. WWR official
all-jobs or verified category feeds, `Company: Position` parser tested on real names, honest UA, challenge pauses.
EU Remote Jobs `jobs/feed/` (seeded strict empty config), namespaced `job_listing`, unknown employer = triage.

- [ ] Real fixtures with ambiguities/CDATA/namespaces/GUID/UTC/window semantics and empty/malformed envelopes;
      category effect, company uncertainty, enrichment, no bypass, complete/partial counts; DOU outcomes unchanged.

### Task 3.7: Module registration, typed manifest, forward seed delta, drift test

**Files:** ✓ `job-sourcing.module.ts`, new `providers/manifest.ts` + generator, new forward seed delta, drift tests.
The 2026-10-05 seed is immutable (its "append here" header note is superseded — C-16).

Manifest entries: stable source/config ID (new column — C-16), provider, namespace, verified employer name/domain
(nullable), endpoint variant, validated config via instance `parseConfig`, policy/docs/fixture references + hashes,
auth requirement, attribution, quota account/unit/limit/reset, polling/coverage semantics, readiness status, disabled
seed state. Portfolio lists all 31 types; registration has 23 new non-HTML adapters + DOU + 7 HTML only when
implemented; missing adapter = explicit blocked entry. Generated parameterized idempotent forward SQL compared back to
DB rows (no regex SQL parsing); config revision starts a new checkpoint scope; activation is an ADMIN action; no
startup seeding. Cadence intentions (daily default, Jooble weekly if allowed, WTTJ 72 h on permitted URLs) validated
before freezing; account quota never derived from seed row counts. Board slugs verified by response ownership;
Stripe/Airbnb/Cloudflare/Databricks/Figma/Palantir/OpenAI remain candidates; favour remote-open, contractor/agency-
friendly employers; research reconstructed with provenance (C-18).

- [ ] Tests: manifest uniqueness/config validation, explicit disposition per entry, docs/fixture hashes, account
      totals/units, unknown providers, policy expiry/auth deadlines, generated SQL reapplication, DB equality.
- [ ] DevOps wires the delta per C-15; redeploy never resets enabled/pause/budget or re-adds an ADMIN-disabled source.

# Phase 4 — The funnel and the queue

### Task 4.1: Layer 1 — workplace / basis / schedule / seniority / freshness (pure)

Dimensions: workplace `REMOTE|HYBRID|ONSITE|UNKNOWN`, basis `EMPLOYEE|CONTRACTOR|B2B|UNKNOWN`, schedule
`FULL_TIME|PART_TIME|FLEXIBLE|UNKNOWN`, duration `PERMANENT|FIXED_TERM|PROJECT|UNKNOWN`, agency acceptance
`ACCEPTED|PROHIBITED|UNKNOWN`; role family, seniority, leadership; applicant countries/regions/timezones/work
authorization; skills/dates/availability. Unknown ≠ contradictory ≠ incompatible, each with evidence and rule
version. Region/timezone policy frozen from studio operations (no Ukraine/work-auth assumption). Strong explicit
ONSITE/HYBRID, part-time/intern/too-low level reject; employee-only/no-agency/geography apply only to known
incompatible facts, otherwise lead with UNKNOWN warnings; triage reserved for unverifiable employer, unknown/low-
evidence stack, unresolved contradictions, ambiguous identity. Title/structured hints first, body requirement
sections second; staff/principal → senior expertise with leadership UNKNOWN; negations not positives; the 30-day
publication cutoff replaced by activity/expiry + freshness rank; discovery window ≠ closure criterion.

- [ ] Tests: conflicting remote flags, city + remote Europe, US authorization, B2B full-time/fixed-term, no-agency,
      mentorship, staff/principal, localized/negated requirements, future dates, old active vacancies; reproducible
      from persisted inputs + rule version without network/model.

### Task 4.2: Layer 2 — `tech ∩ union(users.tech_stack)` and per-senior match

Inputs: eligible SENIOR users (reuse `findEligibleSeniorIds` semantics) with `users.tech_stack`; résumé skills stay
the legacy consumer's input. Keep `MAX_STACK_KEYWORDS = 60` / `MAX_STACK_KEYWORD_CHARS = 100` per profile; the roster
union is the distinct complete union (not re-capped at 60); tokenize each posting once; reuse alias/symbol semantics
from `stack-keywords.ts` with a new uncapped union-matching helper. Evidence completeness replaces the 200-char rule;
missing roster profiles = internal readiness issue; low information → authorized triage; known core mismatch is not
stored per senior but recomputable. Global restrictions, senior exclusions (`findMatchingExclusion` — C-24) and
team-triage candidates evaluated before matching; excluded profiles never contribute counts/rank/explanation.

- [ ] Tests: > 60 union (the r4 "techword" case is open — name a repo fixture), per-profile cap, aliases
      (C#/C++/.NET/Go/R/Java-vs-JavaScript), negation/optional/core, 199/200 boundary invariance, long marketing text,
      empty profiles, unknown-stack at excluded company, mixed exclusions, missing-team access; CPU/throughput budget
      frozen from MP-05.

### Task 4.3: Identity resolution and rank

Identical provider namespace/native ID = one record; verified job-specific employer/ATS identity can associate copies
after contradiction checks; same company/title = candidate only; reposts stay distinct; unverified apply URL/tracking/
homepage/redirect is not strong identity; subsidiaries/agencies not collapsed on stripped suffixes. `atsJobKey(url)`
for Greenhouse (`gh_jid`), Lever, Ashby, Workable, SmartRecruiters, Recruitee, Personio shapes, from posting and
application URLs without following redirects — the main cross-source signal. Associations reversible with rule/
evidence/revision/actor; every-member check before attaching; canonical fields per field with deterministic tie-breaks;
ADMIN-audited correction command before any UI. Canonical authority policy frozen/versioned before activation
(employer/ATS facts > publisher structured > aggregator > inference; explicit restrictions dominate permissive claims;
equal-authority conflicts → UNKNOWN/triage; `canonicalAuthorityPolicyVersion` propagated).

Rank defaults: freshness 100, decay 7 d, match 10, cap 10, unknown seniority 15 / stack 20 / remote 10, platform
weight 1; `age = max(0, (evaluationTime − trustedPublishedAtOrFirstSeenAt) / 86_400_000)`;
`score = clamp(round(100·e^(−age/7) + 10·min(matchCount, 10) − penalties), 0, 1000)`; eligibility gates are not
penalties; HR scores use the authorized team count, ADMIN the studio count; future dates → first-seen + warning;
`firstSeenKind = INITIAL_SWEEP` → freshness 0 + unknown-date warning until the configuration version's first complete
run. Weights unchanged until a labelled comparison (precision@10/@20, wasted review time).

- [ ] Tests: identical titles across cities/departments, hyphenated roles, distinct/reposted IDs, changed URL,
      agencies/subsidiaries, poisoned apply URL, transitive contradictory clusters, split recovery; independent score
      examples, monotonicity/cap/rounding/clamp, scoped counts, future/update dates, generation-stable pagination;
      merge precision before recall (MP-12).

### Task 4.4: `evaluate` — composition (new)

Order: persisted revision → classification/availability → global restrictions → per-senior/team restrictions →
skill/role signals → eligibility/triage projections → scope score. Entity resolution independent of roster;
unknowns never override hard negatives; every reason carries evidence + rule version; excluded payloads retained for
audit. Inputs: canonical revision, selected evidence, roster/team/exclusion versions, rule version, evaluation time.
No network/model calls. No empty-team user receives a global unknown pool.

- [ ] Tests trace the whole order; identical inputs → structurally equal output; record-level failures isolated;
      infrastructure failures retryable, never "filtered".

### Task 4.5: Source-record and canonical repositories (new; real-DB concurrency)

Short transactions: verify run epoch → `INSERT … ON CONFLICT (provider, namespace, identity_key) DO NOTHING RETURNING
id`, else separate SELECT/lock with bounded retry (no CTE visibility assumption under READ COMMITTED); lock record;
insert immutable revision idempotently; advance latest pointer only on newer accepted sequence; record run
membership; enqueue dirty work; checkpoint after each page. Canonical identity token rows with UNIQUE(trusted
namespace/job key) or sorted advisory locks + under-lock recheck; deterministic lock order; bounded deadlock retries;
link/unlink + canonical revision + reevaluation in one transaction; default = distinct opportunity. Splits keep
payloads and history; conflicting decisions need ADMIN disposition; no 20-entry storage cap.

- [ ] Real-DB tests: concurrent same native IDs, two discovery configs, cross-source copies, same URL/different IDs,
      late update, crash between revision/checkpoint, unrelated candidates, association vs split, simultaneous
      claim/merge, retry after commit; no lost versions, no duplicate identity, no extra legacy suggestions.

### Task 4.6: Ingest service, DOU bridge, dirty/recompute worker (✓ `collectSource` is the seam)

**Compatibility barrier first:** golden DOU normalizations, fingerprints, posting→suggestion decisions, eligibility/
exclusion results, legacy ranking, APPLIED/REJECTED preservation, trigger modes, one-unit budget arithmetic — verified
with the queue flag off/on; controlled timestamps/UUIDs. DOU keeps its own fetch path until this gate exists (A1n).

After DOU acquisition, feed `persistPostings`/`createSuggestions` the complete array before any new filter, and
separately the observation store; new sources never leak into legacy suggestions; durable bridge delivery keyed by
identity/consumer/version with consumer checkpoints; `createSuggestions([])` is not recovery. Backfill legacy rows by
fingerprint→record (IDs/suggestions/status preserved; explicit legacy namespace); reruns reconcile only. Persist valid
records before evaluating; failures caught at their boundary; yield every 50 observations (benchmark, not a
`setImmediate` spy). Dirty producers: revisions, senior stack/archive/role/team edits, exclusions, project-derived
client changes — written transactionally; worker compares versions before installing output; recompute active and
claimed opportunities regardless of insertion date; full periodic reconciliation; batch 200 initial (MP-05);
generations publish only on coherent versions; actions reauthorize immediately.

Availability reconciliation: authoritative open/closed flags, source expiry, detail/status evidence per record;
404/410 confirms closure only under a tested adapter contract; missing inventory advances a counter only after a
validated FULL_INVENTORY run of the same board/config version; thresholds frozen per source; WINDOW/PARTIAL/invalid
batches never advance counters; canonical OPEN needs current open evidence; CLOSED/EXPIRED recorded decisions;
aggregator expiry ≠ employer closure; reopen preserves claims/dismissals; status refreshes bounded/metered/resumable.

- [ ] Tests: legacy parity; crashes around legacy write/suggestion/checkpoint; partial retries; idempotent backfill;
      roster/exclusion/team events; > 30-day active changes; claimed closure/update; stale worker input; periodic
      repair; event-loop latency; old unit/integration/RBAC/budget suites on scratch + new projection suites.

# Phase 5 — HTML path and model extraction (OpenRouter or local model)

HTML stays in the portfolio behind per-source gates; deterministic HTTP/JSON-LD parsing and stubbed tests proceed
without credentials or browser deployment. Model extraction only after its endpoint is provisioned with a spending or
capacity limit; nothing raises a limit or buys hardware automatically.

### Task 5.1: Rendering engine as a separate isolated deployment (DevOps)

- [ ] **Engine decision (A2) after MP-01:** ≤ 1 source needs rendering → one pinned headless Chromium (Playwright)
      worker behind the egress proxy; several → self-hosted Firecrawl (release/digests pinned; real service list,
      persistence, AGPL review of actual modifications — open claims). Record in the runbook.
- [ ] Separate compose project/profile with its own network; never on `backend` (C-29); no host-gateway, Docker
      socket, broad mounts, privileged mode or CRM secrets; egress proxy denies private/metadata ranges for every
      browser resource incl. redirects/service workers/WebSockets; no published ports; durable or explicitly transient
      queue storage with tested restart; `compose down` scoped to that project only.
- [ ] Capacity budgets before the load test (MP-05); CPU/memory/pid/disk/backlog caps; failure independent of CRM;
      missing capacity → HTML disabled + concrete owner decision.
- [ ] Deterministic HTTP/JSON-LD extractor benchmarked first; security sign-off on egress denial, secret separation,
      capacity; runbook upgrade/rollback/recovery.

### Task 5.2: Model endpoint provisioning (DevOps + human-only; replaces the withdrawn CLI route)

- [ ] **OpenRouter:** owner creates a worker-only key with a USD `limit` + `limit_reset`; requests pin an exact model
      slug, `response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } }`, provider
      restrictions (require parameters, deny data collection, max price) and `zdr` when MP-03 confirms ZDR endpoints
      (parameter names open); fallbacks/order set from MP-03; usage/cost recorded per request; egress allowed to the
      OpenRouter host only; limit/credit errors pause with checkpoints.
- [ ] **Local model:** OpenAI-compatible runtime enforcing JSON schema (Ollama OpenAI endpoint, llama.cpp server or
      vLLM — enforcement confirmed on the pinned version), own container, pinned runtime + model digest, no outbound
      network at inference, CPU/RAM/thread limits, concurrency 1; on the main VPS only if MP-04 passes.
- [ ] **Both:** secrets never in config/manifest/DB/build layers/reports/logs; new optional keys in `config/env.ts`
      read only by the worker (never `CLOUDFLARE_*` — C-21); the worker holds no DB credential; contact details
      stripped before text leaves the host; `ai-input=no` sources processed deterministically; Task 5.4 validation
      applies even with provider-side enforcement; controlled smoke per route (schema, cost, limit pause, egress
      denial). Deterministic HTML may ship with model extraction disabled.

### Task 5.3: Discovery client and `RobotsPolicy`

- [ ] Reviewed REP parser or complete RFC 9309 fixtures (group merging, encoding, longest match/Allow tie, wildcards,
      unreachable handling, bounded size/cache); `Crawl-delay` honoured; `Content-Signal` parsed and `ai-input` exposed
      to the model gate (format open); 24 h cache max; fail closed on unreachable/5xx; 401/403 pause.
- [ ] Robots fetched through constrained egress; relative links resolved against validated origin; robots re-checked
      per detail URL; new rules beat stale cache.
- [ ] Engine response schema pinned to version; target status vs service error distinguished; 30 s target / 60 s
      client / 200 000-char markdown ceilings; oversize = PARTIAL.
- [ ] Tests: REP conformance, permitted/denied routes (Dice), stale cache, status separation, host rejection,
      private-IP denial on redirects/subresources, missing metadata.

### Task 5.4: `HtmlStructurer` port + `OpenAiCompatibleStructurer` adapter

Extract one discovered job/detail or a bounded chunk with known IDs/URLs (never an inventory from listing markdown);
schema with nullable fields, evidence spans/revision IDs, uncertainty, extraction version; model-supplied URLs must
occur in fetched evidence or match a verified identity; no server fetch of application links. Page content only in
the user message as delimited data; request timeout and response caps; `json_schema` strict output parsed then
validated locally (provider enforcement varies); no code-fence fallback; one bad field isolated, invalid whole =
extractor failure. Defaults: 60 000-char input, 2 MiB output, 120 000 ms, concurrency 1 per route; chunk by discovered
record boundaries with persisted remaining IDs; cancel on timeout/overflow and release the budget slot. Shared budget:
20 calls per collection cycle across all HTML providers + daily usage reservations frozen by policy; OpenRouter USD
limit is the hard cap with per-request cost reconciled; local = calls + CPU time; documented status/error codes, not
page text, classify exhaustion.

- [ ] Tests: no CRM secrets reach the extractor; hostile prompt/end-tag content; invented same-host links; missing
      facts; invalid one record; non-JSON/schema-invalid response; real limit/auth/rate errors vs a literal "quota"
      word; shared budget; cancellation; hung endpoint; contact stripping; `ai-input=no` never reaches the model;
      pinned model/provider/runtime config. MP-03 gates enablement.

### Task 5.5: `HtmlProvider` base (HTTP-first; optional browser/model ports)

Stage A: bounded deterministic discovery of IDs/URLs/pagination; Stage B: due detail fetches under policy/robots/
quotas with validators/hashes and persistent enrichment state; Stage C: model only for fields not deterministically
recoverable. Explicit coverage/method/evidence per stage; incomplete enrichment never falsifies discovery or closes
jobs; relative URLs via validated base; posting vs application URL; details outside approved hosts navigation-only;
tenant hosts from verified config; 3 s minimum host gap or larger Crawl-delay; all subrequests metered; exhaustion →
PARTIAL + checkpoint; revisits per lifecycle policy, not daily reprocessing.

- [ ] Tests: discovery/detail separation, pagination/cursor loops, truncation, conditional unchanged content, cached
      details with changed policy/parser version, relative/external links, false model identity, resume, all-robots-
      denied, aggregate caps; coverage bound to board/query/window.

### Task 5.6: HTML adapters, the 02:30 schedule, forward seed delta

`sources/{justjoin,nofluff,landingjobs,nextleveljobs,dice,thehub,wttj}` on the 5.5 base. JustJoin: routes/IDs/terms
unresolved → blocked before activation; no hidden `/api/`. NoFluffJobs: robots denies `/api/` and `/posting/` (open);
listing snippets → incomplete triage only. Landing.jobs: verify paths/structured data; disabled until verified.
NextLevelJobs: no established route → blocked. Dice: planned `/jobs?q…` disallowed (open) → not implemented. The Hub:
verify pagination/details/policy. WTTJ: no Algolia key; routes/terms verified before activation; 72 h cadence after.
A new `HTML_SOURCE_TYPES` constant (C-03) lists the seven members. 02:30 Europe/Kyiv enqueues gated work only;
seed rows via a forward delta (C-16); robots snapshots are test evidence, refreshed at runtime.

- [ ] Per source: discovery/identity/links/details/schema/evidence, allowed vs forbidden routes, strict config before
      network, true pagination/partial scope, unchanged payload reuse, model-free path, policy blocks; manifest reports
      implemented-ready / implemented-blocked / not-implemented.

### Task 5.7: Djinni — JSON-LD enrichment of the detail page

Bounded walk of all `application/ld+json` objects/arrays/`@graph` (type arrays, multiple `JobPosting`), selection by
validated identity, fields `identifier/title/hiringOrganization/description/jobLocationType/
applicantLocationRequirements/employmentType/skills/datePosted/validThrough` with raw evidence; no JS execution, no
remote `@context`; literal `</script>` terminates the element (the old assumption that it cannot is invalid); escaped
`<` decoded after safe parse; malformed → counted failure. HTTP-first with robots/policy/host budget; persistent
state (attempted/succeeded/error/next-due/hash/parser version); batch cap 15 as throughput, fairness over newest;
failures leave the RSS observation usable; updates enqueue classification, not legacy suggestions.

- [ ] Fixtures: multiple graph/types/postings, identity selection, expiry/region, stale conflicts, escaped vs literal
      script-close, invalid/deep JSON, unavailable detail, fairness; no browser/model does not block RSS.

# Phase 6 — HR API

### Task 6.1: Queue visibility

Guards + service authorization; ADMIN/HR only, other roles 403, no session 401 (pattern: `job-sourcing.controller.ts`
guard chain + service-level scope). ADMIN inspects studio candidates/triage and manages suppression/resolution. HR
access = current active-team membership + explicit team scope: every request carries one validated `teamId` the actor
belongs to (default first active team in stable order); eligible seniors from that team's active non-archived
SENIOR memberships; per-team generation/counts/dismissals; no merged scopes in v1. Build the team query inside
job-sourcing (or lift `findActiveTeamsForUser` to `common/` — C-09); `getActiveTeamPeers` is not used for scope.
Unknown stack is data quality, not a grant; no active team → empty list/counts, 404 on details/actions; unknowns
without team disposition → ADMIN triage; standing team subscriptions (`job_team_triage_subscriptions`). Authorize
payload, senior names, source links, counts/keywords/rank and conflict responses separately; "already taken" without
a name outside scope; consistent 404 on visibility miss; cached projections never replace current checks; versioned
policy revalidation on mutation.

- [ ] Matrix: ADMIN, own HR, foreign HR, no-team HR, archived member, SENIOR/JUNIOR/ACCOUNTANT/DROP, unauthenticated;
      unknown stack at restricted company/source; team triage; foreign counts/keywords/rank/name; live exclusion
      changes; fail closed when policy evaluation is unavailable.

### Task 6.2: `JobQueueService` — list and card

Reads `job_opportunities`, scoped matches/dismissals/assignments/associations — never the Phase-1 columns on
`job_postings` (C-01). First list request selects the current immutable generation for its scope; filters/
authorization are predicates over retained entries (no per-filter generations); coalesced publication per scope;
entries carry integer scores ordered `(rank_score, first_seen_at, opportunity_id)` desc with rule/input versions and
evaluation time; removals allowed, additions/moves only on refresh; counts reflect the current authorized workflow
view (documented difference). Card = latest canonical facts + newer-than-list warning + bounded `possibleDuplicates`.
Cursor encodes generation/scope-filter signature/last key with expiry and integrity (or opaque server token),
validated before SQL; expired → stable refresh-required error; malformed → 400; scope mismatch grants nothing.
Default 20 / max 50, limit+1 with authorized predicate, no descriptions in lists; source preview ≤ 20 and senior
preview ≤ 200 with independent continuation/totals; bounded indexed filters (MP-13).

- [ ] Real-DB tests: ties and rank/roster/source changes between pages; expired/filter/actor cursor misuse; auth
      revocation before LIMIT; no-team HR/triage; scoped counts; > 20 links / > 200 seniors; no list description;
      latest card update; query-plan benchmark.

### Task 6.3: Actions — take, dismiss, undo, opened, release/reassign/suppress

Studio-wide claim; UI `queueStatus` = IN_PROGRESS if assigned, else DISMISSED in the actor's team/STUDIO scope, else
NEW. HR dismisses own team view; suppression/release/reassign ADMIN-only; spam/dead-link reports reference the clicked
source copy and schedule verification only. Transaction: session/team/policy checks → lock/conditional update of
assignment/revision/version → audit with unique idempotency key → commit; policy version bumps on membership/
exclusion writes; stale access rejected/retried; retries by the same key return the previous success; unrelated claim
409 exposes only authorized identity. `confirmPossibleDuplicate: true` required when a possible duplicate is claimed,
else 409 `POSSIBLE_DUPLICATE_CLAIMED` with the authorized summary; the take transaction locks the target and its
duplicate set's `job_opportunities` rows in sorted ID order (or advisory locks) and re-checks claims. Dismiss/undo
need expected version and scope; `markOpened` is idempotent click telemetry per actor+opportunity+source record,
never blocking navigation; legacy `job_posting_signals` untouched; new indexes via forward migration.

- [ ] Real-DB tests: simultaneous claims; repeated key; lost-response retry; audit failure rolls back; take/dismiss/
      undo/close races; permission change mid-mutation; team dismissal isolation; ADMIN suppress/release/reassign;
      split conflicts; two-copy click signals; no leaks; negative paths leave no partial writes; two concurrent takes
      of unmerged copies → exactly one succeeds without confirmation.

### Task 6.4: `/job-queue` controller + RBAC integration spec (new)

Explicit `@Inject`, `@UseGuards(RolesGuard)` + `@Roles`, parsed request/response schemas, `@Throttle` per route on
top of the global `UserAwareThrottlerGuard`; error codes from `api-errors/job-sourcing.ts`.

| Method        | Endpoint                                     | Contract / limit                                                                                                            |
| ------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| GET           | `/job-queue`                                 | scope/filter/status/cursor; default 20 / max 50                                                                             |
| GET           | `/job-queue/:id`                             | `ParseUUIDPipe`; authorized latest card                                                                                     |
| GET           | `/job-queue/:id/sources` · `/seniors`        | authorized continuations with totals                                                                                        |
| POST / DELETE | `/job-queue/:id/team-triage[/:teamId]`       | ADMIN; expected revision/policy/grant version; audited; 30/min                                                              |
| POST          | `/job-queue/:id/take`                        | idempotency key + expected revision/version + optional `confirmPossibleDuplicate`; 409 `POSSIBLE_DUPLICATE_CLAIMED`; 30/min |
| POST          | `/job-queue/:id/dismiss` · `/undo`           | scope/reason/expectedVersion; 60/min                                                                                        |
| POST          | `/job-queue/:id/opened`                      | source-record ID; 204; 120/min                                                                                              |
| POST          | `/job-queue/:id/release` · `/reassign`       | ADMIN; audited; 30/min                                                                                                      |
| POST / DELETE | `/job-queue/team-triage-subscriptions[/:id]` | ADMIN; audited; 30/min                                                                                                      |
| POST          | `/job-queue/recompute`                       | ADMIN; enqueue; 202 + run ID; 6/min                                                                                         |

Every request carries the validated `teamId` (ADMIN = studio scope). Recompute is enqueued, never inline. Guard
matrix on a real DB with real guards (pattern: `job-sourcing-rbac.integration.spec.ts`): ADMIN valid; own HR
visible+authorized; foreign/no-team HR 404; other roles 403; no token 401; version conflict 409; cursor 400 or
refresh-required; invalid UUID/limit/body 400. Team triage grants independent of claims; grant/revoke DTOs validated;
audit kinds TRIAGE\_\*; subscriptions same pattern; invalidation marks generations dirty.

- [ ] Real controller/guard/team DB tests + action matrix on a scratch DB with checks enabled (never silently
      skipped); card JSON exposes no foreign identity, secrets, raw HTML or unbounded payload; empty authorized list is 200.

### Task 6.5: ADMIN — source switch and extended source DTO (new endpoint — C-10)

Add `PATCH /job-sourcing/sources/:id` `{ enabled: boolean }`, ADMIN-only, 30/min; no arbitrary config/endpoint
updates. Extend `jobSourceSchema` with readiness/health/pause/cooldown/reason/last-attempt/success/nonempty/cost-unit/
checkpoint fields (additive; `SourceBudgetPanel` keeps parsing). State changes append audit atomically; enable never
resets quota, erases reasons, overrides cooldown or grants readiness; policy/auth pause resolved by explicit audited
ADMIN action; disable cancels queued work and fences in-flight owners.

- [ ] Tests: non-ADMIN 403, missing 404, invalid 400, enable blocked by readiness/auth, cooldown persistence, history
      retention, budget unaffected, in-flight fencing, old-client DTO parsing.

# Phase 7 — HR UI (after Task 0.1)

> Entry gate: `docs/design/vacancy-queue.md` exists with a mobile frame. The coder builds from the spec with shadcn/ui
> and tokens; never copies `design.html`. The legacy dialog's `JOB_SOURCING_ENTRY_ENABLED` flag is **not** touched
> (A2, C-12).

### Task 7.1: Data hooks

**Files:** create `apps/web/app/hooks/use-job-queue.ts` + `__tests__/use-job-queue*.test.tsx` (pattern:
`hooks/__tests__/use-job-sourcing.test.tsx`, mocked `api`).

```ts
export const jobQueueQueryKey = (scope: QueueScopeSignature, status: JobQueueStatus, filters: QueueFilters) => […] as const
export const jobQueueCardQueryKey = (scope: QueueScopeSignature, id: string) => […] as const
export function useJobQueue(scope, status, filters)        // useInfiniteQuery by nextCursor, limit 20
export function useJobQueueCard(scope, id: string | null)  // enabled: id !== null
export function useJobQueueSeniors(scope, id)              // jobQueueSeniorPageSchema
export function useJobQueueSources(scope, id)              // jobQueueSourcePageSchema
export function useTakeJobQueueItem()    // expected version/revision + idempotency key; 409 POSSIBLE_DUPLICATE_CLAIMED → confirm prompt; «вже взято» toast with a name only when returned
export function useDismissJobQueueItem() // scoped, versioned
export function useUndoJobQueueDismissal()
export function useMarkJobOpened()       // fire-and-forget; errors swallowed
```

Keys include actor/team/policy signature and filters; nothing under `['job-queue', …]` enters the persist allow-list
(`__root.tsx`); all caches cleared on logout/account/team/authorization change; every response `.parse()`; toasts via
Lingui macros; backend codes map to localized messages, never raw text; refresh-required replaces the list cleanly;
optimistic updates roll back on conflict.

- [ ] Failing tests first: parse + `nextCursor`; `javascript:` URL → parse error; 409 conflict toast/prompt;
      invalidation; `markOpened` never throws; account switch; auth revocation; cursor expiry/filter change; 201
      seniors / 21 sources continuation; primary-source denominator; lost-response idempotent retry.
- [ ] Implement → PASS (`pnpm --filter @crm/web exec vitest run app/hooks/__tests__/use-job-queue*.test.tsx`); eslint;
      explicit commit.

### Task 7.2: Route, navigation, list

**Files:** create `apps/web/app/routes/_authenticated/job-queue/index.tsx`, `components/job-queue/{JobQueueList,
JobQueueRow,JobQueueStatusTabs,TeamSwitcher}.tsx` + tests; modify `lib/route-access.ts` (`{ prefix: '/job-queue',
roles: ['ADMIN','HR'] }` in `ROUTE_ACCESS`), `components/crm/nav-sidebar.tsx` (`roles: navRolesFor('/job-queue')`)
and their tests. Testids: root `job-queue-page`, list `job-queue-list`, row `job-queue-row-<id>`, tabs
`job-queue-tab-<status>` (E2E anchors are testids, not headings).

Behaviour per spec: tabs with authorized counts; API order; «Завантажити ще» by `nextCursor`; loading/empty/error;
row = title, company, seniority badge, stack-signal chips (N + «+K»), «N сеньйорів мають збіг стеку» from
`totalMatchedSeniorCount` (hidden at 0), trusted publication age vs first-seen/unknown-date, source icon, `+M також
на …` from `totalAlsoSeenOnCount`; triage items labelled as triage (not «не вдалося визначити стек»); bounded
title/company/source/eligibility/availability/assignment filters; team switcher when several active teams; refresh
prompt on generation invalidation; no horizontal overflow at 320; touch ≥ 44 px; mobile = cards.

- [ ] Failing tests (RTL + vitest; router/query providers per `interviews/__tests__/index.test.tsx`): row rendering;
      authorized counts; triage label; tab → `status=IN_PROGRESS`; empty/error states; `route-access` roles;
      `nav-sidebar` visibility; responsive classes without fixed `w-[NNNpx]`; no-team HR; partial source notice;
      changed access; real-width overflow in E2E (class assertions alone are not responsive proof).
- [ ] Implement → PASS; eslint; `pnpm --filter @crm/web build` (`routeTree.gen.ts` is gitignored); explicit commit.

### Task 7.3: The card

**Files:** create `components/job-queue/{JobQueueCard,MatchedSeniors,AlsoSeenOn,PossibleDuplicates}.tsx` + tests;
extract `components/job-sourcing/PostingMarkdown.tsx` from `JobSuggestionDialog.tsx` (preserving
`JobSuggestionDialog.test.tsx` incl. "pins urlTransform …"); consume `openOriginalPosting` from
`components/job-sourcing/open-original.ts` (never `window.open` directly — C-11).

Description via `PostingMarkdown` (UNTRUSTED; no raw HTML, no remote images/autolinks); «Також відкрито на:» links via
`openOriginalPosting` with continuation and `totalSourceCount`; matched seniors only as returned; chips highlighted;
availability/uncertainty/attribution/evidence; updated-since-list warning; «вже взято» with name only inside scope;
possible-duplicate warning + confirmation before take; current-policy denial closes/refetches instead of showing
stale names; full-screen on mobile; focus trap + `aria-labelledby`.

- [ ] Failing tests: `<script>`/`javascript:` content renders as text; links go through `openOriginalPosting` without
      `javascript:`; empty `alsoSeenOn` → no block; IN_PROGRESS shows «вже взято»; Esc/button close; a11y; duplicate
      confirmation.
- [ ] Implement → PASS; explicit commit.

### Task 7.4: Actions + i18n

**Files:** modify `JobQueueCard.tsx`; create `JobQueueActions.tsx`, `DismissMenu.tsx`, tests; catalogs
`packages/shared/src/i18n/locales/{uk,en}/messages.po` via `pnpm i18n:extract` (never by hand).

One primary «Взяти в роботу» (disabled + spinner during the request; repeated clicks ignored); 409 → toast/prompt +
card refetch; «Відкрити оригінал» = `openOriginalPosting` synchronously inside the gesture + independent `markOpened`;
«Приховати» → reason menu → scoped versioned dismiss; scoped Undo; ADMIN-only release/reassign/suppress with
conflict state; closed/newer-revision items cannot be claimed from an old card; keyboard-accessible Radix menu; no
hover-only actions.

- [ ] Failing tests: take success/conflict; double click → one request; open calls `markOpened` once and
      `openOriginalPosting` with the right URL; dismiss reasons; two-team independence; masked conflict name; same-
      action retry; undo/version race; closed-source warning.
- [ ] Implement → PASS. **i18n:** Lingui macros (source `uk`) + `en`; `pnpm i18n:extract`, fill `en`,
      `pnpm i18n:compile`; the CI step "i18n catalogs are in sync (lingui extract --clean)" must pass locally;
      `node scripts/devops/check-no-russian-letters.mjs` (the new `job-queue` directory is guarded — C-13).
- [ ] Explicit commit incl. both catalogs.

### Task 7.5: ADMIN — source switch in the panel (Design Tier 2)

**Files:** modify ✓ `components/job-sourcing/SourceBudgetPanel.tsx`, ✓ `hooks/use-job-sourcing.ts`
(`useSetJobSourceEnabled`), their tests. Consumes the new `PATCH /job-sourcing/sources/:id` (Task 6.5) and the
extended DTO. Shows disabled vs paused vs readiness-blocked separately, unit and quota/reserved/uncertain usage,
attempt/success/nonempty age, cooldown/checkpoint, policy/auth deadline; enable failure explains the readiness code
and preserves state; no toggle clears policy/cost state; `uk`/`en` labels; ui-ux-designer conformance note in the PR.

- [ ] Tests: PATCH with inverted value + refetch; reason display; non-ADMIN panel not rendered (existing test kept);
      readiness error; i18n extract; explicit commit.

### Task 7.6: E2E (AutoTest)

**Files:** create `apps/e2e/tests/job-queue.spec.ts` (+ `fixtures/job-queue.ts`); skill `playwright-patterns`;
stand via `POST /api/auth/dev-login`; data via `mcp__postgres__query` on the scratch/QA DB, never hardcoded, never the
live DB.

- [ ] Scenarios: HR opens «Черга вакансій» from the menu; card shows sources and matched seniors; take → moves from
      «Нові» to «У роботі»; same-team second HR sees «вже взято <name>», foreign-team HR sees it masked; no-team HR
      sees an empty authorized queue; scoped dismissal/undo; availability change while open; uncertainty warnings and
      triage items; unsafe HTML/link/image protection; expired generation refresh; empty/error/loading/partial health;
      cache purge on logout/account change; SENIOR direct URL redirected (defense-in-depth only — the backend guard is
      proven by Task 6.4); mobile 375: no horizontal scroll, full-screen card, ≥ 44 px targets, gesture-safe open
      (pattern: `job-sourcing-mobile.spec.ts`); mock mode never used for rights checks.
- [ ] Run locally `pnpm --filter @crm/e2e test -- job-queue` three times green (zero-flake policy); explicit commit.

**Definition of done (Phase 7):** ui-ux-designer Mode B `Design Review:` + `Fidelity: PASS` on 320/375/768/1024/1280/
1440/1920; manual-qa live pass (mobile + desktop, console, RBAC); copy-reviewer `Copy Review: PASS` on uk + en;
code-reviewer confirms all verdicts.

# Phase 8 — Rollout and verification

### Task 8.1: Runbook and human-only notes

**Files:** `docs/runbooks/vacancy-sourcing.md`, `docs/runbooks/vacancy-sourcing-measurements.md`,
`docs/runbooks/human-only.md` entries (symbols as addresses, no line numbers).

- [ ] Component/ownership diagram; 05:00/02:30 Europe/Kyiv scheduling + catch-up; run/coverage/status meanings;
      manual/admin limits; quota units/reconciliation/uncertain debit; source policy/attribution/auth expiry;
      update/reopen/retention; generation refresh; backfill/legacy recovery; merge/split and claim-conflict recovery;
      aggregate-only queries.
- [ ] Reproducible scratch/load/egress/rollback checks with run IDs; capacity and credentials human-only; pinned
      engine services/digests/persistence/license; model endpoint separation (OpenRouter key rotation + USD limit, or
      local runtime version + model digest); exhaustion pauses with checkpoints.
- [ ] v1 alerts: sustained failed/PARTIAL runs, parse-validity collapse, freshness beyond policy, missing heartbeat,
      unreconciled costly requests, isolation errors, growing backlog, exhausted budgets, access-health events
      (challenge, pause, rising 403/429 share per MP-11); thresholds frozen in versioned policy; no "20 % daily
      errors" gate; suppress unchanged notifications.
- [ ] Catalog review 2027-01-15 and earlier triggers; Recruitee token deadline review (open); dry-run restoration/
      cleanup/claim-conflict instructions exercised on disposable environments only.

### Task 8.2: Phased activation (owner + DevOps)

Full portfolio preserved; a small evidence-ready first wave is risk control, not scope reduction; each configuration
enabled only after terms/auth/fixture/identity/coverage/cost/security/quality gates. Wave order: verified DOU bridge +
supported Greenhouse/Lever/Ashby boards + one ready free API → other ready JSON/RSS/ATS → credentialed quota APIs after
meters reconcile → permitted HTML one source at a time. 24 h non-HTML and 3-night HTML observation minimums; sparse
sources need enough requests/records; health does not require non-empty results; Dice's denied route stays off.
Pre-activation policy freeze (cadence/attempt/retry/lease/concurrency/coverage, account quota + units + reset, cost
uncertainty, expiry/recheck/missing-observation, browsing generations, retention, quality/alert thresholds) with
owner/reviewer/version; unknown values block only their feature; model daily budget disabled until approved; no
2026-10-04 trial/quota value copied as entitlement; canonical authority, triage grant validity, cycle membership and
relation/cursor contracts frozen before dependent activation. Evaluation corpus: authentic permitted samples, recorded
capture/adapter versions, independent labels, stratified, split by employer/job lineage, thresholds frozen before
validation; metrics: false merges, extraction accuracy/completeness, relevance false negatives, precision@10/@20,
usable active opportunities, discovery latency, wasted HR time, cost; triage share/backlog (MP-09) ceiling blocks
expansion; safety tests: zero unauthorized visibility, no exclusion leaks, no legacy regression, no identity
corruption. Steps: disable-by-default deploy → scratch/backfill/shadow comparison → ADMIN-only review → limited HR
teams/sources → expand by metrics; per-configuration yield (MP-10); low-yield re-cadenced/disabled via audited ADMIN
action; rollback by flag without data destruction. "The queue filled up" is not acceptance.

### Task 8.3: Post-deploy checks (both halves of the chain)

- [ ] Build fingerprint (`GET /api/health` GIT_COMMIT) and applied forward migration versions/checksums/catalog state
      agree with the typed manifest; row counts alone insufficient.
- [ ] Read-only prod aggregates: source last-attempt/success/nonempty/partial/cooldown/checkpoints, account used/
      reserved/uncertain, run/record/revision uniqueness, active associations; costs vs provider usage.
- [ ] Legacy DOU shadow decisions match fixtures; backfill checksums/decision joins reconciled; rollback drills
      preserve them; real authorized HR/no-team/foreign requests prove visibility; UI mocks are not evidence.
- [ ] Egress-denial/resource/restart controls verified in an equivalent isolated environment; reopen, partial-run
      recovery, generation refresh, transactional claim audit, alert delivery, source attribution confirmed.
- [ ] Quality report names sample volume and unresolved blockers; nothing credentialed/browser-based is called
      production-ready from doc fixtures; public reports aggregate only.

## Rollback (all of v1)

Order: ADMIN disable/fence new source owners → disable queue/consumer flags → stop isolated browser/model workers and
revoke only their secrets → redeploy a compatible old API/UI if needed. Reservations for sent requests stay
conservative until reconciled; source records/revisions/tombstones/legacy IDs intact; no blanket revert without
checking new-schema/old-binary and enum compatibility.

| Component       | Action / evidence                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| One source      | ADMIN disabled flag + fencing audit; no new network; history/data preserved; in-flight reconciled                                            |
| New portfolio   | Disable non-DOU owners via ADMIN operations; DOU legacy path untouched; old collector ignores new types                                      |
| New queue       | Flag/route rollback after cache clear; authorization still enforced; assignments/dismissals/audit survive; old clients parse additive DTOs   |
| Projection      | Pause new projection/dirty workers; DOU delivery continues; replay retained observations later                                               |
| Schema          | Additive migrations + ledger stay; no DROP/type/decision rollback; index/constraint changes on legacy writes need binary regression evidence |
| Engine/model    | Stop their compose project; revoke their credentials; deterministic paths continue; never a whole-stack `compose down`                       |
| Bad association | Audited ADMIN unlink/split; rebuild canonical facts/matches; hold conflicting assignments; preserve revisions/history                        |

## Spec coverage (self-check)

| Design contract                                                                                                                                                                                                                   | Tasks / evidence                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Full portfolio, gated activation, no bypass                                                                                                                                                                                       | 2.5, 3.1–3.7, 5.6, 8.2; 31-type manifest          |
| Observations, revisions, reversible identity, legacy parity                                                                                                                                                                       | 1.2–1.4, 2.1, 4.3–4.6                             |
| Deterministic relevance / unknowns / restrictions                                                                                                                                                                                 | 4.1–4.4                                           |
| Equal-weight rank, no profile matching                                                                                                                                                                                            | 4.3, 6.3                                          |
| Cron/cadence/reports/quota/recovery                                                                                                                                                                                               | 2.2–2.5, 3.7, 8.1                                 |
| Main VPS; optional browser; OpenRouter-or-local behind one port                                                                                                                                                                   | 5.1–5.7                                           |
| HR scoped list/card/claim; uk/en; Tier 1; a11y                                                                                                                                                                                    | 0.1, 6.1–6.5, 7.1–7.6                             |
| Availability / retention / immutable generations                                                                                                                                                                                  | 1.2–1.4, 4.6, 6.2–6.3                             |
| Shelf life / quality / alerts / rollout / rollback                                                                                                                                                                                | 8.1–8.3                                           |
| Deferred boundaries                                                                                                                                                                                                               | §5                                                |
| r4 additions (storage/matches/subscriptions/DB role, byte budgets/egress proxy, pg-boss comparison/Kyiv cron, triage/ATS key/initial sweep, engine/model endpoint, multi-team/generation/possible duplicates, yield/triage share) | 1.2–1.4, 2.2, 2.5, 4.1–4.3, 5.1–5.2, 6.1–6.3, 8.2 |
| r5 reconciliation (landed work, DOU fetch path, naming, deploy wiring contract, seed immutability, env keys, legacy flag)                                                                                                         | §0, §1, A1n, 1.3, 2.2, 3.7, 5.2, 7.x              |

## Execution Handoff

Task numbering is traceability, not order. Dependency order: 4.6 compatibility fixture gate → 1.1–1.3 extensions /
2.1 identity contracts → 2.2–2.5 kit → 4.5–4.6 records/resolution/bridge/backfill → 4.1–4.4 + 1.4 → evidence-ready
3.x adapters/manifest → 6.x and design-gated 7.x → selective 5.x → staged 8.x. Task 0.1 can start after the DTO/policy
contract and blocks only Phase 7; API work never waits for the engine or credentials.

Each task file (when the feature is resumed) carries exact write ownership, dependencies, stable AC, assumption/risk
disposition and test commands; red→green→review for meaningful behaviour; real scratch-DB concurrency/RBAC/migration
tests; current code/security/spec/design/copy/manual-QA gates. Committing, pushing, merging and deploying follow
owner authorization separately. This document does not execute anything.

**Inherited-text conflicts (right column wins; task files copy the winning text):**

| Inherited text                                                                       | Winning contract                                                                                    |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Task 0.1 "matched seniors (names visible to the viewer)" / «уже взято <name> <when>» | Names only inside the actor's team scope; foreign claims show «вже взято» without a name (6.1, 6.3) |
| Task 0.1 "`enabled` switch, «вимкнено: <reason>» badge"                              | Disabled, paused and readiness-blocked are separate states (6.5, 7.5)                               |
| Task 7.1 `jobQueueQueryKey = (status)`; toast with the name from the response        | Keys include actor/team/policy/filters; name only when returned under masking (7.1)                 |
| Task 7.2 badge «не вдалося визначити стек»                                           | Triage items are labelled as triage, distinct from leads (7.2)                                      |
| Task 7.3 «взято <name> <when>» on IN_PROGRESS                                        | Name only inside scope (7.3)                                                                        |
| Task 7.3 `openOriginal`                                                              | `openOriginalPosting` from `components/job-sourcing/open-original.ts` (C-11)                        |
| Task 7.5 `JobSourceDto.disabledReason/minIntervalHours`                              | Extended source DTO (6.5)                                                                           |
| r4 `job_vacancies*` table names                                                      | `job_opportunities*` pending the A2 naming decision (C-14)                                          |
| r4 "reuse `ApiJsonProvider`/`RssProvider`/`FirecrawlHtmlProvider`"                   | All new; the only shipped provider is `DouRssProvider` (C-03)                                       |
| Seed header "later phases append rows to this same file"                             | New forward deltas only; 2026-10-05 files immutable (C-16)                                          |

**Milestones (nothing dropped; each ends in independently useful, reversible PRs):**

| Milestone                        | Content                                                                                                                                                                                                                                                   | Exit evidence                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| M1 Walking skeleton (ADMIN only) | Measurement spike (MP-01, MP-02, MP-05); 4.6 compatibility gate; 1.1–1.3 extensions; 2.1–2.5 kit with durable claims; 4.5 records/revisions; Greenhouse/Lever/Ashby on verified boards + one ready free API; 4.1–4.4; read-only ADMIN queue behind a flag | Legacy parity green; shadow data for one full cadence cycle per enabled source; labelled sample started |
| M2 HR queue                      | 6.x visibility/generations/claims/dismissals; 0.1 then 7.x; one limited HR team                                                                                                                                                                           | RBAC/action DB matrix green; design/fidelity/copy/manual-QA verdicts                                    |
| M3 Breadth without credentials   | Remaining evidence-ready JSON/RSS/ATS adapters; lifecycle/closure; yield metrics                                                                                                                                                                          | Per-source readiness rows; yield and triage-share report                                                |
| M4 Credentialed quota APIs       | 3.5 with shared metering and reconciliation                                                                                                                                                                                                               | Reconciled provider usage for a full billing window                                                     |
| M5 HTML                          | Engine decision (5.1, MP-01); model route by MP-03/MP-04 (5.2); isolation/capacity; 5.3–5.7 one source at a time                                                                                                                                          | Egress-denial and capacity evidence; per-source permission                                              |
