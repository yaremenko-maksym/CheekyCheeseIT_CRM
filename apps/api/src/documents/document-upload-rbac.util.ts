import { BadRequestException, HttpStatus } from '@nestjs/common'
import type { DocumentCategory, Role } from '@crm/shared'
import { apiError } from '../common/api-error'

/**
 * RBAC for UPLOAD. Throws ForbiddenException if `role` cannot upload
 * `category` for the target `ownerId`. Matrix from pm-brief.md:
 *
 *   RESUME / SCAN:
 *     ADMIN/HR/SENIOR — any ownerId
 *     JUNIOR — ownerId == self only
 *     ACCOUNTANT — forbidden
 *   CONTRACT:
 *     ADMIN — any ownerId
 *     SENIOR — ownerId == self only
 *     others — forbidden
 *   RECEIPT:
 *     ADMIN/ACCOUNTANT — any ownerId
 *     SENIOR — ownerId == self only
 *     HR / JUNIOR — forbidden
 *   AVATAR:
 *     ADMIN — any ownerId (impersonation)
 *     anyone else — ownerId == self only
 *   LOGO:
 *     ADMIN/HR/SENIOR — allowed (projectId scope is enforced elsewhere)
 *     JUNIOR/ACCOUNTANT — forbidden
 */
export function assertCanUpload(
  role: Role,
  actorId: string,
  category: DocumentCategory,
  ownerId: string,
): void {
  const isSelf = actorId === ownerId

  switch (category) {
    case 'RESUME':
    case 'SCAN':
      if (role === 'ACCOUNTANT') {
        throw apiError('DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN', HttpStatus.FORBIDDEN, { category })
      }
      if (role === 'JUNIOR' && !isSelf) {
        throw apiError('DOCUMENT_UPLOAD_SELF_ONLY', HttpStatus.FORBIDDEN)
      }
      if (role === 'DROP' && !isSelf) {
        throw apiError('DOCUMENT_UPLOAD_SELF_ONLY', HttpStatus.FORBIDDEN)
      }
      return
    case 'CONTRACT':
      if (role === 'ADMIN') return
      if (role === 'SENIOR' && isSelf) return
      if (role === 'DROP' && isSelf) return
      throw apiError('DOCUMENT_UPLOAD_CONTRACT_RESTRICTED', HttpStatus.FORBIDDEN)
    case 'RECEIPT':
      if (role === 'ADMIN' || role === 'ACCOUNTANT') return
      if (role === 'SENIOR') {
        if (isSelf) return
        // A senior CAN upload receipts, just not for someone else — the
        // blanket "you don't have access to receipts" text of
        // DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN would be false here
        // (COPY-M-14, PR #702 fix-round 2).
        throw apiError('DOCUMENT_UPLOAD_RECEIPT_SELF_ONLY', HttpStatus.FORBIDDEN)
      }
      throw apiError('DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN', HttpStatus.FORBIDDEN, {
        category: 'RECEIPT',
      })
    case 'AVATAR':
      if (role === 'ADMIN') return
      if (isSelf) return
      throw apiError('DOCUMENT_UPLOAD_AVATAR_SELF_ONLY', HttpStatus.FORBIDDEN)
    case 'LOGO':
      if (role === 'ADMIN' || role === 'HR' || role === 'SENIOR') return
      throw apiError('DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN', HttpStatus.FORBIDDEN, {
        category: 'LOGO',
      })
    case 'INVOICE':
      // INVOICE documents are produced by the system only (PDF generated
      // server-side by InvoicesService — see Invoice Signing Epic). They
      // must never be uploaded via the regular /api/documents endpoint
      // — InvoicesService bypasses this check by calling the internal
      // upload helper directly.
      throw apiError('DOCUMENT_UPLOAD_INVOICE_FORBIDDEN', HttpStatus.FORBIDDEN)
    default: {
      // Exhaustiveness check
      const _exhaustive: never = category
      throw new BadRequestException(`Unknown category: ${String(_exhaustive)}`)
    }
  }
}
