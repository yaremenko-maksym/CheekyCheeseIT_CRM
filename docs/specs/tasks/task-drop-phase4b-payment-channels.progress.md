# Progress: task-drop-phase4b-payment-channels

current_milestone: 0/5 — "starting backend service skeleton"
last_commit: a61befb
last_push: (not yet)

milestones:

1. Shared schemas + service skeleton (PaymentChannelService stubs)
2. PaymentChannelService implementation (3 channels)
3. Controller + endpoints + UT
4. Frontend: /crm/payments/initiate page + FinanceTab button
5. Frontend: /crm/stats — TOВ balance card + participants balance list

files_done: []
files_pending:

- packages/shared/src/schemas/finance.ts (extend with payment-channel schemas)
- apps/api/src/finance/payment-channel.service.ts
- apps/api/src/finance/payment-channel.controller.ts
- apps/api/src/finance/payment-channel.spec.ts
- apps/api/src/finance/finance.module.ts (register new providers)
- apps/web/app/routes/crm/payments/initiate.$incomeId.tsx
- apps/web/app/components/user-profile/tabs/FinanceTab.tsx
- apps/web/app/routes/crm/finance/components/TransactionRow.tsx
- apps/web/app/routes/crm/finance/api.ts
- apps/web/app/routes/crm/stats.tsx
