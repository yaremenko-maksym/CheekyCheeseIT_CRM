import { decodeResumeMessage } from '@crm/shared'
import { translateApiError } from '@/lib/axios-utils'

/**
 * Backlog 443. A stored resume message (`errorMessage`, `renderError`) is an
 * error code encoded by `encodeResumeMessage`, shown as the catalog line in
 * the active locale. A row written before the codes holds free text, which is
 * shown verbatim.
 */
export function resumeMessageText(stored: string): string {
  const decoded = decodeResumeMessage(stored)
  return decoded ? translateApiError(decoded.code, decoded.params) : stored
}
