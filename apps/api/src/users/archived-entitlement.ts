/**
 * task-archived-user-completeness (AC2) — the ONE place that decides which
 * writes to a `users` row are refused while that person is archived.
 *
 * ## The line this module draws
 *
 * Archival (`users.archivedAt`) means the person no longer works here. The
 * discriminator for what an archived person may still be involved in is NOT
 * "is the receiver archived" — it is:
 *
 *   • **new entitlement** — creating a right to money that has NOT been
 *     earned yet. An archived person must not acquire one: nothing they
 *     could earn it with is happening any more.
 *   • **settlement of an already-earned debt** — paying out what the person
 *     earned while they worked. An archived person must KEEP this. Withholding
 *     it would not be a safeguard, it would be non-payment.
 *
 * Getting that backwards is the expensive mistake here, not missing a door.
 * "Refuse everything to an archived receiver" would also catch
 * `TransactionsService.bookCompanyObligations` (the company recording what it
 * owes a senior/drop for income already booked) and the payout-confirmation
 * paths (`manualConfirmPayout` / `payPayoutRequest` / `settleByCompany`) —
 * all of which are the second case and are deliberately left alone.
 *
 * ## Why these five columns and not "the whole row"
 *
 * Applied to a `users` row, the same line runs BETWEEN its columns:
 *
 *   • `role`, `monthlySalary`, `salaryCurrency`, `seniorSharePercent`,
 *     `dropSharePercent` decide what the person will be OWED IN FUTURE — the
 *     salary cron reads role + monthlySalary to mint a fresh PENDING salary
 *     every month, and the share percents decide the size of every future
 *     IOU. Changing one of these for an archived person creates a new
 *     entitlement. Frozen.
 *   • `paymentMethod`, `walletUsdtErc20`, `bankUahIban`, `legalFullName`,
 *     contacts, avatar decide WHERE money already owed is sent. A dismissed
 *     employee whose IBAN changed still has to be paid what they earned, so
 *     `updateRequisites` / `setPaymentRequisites` / the self-update path are
 *     deliberately NOT guarded — freezing them would break settlement, which
 *     is exactly the failure mode described above.
 *
 * ## Why "changed", not "present in the payload"
 *
 * The guard fires on an ACTUAL change, never on the mere presence of a field
 * in the request. `UserDialog` submits the whole form, so an admin correcting
 * an archived employee's IBAN also re-sends the unchanged `role` and
 * `monthlySalary`. Refusing on presence would 400 the legitimate settlement
 * edit — the same "don't make it worse" trap in miniature. `adminUpdateUser`
 * already applies the identical actual-change rule to its ADMIN/DROP
 * privilege guards (see `data.role !== existing.role` there).
 *
 * `monthlySalary` is a Postgres `numeric`, so it comes back as a STRING
 * (`'1500.00'`) while the DTO carries a number (`1500`) — a naive `!==`
 * would report every resubmit as a change and 400 it. Hence the per-field
 * comparison kind below.
 */
import type { User } from '../database/schema'

/**
 * The columns frozen while `archivedAt` is set — the "future entitlement"
 * half of the split described in the module docblock. Values are the
 * comparison kind: `numeric` columns must be compared by VALUE because
 * Drizzle hands back `numeric` as a string.
 */
const ENTITLEMENT_FIELD_KIND = {
  role: 'text',
  salaryCurrency: 'text',
  monthlySalary: 'numeric',
  seniorSharePercent: 'numeric',
  dropSharePercent: 'numeric',
} as const

export type EntitlementField = keyof typeof ENTITLEMENT_FIELD_KIND

export const ENTITLEMENT_FIELDS = Object.keys(ENTITLEMENT_FIELD_KIND) as EntitlementField[]

/** Operator-facing refusal. One message for every door, by design. */
export const ARCHIVED_ENTITLEMENT_MESSAGE =
  'Пользователь архивирован — нельзя менять роль и условия оплаты. ' +
  'Уже заработанные выплаты закрываются как обычно; чтобы изменить условия, сначала разархивируйте.'

/** The subset of a `users` row this module reads. */
export type EntitlementSnapshot = Pick<User, 'archivedAt'> & Partial<Pick<User, EntitlementField>>

function sameValue(kind: 'text' | 'numeric', before: unknown, after: unknown): boolean {
  const a = before ?? null
  const b = after ?? null
  if (a === null || b === null) return a === b
  if (kind === 'numeric') {
    const na = Number(a)
    const nb = Number(b)
    // Non-finite on either side (a malformed string) falls through to the
    // textual comparison rather than silently reporting "equal" via NaN.
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb
  }
  return String(a) === String(b)
}

/**
 * Names of the entitlement columns that `set` would ACTUALLY change relative
 * to `existing`. Empty array ⇒ this write creates no new entitlement, whoever
 * the target is.
 *
 * A key absent from `set` is not a change (the UPDATE will not touch that
 * column). A key present with the value the row already holds is not a change
 * either — see the module docblock.
 */
export function changedEntitlementFields(
  existing: EntitlementSnapshot,
  set: Record<string, unknown>,
): EntitlementField[] {
  return ENTITLEMENT_FIELDS.filter(
    (field) =>
      field in set && !sameValue(ENTITLEMENT_FIELD_KIND[field], existing[field], set[field]),
  )
}

/**
 * True iff this write must be refused: the target is archived AND the write
 * would move at least one entitlement column.
 */
export function createsEntitlementForArchivedUser(
  existing: EntitlementSnapshot,
  set: Record<string, unknown>,
): boolean {
  if (!existing.archivedAt) return false
  return changedEntitlementFields(existing, set).length > 0
}
