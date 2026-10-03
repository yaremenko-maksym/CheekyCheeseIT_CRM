import type { I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { PENDING_TITLE_MESSAGES, renderMessage } from '@crm/shared'
import type { PendingItemOrUnknown } from '@crm/shared'

/**
 * i18n server-text PR1. The server ships `titleKind` + nominative-only
 * `titleParams` (it composes no sentence any more); the words live in
 * `PENDING_TITLE_MESSAGES` and are rendered here in the VIEWER's locale, via
 * the shared `renderMessage` — the same renderer the notification registry
 * uses, deliberately not a second one.
 *
 * `null` = this row cannot be titled by this bundle (COPY-L-6's degraded
 * unknown-kind row carries no `titleKind` at all): the caller shows its own
 * fallback («Запит на дію»).
 */
export function renderPendingTitle(i18n: I18n, item: PendingItemOrUnknown): string | null {
  if (!('titleKind' in item)) return null
  return renderMessage(i18n, PENDING_TITLE_MESSAGES[item.titleKind], item.titleParams)
}

/**
 * `proposedBy` on the wire: a name, `undefined` (a `proposedByMe` row — nobody
 * "proposed it to" the admin), or `null` (the proposer's row could not be
 * resolved — the server used to send the Russian literal «Неизвестно» here).
 * `null` becomes the localized «Невідомо»; `undefined`/empty stays absent.
 */
export function resolveProposer(i18n: I18n, proposedBy: string | null | undefined): string | null {
  if (proposedBy === null) return i18n._(msg`Невідомо`)
  return proposedBy || null
}
