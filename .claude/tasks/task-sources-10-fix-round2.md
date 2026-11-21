# Task sources-10 fix round 2 — PR #1438

PR #1438, branch `feat/sources-10-arbeitnow-headroom`, head `32f120fe1`. Delta review r2: 6000424764 (BLOCK, H=0 M=1
L=3) — read it: `gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/pulls/1438/reviews/6000424764 --jq .body`.
Second-opinion (claude:sonnet) findings verified by Master are listed as SO-n below.
Start: `git fetch origin && git checkout -B fix-1438-r2 origin/feat/sources-10-arbeitnow-headroom`.
Fresh worktree: `pnpm install --frozen-lockfile` and `pnpm --filter @crm/web build` before the first push.

## Master decisions (A1, recorded; add to the PR body "Assumptions")

1. **Separate the near-cap signal from the 3x-median growth (SO-2, N1).** The owner asked for an alert on "page near
   the 24 MiB cap", not on every source's byte growth. Give near-cap its own health reason (e.g. `PAGE_NEAR_CAP`)
   and alert only on it; `PAYLOAD_GROWTH` (3x the 14-day median) goes back to non-alerting, as on `origin/main`.
   FIRST check whether health reason codes are constrained in the DB (pg enum / CHECK on the health-event or source
   columns: read the Drizzle schema and `mcp__postgres__query` / a read-only SELECT on a scratch DB). If a new code
   needs DDL, do NOT add DDL: keep the single `PAYLOAD_GROWTH` reason, keep it alerting (the widening is then an
   accepted, recorded consequence), and make the alert text neutral for both causes (see 3). State which branch
   you took and why.
2. **Precedence (SO-1 HIGH, N2).** In `classify-health.ts` `DEGRADED_REASONS`, the alerting near-cap reason ranks
   right after `SCHEMA_DRIFT`, above `THROTTLED`/`SLOW`. Update the stale comment. Spec: a run that is both slow and
   near-cap reports the near-cap reason and alerts (red against `32f120fe1`).
3. **Alert text (N1).** `source-health-alert.service.ts` `alertOnTransition`: carry the reason in the alert data;
   add a near-cap sentence (uk + en Lingui catalogs, `packages/shared/src/i18n/locales`) so the alert no longer says
   "the response format has changed" for a size signal. Run `i18n:extract` as the repo does. Spec for both texts.
   Invoke the `copywriting` skill for the two strings. Remove `Skip-Copy-Review:` from the PR body (Master runs
   copy-review).
4. **Evidence (N3).** `run-provenance.ts`: the evidence for the near-cap reason shows the average page and the cap.
5. **Test (N4).** `health-alert-policy.spec.ts`: make the test start from `DEGRADED(SLOW)` as its title says (or fix
   the title and add that case).
6. **SO-5 (low).** The per-page `logger.warn` in `api-json.provider.ts` fires only for a source with a declared cap
   (today Arbeitnow), not at 80% of the 2 MiB default for every source.
7. **SO-7 (low).** `provider-facts.ts`: the declared cap uses the Arbeitnow cap constant, not the shared ceiling.
8. Accepted, no change (state in the PR body): `request_count` includes redirect hops/retries, so the average is
   understated (no false positives; follow-up `max_page_bytes`); flapping is bounded by entry-only alerts and the
   3 e-mails per source per Kyiv day.

## Verify

Typecheck, eslint, prettier, unit, health integration specs on scratch DB (`DATABASE_URL` inline, `crm_qa_s10_r2`,
never `crm_db`), mutation gate on changed lines (`node scripts/devops/mutation-gate.mjs --changed`; use
`MUTATION_BUDGET_SECONDS=3600` locally if load is high, and say so).

## Rules

Zone `apps/**`, `packages/**` only. Commit `ac_verified: 1,2,3` plus `N1 N2 N3 N4 SO-1 SO-2 SO-5 SO-7`. PR body:
append a "Fix round 2" table (outcome + evidence); re-read it right before writing (`gh pr view 1438 --json body
--jq .body > f`, edit, `gh pr edit 1438 --body-file f`). Push `DATABASE_URL= git push origin
HEAD:feat/sources-10-arbeitnow-headroom` in the background, verify with `git ls-remote`. Never --no-verify. Notes
server: `notes.search` first, `notes.add` facts with file:line. No second-opinion. English only. Report:
`Worktree:`, `Pushed: <branch> @ <sha>`, `Findings: resolved N / disagreed M`, `Tests:` with counts (red/green),
mutation survivors, which branch of decision 1 you took.
