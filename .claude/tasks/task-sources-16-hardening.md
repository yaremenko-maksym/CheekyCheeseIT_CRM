# Task sources-16 — hardening of the shared HTML fetch paths (robots in code, no redirects, linear scans, 410)

## Why

Review rounds of PRs #1443-#1445 left four findings on code that is LIVE for JustJoin.it, The Hub, Landing.jobs and
Next Level Jobs (shared sitemap + JSON-LD core `apps/api/src/job-sourcing/providers/sources/sitemap-jsonld.ts`) and
on the shared `metered-fetch`. Master decision A1 (2026-11-21): fix them in one PR. The listing collector of
#1445 (`providers/sources/listing-detail.collector.ts`, Dice / No Fluff Jobs) already does items 1-2 right: reuse
its approach, do not invent a second one.

| ID | Where | Problem | Decision |
| --- | --- | --- | --- |
| H-1 | `sitemap-jsonld.ts` collect loop | robots.txt is not checked in code before each sitemap / detail URL | Fetch robots once per run (500 KiB cap, fail closed exactly as `listing-detail.collector.ts` does: 3xx, HTML body, non-text type when present, non-empty body without a directive line; empty body = allow all). Check every URL against it before the request; a disallowed URL is never requested (skip + count) |
| H-2 | `sitemap-jsonld.ts` collect loop | requests follow redirects | `followRedirects: false` (with `metered-fetch`'s `redirectIsAnAnswer` as the collector uses it): a detail 3xx is skipped like a 404 and its target is never requested; a sitemap 3xx fails closed as drift; 2 detail 3xx in a row end the run as `ACCESS_POLICY`. Before switching, check every captured fixture/provenance and, if needed, ONE live GET per site (owner-approved for diagnosis) that the sitemap URLs answer 200 without a redirect (trailing slash, http->https, locale). If a site redirects its own sitemap URLs, normalise the URL in code to the canonical form instead of following, and say so in the PR |
| H-3 | `nextleveljobs.provider.ts` `APPLY_BUTTON` | `[^>]*` lookahead regex is quadratic: 200 KB = 5.3 s synchronous | Linear `indexOf` scan with the same answers; differential spec vs the old regex on every captured NLJ fixture; a 2 MiB hostile page < 100 ms |
| H-4 | `metered-fetch.ts` | a 410 Gone ends the run (shared with SmartRecruiters and NLJ newest-id loop) | 410 on a detail request = the posting is gone, same as 404 (skip, keep going); 410 on a list / sitemap / robots request keeps today's behaviour. Spec both |
| H-5 | `sitemap-jsonld.ts` persistence-failure path (around `reportPersistenceFailure` / the second `report` for one fetch) | one fetch can produce two request reports | one request report per fetch, as fixed in the collector (BP2-L-1 of #1445). Spec: request count equals fetch count |

Out of scope: `hn-hiring.provider.ts` regexes; the Dice / NFJ collector itself; selection logic.

## Do

TDD (failing specs first). The trio + NLJ specs may only gain cases; existing expectations change only where H-1/H-2
change behaviour on purpose, each such change named in the PR body. Manifest `requestsPerRun` must still bound a
run (robots adds 1 request per run where it was not counted; update the figure and regenerate if so:
`pnpm --filter @crm/api job-sources:manifest:generate`, seed-delta integration spec on scratch DB `crm_qa_s16`,
`DATABASE_URL` inline, filter contains `integration.spec`). Run `src/job-sourcing` specs, typecheck, eslint, prettier,
mutation gate `node scripts/devops/mutation-gate.mjs --changed` (alone, not during a push).

## Acceptance criteria

1. H-1..H-5 resolved as decided, each with a spec.
2. No URL disallowed by robots and no redirect target is ever requested by the four sitemap sources.
3. Trio / NLJ specs pass; any changed expectation is named in the PR body with its reason.
4. Mutation gate green, typecheck / eslint / prettier clean; seed delta + integration spec if the manifest moved.

## Rules

Start from `origin/main`. Branch `fix/sources-16-hardening`. Zone `apps/api/**` (+ PR body). Every Edit/Write path
starts with your own `git rev-parse --show-toplevel`. NO_EVASION: a 403, 429, Cloudflare/bot challenge or explicit
block ends it; no user-agent change, proxy or headless browser. At most one diagnostic GET per site. Push early
`wip:` commits; final commit `fix(job-sourcing): robots in code and no redirects for sitemap sources, linear NLJ
scan, 410 as gone` with `ac_verified: 1,2,3,4`. Push with `DATABASE_URL= git push` (background the long pre-push,
one push). Draft PR; body per `.claude/rules/common/doc-durability.md` with `Plan:` line, `## Assumptions`,
`Skip-QA:` and `Skip-Design-Review:` (backend-only). No `--no-verify`, explicit `git add`. No secrets or personal
data. No second-opinion. Notes server: `notes.search` before reading code, `notes.add` facts with file:line.

Report: `Worktree:`, `Pushed: <branch> @ <sha>` (verify `git ls-remote`), PR URL, test counts (non-zero), mutation
result, the live-GET results per site (status only), `Findings resolved (5)`, `Token-economy:` line.
