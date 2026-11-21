# Task sources-12 — Next Level Jobs (nextleveljobs.eu) source adapter

## Why

Owner decision 2026-11-20 (A3, recorded): connect Next Level Jobs; the owner accepts the risk of UNCLEAR permission
(the same acceptance as 2026-11-16 for six sources — see `docs/superpowers/research/2026-11-16-unclear-source-permissions.md`).
External GETs to nextleveljobs.eu are owner-approved for captures and smokes.

## Facts (research 2026-11-20, read-only)

- robots.txt: `User-agent: *` / `Allow: /` / `Sitemap: https://nextleveljobs.eu/sitemap.xml`.
- ToS: https://nextleveljobs.eu/privacy-policy (combined terms + privacy, German law): no clause on automated
  access, scraping or storage -> UNCLEAR.
- `https://nextleveljobs.eu/jobs/sitemap.xml`: 200 `application/xml`, ~485 KB, 2 787 URLs
  `/companies/<company>/jobs/<id>`. `lastmod` is useless for freshness (almost all = today): find new jobs by
  diffing the URL set against what we already hold.
- Job page ~175 KB, one JSON-LD `JobPosting`: `title`, `hiringOrganization.name`, `jobLocation` +
  `jobLocationType` + `applicantLocationRequirements`, `datePosted`, `validThrough`, `employmentType`,
  `occupationalCategory`, `url` (canonical), plain-text `description`. No `baseSalary` in the sample. Page links the
  employer's original posting (often `jobs.ashbyhq.com/...`, Greenhouse, ...).
- VPS probe: 200, no Cloudflare challenge.
- The site scrapes company career pages itself -> its jobs overlap our ATS sources.

## Do

1. Find the existing pattern first (codegraph / ast-grep): `providers/html/html-provider.ts`,
   `providers/xml-source.provider.ts`, `structuring/json-ld.ts`, `providers/detail-mode.ts`, the manifest files
   (`manifest.definitions.ts`, `manifest.hosts.ts`, `manifest.fetch-profile.ts`, `manifest.seed-sql.ts`,
   `manifest.activation.ts`, `owner-decisions.ts`) and how the most recent sources (WWR, Djinni, Working Nomads) were
   added end to end, including the prod seed-delta path. Reuse; no new framework.
2. Adapter: enumerate via the jobs sitemap, fetch details for unseen URLs only, under a conservative per-run and
   per-host request budget (polite: well under 1 req/s; cap detail fetches per run so a first run does not pull
   2 787 pages at once — state the numbers). Deterministic JSON-LD parse; no model.
3. Dedup: if the posting links an employer apply URL that matches a posting we already hold from an ATS source,
   do not create a duplicate (reuse the existing dedup/identity seam; state how).
4. Record the owner's risk acceptance where the code records owner decisions (`owner-decisions.ts` or equivalent),
   with date 2026-11-20 and the UNCLEAR classification.
5. Fixtures: one sitemap capture (trimmed) + one or two job pages, with provenance like the existing fixtures.
6. Prod enablement through the deployed pipeline only (seed-delta / manifest activation like previous sources),
   never by hand. Enabled by default.
7. Tests: unit (parser, sitemap diff, budget, dedup) red/green; integration on a scratch DB (`DATABASE_URL` inline,
   `crm_qa_s12`, never `crm_db`); mutation gate on changed lines (`node scripts/devops/mutation-gate.mjs --changed`).
   One live smoke GET is allowed (owner-approved).

## Acceptance criteria

1. Sitemap enumeration + unseen-only detail fetch within stated budgets.
2. JSON-LD fields mapped; missing salary handled.
3. No duplicates vs ATS postings with the same apply URL.
4. Owner decision recorded; source enabled via pipeline on deploy.
5. Tests + mutation gate green; typecheck, eslint, prettier clean.

## Rules

Zone `apps/**`, `packages/**` only (no `.claude/**`, no `docs/**`). NO DDL without stopping and reporting (a new
column = owner decision). NO_EVASION: a 403/429/challenge ends it — no UA change, proxy or headless browser. Draft PR
`feat(job-sourcing): Next Level Jobs source (sitemap + JSON-LD)`, body with `Task:` (this file's name), `Plan:` (one
line), "Assumptions", "Follow-ups". Commit `ac_verified: 1,2,3,4,5`. Push `DATABASE_URL= git push` in the background,
verify with `git ls-remote`. Never --no-verify. Notes server: `notes.search` first, `notes.add` facts with file:line.
No second-opinion. English only. Report: `Worktree:`, `Pushed: <branch> @ <sha>`, PR URL, `Tests:` with counts
(red/green), mutation survivors, request budget numbers.
