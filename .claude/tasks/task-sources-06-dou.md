# task-sources-06-dou — DOU: legitimate channel or a recorded "not connected"

## Agent: coder (investigation, then a small fix)
## Status: ready (dispatch when a slot frees)
## Model: gemini-3.8-flash (jev T1 0.77; Claude verifies)
## Branch: fix/sources-06-dou-challenge-health (only for AC 3)
## Source: `~/.claude/handoffs/sources-connect-2026-11-19/task-06-dou.md`

## Context
- Prod `DOU_RSS` row: enabled, `CANDIDATE`, legacy path (`collectAll` at 05:00 Kyiv), never
  collected (`last_collected_at` null).
- Dry-run of `DouRssProvider.collect({})` inside `crm-api-1` 2026-11-19: `DOU feed responded 403
  Forbidden`, URL `https://jobs.dou.ua/vacancies/feeds/`, headers `server: cloudflare`,
  `cf-mitigated: challenge`, body "Just a moment...".

## Acceptance criteria
1. Look for a legitimate channel not challenged from the VPS: other official DOU feed URLs
   (e.g. per-category feeds linked from the site), a documented API, a partner/export program.
   One plain request each, from the VPS (`ssh crm-vps 'curl -sS -o /dev/null -w "%{http_code} %header{cf-mitigated}\n" <url>'`)
   and note the result. Record URL, status, `cf-mitigated`, date.
2. If none: report "not connected: Cloudflare challenge on the server IP" with evidence, plus owner
   options (ask DOU to allowlist the server; accept DOU stays off).
3. The legacy loop must not stay silently broken: a 403 / `cf-mitigated: challenge` surfaces as a
   clear source health state (reuse the existing health/readiness vocabulary), with a unit test.
   Only if small (< ~80 LOC); otherwise report the scope.

## Assumptions
- (A1) A challenged response is a terminal BLOCKED-type health state, never retried within the run.
