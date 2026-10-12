import { HttpStatus } from '@nestjs/common'
import { apiError } from '../common/api-error'
import type { DatabaseService } from '../database/database.service'
import type { User } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { updateUserRow } from './user-write.util'

/** Helpers owned by the `UsersService` facade / sibling collaborators, passed in as bound callbacks. */
export interface SalaryHelpers {
  findById(id: string): Promise<User | undefined>
  proposeSeniorShareChangeInTx(
    tx: DrizzleTx,
    existing: Pick<User, 'id' | 'archivedAt' | 'seniorSharePercent'>,
    requestedPercent: number,
    actorId: string,
  ): Promise<{ pendingSeniorSharePercent: number | null } | null>
}

/**
 * `changeSalary`, extracted verbatim from `UsersService` (behavior-preserving leaf move).
 * `@Roles('ADMIN')` + `@AuditLog('salary_change')` stay on the controller handler. Every `users`
 * write goes through the shared `updateUserRow` choke point (no direct write here).
 */
export class SalaryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly helpers: SalaryHelpers,
  ) {}

  async changeSalary(
    id: string,
    data: {
      monthlySalary?: number | null
      salaryCurrency?: 'USDT' | 'USD' | 'EUR' | 'UAH'
      seniorSharePercent?: number
    },
    // Optional: only consulted (and required) when `data.seniorSharePercent`
    // is actually present — every OTHER call of this method (monthlySalary /
    // salaryCurrency only) is unaffected and does not need to supply one.
    actorId?: string,
  ): Promise<User> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (data.monthlySalary !== undefined)
      set.monthlySalary = data.monthlySalary != null ? String(data.monthlySalary) : null
    if (data.salaryCurrency !== undefined) set.salaryCurrency = data.salaryCurrency
    // task-pending-share (position 5): `seniorSharePercent` is DELIBERATELY
    // excluded from `set` — this was a second, un-gated direct-write door
    // onto the same column `adminUpdateUser` already routes through
    // proposal+confirmation (this endpoint had no role check at all, unlike
    // that one — closing it here, not widening it). See
    // `proposeSeniorShareChangeInTx`'s doc for the full reasoning.
    // task-archived-user-completeness (AC2): this method wrote blind (no read
    // of the target at all), so it could not have known the user was archived.
    // The read is what `updateUserRow` compares against — without it every
    // resubmit of an unchanged salary would look like a change and 400.
    const existing = await this.helpers.findById(id)
    if (!existing) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
    // task-648-fix-round-4 (SR-L-5): the same role gate `adminUpdateUser`
    // applies to its own propose (`effectiveRole === 'SENIOR'`). This
    // endpoint carries no `role` field, so the effective role is simply the
    // target's current one. Without this line the second door onto this
    // column opened a `USER_SENIOR_SHARE` proposal against a DROP/JUNIOR
    // target — a confirmation row for a share that role does not have,
    // hanging fail-closed forever because the client never offers those
    // buttons. Nothing was exploitable; the two doors onto one column simply
    // disagreed, which is the shape every finding on this path started as.
    //
    // Ignoring the field rather than 400-ing is deliberate: it is exactly
    // what `adminUpdateUser` does with the same input (its
    // `requestedSeniorSharePercent` ternary), and a gate that answers
    // differently depending on which endpoint you knock at is the drift this
    // is closing.
    const requestedSeniorSharePercent: number | undefined =
      existing.role === 'SENIOR' ? data.seniorSharePercent : undefined
    // No share change requested — byte-for-byte the pre-existing single
    // statement, no transaction wrapper added (keeps this the SAME shape
    // every OTHER caller of this method already relies on).
    if (requestedSeniorSharePercent === undefined) {
      return updateUserRow(this.db.db, id, existing, set)
    }
    if (!actorId) {
      throw apiError('SHARE_CHANGE_REQUESTER_REQUIRED', HttpStatus.BAD_REQUEST)
    }
    return this.db.db.transaction(async (tx) => {
      const updated = await updateUserRow(tx, id, existing, set)
      const shareChangeResult = await this.helpers.proposeSeniorShareChangeInTx(
        tx,
        existing,
        requestedSeniorSharePercent,
        actorId,
      )
      // Same stale-response fix as adminUpdateUser — see proposeSeniorShareChangeInTx's own doc.
      // task-648-fix-round-1 (SR-H-1): non-null for BOTH propose/cancel now.
      if (shareChangeResult)
        updated.pendingSeniorSharePercent = shareChangeResult.pendingSeniorSharePercent
      return updated
    })
  }
}
