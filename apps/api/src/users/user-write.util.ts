import { HttpStatus } from '@nestjs/common'
import { and, eq, isNull } from 'drizzle-orm'
import { apiError } from '../common/api-error'
import type { DatabaseService } from '../database/database.service'
import type { DrizzleTx } from '../database/types'
import { users, type User } from '../database/schema'
import {
  ARCHIVED_ENTITLEMENT_CODE,
  changedEntitlementFields,
  type EntitlementSnapshot,
} from './archived-entitlement'

/**
 * task-archived-user-completeness (AC2) — the single write path for every
 * UPDATE that can move an entitlement column, and the only place the
 * archived-user refusal is spelled out.
 *
 * ## Why one choke point instead of a check per endpoint
 *
 * The defect this closes is not one missing `if`. `changeRole` and
 * `adminUpdateUser` are two doors into the SAME state (`PATCH /:id/role`
 * and the `role` field of `PATCH /:id`), and `changeSalary` is a third into
 * the money half of it — the reported chain (JUNIOR → HR → archive →
 * JUNIOR) walks through them precisely because they do not agree with each
 * other. Five copies of the same `if` agree only until someone edits one of
 * them, and the next door added to this service starts out with zero. Here
 * the decision (which columns, which message, actual-change semantics) is
 * stated ONCE in `archived-entitlement.ts` and every writer inherits it by
 * calling this method rather than by remembering a rule.
 *
 * The honest limit of a choke point: it protects writers that USE it. A
 * future method reaching for `this.db.db.update(users)` directly is not
 * covered — which is why this is not the only layer (see below), and why the
 * set of direct writers is a CHECKED inventory rather than a claim in this
 * comment.
 *
 * Two of them bypass this method on purpose (`updateProfile`,
 * `updateRequisites`). They are safe not because they look harmless but
 * because the `set` object they build contains no entitlement column, and
 * `archived-entitlement.unit.spec.ts` asserts exactly that by capturing what
 * they hand to Drizzle. The rest (`setAdminNote`, `archive`,
 * `unarchivePairTx`, `updateGoogleId`, `archiveDrop`, and
 * `TeamsService.archiveDropTeam`) write only `admin_note` / `archived_at` /
 * `google_id`, none of which decide what anyone is owed.
 *
 * Do NOT trust that list as prose — an earlier revision of this docblock
 * promised that a third direct writer would turn the spec red, and security
 * review measured that it did not: the spec named two methods one by one and
 * was structurally blind to a third. It is now ENUMERATING — it scans every
 * non-spec file under `apps/api/src`, collects the enclosing method of every
 * `.update(users)`, and diffs the whole set against an explicit inventory.
 * A new writer anywhere in the API fails that test by name. That is the only
 * form in which this paragraph is worth reading — and it too has stated
 * limits (the scan is line-based, so its coverage of a multi-line call rests
 * on the prettier gate); they are listed on the check itself, not paraphrased
 * here, so there is one place to keep honest.
 *
 * ## Two layers, not one
 *
 * `existing` is read BEFORE this call (its callers need it for their own
 * guards), so on its own it is a TOCTOU window: an archive committing
 * between that read and this UPDATE would let the change through. When the
 * write actually moves an entitlement column, the refusal is therefore
 * ALSO expressed as `archived_at IS NULL` inside the statement, where
 * Postgres re-evaluates it against the committed row. Same two-layer shape
 * `TransactionsService` already uses for the salary receiver
 * (`assertSalaryReceiverNotArchived` + `salaryReceiverNotArchivedFilter`).
 *
 * When nothing entitlement-bearing changes, no predicate is added: the
 * statement stays exactly what it was, so settlement-time edits (requisites,
 * contacts, a resubmitted unchanged role) are untouched.
 */
export async function updateUserRow(
  db: DatabaseService['db'] | DrizzleTx,
  id: string,
  existing: EntitlementSnapshot,
  set: Record<string, unknown>,
): Promise<User> {
  const changed = changedEntitlementFields(existing, set)
  if (changed.length > 0 && existing.archivedAt) {
    throw apiError(ARCHIVED_ENTITLEMENT_CODE, HttpStatus.BAD_REQUEST)
  }

  const rows = await db
    .update(users)
    .set(set)
    .where(changed.length > 0 ? and(eq(users.id, id), isNull(users.archivedAt)) : eq(users.id, id))
    .returning()

  const updated = rows[0]
  if (updated) return updated

  // Zero rows with the archival predicate attached is ambiguous by itself —
  // the row may be missing, or it may have been archived since `existing`
  // was read. Re-read (same executor, so it sees this transaction's own
  // writes) rather than guess, so the operator gets the true reason.
  if (changed.length > 0) {
    const [current] = await db
      .select({ archivedAt: users.archivedAt })
      .from(users)
      .where(eq(users.id, id))
    if (current?.archivedAt) throw apiError(ARCHIVED_ENTITLEMENT_CODE, HttpStatus.BAD_REQUEST)
  }
  throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
}
