# progress: task-usdt-income-idempotency

current_milestone: 7/7 (DONE — all AC verified)
branch: feature/drop-share-override-and-receiver (PR #367)
last_commit: (M5-M7 specs)
last_push: pending

## AC verification

- AC1 schema requires uuid → 400: covered by usdt-income-obligations RBAC + Zod (createUsdtIncomeSchema).
- AC2/AC3/AC4/AC4b: usdt-income-idempotency.integration.spec.ts — 4 tests green (crm_qa).
- AC5: uq_transactions_admin_income_idempotency_key verified via psql pg_indexes (crm_qa); db:push applied; manual .sql shipped.
- AC6: usdt-income-idempotency.unit.spec.ts — 3 tests green (early-return no insert/book; RBAC-first; miss falls through).
- AC7: obligations spec updated (helper injects key); full integration 72f/742 green; unit 153f/2347 green; typecheck+eslint clean.

## Milestones

- [x] M1 shared: createUsdtIncomeSchema += idempotencyKey (uuid, REQUIRED)
- [x] M2 db-schema: partial unique index uq_transactions_admin_income_idempotency_key
- [x] M3 prod-DDL: drizzle/manual/2026-07-14_usdt_income_idempotency_index.sql
- [x] M4 service: declareUsdtProjectIncome — early-SELECT + persist key + 23505 catch
- [x] M4b web (integration seam): CreateTransactionDialog Surface C sends idempotencyKey
      (parallel frontend 6943ee43 landed the dialog without the key; required field
      broke web typecheck — closed the seam, apps/web is in Coder zone)
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
