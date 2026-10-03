import type { I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'

/**
 * i18n server-text PR4 (S4). A legend journal entry's `authorName` is `null`
 * when the author's user row no longer exists — the server used to send the
 * Russian literal «Неизвестный» here. The viewer's locale names the author
 * instead; a real name (even the string "null") passes through untouched.
 *
 * Reuses the catalog's existing «Невідомо» msgid (also used by
 * `resolveProposer`), so no new translation is introduced.
 */
export function resolveLegendAuthor(i18n: I18n, authorName: string | null): string {
  if (authorName === null) return i18n._(msg`Невідомо`)
  return authorName
}
