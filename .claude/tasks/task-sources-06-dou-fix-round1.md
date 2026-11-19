# task-sources-06-dou-fix-round1 — PR #1427 fix round 1

## Agent: coder
## Branch: fix/sources-06-dou-challenge-health (PR #1427, head f62582eaa)
## Parent task: `.claude/tasks/task-sources-06-dou.md` (commit it on this branch: CR-L-4)

## Findings to resolve (all; verbatim in the PR comments)
- Code review: https://github.com/yaremenko-maksym/CheekyCheeseIT_CRM/pull/1427#issuecomment-7009857429
  CR-H-1, CR-H-2, CR-M-1..5, CR-L-1..4 (11)
- Spec review: https://github.com/yaremenko-maksym/CheekyCheeseIT_CRM/pull/1427#issuecomment-7009584038 (10)

## Direction (Master, A1)
- DROP the stored `readiness = 'BLOCKED'` write and the `readiness !== 'BLOCKED'` filter (CR-H-1, spec H #4).
  "Never retried" comes from the owned mechanism: an `ACCESS_POLICY` ending -> `last_error_code` ->
  `AUTH_PAUSED` (`ownership/ledger-policy.ts`), cleared by ADMIN `resetFailures`. FIRST confirm the legacy
  DOU path actually writes `last_error_code` on the `job_sources` row (reviewer warns its ending is
  "run-row-only"). If it does not, make the legacy path write it through the existing ledger writer;
  if that is more than ~40 LOC, stop and report.
- Health event: emit through the owned writer/alert path (`JobSourceHealthService` /
  `SourceHealthAlertService.alertOnTransition`), in one transaction, with the classifier's vocabulary
  (CR-M-1, CR-M-5, CR-L-1). If DOU cannot go through it (excluded from REPORTING_TYPES), state the
  decision in the PR body and the runbook rather than hand-writing a row.
- Any DB write in the catch is guarded so one failure never aborts `collectAll` (CR-H-2). No `this.db?.db?.`.
- Refusal classification: one shared predicate (`http/source-errors.ts` or `bounded-fetch.ts`) with the
  `cf-mitigated: challenge` check, used by both; cancel the body before throwing (CR-M-3).
- Scope the catch so non-DOU adapters keep their existing A1k ban path (spec M).
- Tests: challenge with a non-refusal status (e.g. 503 + header), 401, 451; second `collectAll` skips the
  paused source and `resetFailures` makes it collectable again (CR-M-4, spec M).
- `budgetExhausted: err.budgetExhausted` (CR-L-2). English message in `source-errors.ts` (CR-L-3).
- PR body: AC 1/2 evidence table (URL | status | cf-mitigated | date) from the investigation, "not connected:
  Cloudflare challenge on the server IP", owner options, Plan, Tests, Skip-* lines; runbook
  `docs/runbooks/vacancy-sourcing.md` gets the new pause + recovery step. No IP addresses.

## Evidence for the PR body (from the investigation, 2026-11-19 UTC, plain curl from the VPS)
| URL | status | cf-mitigated | time |
| --- | --- | --- | --- |
| https://jobs.dou.ua/vacancies/feeds/ | 403 | challenge | 11:27:38Z |
| https://jobs.dou.ua/vacancies/feeds/?category=Node.js | 403 | challenge | 11:28:03Z |
| https://jobs.dou.ua/vacancies/feeds/?category=Java | 403 | challenge | 11:28:07Z |
| https://jobs.dou.ua/vacancies/feeds/?category=Python | 403 | challenge | 11:28:11Z |
| https://jobs.dou.ua/companies/epam-systems/vacancies/feeds/ | 403 | challenge | 11:28:15Z |
| https://jobs.dou.ua/ | 403 | challenge | 11:28:41Z |
| https://jobs.dou.ua/robots.txt | 403 | challenge | 11:28:46Z |
| https://dou.ua/feed/ | 200 | none | 11:28:20Z (editorial feed, no vacancies) |
No public jobs API found; partner access is by agreement with DOU.

## Assumptions
- (A1) Recovery = ADMIN `resetFailures`, no new state.
