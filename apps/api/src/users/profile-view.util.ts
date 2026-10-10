import type { PendingSeniorShare } from '@crm/shared'
import type { User } from '../database/schema'

/**
 * Pure slices of `UsersService.buildProfileView`. No db, no audit, no `this` —
 * the reads, the `requisites_read` audit write and the masking orchestration
 * stay inline in the service.
 */

/**
 * Builds the pending-senior-share DTO fragment from already-loaded target
 * fields. `status` is the approvals status already resolved under the
 * `fields.sharePending` gate; anything other than `'PENDING'` yields `null`.
 */
export function computePendingSeniorShare(
  target: Pick<User, 'id' | 'displayName' | 'pendingSeniorSharePercent' | 'seniorSharePercent'>,
  status: string,
): PendingSeniorShare | null {
  return status === 'PENDING'
    ? {
        // Guaranteed non-null in practice while PENDING — see
        // `proposeSeniorShareChangeInTx`'s doc (a base-share proposal is
        // always a concrete percent). `??` is a defensive fallback only.
        percent: target.pendingSeniorSharePercent ?? target.seniorSharePercent,
        // task-648-fix-round-1 (COPY-H-2/COPY-H-3). A base-share (USER
        // level) proposal has nothing above it in the resolver hierarchy
        // that could override it, so the effective-after-approval value
        // always equals `percent` itself — unlike the PROJECT-level DTO
        // (`ProjectsService.loadPendingSeniorShare`), there is no
        // PROJECT/TEAM fallback to resolve here.
        effectivePercentAfterApproval:
          target.pendingSeniorSharePercent ?? target.seniorSharePercent,
        approverId: target.id,
        approverName: target.displayName,
      }
    : null
}

/** Payment-requisite fields that the `requisites_read` audit tracks. */
const REQUISITE_FIELDS = [
  'paymentMethod',
  'walletUsdtErc20',
  'walletUsdtLabel',
  'bankUahRecipient',
  'bankUahIban',
  'bankUahRnokpp',
  'bankUahBankName',
] as const

/**
 * Which requisite fields are actually present (non-null) on the already
 * masked profile — i.e. what the viewer really received.
 */
export function collectExposedRequisiteFields(filteredUser: object): string[] {
  return REQUISITE_FIELDS.filter((f) => (filteredUser as Record<string, unknown>)[f] != null)
}
