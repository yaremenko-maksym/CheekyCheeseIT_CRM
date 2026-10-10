import type { PendingSeniorShare, ViewPermissions } from '@crm/shared'
import type { User, UserEmail } from '../database/schema'

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

// ---------------------------------------------------------------------------
// Build filteredUser with explicit allow-list projection (OWASP A01 guard).
//
// IMPORTANT: use an explicit field list rather than `{ ...target }` so that
// future DB columns do NOT leak automatically before a permissions gate is
// added. Add new sensitive fields here AND in getViewPermissions flags.
//
// Field visibility matrix (viewer → target):
//   email / phone / telegram (realContacts) — hidden when fields.realContacts=false
//     (e.g. JUNIOR viewing SENIOR/DROP: legend persona boundary)
//   adminNote                               — ADMIN only (fields.adminNote), never self
//   registrationAddress (fopPii)            — ADMIN + self (fields.fopPii)
//   legalFullName                           — ADMIN + self (fields.legalName)
//   monthlySalary                           — fields.salary
//   seniorSharePercent / dropSharePercent   — fields.share
//   paymentMethod / wallet* / bankUah*      — fields.requisites
//   techStack                               — fields.techStack
//   displayName, avatarUrl, avatarDocumentId, role, id — always present
// ---------------------------------------------------------------------------
// FilteredUser extends User but allows email to be null when realContacts
// is masked (e.g. JUNIOR viewing SENIOR). The DB type is string (NOT NULL)
// but the API contract intentionally redacts it at this layer.
// SEC-09: exclude googleId — Google's internal identifier is not part of the
// profile API contract and should not be returned to any caller. The field
// is used only for OAuth callback flow (updateGoogleId), never for display.
//
// task-i18n-stage2 (Task 3) — `locale` is ALSO excluded here, deliberately
// (an assumption recorded, not an oversight): this profile-view DTO
// (`GET /users/:id`) has no established use for a viewer to read a
// TARGET's interface language — only `/auth/me` (own session) and the
// create wizard need it. Extending this allow-list to a field nothing
// reads would be scope creep past what task-i18n-stage2's Task 3
// actually asked for; re-add here (and to `userProfileSchema`) if a
// future task needs it.
export type FilteredUser = Omit<
  User,
  'email' | 'googleId' | 'pendingSeniorSharePercent' | 'locale'
> & {
  email: string | null
  personalEmail: string | null
  personalEmailCanLogin: boolean | null
  personalContactVisible: boolean
  pendingSeniorShare: PendingSeniorShare | null
}

export function projectProfileUser(
  target: User,
  permissions: ViewPermissions,
  personalEmailRow: Pick<UserEmail, 'email' | 'canLogin'> | undefined,
  pendingSeniorShare: PendingSeniorShare | null,
): FilteredUser {
  const filteredUser: FilteredUser = {
    // Always-safe identity fields (persona display, never masked)
    id: target.id,
    displayName: target.displayName,
    role: target.role,
    avatarUrl: target.avatarUrl,
    avatarDocumentId: target.avatarDocumentId,
    archivedAt: target.archivedAt,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,

    // Real contacts — hidden from JUNIOR viewing SENIOR/DROP (legend boundary)
    email: permissions.fields.realContacts ? target.email : null,
    phone: permissions.fields.realContacts ? (target.phone ?? null) : null,
    telegram: permissions.fields.realContacts ? (target.telegram ?? null) : null,
    // §4.4 — same realContacts gate as email/phone/telegram above.
    // SR-M-4 — same `personalContact` gate as the fetch above.
    personalEmail: permissions.fields.personalContact ? (personalEmailRow?.email ?? null) : null,
    // task-user-emails-invite: lets the frontend tell "no personal address
    // set" (null) apart from "set, invite not yet accepted" (false) apart
    // from "accepted, works as a login" (true) — drives the ADMIN-only
    // "resend invite" action (AdminActionsMenu) and the profile-header
    // status badge. Same gate as personalEmail itself — never surfaced to
    // a viewer who cannot see the address in the first place.
    personalEmailCanLogin: permissions.fields.personalContact
      ? (personalEmailRow?.canLogin ?? null)
      : null,
    // UX-M-1 (design-gate audit, PR #623): WITHOUT this flag, "no access
    // to this field" and "field is genuinely empty" were the exact same
    // wire value (`null`) — a viewer with real access (e.g. an ADMIN
    // looking at a user who simply never got a personal address) could
    // not be told apart, over the API, from a viewer who is masked from
    // seeing it at all (e.g. ACCOUNTANT, or HR outside their own team).
    // `personalEmail`/`personalEmailCanLogin` being `null` is ONLY
    // meaningful "not set" once THIS is `true` — a consumer must check it
    // FIRST. Mirrors `permissions.fields.personalContact` exactly (it IS
    // that flag, just also shipped on the DTO the frontend actually
    // reads — `permissions.fields` is a `Record<string, boolean>` the
    // frontend does consult elsewhere, but naming the specific field here
    // makes the contract explicit rather than requiring every consumer to
    // know `personalContact` is the flag that governs these two).
    personalContactVisible: permissions.fields.personalContact ?? false,

    // Admin-only internal note (never visible to subject or non-ADMIN)
    adminNote: permissions.fields.adminNote ? (target.adminNote ?? null) : null,

    // FOP PII: registrationAddress — ADMIN + self only
    registrationAddress: permissions.fields.fopPii ? (target.registrationAddress ?? null) : null,

    // Passport PII — ADMIN + self only
    legalFullName: permissions.fields.legalName ? (target.legalFullName ?? null) : null,

    // Financial fields — gated by role-based flags
    monthlySalary: permissions.fields.salary ? target.monthlySalary : null,
    salaryCurrency: permissions.fields.salary ? (target.salaryCurrency ?? null) : null,
    seniorSharePercent: permissions.fields.share ? target.seniorSharePercent : 0,
    // task-pending-share (position 5): computed above, already gated on
    // `fields.share` (the query itself is skipped when masked).
    pendingSeniorShare,
    // Drop role - phase 1: also mask dropSharePercent for non-privileged viewers
    dropSharePercent: permissions.fields.share ? (target.dropSharePercent ?? null) : null,

    // Tech stack
    techStack: permissions.fields.techStack ? (target.techStack ?? null) : null,

    // Payment requisites.
    // `requisitesExcludeWallet` (pre-deploy MEDIUM): an ACCOUNTANT viewing an
    // ADMIN gets the requisites surface EXCEPT the payout destination
    // (wallet/IBAN/recipient/RNOKPP/bank) — admins are not on payroll, so the
    // accountant has no business need for another admin's payout details.
    // `paymentMethod` (the method type, no destination) stays visible.
    paymentMethod: permissions.fields.requisites ? (target.paymentMethod ?? null) : null,
    walletUsdtErc20:
      permissions.fields.requisites && !permissions.fields.requisitesExcludeWallet
        ? (target.walletUsdtErc20 ?? null)
        : null,
    walletUsdtLabel:
      permissions.fields.requisites && !permissions.fields.requisitesExcludeWallet
        ? (target.walletUsdtLabel ?? null)
        : null,
    bankUahRecipient:
      permissions.fields.requisites && !permissions.fields.requisitesExcludeWallet
        ? (target.bankUahRecipient ?? null)
        : null,
    bankUahIban:
      permissions.fields.requisites && !permissions.fields.requisitesExcludeWallet
        ? (target.bankUahIban ?? null)
        : null,
    bankUahRnokpp:
      permissions.fields.requisites && !permissions.fields.requisitesExcludeWallet
        ? (target.bankUahRnokpp ?? null)
        : null,
    bankUahBankName:
      permissions.fields.requisites && !permissions.fields.requisitesExcludeWallet
        ? (target.bankUahBankName ?? null)
        : null,
  }
  return filteredUser
}
