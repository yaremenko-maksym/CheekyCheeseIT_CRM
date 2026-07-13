# task-integration-spec-cleanup — progress

## current_milestone: 1/4 (audit)

## last_commit: (none yet)

## last_push: (none yet)

## Approach

- Set up isolated scratch Postgres DB `crm_qa_verify_aca0b9` (NOT the shared `crm_qa`,
  which currently holds another concurrent agent's in-flight branch data — 43 tx / 11
  projects with `drop_share_percent*` columns from feature/drop-share-override-and-receiver,
  confirmed via `drizzle-kit push` dry-run diff). Pushing my branch's (main) schema onto the
  shared `crm_qa` would have deleted that data — avoided entirely.
- db:push + db:seed + CI's 2 QA fixture inserts (mirrors `.github/workflows/ci.yml` `integration` job)
  onto the isolated DB.
- Full sequential run (fileParallelism:false via vitest.config.mts `isIntegrationRun`) ×2
  back-to-back WITHOUT reseed: both 70/70 files green, 721/721 tests green — the specific
  income-compliance/admin-summary failure from the PR #367 report did NOT reproduce against a
  freshly-seeded DB (both those specs already use scoped/floor/delta-safe assertions — verified
  by reading the source; they are NOT the residue source).
- Ran a per-file empirical residue audit instead: reseed once, then run all 70 spec files
  ONE AT A TIME (cumulative, no reseed between), snapshotting row counts across all 25 tables
  before/after each file to attribute any net delta to that specific file. Script:
  `/tmp` scratchpad `residue-audit.sh` (not committed — dev tool only).

## Confirmed findings so far (via empirical diff, not guesswork)

1. **`finance/salary-cron-idempotency.integration.spec.ts`** — Pattern A violation.
   `createMonthlySalaries('2099-12')` is a COMPANY-WIDE cron (creates a PENDING SALARY row for
   EVERY eligible employee with `monthlySalary` set, not just the spec's own 2 fixture users).
   `cleanup()` only deletes `receiverId IN [HR_EMP_ID, ACCT_ID]` — leaves 9 orphaned SALARY/PENDING
   rows forever (for real seeded HR/ACCOUNTANT/JUNIOR employees). Fix: scope cleanup by
   `salaryMonth = MONTH` alone (no receiverId filter) since '2099-12' is already spec-unique.
2. **`onboarding/onboarding-contract.integration.spec.ts`** — Pattern A violation (test-side only).
   Test 4a calls the REAL `SignedContractsService.sign()` for DMYTRO — creates a genuine
   `signed_contracts` row every run. `afterAll` only reverts `employee_contracts` status via
   `revert()`; `signed_contracts` is INTENTIONALLY immutable audit in production code
   (`employee-contracts.service.ts` docstring: "signed_contracts row is immutable audit — NOT
   deleted") — this is correct prod behavior, NOT a bug, so production code is untouched.
   Fix is test-side only: capture `result.id` from the `sign()` call in 4a and delete that
   specific `signed_contracts` row directly via db in `afterAll` (mirrors existing pattern of
   other specs bypassing the service layer for their own cleanup, e.g. income-compliance).

## Next steps

- Finish per-file audit (background run) — build the full audit table for PR body.
- Apply fixes to the 2 files above.
- Re-check other "company-wide aggregate" specs named in the task (senior-summary,
  accountant-summary, hr-summary, total-earned, transactions.summary.rbac) — spot-checked via
  grep already: hr-summary/accountant-summary already use base-then-delta pattern;
  senior-summary/total-earned/transactions.summary.rbac use RBAC-persona-scoped absolute
  assertions (safe — scoped by namespaced userId, not company-wide) — needs one more pass to
  confirm no absolute company-wide-total assertion slipped through.
- Final verification: reseed once (baseline) + full suite ×2 without reseed in between (already
  proven clean on stock code; re-run after fixes to confirm identical clean result + include
  final summary lines in PR body per AC4).
