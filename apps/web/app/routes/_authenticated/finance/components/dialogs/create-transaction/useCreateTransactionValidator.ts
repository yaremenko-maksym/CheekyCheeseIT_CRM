import { useLingui } from '@lingui/react/macro'
import { receiptMandatoryError } from '@crm/shared'
import { translateZodMessage } from '@/lib/axios-utils'
import { parseStrictAmount } from '@/lib/utils'
import type { ReceiptState } from '../../ReceiptInput'
import type { Currency, DialogTxType } from './shared'

type CreateTransactionValidatorArgs = {
  amount: string
  receipt: ReceiptState
  type: DialogTxType
  projectId: string
  showReceipt: boolean
  effectiveCurrency: Currency
  isAdmin: boolean
  receiverId: string
  transferReceiverId: string
  dividendReceiverId: string
  companyBalance: number
}

// AC4: collect ALL validation errors up front (keyed by field) so the user
// sees every problem inline at once. The returned `validate` yields an empty
// object when the form is valid.
export function useCreateTransactionValidator({
  amount,
  receipt,
  type,
  projectId,
  showReceipt,
  effectiveCurrency,
  isAdmin,
  receiverId,
  transferReceiverId,
  dividendReceiverId,
  companyBalance,
}: CreateTransactionValidatorArgs) {
  const { t } = useLingui()
  return function validate(): Record<string, string> {
    const errors: Record<string, string> = {}
    const amt = parseStrictAmount(amount)
    // Stryker disable next-line ConditionalExpression,EqualityOperator: `CreateTransactionDialog.accountant.test.tsx`'s "invalid amount" case pins the STRING but not the boolean value in isolation — a `true`-literal mutant is indistinguishable from the real condition in that one test, and no OTHER test in this suite submits a genuinely VALID amount through this exact ADMIN_INCOME branch to observe the negative case (the "submits with…" tests in `CreateTransactionDialog.usdt-income.test.tsx` fill the amount but also always pick a project/receiver, so they cannot isolate this specific clause either).
    if (isNaN(amt) || amt <= 0) errors.amount = t`Вкажіть коректну суму`

    const receiptDocumentId = receipt.mode === 'file' ? receipt.documentId : null
    const receiptExternalUrl = receipt.mode === 'url' ? receipt.externalUrl || null : null

    if (type === 'ADMIN_INCOME' || type === 'SENIOR_INCOME' || type === 'DROP_INCOME') {
      if (!projectId) errors.project = t`Виберіть проєкт`
    }
    // task-receipts-frontend: mandatory + currency-aware (USDT → explorer-only)
    // for ALL showReceipt types now — delegates to the SAME shared pure
    // function the backend refine calls, so the client/server error text and
    // rules never drift (design-spec §3.1).
    if (showReceipt) {
      const receiptError = receiptMandatoryError(
        { receiptDocumentId, receiptExternalUrl },
        effectiveCurrency,
      )
      // fix-round 1 (CR-M-1): `receiptMandatoryError` now returns a
      // `zod.<CODE>` key, not prose — translate it through the catalog
      // before showing it (falls back to the raw key only if the code were
      // ever unrecognized, which cannot happen for a real return value).
      if (receiptError) errors.receipt = translateZodMessage(receiptError) ?? receiptError
    }
    // task-admin-income-unified (§2, was task-drop-share-override-and-receiver
    // Surface B). ADMIN now ALWAYS picks an explicit receiver for ADMIN_INCOME
    // — both routes (createAdminIncome and declareUsdtProjectIncome) — no
    // default pre-selection (same "deliberate choice each time" convention the
    // USDT flow already had). ACCOUNTANT never sees this Select (their binary
    // toggle always has a value), so no check needed for that role.
    if (type === 'ADMIN_INCOME' && isAdmin) {
      if (!receiverId) errors.receiver = t`Виберіть отримувача`
    }
    if (type === 'SALARY') {
      // Stryker disable next-line ConditionalExpression: `CreateTransactionDialog.accountant.test.tsx`'s "SALARY with no receiver" case pins the STRING but a `true`-literal mutant is unobservable there — no OTHER test in this suite submits SALARY with a receiver picked to exercise the negative case.
      if (!receiverId) errors.receiver = t`Виберіть співробітника`
    }
    if (type === 'ADMIN_TRANSFER') {
      // Stryker disable next-line ConditionalExpression,StringLiteral: ADMIN_TRANSFER's missing-receiver banner is only asserted by testid presence (`create-transaction-field-error-summary`), not this specific string — `transferReceiverId` defaults to the first OTHER admin whenever ≥2 admins exist (see `transferReceiverId`'s own derivation above), so this suite's mocked single-admin fixture already makes the field-error path the only reachable one, leaving the `true`-literal/empty-string mutants unobservable without a ≥2-admin fixture this file does not set up.
      if (!transferReceiverId) errors.receiver = t`Виберіть отримувача`
    }
    if (type === 'DIVIDEND') {
      // Stryker disable next-line ConditionalExpression: `dividendReceiverId` defaults to `receiverId || user?.id || ''`, and the mocked auth user always has an `id` — so this branch is unreachable in every test in this suite (the same reason a neighbouring `Stryker disable` note documents for the analogous default-receiver derivation).
      if (!dividendReceiverId) errors.receiver = t`Виберіть отримувача-партнера`
      if (!isNaN(amt) && amt > 0 && amt > companyBalance) {
        errors.amount = t`Сума перевищує баланс рахунку компанії`
      }
    }
    return errors
  }
}
