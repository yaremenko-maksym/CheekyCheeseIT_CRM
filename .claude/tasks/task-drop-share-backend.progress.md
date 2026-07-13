# Progress — task-drop-share-backend

current_milestone: 4/6 (Part B backend)
branch: backend-v2 → feature/drop-share-override-and-receiver
last_push: 472e0a1f

## Done

- M0 merge main into feature (6a81618d) — pushed
- Step 1 shared + atomicity constants.ts (8614a028) — AC1, AC2 — pushed
- Step 2 schema migration + manual prod-DDL (472e0a1f) — AC3, AC4
- Step 3 Part A: resolveDropShare + override CRUD + snapshot (472e0a1f) — AC5, AC6, AC7, AC8

## In progress

- Step 4 Part B: declareUsdtProjectIncome endpoint (D3), bookCompanyObligations (D4),
  settle drop branch (D5), ledger term (C7), totalIncome fix (C4), seed USDT fixture (C10)

## Pending

- AC9 (D2 gate integration), AC10-AC17
- Full integration run against crm_qa
- PR creation
- security-reviewer (PM-dispatched)

## blast_radius (Part A/B)

- computeDropDistribution (tx.service) — drop share now from snapshot (fallback resolver)
- createPayoutRequest drop-branch — per-income snapshot
- projects.service create/update/mapProject/createFromInterview — paymentType enum
- projects-junior-masking integration — REAL_PAYMENT_TYPE → valid enum
- DEFAULT_DROP_SHARE_PERCENT moved to resolver, re-exported from transactions.service
