import type { MessageDescriptor } from '@lingui/core'

/**
 * task-i18n-stage4-task1 bootstrap stub — filled by task-i18n-stage4-task2
 * (`finance`/`invoices` error codes, Track A). Empty on purpose: the barrel
 * (`./index.ts`) spreads this module in alongside `auth-users-projects.ts`
 * and `documents-contracts-notifications.ts` so all three module files can
 * exist (and typecheck) before Task 2/3 land their own codes — see
 * "Дисциплина параллельности" in `docs/superpowers/plans/2026-09-20-crm-i18n-stage4-api-shared.md`.
 * Task 2 fills this file in place; it does not touch the barrel.
 */
export const FINANCE_INVOICES_ERROR_CODES = [] as const
export type FinanceInvoicesErrorCode = (typeof FINANCE_INVOICES_ERROR_CODES)[number]

export const FINANCE_INVOICES_ERROR_PARAMS = {} as const satisfies Record<
  FinanceInvoicesErrorCode,
  readonly string[]
>

export const FINANCE_INVOICES_ERROR_MESSAGES: Record<FinanceInvoicesErrorCode, MessageDescriptor> =
  {}

export const FINANCE_INVOICES_ERROR_FALLBACK_EN: Record<FinanceInvoicesErrorCode, string> = {}
