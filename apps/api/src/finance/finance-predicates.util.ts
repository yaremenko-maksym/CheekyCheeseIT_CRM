import { COMPANY_ACCOUNT_LABEL } from '@crm/shared'
import { uniqueViolationConstraint } from '../database/pg-errors'

/**
 * MED-Q (security-review round 6) — is THIS unique violation the on-chain
 * registry, or something else entirely?
 *
 * Mapping any 23505 to «хеш уже использован» hands the user a confident,
 * wrong explanation: an unrelated unique constraint can fail in the same
 * transaction and must not be reported as a tx hash the operator never
 * touched. Same failure the payout cascade already avoids with an
 * allow-list of index names — the receipt entrances now share it.
 */
export function isRegistryConflict(err: unknown): boolean {
  const constraint = uniqueViolationConstraint(err)
  return (
    constraint === 'uq_consumed_tx_hashes_active_tx_hash' ||
    // Pre-MED-J name; a rolling deploy can still be running the old index.
    constraint === 'uq_consumed_tx_hashes_tx_hash'
  )
}

/**
 * task-counterparty-role-masking (RBAC identity-masking, security-critical).
 *
 * A transaction "side" (sender or receiver) is an **internal company party**
 * — either the company account pool itself, or a specific ADMIN partner
 * (Максим/Константин) — whose real identity is disclosed ONLY to
 * ADMIN/ACCOUNTANT. For every other role the side is rebranded to
 * «CheekyCheeseIT» with the user id + displayName stripped (see the
 * `senderMasked`/`receiverMasked` branches in `mapTx`), so a
 * SENIOR/JUNIOR/DROP/HR can never learn which admin funded a payout nor
 * enumerate the admin profile via a leaked id.
 *
 * The account pool is recognised by its label code (`COMPANY_ACCOUNT_LABEL`)
 * or, as a defensive fallback, a company-account-funded row whose side
 * carries no user id. The pre-server-text-PR3 Russian prose alias is no longer
 * recognised (prod has no such rows; nothing writes it). An ADMIN partner is recognised by the joined role.
 *
 * NOTE: the actual recipient of a company payout (the drop/senior — a
 * non-ADMIN user with their own id) is never an internal party, so viewers
 * still see themselves on their own rows.
 */
export function isInternalCompanySide(
  sideId: string | null | undefined,
  sideLabel: string | null | undefined,
  sideRole: string | null | undefined,
  fundingSource: string | null | undefined,
): boolean {
  const isCompanyAccount =
    sideLabel === COMPANY_ACCOUNT_LABEL ||
    (fundingSource === 'COMPANY_ACCOUNT' && (sideId === null || sideId === undefined))
  const isAdminPartner = !!sideId && sideRole === 'ADMIN'
  // MED-1 (security review PR #384): `transactions.senderId → users.id` is
  // ON DELETE SET NULL. If an ADMIN partner who personally funded a payout
  // (fundingSource='ADMIN_PERSONAL') is later deleted, `senderId` flips to
  // NULL but `senderLabel` still carries the SNAPSHOT of their displayName
  // (stamped at pay/settle time — see `paySalary` / `PendingSettlementService`
  // settle-in-place). Without this branch, `isAdminPartner` above (which
  // requires a LIVE `sideId`) no longer fires and the deleted admin's name
  // leaks through unmasked to non-privileged viewers. Every current
  // ADMIN_PERSONAL write path always stamps a real, non-null RECEIVER (the
  // employee/senior/drop being paid) — only the SENDER side can ever be null
  // under this funding marker — so this condition is safe for the receiver
  // side too; it is intentionally NOT scoped to sender-only so a future
  // write path can never silently reuse the marker asymmetrically and bypass
  // masking.
  const isOrphanedAdminPersonalPayer =
    fundingSource === 'ADMIN_PERSONAL' && (sideId === null || sideId === undefined)
  return isCompanyAccount || isAdminPartner || isOrphanedAdminPersonalPayer
}
