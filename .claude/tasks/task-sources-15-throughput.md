# Task sources-15 — HTML sources 4 runs a day, SmartRecruiters 10 requests a minute

## Why

Owner decisions 2026-11-21 (chat, after every source was connected on prod):

1. The six live HTML sources (`JUSTJOIN_HTML`, `THEHUB_HTML`, `LANDINGJOBS_HTML`, `NEXTLEVELJOBS_HTML`,
   `DICE_HTML`, `NOFLUFF_HTML`) run **4 times a day** instead of once. Today each makes one run a night
   (`HTML_COLLECTION_CRON = '30 2 * * *'`, Europe/Kyiv, in `apps/api/src/job-sourcing/job-sourcing.cron.ts`) and
   stores 20-25 postings per site per day. The per-run bounds (`maxDetails`, `requestsPerRun`) stay as they are;
   only the number of runs grows (expected ~100 new postings per site per day).
2. SmartRecruiters (`SMARTRECRUITERS_ATS`, 2 boards) host budget rises from `perMinute: 2` to `perMinute: 10`.
   Today a run reads 1 posting (`SMARTRECRUITERS_BOUNDS.maxRequests` = 2 requests: list + one detail); last 24 h on
   prod: 17 runs, 17 received, 2 new. Let one run read up to 9 postings (1 list + 9 details = 10 requests). This
   overrides the "raise only after two weeks without a refusal" note in `providers/manifest.definitions.ts` (owner
   decision 11, 2026-10-26) for SmartRecruiters only; cite the 2026-11-21 decision in that comment.

## Do

1. Find what else gates an HTML run besides the cron: the source rows' `interval_minutes` / cadence, the claim
   predicate, `minIntervalHoursFloor`, host budgets (`hostRate` / `hostRequestBudget` per day/hour), the
   `daily-html` trigger key (one run per day key?) and the start-offset jitter window. All of them must admit 4
   runs a day; nothing else may change. Spread the 4 slots 6 h apart (e.g. 02:30, 08:30, 14:30, 20:30 Kyiv) and
   keep the jitter. Keep every NO_EVASION stop (403 / 429 / challenge ends the run) and every robots / Crawl-delay
   rule untouched.
2. SmartRecruiters: raise its `hostRequestBudget.perMinute` to 10 and `SMARTRECRUITERS_BOUNDS.maxRequests` to 10
   (the single constant read by the adapter and the manifest). `perHour` stays consistent (`assertPolicy` must pass;
   do not raise `perHour` beyond what 10 a minute needs at the run cadence). The other BOARD hosts stay at 2.
3. If a manifest output changes, regenerate (`pnpm --filter @crm/api job-sources:manifest:generate`) and run the
   seed-delta integration spec on scratch DB `crm_qa_s15` (`DATABASE_URL` inline, never `crm_db`; the vitest filter
   must contain `integration.spec`). A config change that reaches prod rows goes only through the generated seed
   delta (deploy pipeline), never by hand.
4. Tests (TDD, failing first): the cron fires the HTML handler at 4 slots; a 4-runs-a-day cadence is claimable on
   each slot; SmartRecruiters run reads up to 9 postings and stops at 10 requests; budgets assert.
5. `docs/runbooks/vacancy-sourcing.md` is not your zone: list the cron-table lines that change in the PR body
   under "Runbook lines to update" (Master edits them).

## Acceptance criteria

1. Each HTML source is claimable and runs at 4 Kyiv slots a day, same per-run bounds, jitter kept.
2. SmartRecruiters: 10 requests a minute per host, up to 9 postings per run; other BOARD hosts unchanged.
3. Seed delta regenerated if needed + seed-delta integration spec green on `crm_qa_s15`.
4. Tests + mutation gate (`node scripts/devops/mutation-gate.mjs --changed`, run alone, not during a push) green;
   typecheck, eslint, prettier clean.

## Rules

Start from `origin/main`. Branch `feat/sources-15-throughput`. Zone `apps/api/**` (+ PR body). Every Edit/Write path
starts with your own `git rev-parse --show-toplevel`. TDD. Push early `wip:` commits; final commit
`feat(job-sourcing): HTML sources 4 runs a day, SmartRecruiters 10 requests a minute` with `ac_verified: 1,2,3,4`.
Push with `DATABASE_URL= git push` (pre-push is long: background it, wait, one push). Draft PR; body per
`.claude/rules/common/doc-durability.md` with `Plan:` line, `## Assumptions`, `Skip-QA:` and `Skip-Design-Review:`
(backend-only). No `--no-verify`, explicit `git add`. No external GETs (no live smoke needed). No secrets or personal
data. No second-opinion. Notes server: `notes.search` before reading code, `notes.add` facts with file:line.

Report: `Worktree:`, `Pushed: <branch> @ <sha>` (verify `git ls-remote`), PR URL, test counts (non-zero), mutation
result, the gates you found in step 1 and what you changed in each, `Token-economy:` line.
