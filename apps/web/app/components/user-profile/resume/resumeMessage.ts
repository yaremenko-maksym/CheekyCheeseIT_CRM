import { decodeResumeMessage, type ResumeFallbackCode } from '@crm/shared'
import { translateApiError } from '@/lib/axios-utils'

/**
 * Backlog 443. A stored resume message (`errorMessage`, `renderError`) is an
 * error code encoded by `encodeResumeMessage`, shown as the catalog line in
 * the active locale. A row written before the codes holds free text, which is
 * shown verbatim. A coded value this build cannot render shows `fallback`, the
 * generic line of the caller's area.
 */
export function resumeMessageText(stored: string, fallback: ResumeFallbackCode): string {
  const decoded = decodeResumeMessage(stored, fallback)
  return decoded ? translateApiError(decoded.code, decoded.params) : stored
}
