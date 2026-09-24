/**
 * Invoice copy helpers — single source of truth for human-readable type
 * labels in the UI (cards, dialog header, public verify page).
 *
 * UT round 1: user asked to replace «Выплата сеньору» / raw enum values
 * with «Выплата синьора» / «Зарплата» so the wording matches the rest of
 * the CRM (the canonical spelling is «синьор»).
 *
 * task-i18n-stage3a (Task 2), Step 5 (fix-round 1, SPEC-H-1) — Шаблон A
 * (transient dual export, same reasoning as `ROLE_LABEL_MESSAGES` in Task 1
 * / `SORT_OPTION_MESSAGES` above). `getInvoiceTypeLabel` below is imported
 * by `components/invoices/invoice-card.tsx` and
 * `invoice-detail-dialog.tsx` — both `web-finance` (wave d, not started).
 * Changing its RETURN type would break their render (React throws on a
 * `MessageDescriptor` child) for the whole gap until wave d migrates —
 * so it is left UNTOUCHED, byte-for-byte, and `useInvoiceTypeLabel` is a
 * NEW, separate export for consumers inside THIS wave's perimeter. Wave d
 * deletes the legacy export once its two consumers switch to the hook.
 *
 * `INVOICE_TYPE_MESSAGES.SENIOR_INCOME` dedups the WORDING (not the exact
 * sentence) against `ArchivePendingTransactionsList.tsx`'s
 * `TYPE_LABEL_MESSAGES.SENIOR_INCOME` (PR1, merged — COPY-H-core-4): both
 * now say «Дохід сеньйора» (canon spelling per `CONTEXT.md` «Формы uk/en» —
 * NOT «синьйор» — and «дохід»/income, not the legacy «виплата»/payout,
 * which named the wrong side of the transaction). The archive list's own
 * «(неоплачена частка)» qualifier is NOT copied here — it describes ONE
 * specific pending-approval context that does not hold for every invoice
 * this hook's consumers render (a signed, already-settled invoice is not
 * "unpaid").
 */
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { useLingui } from '@lingui/react/macro'
import type { InvoiceListItem } from '@crm/shared'

export type InvoiceTypeForLabel = InvoiceListItem['type']

const INVOICE_TYPE_MESSAGES: Record<InvoiceTypeForLabel, MessageDescriptor> = {
  SENIOR_INCOME: msg`Дохід сеньйора`,
  SALARY: msg`Зарплата`,
}

/**
 * New canon for consumers inside wave (a)+; legacy `getInvoiceTypeLabel`
 * (below, unchanged) keeps serving `components/invoices/**` (wave d) until
 * their migration.
 */
export function useInvoiceTypeLabel(type: InvoiceTypeForLabel): string {
  const { i18n } = useLingui()
  return i18n._(INVOICE_TYPE_MESSAGES[type])
}

export function getInvoiceTypeLabel(type: InvoiceTypeForLabel): string {
  if (type === 'SENIOR_INCOME') return 'Выплата синьора'
  if (type === 'SALARY') return 'Зарплата'
  // Exhaustive switch — TS narrows `type` to `never` here.
  return type
}
