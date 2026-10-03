import type { I18n } from '@lingui/core'
import { CONTRACT_NAME_MESSAGES, renderMessage } from '@crm/shared'
import type { Document } from '@crm/shared'

/**
 * i18n server-text PR2. The one place that decides what name a document shows.
 *
 * `name` is multiplexed on the wire: a real upload uses it as the (sanitized)
 * filename — the user sees `originalName ?? name` — while a virtual
 * employee-contract entry carries NO prose, only `nameKind` (+ `contractNumber`
 * for a signed one). The structure is rendered here, in the VIEWER's locale,
 * through the shared `renderMessage`, and ONLY when `nameKind` is set; every
 * other document (and any older API response without the new fields) keeps the
 * filename path untouched.
 */
export function getDocumentDisplayName(
  i18n: I18n,
  doc: Pick<Document, 'name' | 'originalName'> &
    Partial<Pick<Document, 'nameKind' | 'contractNumber'>>,
): string {
  if (doc.nameKind) {
    return renderMessage(i18n, CONTRACT_NAME_MESSAGES[doc.nameKind], {
      contractNumber: doc.contractNumber ?? '',
    })
  }
  return doc.originalName ?? doc.name
}
