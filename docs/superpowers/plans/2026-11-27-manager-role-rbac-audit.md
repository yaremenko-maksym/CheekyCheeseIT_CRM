# MANAGER role — RBAC audit checklist (design §5)

Tracked checklist for `docs/superpowers/plans/2026-11-27-manager-role-plan.md`. Generated on 2026-11-27 from
`origin/main` at `17e233a6d` by the script in the appendix; **regenerate at the start of PR 2** (after the ACCOUNTANT
removal, PR 1b–1d, rows move or disappear) and carry the ticks over by file + symbol.

## How to read a row

`- [ ] \`<symbol>\` — <kinds> — **<proposed class>**`

- **Kinds:** `admin-cmp` (`=== / !== 'ADMIN'`), `@Roles(...)` (resolved role set; `(empty)` = an override that opens
  the handler), `no-roles` (controller handler with no method- or class-level `@Roles`: `RolesGuard` is a no-op, the
  service must check), `role-branch` (any other role literal compared or listed, `.includes(role)`, `switch (role)`),
  `db-role` (Drizzle `eq/inArray(…role)` or SQL `role = '…'`).
- **Classes:** `ADMIN only` · `ADMIN or MANAGER-in-scope` · `MANAGER-specific`. `ADMIN only (default-deny)` is `ADMIN
only` for a feature the design does not grant MANAGER (owner question Q-E in the plan).
- Classes are **proposed** by path and symbol rules (appendix). PR 2 confirms each row against the §5 action table,
  ticks it, and for "ADMIN or MANAGER-in-scope" names the PR that grants it. Symbol-level overrides already move
  dividends, company account, admin summary and manager-share setters to `ADMIN only`, and HOLDING / partner /
  `getTotalEarned` to `MANAGER-specific`.

## Counts and reconciliation

- Entries (file + symbol): 646 in 233 files.
- Raw occurrences: admin-cmp 256, roles 139, no-roles 117, role-branch 448, db-role 38.
- Proposed classes: ADMIN only 57, ADMIN only (default-deny) 219, ADMIN or MANAGER-in-scope 355, MANAGER-specific 15.

Reconciled against a raw `grep` over the same roots (non-test files):

- `=== / !== 'ADMIN'`: raw grep 272 lines; the script counts 256. The 16 others are comment lines, which the script skips.
- `@Roles(`: raw grep 186 lines; the script counts 139 calls. The 47 others are mentions inside comments and JSDoc
  (e.g. "No `@Roles(...)` here") and one inside an SQL comment in `manifest.seed-sql.ts`.
- The design estimate "~79 files" was made on ADMIN comparisons only; the measured figure is 138 files for those, 233
  files for all five kinds.
- Rows named `(module scope)` are top-level constants (role arrays, enum and Zod definitions); `(class)` is a
  class-level `@Roles`.

## Inventory

#### `apps/api/src/admin/admin-summary.service.ts`

- [ ] `getSummary` — admin-cmp — **ADMIN only**

#### `apps/api/src/admin/admin.controller.ts`

- [ ] `getSummary` — @Roles('ADMIN') — **ADMIN only**

#### `apps/api/src/auth/auth.controller.ts`

- [ ] `impersonate` — @Roles('ADMIN'); admin-cmp — **ADMIN only**
- [ ] `me` — no-roles (guard no-op: service must check) — **ADMIN only**
- [ ] `stopImpersonating` — admin-cmp; no-roles (guard no-op: service must check) — **ADMIN only**

#### `apps/api/src/auth/onboarding.guard.ts`

- [ ] `rawUrl` — admin-cmp — **ADMIN only**

#### `apps/api/src/common/guards/roles.guard.ts`

- [ ] `canActivate` — role-branch — **ADMIN only (default-deny)**

#### `apps/api/src/common/hr-access.service.ts`

- [ ] `inArray` — db-role; role-branch — **ADMIN only (default-deny)**
- [ ] `isNull` — role-branch — **ADMIN only (default-deny)**

#### `apps/api/src/contact/contact.service.ts`

- [ ] `submit` — db-role — **ADMIN only (default-deny)**

#### `apps/api/src/contracts/contract-rendering.ts`

- [ ] `fopParts` — role-branch — **ADMIN only (default-deny)**

#### `apps/api/src/contracts/contract-templates.controller.ts`

- [ ] `current` — admin-cmp; no-roles (guard no-op: service must check) — **ADMIN only**
- [ ] `getById` — @Roles('ADMIN') — **ADMIN only**
- [ ] `list` — @Roles('ADMIN') — **ADMIN only**
- [ ] `previewPdf` — @Roles('ADMIN') — **ADMIN only**
- [ ] `previewRendered` — @Roles('ADMIN', 'HR') — **ADMIN only**
- [ ] `publish` — @Roles('ADMIN') — **ADMIN only**

#### `apps/api/src/contracts/contract-templates.service.ts`

- [ ] `getCurrentForRole` — admin-cmp — **ADMIN only**
- [ ] `targetRole` — admin-cmp — **ADMIN only**

#### `apps/api/src/contracts/employee-contracts.controller.ts`

- [ ] `(class)` — @Roles('ADMIN') on class — **ADMIN only (default-deny)**
- [ ] `get` — @Roles((empty)); admin-cmp — **ADMIN only (default-deny)**
- [ ] `getPdf` — @Roles((empty)); admin-cmp — **ADMIN only (default-deny)**

#### `apps/api/src/contracts/employee-contracts.service.ts`

- [ ] `resolveUserFieldEmpty` — role-branch — **ADMIN only (default-deny)**
- [ ] `where` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/api/src/contracts/onboarding-contract.controller.ts`

- [ ] `getForSigning` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `getOwnPdf` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**

#### `apps/api/src/contracts/signed-contracts.controller.ts`

- [ ] `downloadPdf` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `findMine` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `findOne` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `getMyContractStatus` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `sign` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**

#### `apps/api/src/contracts/signed-contracts.service.ts`

- [ ] `userRole` — admin-cmp — **ADMIN only (default-deny)**
- [ ] `where` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/api/src/credentials/credentials.controller.ts`

- [ ] `create` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `list` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `remove` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `reveal` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `update` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/credentials/credentials.service.ts`

- [ ] `assertAccess` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `canAccess` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `viewer` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/credentials/user-credentials.controller.ts`

- [ ] `list` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `reveal` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `update` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/database/schema/enums.ts`

- [ ] `(module scope)` — role-branch — **ADMIN only**

#### `apps/api/src/documents/document-scope.util.ts`

- [ ] `eq` — db-role — **ADMIN only (default-deny)**
- [ ] `hrAccess` — role-branch — **ADMIN only (default-deny)**

#### `apps/api/src/documents/document-upload-rbac.util.ts`

- [ ] `category` — admin-cmp; role-branch — **ADMIN only (default-deny)**

#### `apps/api/src/documents/document-visibility.util.ts`

- [ ] `and` — role-branch — **ADMIN only (default-deny)**
- [ ] `conditions` — admin-cmp — **ADMIN only (default-deny)**
- [ ] `filters` — admin-cmp — **ADMIN only (default-deny)**
- [ ] `visibleClauses` — role-branch — **ADMIN only (default-deny)**

#### `apps/api/src/documents/documents.controller.ts`

- [ ] `download` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `hardDelete` — @Roles('ADMIN') — **ADMIN only (default-deny)**
- [ ] `list` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `preview` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `reconcileOrphans` — @Roles('ADMIN') — **ADMIN only (default-deny)**
- [ ] `restore` — @Roles('ADMIN') — **ADMIN only (default-deny)**
- [ ] `softDelete` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `thumbnail` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `upload` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**

#### `apps/api/src/documents/documents.service.ts`

- [ ] `effectiveFilters` — role-branch — **ADMIN only (default-deny)**
- [ ] `filters` — admin-cmp — **ADMIN only (default-deny)**
- [ ] `findActiveOrThrow` — admin-cmp; role-branch — **ADMIN only (default-deny)**
- [ ] `hardDelete` — admin-cmp — **ADMIN only (default-deny)**
- [ ] `restore` — admin-cmp — **ADMIN only (default-deny)**
- [ ] `softDelete` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/api/src/finance/admin-edit.service.ts`

- [ ] `currentUser` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/admin-income.service.ts`

- [ ] `currentUser` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `eq` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/balance.controller.ts`

- [ ] `getAdmin` — no-roles (guard no-op: service must check) — **MANAGER-specific**
- [ ] `getSenior` — no-roles (guard no-op: service must check) — **MANAGER-specific**
- [ ] `getTotalEarned` — no-roles (guard no-op: service must check) — **MANAGER-specific**
- [ ] `list` — no-roles (guard no-op: service must check); role-branch — **MANAGER-specific**

#### `apps/api/src/finance/balance.service.ts`

- [ ] `add` — admin-cmp; role-branch — **MANAGER-specific**
- [ ] `assertCanListPendingObligations` — admin-cmp — **MANAGER-specific**
- [ ] `assertCanReadAdminBalance` — admin-cmp; role-branch — **MANAGER-specific**
- [ ] `assertCanReadSeniorBalance` — admin-cmp; role-branch — **MANAGER-specific**
- [ ] `assertCanReadTotalEarned` — admin-cmp — **MANAGER-specific**

#### `apps/api/src/finance/company-account.controller.ts`

- [ ] `createDividend` — @Roles('ADMIN') — **ADMIN only**
- [ ] `getAccount` — @Roles('ADMIN', 'ACCOUNTANT') — **ADMIN only**
- [ ] `getDepositStatus` — @Roles('SENIOR', 'DROP', 'ADMIN', 'ACCOUNTANT') — **ADMIN only**
- [ ] `submitDeposit` — @Roles('SENIOR', 'DROP') — **ADMIN only**
- [ ] `updateRequisites` — @Roles('ADMIN') — **ADMIN only**
- [ ] `updateWallet` — @Roles('ADMIN') — **ADMIN only**

#### `apps/api/src/finance/company-account.service.ts`

- [ ] `currentUser` — admin-cmp; role-branch — **ADMIN only**
- [ ] `eq` — admin-cmp — **ADMIN only**
- [ ] `getAccount` — admin-cmp — **ADMIN only**
- [ ] `getDepositStatus` — admin-cmp — **ADMIN only**
- [ ] `updateWallet` — admin-cmp — **ADMIN only**

#### `apps/api/src/finance/company-obligations.util.ts`

- [ ] `dbtx` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/drop-self.service.ts`

- [ ] `getDropSelfPayments` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `getDropSelfSummary` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `query` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/edit-cascade.service.ts`

- [ ] `currentUser` — admin-cmp — **ADMIN only**

#### `apps/api/src/finance/finance-predicates.util.ts`

- [ ] `isInternalCompanySide` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/income-compliance.util.ts`

- [ ] `currentUser` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/income-receipt.service.ts`

- [ ] `assertTransactionWritable` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `currentUser` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/onchain-claim.service.ts`

- [ ] `currentUser` — admin-cmp — **ADMIN only**
- [ ] `inspectOnChainHash` — admin-cmp — **ADMIN only**

#### `apps/api/src/finance/payout-confirmation.service.ts`

- [ ] `currentUser` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `readBack` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/payout-request-read.service.ts`

- [ ] `findPayoutRequest` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `findPayoutRequests` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/payout-request.service.ts`

- [ ] `currentUser` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/payout-settlement.service.ts`

- [ ] `currentUser` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/pending-settlement.controller.ts`

- [ ] `listCompany` — @Roles('ADMIN', 'ACCOUNTANT') — **ADMIN or MANAGER-in-scope**
- [ ] `listSenior` — @Roles('ADMIN', 'ACCOUNTANT', 'SENIOR') — **ADMIN or MANAGER-in-scope**
- [ ] `settleCompanyBySourceTransaction` — @Roles('ADMIN', 'ACCOUNTANT') — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/pending-settlement.service.ts`

- [ ] `actor` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `conjuncts` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `listCompanyObligations` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `listSeniorObligations` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/project-finance-settings.service.ts`

- [ ] `currentUser` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `getProjectFinanceSettings` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/salary-payment.service.ts`

- [ ] `assertTransactionWritable` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `createMonthlySalaries` — db-role — **ADMIN or MANAGER-in-scope**
- [ ] `currentUser` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/salary.service.ts`

- [ ] `Array` — db-role — **ADMIN or MANAGER-in-scope**
- [ ] `currentUser` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `project` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `query` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/senior-drop-income.service.ts`

- [ ] `currentUser` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/summary.service.ts`

- [ ] `allTxs` — db-role — **MANAGER-specific**
- [ ] `balance` — db-role — **MANAGER-specific**
- [ ] `getAccountantSummary` — admin-cmp — **MANAGER-specific**
- [ ] `getSeniorSummary` — admin-cmp — **MANAGER-specific**
- [ ] `getSummary` — admin-cmp — **MANAGER-specific**

#### `apps/api/src/finance/transaction-date-policy.ts`

- [ ] `BACKDATE_EXEMPT_ROLES` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/transaction-entry.service.ts`

- [ ] `assertSalaryCreationIntent` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `currentUser` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/transaction-mapper.util.ts`

- [ ] `mapTx` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `seniorSharePercentSource` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/transaction-trash.service.ts`

- [ ] `adminDeleteTransaction` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `currentUser` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `restoreTransactionRow` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/transaction-visibility.util.ts`

- [ ] `assertTransactionReadAccess` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `isPrivilegedViewer` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/transactions.controller.ts`

- [ ] `adminDelete` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `adminEdit` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `attachReceipt` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `backfillSalaryMonth` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `confirmPayout` — @Roles('ADMIN', 'ACCOUNTANT') — **ADMIN or MANAGER-in-scope**
- [ ] `create` — @Roles('SENIOR', 'DROP') — **ADMIN or MANAGER-in-scope**
- [ ] `createAdminIncome` — @Roles('ADMIN', 'ACCOUNTANT') — **ADMIN or MANAGER-in-scope**
- [ ] `createAdminTransfer` — @Roles('ADMIN', 'ACCOUNTANT') — **ADMIN or MANAGER-in-scope**
- [ ] `createDropIncome` — @Roles('DROP') — **ADMIN or MANAGER-in-scope**
- [ ] `createExpense` — @Roles('ADMIN', 'ACCOUNTANT') — **ADMIN or MANAGER-in-scope**
- [ ] `createSalary` — @Roles('ADMIN', 'ACCOUNTANT') — **ADMIN or MANAGER-in-scope**
- [ ] `createSeniorIncome` — @Roles('SENIOR') — **ADMIN or MANAGER-in-scope**
- [ ] `declareUsdtProjectIncome` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `findAll` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `findOne` — @Roles('ADMIN', 'ACCOUNTANT', 'SENIOR', 'DROP'); no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `get` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `getAccountantSummary` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `getAuditLog` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `getDropSelfIncomes` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `getDropSelfPayments` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `getDropSelfSummary` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `getEditCascadePreview` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `getExchangeRate` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `getIncomeCompliance` — @Roles('ADMIN', 'ACCOUNTANT') — **ADMIN or MANAGER-in-scope**
- [ ] `getSalaryMonthGap` — @Roles('ADMIN', 'ACCOUNTANT') — **ADMIN or MANAGER-in-scope**
- [ ] `getSalaryParts` — @Roles('ADMIN', 'ACCOUNTANT') — **ADMIN or MANAGER-in-scope**
- [ ] `getSeniorSummary` — @Roles('SENIOR', 'ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `getSummary` — @Roles('ADMIN', 'ACCOUNTANT') — **ADMIN or MANAGER-in-scope**
- [ ] `inspectOnChainHash` — @Roles('ADMIN', 'ACCOUNTANT') — **ADMIN only**
- [ ] `manualConfirm` — @Roles('ADMIN', 'ACCOUNTANT') — **ADMIN or MANAGER-in-scope**
- [ ] `pay` — @Roles('SENIOR', 'DROP') — **ADMIN or MANAGER-in-scope**
- [ ] `paySalary` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `releaseOnChainHash` — @Roles('ADMIN') — **ADMIN only**
- [ ] `restore` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `updateDropIncome` — @Roles('DROP') — **ADMIN or MANAGER-in-scope**
- [ ] `updateSeniorIncome` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `upsert` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `validate` — @Roles('ADMIN', 'ACCOUNTANT') — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/finance/transactions.service.ts`

- [ ] `allTxs` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `currentUser` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/integrations/meeting-recorder/interview-recordings.controller.ts`

- [ ] `detail` — @Roles('ADMIN', 'SENIOR', 'HR') — **ADMIN only (default-deny)**
- [ ] `link` — @Roles('ADMIN') — **ADMIN only (default-deny)**
- [ ] `list` — @Roles('ADMIN', 'SENIOR', 'HR') — **ADMIN only (default-deny)**
- [ ] `listUnmatched` — @Roles('ADMIN') — **ADMIN only (default-deny)**
- [ ] `mediaList` — @Roles('ADMIN', 'SENIOR', 'HR') — **ADMIN only (default-deny)**
- [ ] `mediaPlayback` — @Roles('ADMIN', 'SENIOR', 'HR') — **ADMIN only (default-deny)**
- [ ] `purgeRecording` — @Roles('ADMIN') — **ADMIN only (default-deny)**

#### `apps/api/src/integrations/meeting-recorder/media/recording-media.controller.ts`

- [ ] `complete` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `create` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `part` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `playback` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `status` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**

#### `apps/api/src/integrations/meeting-recorder/meeting-recorder.controller.ts`

- [ ] `constructor` — @Roles('ADMIN') — **ADMIN only**
- [ ] `createConnection` — no-roles (guard no-op: service must check) — **ADMIN only**
- [ ] `listConnections` — no-roles (guard no-op: service must check) — **ADMIN only**
- [ ] `replaceMediaToken` — no-roles (guard no-op: service must check) — **ADMIN only**
- [ ] `resetPairing` — no-roles (guard no-op: service must check) — **ADMIN only**
- [ ] `setSecret` — no-roles (guard no-op: service must check) — **ADMIN only**
- [ ] `updateConnection` — no-roles (guard no-op: service must check) — **ADMIN only**

#### `apps/api/src/integrations/meeting-recorder/meeting-recorder.service.ts`

- [ ] `currentUser` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/api/src/interviews/interview-access-policy.service.ts`

- [ ] `currentUser` — admin-cmp; role-branch — **ADMIN only (default-deny)**
- [ ] `getAccessibleSeniorIds` — role-branch — **ADMIN only (default-deny)**

#### `apps/api/src/interviews/interviews.controller.ts`

- [ ] `assertNotDrop` — role-branch — **ADMIN only (default-deny)**
- [ ] `boardSeniors` — @Roles('ADMIN', 'SENIOR', 'HR') — **ADMIN only (default-deny)**
- [ ] `create` — @Roles('ADMIN', 'SENIOR', 'HR') — **ADMIN only (default-deny)**
- [ ] `findBySenior` — @Roles('ADMIN', 'SENIOR', 'HR') — **ADMIN only (default-deny)**
- [ ] `hrSummary` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `move` — @Roles('ADMIN', 'SENIOR', 'HR') — **ADMIN only (default-deny)**
- [ ] `remove` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `update` — @Roles('ADMIN', 'SENIOR', 'HR') — **ADMIN only (default-deny)**

#### `apps/api/src/interviews/interviews.service.ts`

- [ ] `accessibleSeniorIds` — admin-cmp; db-role — **ADMIN only (default-deny)**
- [ ] `create` — admin-cmp; role-branch — **ADMIN only (default-deny)**
- [ ] `currentUser` — role-branch — **ADMIN only (default-deny)**
- [ ] `getBoardSeniors` — role-branch — **ADMIN only (default-deny)**
- [ ] `getHrSummary` — admin-cmp — **ADMIN only (default-deny)**
- [ ] `projectScope` — role-branch — **ADMIN only (default-deny)**
- [ ] `remove` — admin-cmp; role-branch — **ADMIN only (default-deny)**

#### `apps/api/src/invoices/invoice-creation.service.ts`

- [ ] `earliestLinkedIncome` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/api/src/invoices/invoice-query.service.ts`

- [ ] `isNotNull` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/api/src/invoices/invoice-view-access.util.ts`

- [ ] `assertCanViewInvoice` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/api/src/invoices/invoices.controller.ts`

- [ ] `detail` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `list` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `sign` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**

#### `apps/api/src/invoices/invoices.service.ts`

- [ ] `getAdminId` — db-role — **ADMIN only (default-deny)**
- [ ] `inArray` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/api/src/job-sourcing/admin/job-source-admin.controller.ts`

- [ ] `addNote` — @Roles('ADMIN') — **ADMIN only**
- [ ] `listExcluded` — @Roles('ADMIN') — **ADMIN only**
- [ ] `listSourceHealth` — @Roles('ADMIN') — **ADMIN only**
- [ ] `resetFailures` — @Roles('ADMIN') — **ADMIN only**
- [ ] `setEnabled` — @Roles('ADMIN') — **ADMIN only**
- [ ] `sourceDetail` — @Roles('ADMIN') — **ADMIN only**

#### `apps/api/src/job-sourcing/admin/job-source-admin.service.ts`

- [ ] `assertAdmin` — admin-cmp — **ADMIN only**

#### `apps/api/src/job-sourcing/dirty-producers.ts`

- [ ] `reason` — role-branch — **ADMIN only (default-deny)**

#### `apps/api/src/job-sourcing/funnel/evaluate.ts`

- [ ] `projectionsForViewer` — admin-cmp; role-branch — **ADMIN only (default-deny)**

#### `apps/api/src/job-sourcing/health/active-admins.ts`

- [ ] `activeAdminIds` — db-role — **ADMIN only (default-deny)**

#### `apps/api/src/job-sourcing/job-sourcing.controller.ts`

- [ ] `collect` — @Roles('ADMIN') — **ADMIN only (default-deny)**
- [ ] `createExclusion` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `deleteExclusion` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `listExclusions` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `listSources` — @Roles('ADMIN') — **ADMIN only (default-deny)**
- [ ] `listSuggestions` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `openOpportunity` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `updateStatus` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**

#### `apps/api/src/job-sourcing/job-sourcing.service.ts`

- [ ] `assertCanManageGlobal` — admin-cmp — **ADMIN only (default-deny)**
- [ ] `assertCanManageSources` — admin-cmp — **ADMIN only (default-deny)**
- [ ] `assertNotSenior` — role-branch — **ADMIN only (default-deny)**
- [ ] `findEligibleSeniorIds` — db-role — **ADMIN only (default-deny)**
- [ ] `notFound` — admin-cmp; role-branch — **ADMIN only (default-deny)**
- [ ] `user` — admin-cmp; db-role; role-branch — **ADMIN only (default-deny)**

#### `apps/api/src/job-sourcing/queue/job-queue.controller.ts`

- [ ] `cancel` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `card` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `createManualCard` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `dismiss` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `grantTeamTriage` — @Roles('ADMIN') — **ADMIN only (default-deny)**
- [ ] `list` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `opened` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `parseManual` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `pickManual` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `recompute` — @Roles('ADMIN') — **ADMIN only (default-deny)**
- [ ] `revokeTeamTriage` — @Roles('ADMIN') — **ADMIN only (default-deny)**
- [ ] `seniorOptions` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `seniors` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `sources` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `submit` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `subscribeTeamTriage` — @Roles('ADMIN') — **ADMIN only (default-deny)**
- [ ] `suppress` — @Roles('ADMIN') — **ADMIN only (default-deny)**
- [ ] `undo` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `unsubscribeTeamTriage` — @Roles('ADMIN') — **ADMIN only (default-deny)**

#### `apps/api/src/job-sourcing/queue/job-queue.service.ts`

- [ ] `query` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/api/src/job-sourcing/queue/queue-actions.service.ts`

- [ ] `VALUES` — role-branch — **ADMIN only (default-deny)**
- [ ] `lockActor` — admin-cmp — **ADMIN only (default-deny)**
- [ ] `scopeTeamId` — role-branch — **ADMIN only (default-deny)**

#### `apps/api/src/job-sourcing/queue/queue-recompute.service.ts`

- [ ] `enqueue` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/api/src/job-sourcing/queue/queue-scope.service.ts`

- [ ] `db` — admin-cmp; role-branch — **ADMIN only (default-deny)**

#### `apps/api/src/job-sourcing/queue/queue-scope.ts`

- [ ] `JOB_QUEUE_ROLES` — role-branch — **ADMIN only (default-deny)**
- [ ] `isJobQueueRole` — role-branch — **ADMIN only (default-deny)**
- [ ] `visibleOpportunityPredicate` — db-role — **ADMIN only (default-deny)**

#### `apps/api/src/job-sourcing/queue/senior-eligibility.ts`

- [ ] `refuse` — db-role — **ADMIN only (default-deny)**

#### `apps/api/src/job-sourcing/runtime/recompute-inputs.ts`

- [ ] `loadRoster` — db-role — **ADMIN only (default-deny)**

#### `apps/api/src/job-sourcing/store/canonical.store.ts`

- [ ] `asAdminActor` — admin-cmp — **ADMIN only (default-deny)**
- [ ] `assertAdmin` — db-role — **ADMIN only (default-deny)**

#### `apps/api/src/legends/legends.controller.ts`

- [ ] `addEntry` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `getLegend` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `upsertLegend` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**

#### `apps/api/src/legends/legends.service.ts`

- [ ] `canAccess` — admin-cmp; role-branch — **ADMIN only (default-deny)**
- [ ] `canReceiveDefaults` — admin-cmp — **ADMIN only (default-deny)**
- [ ] `loadProject` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/api/src/notifications/notifications.controller.ts`

- [ ] `delete` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `getPreferences` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `list` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `markAllRead` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `markRead` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `updatePreferences` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**

#### `apps/api/src/onboarding/onboarding.controller.ts`

- [ ] `status` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**

#### `apps/api/src/onboarding/onboarding.service.ts`

- [ ] `getStatus` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/api/src/pending/pending.controller.ts`

- [ ] `getPending` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/pending/pending.service.ts`

- [ ] `proposedByMe` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/projects/project-access.service.ts`

- [ ] `assertAccess` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `user` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/projects/project-archive.service.ts`

- [ ] `archive` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `eq` — db-role — **ADMIN or MANAGER-in-scope**
- [ ] `getArchiveImpact` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `unarchive` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/projects/project-interview-seed.service.ts`

- [ ] `u` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/projects/project-map.util.ts`

- [ ] `(module scope)` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `isJuniorMember` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `pendingApproverIdsByProjectId` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/projects/project-members.service.ts`

- [ ] `addMember` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `isNull` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `removeMember` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/projects/project-members.util.ts`

- [ ] `assertCanAddMember` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `assertCanRemoveMember` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `assertNoActiveJunior` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/projects/project-read.service.ts`

- [ ] `project` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/projects/project-scoped-read.service.ts`

- [ ] `eq` — db-role — **ADMIN or MANAGER-in-scope**
- [ ] `findDropOwnProjects` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `project` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/projects/project-share-change.service.ts`

- [ ] `cancelSeniorShareChange` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/projects/project-team.util.ts`

- [ ] `accountants` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `drop` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `hrs` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `teamRows` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/projects/project-update-data.util.ts`

- [ ] `db` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `role` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/projects/project-visibility.util.ts`

- [ ] `canSeePendingSeniorShare` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/projects/projects.controller.ts`

- [ ] `addMember` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `approveDraft` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `approveSeniorShareChange` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `archive` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `archiveImpact` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `auditLog` — @Roles('ADMIN'); admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `cancelSeniorShareChange` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `create` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `findAll` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `findDropOwnProjects` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `findOne` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `getHrContact` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `rejectDraft` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `rejectSeniorShareChange` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `removeMember` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `unarchive` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `update` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/projects/projects.service.ts`

- [ ] `assertFinanceFieldsAllowed` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `eq` — db-role — **ADMIN or MANAGER-in-scope**
- [ ] `findAll` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `isNull` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `project` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/resumes/resume-access.ts`

- [ ] `(module scope)` — role-branch — **ADMIN only (default-deny)**
- [ ] `mode` — role-branch — **ADMIN only (default-deny)**

#### `apps/api/src/resumes/resumes.controller.ts`

- [ ] `confirm` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `editStaged` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `get` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `getPdf` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `getSource` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `getStagedPdf` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `ingestText` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `regenerateStaged` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `remove` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `submit` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `update` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `updateFacts` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `updateHeader` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `updateLayout` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `updateTemplate` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `uploadSource` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**

#### `apps/api/src/resumes/resumes.service.ts`

- [ ] `where` — role-branch — **ADMIN only (default-deny)**

#### `apps/api/src/tailored-resumes/tailored-resumes.controller.ts`

- [ ] `detail` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `edit` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `generate` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `list` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `pdf` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**

#### `apps/api/src/teams/team-access.util.ts`

- [ ] `allProjects` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `isHrOfTeam` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/teams/team-archive.util.ts`

- [ ] `and` — db-role; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `archiveTeam` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `currentUser` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `eq` — db-role; role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/teams/team-mapping.util.ts`

- [ ] `currentUser` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `filteredJuniorMembers` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `juniorMembers` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `mapDropTeam` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/teams/team-membership.util.ts`

- [ ] `currentUser` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/teams/team-notifications.util.ts`

- [ ] `title` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/teams/teams.controller.ts`

- [ ] `addMember` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `archive` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `archiveImpact` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `auditLog` — @Roles('ADMIN'); admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `create` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `findAll` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `findOne` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `removeMember` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `rotateSenior` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `unarchive` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `update` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/teams/teams.service.ts`

- [ ] `and` — db-role — **ADMIN or MANAGER-in-scope**
- [ ] `currentUser` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `findAll` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/telemetry/telemetry.controller.ts`

- [ ] `reportError` — no-roles (guard no-op: service must check) — **ADMIN only**
- [ ] `reportEvents` — no-roles (guard no-op: service must check) — **ADMIN only**

#### `apps/api/src/test/create-user-harness.ts`

- [ ] `baseInput` — role-branch — **ADMIN only (default-deny)**

#### `apps/api/src/tos/tos.controller.ts`

- [ ] `accept` — no-roles (guard no-op: service must check) — **ADMIN only**
- [ ] `current` — no-roles (guard no-op: service must check) — **ADMIN only**
- [ ] `list` — @Roles('ADMIN') — **ADMIN only**
- [ ] `previewPdf` — @Roles('ADMIN') — **ADMIN only**
- [ ] `publish` — @Roles('ADMIN') — **ADMIN only**

#### `apps/api/src/users/admin-user-update.service.ts`

- [ ] `assertAssignableRoleOnChange` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `assertSeniorOnlyRoles` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `assertSeniorRoleFloor` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/users/drop-creation.service.ts`

- [ ] `actor` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/users/profile-view.util.ts`

- [ ] `filteredUser` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/users/rejoin-team.service.ts`

- [ ] `rejoinTeam` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/users/role-guards.util.ts`

- [ ] `assertAssignableRole` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `assertSeniorOnlyRoles` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `assertSeniorRoleFloor` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `currentRole` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `requestedRole` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `target` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/users/salary.service.ts`

- [ ] `set` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/users/senior-availability.controller.ts`

- [ ] `get` — @Roles('ADMIN', 'SENIOR') — **ADMIN or MANAGER-in-scope**
- [ ] `set` — @Roles('ADMIN', 'SENIOR') — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/users/senior-availability.service.ts`

- [ ] `authorize` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/users/senior-share-change.service.ts`

- [ ] `cancelSeniorShareChange` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/users/team-members-preview.service.ts`

- [ ] `eq` — db-role — **ADMIN or MANAGER-in-scope**
- [ ] `isNull` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `ne` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `rows` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `seniorIds` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/users/team-reconcile.service.ts`

- [ ] `activeMembers` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/users/user-archive.service.ts`

- [ ] `actor` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `archive` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `getArchiveImpact` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `ne` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `unarchivePairTx` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/users/user-creation.service.ts`

- [ ] `assertSeniorOnlyRoles` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `assertTeamStaff` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `createUser` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `enrolledHrIds` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `locale` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `memberIds` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/users/user-profile.service.ts`

- [ ] `data` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/users/user-update.util.ts`

- [ ] `set` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/users/user-write.util.ts`

- [ ] `predicates` — db-role; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `set` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/users/users-access.service.ts`

- [ ] `(module scope)` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `fields` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `getViewPermissions` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `isHrInTargetTeam` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `isNull` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/users/users-list.util.ts`

- [ ] `withActiveProjectFlag` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/users/users.controller.ts`

- [ ] `approveSeniorShareChange` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `archiveDrop` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `archiveImpact` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `archiveUser` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `cancelSeniorShareChange` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `changePersonalEmail` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `changeRequisites` — @Roles('ADMIN'); admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `changeRole` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `changeSalary` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `createDrop` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `createSeniorAsHr` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `createUser` — @Roles('ADMIN', 'HR'); admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `findAll` — admin-cmp; no-roles (guard no-op: service must check); role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `getAuditLog` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `getMe` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `getProfile` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `getSalaryMeta` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `getUserTeam` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `getUserTransactions` — @Roles('ADMIN', 'ACCOUNTANT'); admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `rejectSeniorShareChange` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `rejoinTeam` — no-roles (guard no-op: service must check); role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `resendPersonalEmailInvite` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `setNote` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `unarchiveUser` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**
- [ ] `updateMe` — no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `updateMeRequisites` — admin-cmp; no-roles (guard no-op: service must check) — **ADMIN or MANAGER-in-scope**
- [ ] `updateUser` — @Roles('ADMIN') — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/users/users.service.ts`

- [ ] `assertAdminTargetEditableForRoleChange` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `findAll` — db-role — **ADMIN or MANAGER-in-scope**
- [ ] `rolesGuarded` — db-role — **ADMIN or MANAGER-in-scope**

#### `apps/api/src/vacancies/applications.service.ts`

- [ ] `actor` — admin-cmp — **ADMIN only (default-deny)**
- [ ] `assertAdminOrHr` — admin-cmp — **ADMIN only (default-deny)**
- [ ] `notifyAdminsAndHr` — db-role; role-branch — **ADMIN only (default-deny)**

#### `apps/api/src/vacancies/vacancies.controller.ts`

- [ ] `create` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `getResumePreviewUrl` — no-roles (guard no-op: service must check) — **ADMIN only (default-deny)**
- [ ] `getResumeUrl` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `list` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `listApplications` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `remove` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `removeApplication` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `update` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**
- [ ] `updateApplication` — @Roles('ADMIN', 'HR') — **ADMIN only (default-deny)**

#### `apps/api/src/vacancies/vacancies.service.ts`

- [ ] `assertAdminOrHr` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/api/src/zod-exception.filter.ts`

- [ ] `FINANCE_CRITICAL_PREFIXES` — admin-cmp — **ADMIN only**

#### `apps/web/app/components/archive/UserArchiveImpact.tsx`

- [ ] `renderBody` — role-branch — **ADMIN only (default-deny)**
- [ ] `value` — role-branch — **ADMIN only (default-deny)**

#### `apps/web/app/components/crm/nav-sidebar.tsx`

- [ ] `NavSidebar` — role-branch — **ADMIN only (default-deny)**
- [ ] `className` — role-branch — **ADMIN only (default-deny)**

#### `apps/web/app/components/documents/document-card.tsx`

- [ ] `DocumentCard` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/web/app/components/documents/document-detail-dialog.tsx`

- [ ] `DocumentDetailDialog` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/web/app/components/documents/document-row.tsx`

- [ ] `DocumentRow` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/web/app/components/job-queue/DismissMenu.tsx`

- [ ] `onClose` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/web/app/components/job-queue/ExternalSubmissionDialog.tsx`

- [ ] `activeSeniors` — role-branch — **ADMIN only (default-deny)**

#### `apps/web/app/components/job-queue/JobQueueActions.tsx`

- [ ] `Boolean` — admin-cmp — **ADMIN only (default-deny)**
- [ ] `onRefused` — role-branch — **ADMIN only (default-deny)**

#### `apps/web/app/components/job-queue/JobQueueCard.tsx`

- [ ] `onClose` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/web/app/components/job-queue/JobQueueRow.tsx`

- [ ] `className` — admin-cmp — **ADMIN only (default-deny)**
- [ ] `onOpen` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/web/app/components/job-queue/MatchedSeniors.tsx`

- [ ] `onAccessLost` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/web/app/components/projects/ProjectRow.tsx`

- [ ] `ProjectRow` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `title` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/ui/role-select.tsx`

- [ ] `ALL_ROLES` — role-branch — **ADMIN only (default-deny)**

#### `apps/web/app/components/ui/share-slider.tsx`

- [ ] `ShareSlider` — db-role — **ADMIN only (default-deny)**

#### `apps/web/app/components/user-profile/UserProfileShell.tsx`

- [ ] `avatarUrl` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `canEdit` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `setDirtyGuardOpen` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `tabLabel` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/user-profile/admin-actions/AdminActionsMenu.tsx`

- [ ] `close` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/user-profile/self-edit/ProfileEditFields.tsx`

- [ ] `scheduleSave` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/user-profile/self-edit/RequisitesEditForm.tsx`

- [ ] `RequisitesEditForm` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/user-profile/tabs/FinanceTab.tsx`

- [ ] `EARNED_TARGET_ROLES` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `FinanceTab` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/user-profile/tabs/NotificationSettingsTab.tsx`

- [ ] `ErrorState` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/user-profile/tabs/OverviewTab.tsx`

- [ ] `className` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `kpiCards` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `onClick` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `pendingPercent` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/user-profile/tabs/ProjectsTab.tsx`

- [ ] `queryFn` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/users/ArchiveUserConfirmDialog.tsx`

- [ ] `onSuccess` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/users/ProfileNameLink.tsx`

- [ ] `ProfileNameLink` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/users/RejoinTeamDialog.tsx`

- [ ] `onValueChange` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `queryFn` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/users/UnarchiveButton.tsx`

- [ ] `UnarchiveButton` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/users/UserDialog.tsx`

- [ ] `UserDialog` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `onSubmit` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/users/UserRow.tsx`

- [ ] `UserRow` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `onClick` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/users/constants.ts`

- [ ] `CREATE_ALLOWED_ROLES` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `ROLES` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/users/user-dialog/ContractDataSection.tsx`

- [ ] `ContractDataSection` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `onSubmit` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/users/user-dialog/FinanceSection.tsx`

- [ ] `FinanceSection` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `approverName` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/users/user-dialog/PaymentRequisitesSection.tsx`

- [ ] `PaymentRequisitesSection` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/users/user-dialog/TeamSection.tsx`

- [ ] `TeamSection` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `onBlur` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `onValueChange` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/users/user-dialog/TechStackSection.tsx`

- [ ] `TechStackSection` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/users/user-dialog/payloads.ts`

- [ ] `String` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `emptyStack` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `payload` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `paymentMethod` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `paymentMethodUpdate` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `value` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/users/user-dialog/useTeamSelection.ts`

- [ ] `setSelectedHrIds` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/users/user-dialog/useUserDialogData.ts`

- [ ] `queryFn` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/users/user-dialog/useUserDialogMutations.ts`

- [ ] `setCurrentStep` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/components/users/user-dialog/validation.ts`

- [ ] `defaultPaymentMethod` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `seniorRolesError` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/context/onboarding.tsx`

- [ ] `useOnboardingGate` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/hooks/use-role-guard.ts`

- [ ] `useRoleGuard` — role-branch — **ADMIN only (default-deny)**

#### `apps/web/app/lib/route-access.ts`

- [ ] `(module scope)` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `ROUTE_ACCESS` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `isRouteAllowed` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `resolveRoleHome` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/admin/contracts.index.tsx`

- [ ] `ALL_ROLES` — role-branch — **ADMIN only**

#### `apps/web/app/routes/_authenticated/admin/login-as.tsx`

- [ ] `LoginAsPage` — admin-cmp — **ADMIN only**
- [ ] `fetchNonAdminUsers` — admin-cmp — **ADMIN only**

#### `apps/web/app/routes/_authenticated/admin/route.tsx`

- [ ] `ADMIN_TABS` — admin-cmp — **ADMIN only**

#### `apps/web/app/routes/_authenticated/documents.tsx`

- [ ] `DocumentsPageContent` — admin-cmp — **ADMIN only (default-deny)**
- [ ] `useRoleGuard` — role-branch — **ADMIN only (default-deny)**

#### `apps/web/app/routes/_authenticated/documents/constants.ts`

- [ ] `canSeeOwnerFilter` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/web/app/routes/_authenticated/finance/components/TransactionRow.tsx`

- [ ] `TransactionRow` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/finance/components/dialogs/CompanySharePayoutModal.tsx`

- [ ] `validatedTxs` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/finance/components/dialogs/CreateTransactionDialog.tsx`

- [ ] `formatNumber` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `queryFn` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/finance/components/dialogs/FundingSourceFields.tsx`

- [ ] `queryFn` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/finance/components/dialogs/PayoutDetailDialog.tsx`

- [ ] `onClose` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/finance/components/dialogs/TransactionDetailDialog.tsx`

- [ ] `queryFn` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/finance/components/receipt-permissions.ts`

- [ ] `tx` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/finance/index.tsx`

- [ ] `FinancePage` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/index.tsx`

- [ ] `CrmDashboard` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/interviews/components/CreateProjectFromHiredDialog.tsx`

- [ ] `onRemove` — role-branch — **ADMIN only (default-deny)**
- [ ] `roles` — role-branch — **ADMIN only (default-deny)**

#### `apps/web/app/routes/_authenticated/interviews/components/RecordingDetailDialog.tsx`

- [ ] `key` — admin-cmp — **ADMIN only (default-deny)**

#### `apps/web/app/routes/_authenticated/interviews/index.tsx`

- [ ] `useRoleGuard` — admin-cmp; role-branch — **ADMIN only (default-deny)**

#### `apps/web/app/routes/_authenticated/interviews/unmatched.tsx`

- [ ] `UnmatchedInterviewRecordingsPage` — role-branch — **ADMIN only (default-deny)**

#### `apps/web/app/routes/_authenticated/job-queue/index.tsx`

- [ ] `JobQueuePage` — admin-cmp; role-branch — **ADMIN only (default-deny)**
- [ ] `notice` — admin-cmp — **ADMIN only (default-deny)**
- [ ] `prefill` — role-branch — **ADMIN only (default-deny)**
- [ ] `returnToTop` — admin-cmp — **ADMIN only (default-deny)**
- [ ] `sort` — admin-cmp — **ADMIN only (default-deny)**
- [ ] `submissionTeams` — role-branch — **ADMIN only (default-deny)**

#### `apps/web/app/routes/_authenticated/legend.tsx`

- [ ] `LegendPage` — role-branch — **ADMIN only (default-deny)**

#### `apps/web/app/routes/_authenticated/profile/$userId.tsx`

- [ ] `UserDetailPage` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/project.tsx`

- [ ] `JuniorProjectHub` — role-branch — **ADMIN only (default-deny)**

#### `apps/web/app/routes/_authenticated/projects/$projectId.tsx`

- [ ] `ProjectDetailPage` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `availableToAdd` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `queryFn` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/projects/ProjectEditFields.tsx`

- [ ] `RBAC` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `approverName` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/projects/ProjectHero.tsx`

- [ ] `fallback` — admin-cmp — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/projects/ProjectOverviewTab.tsx`

- [ ] `ProjectOverviewTab` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `RBAC` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `label` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/projects/ProjectTeamCards.tsx`

- [ ] `className` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `disabled` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `project` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `variant` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/projects/ProjectTransactions.tsx`

- [ ] `project` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `queryFn` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/projects/index.tsx`

- [ ] `ProjectsPage` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `list` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `onChange` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `queryFn` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/projects/use-project-permissions.ts`

- [ ] `project` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/stats.tsx`

- [ ] `StatsPage` — admin-cmp — **MANAGER-specific**

#### `apps/web/app/routes/_authenticated/team/$teamId.tsx`

- [ ] `TeamDetailPage` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `candidateUsers` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `onError` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `onRemove` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `queryFn` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/team/index.tsx`

- [ ] `TeamPage` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `queryFn` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `result` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `variants` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/team/team-detail/components/ActiveProjectsCard.tsx`

- [ ] `members` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/team/team-detail/components/MembersCard.tsx`

- [ ] `href` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `onRemove` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `variant` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/team/team-detail/components/TeamDetailHeader.tsx`

- [ ] `onArchive` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `onClick` — admin-cmp — **ADMIN or MANAGER-in-scope**
- [ ] `viewerRole` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/team/team-detail/components/TeamNotFound.tsx`

- [ ] `TeamNotFound` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/team/team-list/components/HrCreateSeniorDialog.tsx`

- [ ] `onClose` — role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/users/index.tsx`

- [ ] `useRoleGuard` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**

#### `apps/web/app/routes/_authenticated/vacancies/$vacancyId.tsx`

- [ ] `VacancyDetailPage` — role-branch — **ADMIN only (default-deny)**

#### `apps/web/app/routes/_authenticated/vacancies/index.tsx`

- [ ] `VacanciesListPage` — role-branch — **ADMIN only (default-deny)**

#### `packages/shared/src/schemas/auth.ts`

- [ ] `(module scope)` — role-branch — **ADMIN only (default-deny)**

#### `packages/shared/src/schemas/contracts.ts`

- [ ] `(module scope)` — role-branch — **ADMIN only (default-deny)**

#### `packages/shared/src/schemas/finance/income.ts`

- [ ] `mandatoryReceiptRefine` — role-branch — **ADMIN or MANAGER-in-scope**

#### `packages/shared/src/schemas/finance/payout.ts`

- [ ] `(module scope)` — role-branch — **ADMIN or MANAGER-in-scope**

#### `packages/shared/src/schemas/projects.ts`

- [ ] `(module scope)` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `IT_DOMAINS` — role-branch — **ADMIN or MANAGER-in-scope**

#### `packages/shared/src/schemas/teams.ts`

- [ ] `(module scope)` — role-branch — **ADMIN or MANAGER-in-scope**

#### `packages/shared/src/schemas/users.ts`

- [ ] `(module scope)` — role-branch — **ADMIN or MANAGER-in-scope**
- [ ] `refineRequisitePresence` — admin-cmp; role-branch — **ADMIN or MANAGER-in-scope**

#### `packages/shared/src/types/roles.ts`

- [ ] `ROLES` — role-branch — **ADMIN only (default-deny)**

## Appendix — generator

Run from the repo root: `python3 -I gen.py > inventory.md` after saving the block below as `gen.py` outside the repo.

```python
#!/usr/bin/env python3
"""RBAC audit inventory for the MANAGER role (design §5).

Lists, in non-test source, grouped by file and enclosing symbol:
  - every `=== 'ADMIN'` / `!== 'ADMIN'` comparison                       (kind: admin-cmp)
  - every `@Roles(...)`, multi-line and spread included                    (kind: roles)
  - every controller handler with no method- or class-level `@Roles`      (kind: no-roles)
  - every other role branch: a role literal compared or listed next to
    `role`, `.includes(...role)`, `switch (...role)`                       (kind: role-branch)
  - every Drizzle / SQL predicate on a role column                         (kind: db-role)
with a proposed class: ADMIN only | ADMIN or MANAGER-in-scope | MANAGER-specific.
Run from the repo root: python3 -I <this file>   (prints Markdown to stdout)
"""
import os
import re
import sys

ROOTS = ['apps/api/src', 'apps/web/app', 'packages/shared/src']
TEST = re.compile(r'\.(spec|test)\.tsx?$|/__test-helpers__/|/__tests__/|/testing/|/seed')
LIT = r"""['"](ADMIN|SENIOR|JUNIOR|HR|ACCOUNTANT|DROP)['"]"""
ADMIN_CMP = re.compile(r"""(===|!==)\s*['"]ADMIN['"]|['"]ADMIN['"]\s*(===|!==)""")
ROLE_BRANCH = re.compile(
    r"(\brole\b|Role\b)[^\n]*(===|!==)\s*" + LIT + r"|" + LIT + r"\s*(===|!==)[^\n]*\brole\b"
    r"|\.includes\([\w.?]*role\)|switch\s*\([\w.?]*role\)|\[\s*" + LIT + r"(\s*,\s*" + LIT + r")*\s*\]"
)
DB_ROLE = re.compile(r"(eq|ne|inArray|notInArray)\(\s*[\w.]*\.role\b|\brole\s*(=|<>|IN)\s*'?\(?'?(ADMIN|SENIOR|JUNIOR|HR|ACCOUNTANT|DROP)|\$\{[\w.]*\.role\}\s*(=|<>|IN)")
HTTP = re.compile(r'^\s*@(Get|Post|Put|Patch|Delete)\(')
SYMBOL = re.compile(
    r'^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:readonly\s+)?'
    r'(?:async\s+)?(?:function\s+)?(?:const\s+|let\s+)?([A-Za-z_$][\w$]*)\s*(?:[=:]\s*(?:async\s*)?\(|\(|<|=\s*(?:async\s+)?function|\s*=\s*\{|\s*=\s*\[|:\s*[A-Z])'
)
SKIP = {'if', 'for', 'while', 'switch', 'return', 'catch', 'await', 'map', 'filter', 'some', 'every',
        'useMemo', 'useCallback', 'useEffect', 'useQuery', 'useMutation', 'super', 'expect', 'z'}

A, S, M = 'ADMIN only', 'ADMIN or MANAGER-in-scope', 'MANAGER-specific'
# Symbol overrides first (design §5 table rows that cut across a module), then path rules.
SYMBOL_RULES = [
    (r'(?i)dividend|companyAccount|company_account|deposit|onchain|adminSummary|managerShare|setManager|grantAdmin', A),
    (r'(?i)holding|partner|getTotalEarned|legacyBalance|summaryDebt', M),
]
PATH_RULES = [
    (r'finance/(company-account|dividend|onchain|edit-cascade)', A),
    (r'admin-summary|(^|/)admin/', A),
    (r'finance/(summary|balance|stats)|routes/_authenticated/stats|components/.*stats', M),
    (r'/tos/|auth/|job-sourcing/admin|contract-templates|meeting-recorder\.controller|/database/|telemetry|zod-exception|/config/', A),
    (r'finance/|/salary|/payout|/pending|approvals/|drop-creation|users/|projects/|teams/|credentials/|'
     r'routes/_authenticated/(finance|team|projects|routing|index|profile|users)|components/(finance|team|projects|users|user-profile|layout|nav)|'
     r'schemas/(users|finance|projects|teams)|lib/route-access|context/', S),
]
# Everything else (interviews, vacancies, job sourcing, documents, contracts, invoices, legends,
# onboarding, integrations) is ADMIN only by default-deny: the design grants MANAGER none of it.
DEFAULT_DENY = A + ' (default-deny)'


def classify(path, sym):
    for pat, cls in SYMBOL_RULES:
        if re.search(pat, sym):
            return cls
    for pat, cls in PATH_RULES:
        if re.search(pat, path):
            return cls
    return DEFAULT_DENY


def symbol_before(lines, idx):
    for j in range(idx, max(-1, idx - 150), -1):
        m = SYMBOL.match(lines[j])
        if m and m.group(1) not in SKIP:
            return m.group(1)
    return '(module scope)'


def handler_after(lines, idx):
    for j in range(idx + 1, min(len(lines), idx + 25)):
        s = lines[j].strip()
        if s.startswith('@') or not s:
            continue
        m = re.match(r'(?:public\s+|private\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(', s)
        if m:
            return m.group(1)
    return '(unresolved handler)'


def roles_call(lines, i):
    text, j = lines[i][lines[i].index('@Roles('):], i
    while text.count('(') > text.count(')') and j + 1 < len(lines):
        j += 1
        text += ' ' + lines[j].strip()
    inner = text[len('@Roles('):]
    depth, out = 1, ''
    for ch in inner:
        depth += ch == '('
        depth -= ch == ')'
        if depth == 0:
            break
        out += ch
    return re.sub(r'\s+', ' ', out).strip() or '(empty)', j


def scan(path, rows, raw):
    lines = open(path, encoding='utf-8').read().split('\n')
    is_ctrl = path.endswith('.controller.ts')
    class_roles = False
    in_block = False
    for i, line in enumerate(lines):
        s = line.strip()
        if in_block:
            in_block = '*/' not in s
            continue
        if s.startswith('/*'):
            in_block = '*/' not in s
            continue
        if s.startswith('*') or s.startswith('//') or s.startswith('--'):
            continue
        code = re.sub(r'\s//.*$', '', line)
        if ADMIN_CMP.search(code):
            raw['admin-cmp'] += len(ADMIN_CMP.findall(code))
            rows.setdefault((path, symbol_before(lines, i)), set()).add('admin-cmp')
        elif ROLE_BRANCH.search(code):
            raw['role-branch'] += 1
            rows.setdefault((path, symbol_before(lines, i)), set()).add('role-branch')
        if DB_ROLE.search(code):
            raw['db-role'] += 1
            rows.setdefault((path, symbol_before(lines, i)), set()).add('db-role')
        if '@Roles(' in code:
            raw['roles'] += 1
            roles, end = roles_call(lines, i)
            nxt = next((lines[k].strip() for k in range(end + 1, min(len(lines), end + 6)) if lines[k].strip()), '')
            if is_ctrl and re.match(r'(export\s+)?class\s', nxt):
                class_roles = True
                rows.setdefault((path, '(class)'), set()).add(f'@Roles({roles}) on class')
            else:
                rows.setdefault((path, handler_after(lines, end)), set()).add(f'@Roles({roles})')
        if is_ctrl and HTTP.match(line) and not class_roles:
            block, k = [], i
            while k > 0 and (lines[k - 1].strip().startswith('@') or lines[k - 1].strip().startswith(')') or lines[k - 1].strip().startswith("'") or lines[k - 1].strip().endswith(',')):
                k -= 1
                block.append(lines[k])
            k = i
            while k + 1 < len(lines) and not re.match(r'\s*(?:public\s+|private\s+)?(?:async\s+)?[A-Za-z_$][\w$]*\s*\(', lines[k + 1]):
                k += 1
                block.append(lines[k])
            if not any('@Roles(' in b for b in block) and '@Public' not in ' '.join(block):
                raw['no-roles'] += 1
                rows.setdefault((path, handler_after(lines, i)), set()).add('no-roles (guard no-op: service must check)')


def main():
    rows, raw = {}, {'admin-cmp': 0, 'roles': 0, 'no-roles': 0, 'role-branch': 0, 'db-role': 0}
    for root in ROOTS:
        for dp, _, files in os.walk(root):
            for f in files:
                p = os.path.join(dp, f)
                if p.endswith(('.ts', '.tsx')) and not TEST.search(p) and 'routeTree.gen' not in p:
                    scan(p, rows, raw)
    by_file, counts = {}, {}
    for (p, sym), kinds in rows.items():
        by_file.setdefault(p, []).append((sym, sorted(kinds)))
    out = []
    for p in sorted(by_file):
        out.append(f'\n#### `{p}`\n')
        for sym, kinds in sorted(by_file[p]):
            cls = classify(p, sym)
            counts[cls] = counts.get(cls, 0) + 1
            out.append(f'- [ ] `{sym}` — {"; ".join(kinds)} — **{cls}**')
    print(f'Entries (file + symbol): {sum(counts.values())} in {len(by_file)} files.')
    print('Raw occurrences: ' + ', '.join(f'{k} {v}' for k, v in raw.items()) + '.')
    print('Proposed classes: ' + ', '.join(f'{k} {v}' for k, v in sorted(counts.items())) + '.')
    print('\n'.join(out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
```
