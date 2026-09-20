import type { MessageDescriptor } from '@lingui/core'

/**
 * task-i18n-stage4-task1 bootstrap stub — filled by task-i18n-stage4-task3
 * (`documents`/`contracts`/`teams`/`legends`/`approvals`/`interviews`/
 * `notifications` error codes, Track A). Empty on purpose — see
 * `finance-invoices.ts`'s doc comment for the full rationale (same
 * bootstrap, same "Дисциплина параллельности" section of the stage 4 plan).
 * Task 3 fills this file in place; it does not touch the barrel.
 */
export const DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_CODES = [] as const
export type DocumentsContractsNotificationsErrorCode =
  (typeof DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_CODES)[number]

export const DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_PARAMS = {} as const satisfies Record<
  DocumentsContractsNotificationsErrorCode,
  readonly string[]
>

export const DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_MESSAGES: Record<
  DocumentsContractsNotificationsErrorCode,
  MessageDescriptor
> = {}

export const DOCUMENTS_CONTRACTS_NOTIFICATIONS_ERROR_FALLBACK_EN: Record<
  DocumentsContractsNotificationsErrorCode,
  string
> = {}
