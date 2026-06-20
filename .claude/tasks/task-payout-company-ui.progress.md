# Progress: task-payout-company-ui

current_milestone: 1/6
last_commit: (none yet)
last_push: (none yet)

## Milestones (WS = workstream)

- [ ] WS1 — financeApi.manualConfirmPayout wrapper + ManualConfirmPayoutDto import
- [ ] WS2 — PayoutDetailDialog redesign (on-chain status machine + manual override ADMIN/ACCOUNTANT)
- [ ] WS3 — CreateTransactionDialog DIVIDEND type (ADMIN-only) → companyAccountApi.createDividend
- [ ] WS4 — Company account balance KPI in /crm/stats
- [ ] WS5 — Admin wallet route/tab + reuse ChangeWalletAddressDialog
- [ ] WS6 — Remove CompanyAccountCard from finance; delete CompanyAccountCard.tsx + WithdrawDividendsDialog.tsx

## blast_radius

- PayoutDetailDialog — 1 caller: finance/index.tsx (openPayoutDetail). No covering unit test (RTL **tests** dir exists, none for this dialog).
- CreateTransactionDialog — 1 caller: finance/index.tsx. No covering unit test.
- CompanyAccountCard — 1 importer: finance/index.tsx (removed WS6).
- WithdrawDividendsDialog — 1 importer: CompanyAccountCard (deleted). Logic → WS3.
- ChangeWalletAddressDialog — 1 importer: CompanyAccountCard (deleted). MOVE to admin route, reused there.
- stats.tsx — adds 1 KPI card; standalone.

## Key facts (verified via code)

- manual-confirm endpoint: POST /payout-requests/:id/manual-confirm, manualConfirmPayoutSchema { method: CASH|ADMIN_USDT|COMPANY_ACCOUNT, note?, txHash? }. RolesGuard ADMIN/ACCOUNTANT.
- payout recipient address = PayoutRequestDto.contractAddress (already rendered in dialog, copyable).
- createDividend body = { amount, adminId? } (NOT receiverId — task/spec inaccuracy; adminId targets receiver admin, defaults to caller). Response { id, amount, receiverId }.
- companyAccountApi.getAccount → { walletAddress, balance, confirmationThreshold, updatedAt } query key ['company-account'].
- /crm/admin route-access entry already ADMIN-only (prefix covers new admin sub-routes). Coverage invariant auto-covers new files under routes/crm/admin/\*\*.
- DIVIDEND added as synthetic CreateTransactionDialog branch — NOT a TransactionType enum value (avoid backend churn). Uses local union for `type` state.

## files_pending

WS1: apps/web/app/routes/crm/finance/api.ts
WS2: apps/web/app/routes/crm/finance/components/dialogs/PayoutDetailDialog.tsx
WS3: apps/web/app/routes/crm/finance/components/dialogs/CreateTransactionDialog.tsx, constants.ts (TYPE_LABELS — no change; DIVIDEND not enum)
WS4: apps/web/app/routes/crm/stats.tsx
WS5: apps/web/app/routes/crm/admin/templates/wallet.index.tsx (new), route.tsx (tab), ChangeWalletAddressDialog moved
WS6: apps/web/app/routes/crm/finance/index.tsx, delete CompanyAccountCard.tsx + WithdrawDividendsDialog.tsx
</content>
</invoke>
