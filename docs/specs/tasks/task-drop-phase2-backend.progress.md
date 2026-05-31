# Progress: task-drop-phase2-backend

current_milestone: 4/5 — "getSummary dropBalances + distribution UT"
last_commit: b7c57f5
last_push: b7c57f5

## Plan
1. Shared schemas: `transactionTypeSchema` += `PAYOUT_DROP`, `DROP_INCOME`; `createDropIncomeSchema`; `transactionSchema.recipientId`.
2. Drizzle pgEnum: `transactionTypeEnum` += `PAYOUT_DROP`, `DROP_INCOME`; transactions.recipientId column; migration 0021.
3. `transactions.service.ts`:
   - Extract `computePartnersSplit` helper (refactor-only).
   - New `computeDropDistribution` helper.
   - Branch in `payPayoutRequest` on `project.dropId`.
   - Extend `validateTransaction` to handle `DROP_INCOME`.
   - New `createDropIncome` method.
   - Extend `unlockJuniorSalaryForProject` query to include `DROP_INCOME`.
   - Extend `getSummary` to include `dropBalances`.
4. Controller: new `POST /transactions/drop-income`; finance summary already returns drop balances.
5. UT:
   - `transactions.distribution.spec.ts` — math 1000→260/50/345/345; edges.
   - `transactions.partners-split.spec.ts` — regression for `computePartnersSplit(1000)` → 500/500.

## files_done
(nothing yet)

## files_pending
- packages/shared/src/schemas/finance.ts
- apps/api/src/database/schema.ts
- apps/api/drizzle/migrations/0021_*.sql
- apps/api/src/finance/transactions.service.ts
- apps/api/src/finance/transactions.controller.ts
- apps/api/src/finance/transactions.distribution.spec.ts (new)
