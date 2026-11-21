# Task sources-10 fix round 3 — PR #1438 (branch `feat/sources-10-arbeitnow-headroom`)

## Why

Round 2 made `DEGRADED` alert on two reasons (`SCHEMA_DRIFT`, `PAYLOAD_GROWTH`). Two reviewers (SO r2 gemini +
claude:sonnet) found the alert-entry logic still assumes one alerting DEGRADED reason. The comment above
`earlierEventsTodaySql` states the invariant that broke: "consecutive events always differ in (state, reason), so
was DEGRADED/SCHEMA_DRIFT and entered it again cannot occur" — with two alerting reasons, SCHEMA_DRIFT ->
PAYLOAD_GROWTH is DEGRADED -> DEGRADED.

## Findings to resolve

| ID | Sev | Where | Problem |
| --- | --- | --- | --- |
| R3-1 | M | `health/health-alert-policy.ts` `isAlertEntry` | Compares only `alertStateOf(from) === entered`; DEGRADED(SCHEMA_DRIFT) <-> DEGRADED(PAYLOAD_GROWTH) sends no alert, the new reason is silent |
| R3-2 | M | `health/source-health-alert.service.ts` `earlierEntriesToday` + `earlierEventsTodaySql` | Passes `reason: null` for the from side, so the daily-budget count and the live decision disagree (an event can be counted as an entry that never alerted, or vice versa) and burn the 3-per-Kyiv-day email budget |

## Do

1. TDD: failing unit specs first (policy spec) for SCHEMA_DRIFT -> PAYLOAD_GROWTH and back = entry; same reason ->
   not an entry; non-alerting DEGRADED reason -> alerting one = entry; alerting -> non-alerting = null.
2. R3-1: make the alert identity of a DEGRADED ref include its reason (e.g. an `alertKeyOf` used only for the
   comparison); `isAlertEntry` keeps returning `AlertState | null`. Smallest change.
3. R3-2: the count must evaluate each earlier event with the SAME `from` reason the live path uses
   (`stateBefore`: previous TRANSITION's `reason_code`). Derive it in SQL (e.g. `LAG(reason_code) OVER (ORDER BY at,
   id)` over the source's TRANSITION events, including the one event before Kyiv midnight so the first event of
   the day has its predecessor), keep the read bounded (no full-history scan per call), no DDL. Fix the stale
   comment. Integration spec in `source-health-alerts.integration.spec.ts`: a SCHEMA_DRIFT -> PAYLOAD_GROWTH day
   counts consistently with what was sent.
4. Run: policy unit spec, `pnpm --filter @crm/api test` (unit), the integration spec on scratch DB `crm_qa_s10_r3`
   with `DATABASE_URL` inline (never crm_db), typecheck, eslint on changed files, the diff mutation gate for the
   changed files if available locally.
5. Commit `fix(job-sourcing): alert on DEGRADED reason change; budget count uses previous reason` with
   `ac_verified: R3-1,R3-2`; push `DATABASE_URL= git push`. Report `Worktree:`, `Pushed: <branch> @ <sha>`, test
   counts (non-zero), `Findings resolved (2)`.

## Rules

- Zone `apps/api/**` only. No DDL, no migrations, no catalog text change (the alert text already names the reason
  neutrally). No `--no-verify`, explicit `git add`.
- Read-only on crm_db. Notes server: `notes.search` before reading code, `notes.add` facts with file:line.
- Do not run second-opinion.
