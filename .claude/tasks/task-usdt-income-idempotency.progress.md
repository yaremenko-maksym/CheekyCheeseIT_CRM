# progress: task-usdt-income-idempotency

current_milestone: 1/7
branch: feature/drop-share-override-and-receiver (PR #367)
last_commit: —
last_push: —

## Milestones

- [ ] M1 shared: createUsdtIncomeSchema += idempotencyKey (uuid, REQUIRED)
- [ ] M2 db-schema: partial unique index uq_transactions_admin_income_idempotency_key
- [ ] M3 prod-DDL: drizzle/manual/2026-07-14_usdt_income_idempotency_index.sql
- [ ] M4 service: declareUsdtProjectIncome — early-SELECT + persist key + 23505 catch
- [ ] M5 new integration spec usdt-income-idempotency.integration.spec.ts (AC2/3/4)
- [ ] M6 update usdt-income-obligations.integration.spec.ts (all calls send key) (AC7)
- [ ] M7 new unit spec usdt-income-idempotency.unit.spec.ts (early-return no insert/book) (AC6)

## blast_radius

- createUsdtIncomeSchema (shared) — call-sites: transactions.controller.ts:317 (Parameters<> auto-typed), integration spec.
- declareUsdtProjectIncome (service) — call-sites: transactions.controller.ts:316, usdt-income-obligations.integration.spec.ts (11 calls).
- transactions.idempotencyKey column — SHARED with dividend flow; new partial index scoped WHERE type='ADMIN_INCOME'.

## files_done

## files_pending

- packages/shared/src/schemas/finance.ts
- apps/api/src/database/schema.ts
- apps/api/drizzle/manual/2026-07-14_usdt_income_idempotency_index.sql
- apps/api/src/finance/transactions.service.ts
- apps/api/src/finance/usdt-income-idempotency.integration.spec.ts
- apps/api/src/finance/usdt-income-obligations.integration.spec.ts
- apps/api/src/finance/usdt-income-idempotency.unit.spec.ts
