/**
 * Invoice copy helpers — single source of truth for human-readable type
 * labels in the UI (cards, dialog header, public verify page).
 *
 * UT round 1: user asked to replace «Выплата сеньору» / raw enum values
 * with «Выплата синьора» / «Зарплата» so the wording matches the rest of
 * the CRM (the canonical spelling is «синьор»).
 */
import type { InvoiceListItem } from '@crm/shared'

export type InvoiceTypeForLabel = InvoiceListItem['type']

export function getInvoiceTypeLabel(type: InvoiceTypeForLabel): string {
  if (type === 'SENIOR_INCOME') return 'Выплата синьора'
  if (type === 'SALARY') return 'Зарплата'
  // Exhaustive switch — TS narrows `type` to `never` here.
  return type
}
