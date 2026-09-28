/**
 * Invoice copy helpers — single source of truth for human-readable type
 * labels in the UI (cards, dialog header, public verify page).
 *
 * task-i18n-stage3a (Task 2), Step 5 (fix-round 1, SPEC-H-1) introduced
 * `useInvoiceTypeLabel` as a NEW, catalog-backed export while the legacy
 * `getInvoiceTypeLabel` (Russian, byte-for-byte string return) kept serving
 * its last two consumers — `components/invoices/invoice-card.tsx` and
 * `invoice-detail-dialog.tsx` — until their own wave migrated. task-i18n-
 * stage3d-pr4 is that wave: both consumers now call this hook and the
 * legacy export is deleted (`git grep -n getInvoiceTypeLabel` returns only
 * this file's own history in comments).
 *
 * `INVOICE_TYPE_MESSAGES.SENIOR_INCOME` dedups the WORDING (not the exact
 * sentence) against `ArchivePendingTransactionsList.tsx`'s
 * `TYPE_LABEL_MESSAGES.SENIOR_INCOME` (PR1, merged — COPY-H-core-4): both
 * say «Дохід сеньйора» (canon spelling per `CONTEXT.md` «Формы uk/en» —
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

export function useInvoiceTypeLabel(type: InvoiceTypeForLabel): string {
  const { i18n } = useLingui()
  return i18n._(INVOICE_TYPE_MESSAGES[type])
}
