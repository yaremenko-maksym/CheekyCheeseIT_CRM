# Progress: task-coder-settle-in-place

current_milestone: 6/6 (review round 1 done)
last_commit: fix(finance): review round 1 — defense-in-depth test + data-fix backup guard
last_push: DONE
milestone_1_done: settleByCompany flips source IOU in place; eslint clean; api typecheck green
milestone_2_done: unit spec rewritten (flip mock, 44 pass) + share-snapshot reset (money bug caught beyond ADR)
milestone_3_done: integration specs adapted; full integration suite 772 pass (crm_qa); +2 dedicated in-place tests
milestone_4_done: data-fix SQL validated on real Postgres (repoint+delete+idempotency, rollback-verified)
milestone_6_done: review round 1 (PR #379, both APPROVE, 2 MED fix-round):

- code-review MED: defense-in-depth throw (:414-422) now covered by dedicated unit test
  (mock: source tx status≠PENDING_PAYMENT while obligation claim wins) + integration test
  (real Postgres: out-of-band corrupted source status → whole db.transaction rolls back,
  obligation claim undone, proven via re-read after the throw).
- security MED: data-fix SQL 2b DELETE now guarded by
  `EXISTS (SELECT 1 FROM _settle_phantom_backup_20260715 b WHERE b.id=t.id)` — only deletes
  rows STEP 1 actually backed up. Verified on crm_qa with a synthetic orphan-IOU row
  (no obligation ever pointed at it): backup skips it, 2b delete leaves it untouched;
  real hung-pair phantom still correctly collapsed; idempotent re-run = 0 additional.
  money_catch: getSeniorBalance uses seniorSharePercent as GROSS/NET discriminator → flip MUST null share snapshots (else NET×26% undercount). ADR consumer table missed this.

## Milestones

1. Production flip: settleByCompany UPDATE-in-place (pending-settlement.service.ts)
2. Unit spec rewrite (pending-settlement.spec.ts) — flip semantics, no second row
3. Integration specs adapted (usdt-income-obligations / senior-settle-owner / drop-payout-company-account / others)
4. Data-fix SQL file (apps/api/drizzle/manual/2026-07-15_settle_phantom_cleanup.sql)
5. Quality gate (eslint + typecheck + full api test) + PR

## blast_radius (settleByCompany UPDATE-in-place)

- pending-settlement.service.ts settleByCompany — the method itself (core change)
- settleByCompanySourceTransaction — delegates, unchanged
- consumers keyed on FINAL row form (per ADR, 0 code changes):
  - company-account-balance.ts ledger terms (SENIOR_INCOME/PAYOUT_DROP + COMPANY_ACCOUNT)
  - computeDropAggregate (transactions.service.ts) — C6 received/sent
  - autoCreateForSeniorPayout (invoices.service.ts) — gate type==='SENIOR_INCOME'
  - C4 settlementTxIds (transactions.service.ts getSummary) — closingTransactionId=self
- Tests pinning old INSERT behavior (need rewrite to flip):
  - pending-settlement.spec.ts (unit, ~50 refs — heaviest)
  - usdt-income-obligations.integration.spec.ts (findAll DROP_PENDING_PAYOUT post-settle assertion)
  - senior-settle-owner.integration.spec.ts
  - drop-payout-company-account.integration.spec.ts
  - payout-no-admin-split.integration.spec.ts / finance-bugs.unit.spec.ts / balance.spec.ts

## Prod data (verified via postgres MCP)

All obligations debtorType=COMPANY, source in {SENIOR_PENDING_PAYOUT, DROP_PENDING_PAYOUT}.
28 PAID phantoms (21 senior + 7 drop) → data-fix targets. No legacy DROP-debt rows.
