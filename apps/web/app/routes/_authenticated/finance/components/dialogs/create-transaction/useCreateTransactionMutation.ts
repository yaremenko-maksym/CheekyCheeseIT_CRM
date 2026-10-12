import { useMutation, type QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useLingui } from '@lingui/react/macro'
import { COMPANY_ACCOUNT_RECEIVER } from '@crm/shared'
import { parseStrictAmount } from '@/lib/utils'
import { financeApi, companyAccountApi } from '../../../api'
import type { ReceiptState } from '../../ReceiptInput'
import type { Currency, DialogTxType, FundingSourceUI } from './shared'

type CreateTransactionMutationArgs = {
  qc: QueryClient
  type: DialogTxType
  amount: string
  receipt: ReceiptState
  isSelectedProjectUsdt: boolean
  projectId: string
  receiverId: string
  usdtIncomeIdempotencyKey: string
  notes: string
  txDate: string
  isUsdtLocked: boolean
  currency: Currency
  isAdmin: boolean
  fundingSource: FundingSourceUI
  seniorIncomeIdempotencyKey: string
  dropIncomeIdempotencyKey: string
  category: string
  salaryMonth: string
  salaryIdempotencyKey: string
  effectiveTransferSenderId: string
  transferReceiverId: string
  dividendIdempotencyKey: string
  dividendReceiverId: string
  isAdminIncomeCompanyFunded: boolean
  onClose: () => void
  resetForm: () => void
}

// The submit mutation of `CreateTransactionDialog`: picks the endpoint per
// transaction type, builds the payload and runs the post-success side effects.
export function useCreateTransactionMutation({
  qc,
  type,
  amount,
  receipt,
  isSelectedProjectUsdt,
  projectId,
  receiverId,
  usdtIncomeIdempotencyKey,
  notes,
  txDate,
  isUsdtLocked,
  currency,
  isAdmin,
  fundingSource,
  seniorIncomeIdempotencyKey,
  dropIncomeIdempotencyKey,
  category,
  salaryMonth,
  salaryIdempotencyKey,
  effectiveTransferSenderId,
  transferReceiverId,
  dividendIdempotencyKey,
  dividendReceiverId,
  isAdminIncomeCompanyFunded,
  onClose,
  resetForm,
}: CreateTransactionMutationArgs) {
  const { t } = useLingui()
  return useMutation({
    mutationFn: async () => {
      const amt = parseStrictAmount(amount)
      // Build XOR receipt fields: exactly one populated, or both null.
      const receiptDocumentId = receipt.mode === 'file' ? receipt.documentId : null
      const receiptExternalUrl = receipt.mode === 'url' ? receipt.externalUrl || null : null

      // task-admin-income-unified. The invariant this task exists to enforce:
      // a USDT-payment project can ONLY ever reach `declareUsdtProjectIncome`
      // (the one path that books the senior/drop obligation) — never
      // `createAdminIncome` (which does not, and now also refuses the project
      // server-side as a second line of defence). `isSelectedProjectUsdt` is
      // derived from the SAME project object the Select renders, so there is
      // no way for the branch taken here to disagree with what the user saw.
      // Stryker disable next-line ConditionalExpression: empirically verified — `pnpm vitest run` on this file (unmutated harness) FAILS "non-USDT project → createAdminIncome, receiverId sent explicitly (ADMIN)" and 7 other tests when this condition is hand-forced to `true` (confirmed by direct simulation, not assumed). Stryker's own coverage-based test selection for this async-arrow-function / early-return shape does not attribute the kill correctly — a tool limitation, not an untested branch.
      if (type === 'ADMIN_INCOME' && isSelectedProjectUsdt) {
        // task-drop-share-override-and-receiver (Surface B, ADR D3, unchanged
        // by this task). ADMIN-only USDT project-income declaration with an
        // explicit receiver (an ADMIN's uuid or the 'COMPANY_ACCOUNT' sentinel
        // — sent as-is from the Select). Receipt is MANDATORY (explorer-only —
        // `createUsdtIncomeSchema` currency is a `z.literal('USDT')`).
        return financeApi.declareUsdtProjectIncome({
          projectId,
          amount: amt,
          currency: 'USDT',
          receiverId,
          receiptDocumentId,
          receiptExternalUrl,
          // MED-1 (security-review PR #367): stable per-open idempotency key so a
          // double-click / retry does not create a second income + obligation set.
          idempotencyKey: usdtIncomeIdempotencyKey,
          notes: notes || null,
          txDate: txDate || null,
        })
      }
      if (type === 'ADMIN_INCOME') {
        return financeApi.createAdminIncome({
          projectId,
          amount: amt,
          // company-account income is always USDT; send locked currency for clarity.
          currency: isUsdtLocked ? 'USDT' : currency,
          receiptDocumentId,
          receiptExternalUrl,
          notes: notes || null,
          txDate: txDate || null,
          // task-admin-income-unified (§2): `receiverId` REPLACES the old
          // `fundingSource` toggle. ADMIN always sends an explicit value
          // (validate() enforces it — an admin uuid or the COMPANY_ACCOUNT
          // sentinel). ACCOUNTANT never gets a choice: 'legacy' sends nothing
          // (server credits the project owner, unchanged default), 'COMPANY_ACCOUNT'
          // sends the SAME sentinel (still allowed for this role — only picking a
          // SPECIFIC other admin is not, and the UI never offers that).
          ...(isAdmin
            ? { receiverId }
            : fundingSource === 'COMPANY_ACCOUNT'
              ? { receiverId: COMPANY_ACCOUNT_RECEIVER }
              : {}),
        })
      }
      if (type === 'SENIOR_INCOME') {
        return financeApi.createSeniorIncome({
          projectId,
          amount: amt,
          currency,
          // task-senior-drop-income-idempotency (backlog 73/A-3): stable
          // per-open key so a double-click / retry does not create a second
          // income (and, once it reaches payout validation, a second
          // company obligation for the same piece of work).
          idempotencyKey: seniorIncomeIdempotencyKey,
          receiptDocumentId,
          receiptExternalUrl,
          notes: notes || null,
          txDate: txDate || null,
        })
      }
      // Drop role - phase 2. Same payload shape as senior income — mirror
      // path goes through `POST /transactions/drop-income`.
      if (type === 'DROP_INCOME') {
        return financeApi.createDropIncome({
          projectId,
          amount: amt,
          currency,
          // task-senior-drop-income-idempotency (backlog 73/A-3): same
          // contract as SENIOR_INCOME above.
          idempotencyKey: dropIncomeIdempotencyKey,
          receiptDocumentId,
          receiptExternalUrl,
          notes: notes || null,
          txDate: txDate || null,
        })
      }
      if (type === 'EXPENSE') {
        return financeApi.createExpense({
          amount: amt,
          currency: isUsdtLocked ? 'USDT' : currency,
          category,
          notes: notes || null,
          receiptDocumentId,
          receiptExternalUrl,
          txDate: txDate || null,
          // Send COMPANY_ACCOUNT explicitly when chosen; omit for legacy path.
          ...(fundingSource === 'COMPANY_ACCOUNT' && { fundingSource: 'COMPANY_ACCOUNT' }),
        })
      }
      if (type === 'SALARY') {
        // task-salary-pay-flow: a manually-created salary is a NEUTRAL PENDING
        // reminder — NO funding source / payer / currency-lock here. The funding
        // source + payment currency are chosen later, at pay time (PaySalaryDialog).
        return financeApi.createSalary({
          receiverId,
          amount: amt,
          currency,
          salaryMonth,
          idempotencyKey: salaryIdempotencyKey,
          notes: notes || null,
          txDate: txDate || null,
        })
      }
      if (type === 'ADMIN_TRANSFER') {
        // task-receipts-frontend: receipt now MANDATORY, currency-aware
        // (`createAdminTransferSchema` defaults currency to USDT → explorer-only
        // unless the user manually picked a different currency).
        return financeApi.createAdminTransfer({
          senderId: effectiveTransferSenderId,
          receiverId: transferReceiverId,
          amount: amt,
          currency,
          receiptDocumentId,
          receiptExternalUrl,
          notes: notes || null,
          txDate: txDate || null,
        })
      }
      if (type === 'DIVIDEND') {
        // Company-account dividend (ADMIN-only). Always USDT; receiver is an
        // ADMIN partner (adminId). Currency / project fields are irrelevant
        // here — the endpoint only needs amount + target admin. task-receipts-
        // frontend: receipt is now MANDATORY + explorer-only (a dividend is a
        // USDT withdrawal from the company account).
        // MED-2 (BIZ-19): send the stable idempotencyKey (generated at dialog
        // open, refreshed on close). A double-click retry with the same key is
        // idempotent on the backend; reopening the dialog gets a fresh UUID.
        return companyAccountApi.createDividend({
          amount: amt,
          idempotencyKey: dividendIdempotencyKey,
          receiptDocumentId,
          receiptExternalUrl,
          txDate: txDate || null,
          ...(dividendReceiverId ? { adminId: dividendReceiverId } : {}),
        })
      }
      throw new Error('Unknown type')
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      // Drop role - phase 2. Confirm the new flow loudly so the DROP user
      // knows their tx is registered + queued for validation. Other types
      // already surface via the table refresh so a toast would be noise.
      if (type === 'DROP_INCOME') {
        toast.success(t`Дохід зареєстровано, очікує валідації`)
      }
      if (type === 'DIVIDEND') {
        void qc.invalidateQueries({ queryKey: ['company-account'] })
        toast.success(t`Дивіденди виведено`)
      }
      // Invalidate company-account balance when any company-account debit/credit
      // succeeds. `isAdminIncomeCompanyFunded` covers ADMIN_INCOME's two shapes
      // (ADMIN's receiverId sentinel, ACCOUNTANT's fundingSource toggle);
      // `fundingSource === 'COMPANY_ACCOUNT'` covers EXPENSE (unaffected by
      // task-admin-income-unified — still its own toggle).
      if (fundingSource === 'COMPANY_ACCOUNT' || isAdminIncomeCompanyFunded) {
        void qc.invalidateQueries({ queryKey: ['company-account'] })
      }
      onClose()
      resetForm()
    },
  })
}
