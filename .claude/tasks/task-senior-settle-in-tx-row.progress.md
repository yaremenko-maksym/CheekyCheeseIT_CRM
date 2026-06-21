# Progress: task-senior-settle-in-tx-row (owner-clarification follow-up, PR #265)

current_milestone: 1/6
branch: feat/senior-settle-in-tx-row
base: origin/feat/senior-settle-in-tx-row (HEAD 91278e1a)

## Plan (RED-first where possible; reuse PaySalary pattern)

- M1 shared schema: settleSeniorPayoutSchema (= paySalary shape; fundingSource + payerAdminId? + currency + refineCompanyAccountUsdt). export from index.
- M2 backend service: generalize settleByCompany to accept optional `funding`
  {fundingSource, payerAdminId?, currency}; ADMIN_PERSONAL → senderId=payer (ADMIN-validated),
  fundingSource=ADMIN_PERSONAL, any currency, NO company lock/gate; COMPANY_ACCOUNT → current behavior.
  settleByCompanySourceTransaction passes funding through. Idempotency UNCHANGED (conditional UPDATE).
- M3 controller: parse settleSeniorPayoutSchema on by-source-transaction route; RBAC ADMIN/ACCOUNTANT (RolesGuard).
- M4 frontend: extract FundingSourceFields (shared by PaySalaryDialog); new SettleSeniorPayoutDialog;
  finance index onSettleSeniorPayout opens dialog (replaces window.confirm); api settle accepts body.
- M5 tests: pending-settlement.spec.ts (mock) update + add COMPANY/ADMIN_PERSONAL/idempotency/RBAC/USDT-refine;
  integration spec (real-DB) settle ADMIN_PERSONAL vs COMPANY; RTL SettleSeniorPayoutDialog + update PaySalaryDialog if extracted.
- M6 verify: web build (routeTree) → typecheck(api+web) → eslint → prettier → local tests → push.

## blast_radius (settleByCompany — exported, has callers/tests)

- settleByCompany callers: settleByCompanySourceTransaction (same file); controller settle-company (obligation-id route).
- tests pinning: pending-settlement.spec.ts (settleByCompany + bySourceTransaction), drop-payout-company-account.integration.spec.ts (INV2 calls settleByCompany 2-arg).
- DECISION: keep settleByCompany signature backward-compatible — funding is an OPTIONAL 3rd param defaulting to COMPANY_ACCOUNT. 2-arg callers (obligation-id controller route, INV2 spec) keep current behavior → no regression.

## frontend reuse

- PaySalaryDialog account-selector (COMPANY vs admin partners) + currency lock = the pattern to reuse.
- Extract FundingSourceFields presentational sub-component → used by PaySalaryDialog + SettleSeniorPayoutDialog.

files_done:
files_pending: packages/shared/src/schemas/finance.ts, apps/api/src/finance/pending-settlement.service.ts, apps/api/src/finance/pending-settlement.controller.ts, apps/web .../FundingSourceFields.tsx, SettleSeniorPayoutDialog.tsx, PaySalaryDialog.tsx, index.tsx, api.ts, specs
