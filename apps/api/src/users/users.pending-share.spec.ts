/**
 * task-pending-share (position 5 of docs/superpowers/specs/2026-09-01-
 * notifications-and-confirmations-design.md §4.3). Dedicated coverage for
 * the USER-level base senior-share propose -> approve -> reject flow,
 * beyond what `users.service.spec.ts`'s rewritten `adminUpdateUser` tests
 * already cover (those prove propose(); this file proves AC2/AC3/AC4/AC6 —
 * the CONSEQUENCES of a pending proposal existing).
 *
 * AC2 and AC6 are the money-critical ones (task file: "ошибка в них — это
 * деньги, посчитанные не по тому проценту") — AC2 is proven against the
 * REAL, untouched `resolveSeniorShare` (a pure function), not against a
 * mock echoing back whatever the test configured.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { ARCHIVED_ENTITLEMENT_MESSAGE } from './archived-entitlement'
import { UsersService } from './users.service'
import { users } from '../database/schema'
import { resolveSeniorShare } from '../finance/senior-share-resolver'

const seniorUser: SessionUser = {
  id: 'senior-1',
  role: 'SENIOR',
  displayName: 'Senior One',
  email: 's@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const impersonatedSenior: SessionUser = { ...seniorUser, impersonatorId: 'admin-1' }
// task-648-fix-round-1 (AC9 mutation-gate gap-fill): only used by the
// `cancelSeniorShareChange` RBAC block below — every other describe in this
// file is scoped to the affected SENIOR's own session.
const adminUser: SessionUser = {
  id: 'admin-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'a@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

interface UserRow {
  id: string
  role: string
  seniorSharePercent: number
  pendingSeniorSharePercent: number | null
  archivedAt: Date | null
  updatedAt: Date
}

/**
 * `tx` is a DISTINCT object from `db.db` — its `update` is its OWN spy,
 * never called by anything running OUTSIDE `db.db.transaction(cb)`. Same
 * atomicity-proof shape as projects.pending-share.spec.ts's harness.
 */
function buildHarness(overrides: Partial<UserRow> = {}) {
  const userRow: UserRow = {
    id: 'senior-1',
    role: 'SENIOR',
    seniorSharePercent: 26,
    pendingSeniorSharePercent: 40,
    archivedAt: null,
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  }

  const txUpdateCalls: Array<{ table: unknown; values: Record<string, unknown> }> = []
  const topLevelUpdateCalls: Array<{ table: unknown }> = []

  // task-pending-share follow-up (AC9 gap-fill): lets a test simulate "the
  // UPDATE matched zero rows" (row vanished / archived between the approval
  // check and the write) — the reject path's own not-found guard reads this,
  // distinct from `selectForUpdateOverride` below (a DIFFERENT statement,
  // approve's row-LOCK select, not reject's UPDATE...RETURNING).
  let forceEmptyReturning = false

  // `.where(...)` must support BOTH real Drizzle usages: awaited directly
  // (`proposeSeniorShareChangeInTx`'s write — no `.returning()`) and chained
  // with `.returning()` (`updateUserRow`, `rejectSeniorShareChange`'s write).
  // Real Drizzle's update builder is thenable either way; `then` below is
  // what makes `await tx.update(...).where(...)` (no `.returning()`) run the
  // SAME side effect instead of silently no-op'ing on an unawaited chain.
  const makeUpdateChain = (
    log: Array<{ table: unknown; values: Record<string, unknown> }>,
    isTx: boolean,
  ) => ({
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const run = () => {
            log.push({ table, values })
            if (forceEmptyReturning) return []
            if (table === users) Object.assign(userRow, values)
            if (!isTx) topLevelUpdateCalls.push({ table })
            return [{ ...userRow }]
          }
          return {
            returning: async () => run(),
            then: (resolve: (v: unknown[]) => void) => resolve(run()),
          }
        },
      }),
    }),
  })

  // task-pending-share follow-up (AC9 gap-fill): same for-update capture +
  // override as projects.pending-share.spec.ts's harness — see that file's
  // comment for why both exist.
  const selectForCalls: unknown[] = []
  let selectForUpdateOverride: UserRow[] | undefined

  const txHandle = {
    ...makeUpdateChain(txUpdateCalls, true),
    select: () => ({
      from: () => ({
        where: () => ({
          for: (mode: unknown) => {
            selectForCalls.push(mode)
            return {
              limit: async () => (selectForUpdateOverride ?? [userRow]).map((r) => ({ ...r })),
            }
          },
        }),
      }),
    }),
  }

  const db = {
    db: {
      ...makeUpdateChain([], false),
      // `findById` (adminUpdateUser's pre-read) — plain `select().from().where()`.
      select: () => ({ from: () => ({ where: async () => [{ ...userRow }] }) }),
      transaction: vi.fn(
        async <T>(fn: (tx: typeof txHandle) => Promise<T>): Promise<T> => fn(txHandle),
      ),
    },
  }

  const approvals = {
    proposeInTx: vi.fn(async () => undefined),
    approveInTx: vi.fn(async () => undefined),
    rejectInTx: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => 'PENDING' as const),
    cancelInTx: vi.fn(async () => undefined),
  }
  // task-648-fix-round-1 (SR-M-3): approve/reject/cancel now route their
  // response through `buildProfileView` (allow-list), not a raw row — it
  // needs a working `getViewPermissions` so the "empty tabs → 403" guard
  // doesn't fire; this file's own assertions are all on the WRITE side
  // (txUpdateCalls / approvals calls), not on the returned view shape.
  const accessService = {
    getViewPermissions: vi.fn().mockResolvedValue({
      tabs: ['overview'],
      fields: { share: true, personalContact: false, adminNote: false, googleId: false },
    }),
  }
  const tosService = { getLatestAcceptanceForUser: vi.fn().mockResolvedValue(null) }

  const service = new UsersService(
    db as never,
    accessService as never,
    { record: vi.fn(async () => undefined) } as never,
    tosService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    approvals as never,
  )

  return {
    service,
    userRow,
    approvals,
    txUpdateCalls,
    topLevelUpdateCalls,
    txHandle,
    selectForCalls,
    setSelectForUpdateRows: (rows: UserRow[]) => {
      selectForUpdateOverride = rows
    },
    setEmptyReturning: () => {
      forceEmptyReturning = true
    },
  }
}

describe('UsersService — pending base share AC2 (resolver returns previous value while pending)', () => {
  it('resolveSeniorShare, called with the LIVE column, is unaffected by a pending proposal', () => {
    const h = buildHarness({ seniorSharePercent: 26, pendingSeniorSharePercent: 80 })
    const result = resolveSeniorShare(
      { seniorSharePercentOverride: null },
      { seniorSharePercent: h.userRow.seniorSharePercent },
      [],
    )
    expect(result).toEqual({ value: 26, source: 'USER_DEFAULT' })
  })
})

describe('UsersService.approveSeniorShareChange — AC3 (one atomic swap)', () => {
  it('swaps pending into active via the SAME transaction approveInTx used', async () => {
    const h = buildHarness({ seniorSharePercent: 26, pendingSeniorSharePercent: 80 })
    const updated = await h.service.approveSeniorShareChange('senior-1', seniorUser)

    expect(updated.user.seniorSharePercent).toBe(80) // task-648-fix-round-1 (SR-M-3): now buildProfileView's { user, permissions, data } shape
    // SR-M-3: the response is the allow-list DTO, not the raw `users` row —
    // `googleId` (SEC-09) does not exist as a key at all; `adminNote` exists
    // but is null-gated by `fields.adminNote` (false for this SENIOR self-view).
    expect(updated.user).not.toHaveProperty('googleId')
    expect(updated.user.adminNote).toBeNull()
    expect(h.userRow.seniorSharePercent).toBe(80)
    expect(h.userRow.pendingSeniorSharePercent).toBeNull()
    // The write went through `tx` (via updateUserRow's choke point), never
    // through `db.db` directly.
    expect(h.txUpdateCalls.map((c) => c.table)).toEqual([users])
    expect(h.topLevelUpdateCalls).toEqual([])
    expect(h.approvals.approveInTx).toHaveBeenCalledWith(h.txHandle, {
      subjectType: 'USER_SENIOR_SHARE',
      subjectId: 'senior-1',
      approverUserId: 'senior-1',
    })
    // Locked FOR UPDATE (not a plain select) before reading the pending value.
    expect(h.selectForCalls).toContain('update')
  })

  it('refuses impersonated sessions (consent must come from the approver themselves)', async () => {
    const h = buildHarness()
    await expect(
      h.service.approveSeniorShareChange('senior-1', impersonatedSenior),
    ).rejects.toThrow(ForbiddenException)
    expect(h.approvals.approveInTx).not.toHaveBeenCalled()
  })
})

describe('UsersService.rejectSeniorShareChange — AC4 (reason required, active untouched)', () => {
  it('discards the pending value and leaves the active percent untouched', async () => {
    const h = buildHarness({ seniorSharePercent: 26, pendingSeniorSharePercent: 80 })
    const updated = await h.service.rejectSeniorShareChange(
      'senior-1',
      'Слишком большой скачок',
      seniorUser,
    )
    expect(updated.user.seniorSharePercent).toBe(26) // task-648-fix-round-1 (SR-M-3): now buildProfileView's { user, permissions, data } shape
    expect(h.userRow.seniorSharePercent).toBe(26)
    expect(h.userRow.pendingSeniorSharePercent).toBeNull()
    expect(h.approvals.rejectInTx).toHaveBeenCalledWith(
      h.txHandle,
      expect.objectContaining({
        subjectType: 'USER_SENIOR_SHARE',
        subjectId: 'senior-1',
        approverUserId: 'senior-1',
        reason: 'Слишком большой скачок',
      }),
    )
  })
})

describe('UsersService — AC6 (past transactions never recalculated)', () => {
  it('approving a base-share change touches ONLY the users table, never transactions', async () => {
    const h = buildHarness({ seniorSharePercent: 26, pendingSeniorSharePercent: 80 })
    await h.service.approveSeniorShareChange('senior-1', seniorUser)
    // `transactions.senior_share_percent` is a snapshot written once at
    // income-creation time and never re-read by this flow — structurally
    // proven by the fact that no table other than `users` is EVER touched
    // by approve (a `transactions` update would show up here too).
    expect(h.txUpdateCalls.every((c) => c.table === users)).toBe(true)
  })
})

// AC7 (re-propose supersedes; both attempts stay in history with the
// rejection reason) is proven generically, subject-agnostically, by
// approvals.service.spec.ts (see projects.pending-share.spec.ts's identical
// note) — `proposeSeniorShareChangeInTx` / `rejectSeniorShareChange` are
// thin callers of `proposeInTx` / `rejectInTx`.

describe('UsersService — notification seam (position 6 hand-off)', () => {
  it('notifyPendingSeniorShareProposed fires exactly once, with the proposed + previous percent, when adminUpdateUser opens a proposal', async () => {
    const h = buildHarness({ seniorSharePercent: 26, pendingSeniorSharePercent: null })
    const spy = vi.spyOn(
      h.service as unknown as { notifyPendingSeniorShareProposed: (i: unknown) => void },
      'notifyPendingSeniorShareProposed',
    )
    await h.service.adminUpdateUser('senior-1', { seniorSharePercent: 80 }, 'admin-1')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith({
      subjectId: 'senior-1',
      approverUserId: 'senior-1',
      proposedPercent: 80,
      previousPercent: 26,
    })
  })

  it('does NOT fire when the request is a no-op (value unchanged)', async () => {
    const h = buildHarness({ seniorSharePercent: 26, pendingSeniorSharePercent: null })
    const spy = vi.spyOn(
      h.service as unknown as { notifyPendingSeniorShareProposed: (i: unknown) => void },
      'notifyPendingSeniorShareProposed',
    )
    await h.service.adminUpdateUser('senior-1', { seniorSharePercent: 26 }, 'admin-1')
    expect(spy).not.toHaveBeenCalled()
  })

  // task-648-fix-round-1 (SR-H-1, AC9 mutation-gate gap-fill): the tests
  // above only ever exercise the no-op branch with `pendingSeniorSharePercent:
  // null` — nothing to cancel, so `cancelSeniorShareChangeCore` 404s and the
  // early-return-null path is all that ever ran. NOTHING previously covered
  // the actual "I changed my mind" fix this task exists for: requesting the
  // CURRENT active value while a DIFFERENT value is genuinely pending.
  it('SR-H-1: requesting the ACTIVE value while a DIFFERENT value is pending CANCELS the open proposal (not a silent no-op)', async () => {
    const h = buildHarness({ seniorSharePercent: 26, pendingSeniorSharePercent: 80 })
    const result = await h.service.adminUpdateUser(
      'senior-1',
      { seniorSharePercent: 26 },
      'admin-1',
    )
    expect(h.approvals.cancelInTx).toHaveBeenCalledWith(h.txHandle, 'USER_SENIOR_SHARE', 'senior-1')
    expect(h.approvals.proposeInTx).not.toHaveBeenCalled()
    // The pending column is cleared by the cancel write — the stale-response
    // patch (adminUpdateUser's own fix, documented on
    // proposeSeniorShareChangeInTx) must reflect that in the SAME response,
    // not the pre-cancel row `updateUserRow` already returned.
    expect((result as { pendingSeniorSharePercent: unknown }).pendingSeniorSharePercent).toBeNull()
    // AC9 gap-fill: the response check above only proves the STALE-RESPONSE
    // PATCH's own hardcoded `{ pendingSeniorSharePercent: null }` literal —
    // it says nothing about whether `cancelSeniorShareChangeCore`'s actual
    // `.set({ pendingSeniorSharePercent: null, ... })` DB write happened.
    // Reading the row the mock's update chain actually mutated is what
    // makes that write itself observable.
    expect(h.userRow.pendingSeniorSharePercent).toBeNull()
  })

  it('SR-H-1: a genuine cancelInTx failure (not NotFoundException) propagates instead of being swallowed as a no-op', async () => {
    const h = buildHarness({ seniorSharePercent: 26, pendingSeniorSharePercent: 80 })
    h.approvals.cancelInTx.mockRejectedValue(new Error('db connection lost'))
    await expect(
      h.service.adminUpdateUser('senior-1', { seniorSharePercent: 26 }, 'admin-1'),
    ).rejects.toThrow('db connection lost')
  })
})

// ---------------------------------------------------------------------------
// task-pending-share follow-up (AC9 mutation-gate gap-fill, 2026-09-03): the
// blocks below close survivors the mutation gate found on the FULL diff that
// the blocks above did not reach — exact NotFoundException/impersonation
// messages, the archived-senior refusal, role-gating on the propose
// intercept, the missing-actorId guard (both callers), and the stale-
// response fix's own return-value contract (`proposeSeniorShareChangeInTx`'s
// true/false).
// ---------------------------------------------------------------------------

describe('UsersService.approveSeniorShareChange / rejectSeniorShareChange — exact messages + not-found', () => {
  it('approve: exact impersonation message', async () => {
    const h = buildHarness()
    await expect(
      h.service.approveSeniorShareChange('senior-1', impersonatedSenior),
    ).rejects.toThrow(
      'Подтвердить изменение доли может только сам приглашённый — через имперсонацию это сделать нельзя',
    )
  })

  it('approve: throws NotFoundException when the row-lock select finds nothing', async () => {
    const h = buildHarness()
    h.setSelectForUpdateRows([])
    await expect(h.service.approveSeniorShareChange('senior-1', seniorUser)).rejects.toThrow(
      'Пользователь не найден',
    )
  })

  // task-648-fix-round-1 (SR-M-3, AC9 mutation-gate gap-fill): the write
  // itself succeeds (real proposal existed, real update ran) — this is the
  // SEPARATE defensive guard on the re-fetch used to build the allow-listed
  // response (`buildProfileView`'s own subject). Genuinely defensive
  // (`findById(currentUser.id)` failing right after that same caller's
  // write just succeeded is an edge case, not a normal path) but still a
  // real branch the mutation gate expects a reason for, not a shrug.
  it('approve: throws (generic) ForbiddenException if the post-write viewer re-fetch comes back empty', async () => {
    const h = buildHarness()
    vi.spyOn(h.service, 'findById').mockResolvedValue(undefined)
    await expect(h.service.approveSeniorShareChange('senior-1', seniorUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('reject: exact impersonation message', async () => {
    const h = buildHarness()
    await expect(
      h.service.rejectSeniorShareChange('senior-1', 'причина', impersonatedSenior),
    ).rejects.toThrow(
      'Отклонить изменение доли может только сам приглашённый — через имперсонацию это сделать нельзя',
    )
    expect(h.approvals.rejectInTx).not.toHaveBeenCalled()
  })

  it('reject: throws NotFoundException when the UPDATE...RETURNING matches zero rows', async () => {
    const h = buildHarness()
    h.setEmptyReturning()
    await expect(
      h.service.rejectSeniorShareChange('senior-1', 'причина', seniorUser),
    ).rejects.toThrow('Пользователь не найден')
  })

  // task-648-fix-round-1 (SR-M-3, AC9 mutation-gate gap-fill): same
  // reasoning as approve's identical test above.
  it('reject: throws (generic) ForbiddenException if the post-write viewer re-fetch comes back empty', async () => {
    const h = buildHarness()
    vi.spyOn(h.service, 'findById').mockResolvedValue(undefined)
    await expect(
      h.service.rejectSeniorShareChange('senior-1', 'причина', seniorUser),
    ).rejects.toThrow(ForbiddenException)
  })
})

describe('UsersService.adminUpdateUser — proposeSeniorShareChangeInTx branches', () => {
  it('no-ops: proposeInTx NOT called and the response pendingSeniorSharePercent stays at its PRIOR value (not patched)', async () => {
    const h = buildHarness({ seniorSharePercent: 26, pendingSeniorSharePercent: null })
    const updated = await h.service.adminUpdateUser(
      'senior-1',
      { seniorSharePercent: 26 },
      'admin-1',
    )
    expect(h.approvals.proposeInTx).not.toHaveBeenCalled()
    expect(updated.pendingSeniorSharePercent).toBeNull()
    expect(h.userRow.pendingSeniorSharePercent).toBeNull()
  })

  it('proposes: response pendingSeniorSharePercent is patched to the NEW value (not the stale pre-write snapshot)', async () => {
    const h = buildHarness({ seniorSharePercent: 26, pendingSeniorSharePercent: null })
    const updated = await h.service.adminUpdateUser(
      'senior-1',
      { seniorSharePercent: 80 },
      'admin-1',
    )
    expect(updated.pendingSeniorSharePercent).toBe(80)
    expect(h.userRow.pendingSeniorSharePercent).toBe(80)
    // AC2 precondition: the ACTIVE column has not moved yet.
    expect(h.userRow.seniorSharePercent).toBe(26)
  })

  it('refuses to open a proposal for an archived senior', async () => {
    const h = buildHarness({
      seniorSharePercent: 26,
      pendingSeniorSharePercent: null,
      archivedAt: new Date('2026-01-01'),
    })
    await expect(
      h.service.adminUpdateUser('senior-1', { seniorSharePercent: 80 }, 'admin-1'),
    ).rejects.toThrow(ARCHIVED_ENTITLEMENT_MESSAGE)
  })

  it('does not propose when the effective role is not SENIOR, even if seniorSharePercent is present in the payload', async () => {
    const h = buildHarness({
      role: 'JUNIOR',
      seniorSharePercent: 26,
      pendingSeniorSharePercent: null,
    })
    const updated = await h.service.adminUpdateUser(
      'senior-1',
      { seniorSharePercent: 80 },
      'admin-1',
    )
    expect(h.approvals.proposeInTx).not.toHaveBeenCalled()
    expect(updated.pendingSeniorSharePercent).toBeNull()
  })

  it('throws BadRequestException when seniorSharePercent changes but no actorId is supplied', async () => {
    const h = buildHarness({ seniorSharePercent: 26, pendingSeniorSharePercent: null })
    await expect(h.service.adminUpdateUser('senior-1', { seniorSharePercent: 80 })).rejects.toThrow(
      'Смена доли требует определённого инициатора запроса',
    )
  })
})

describe('UsersService.changeSalary — proposeSeniorShareChangeInTx branch', () => {
  it('proposes (not applies) when seniorSharePercent is included, given an actorId', async () => {
    const h = buildHarness({ seniorSharePercent: 26, pendingSeniorSharePercent: null })
    const updated = await h.service.changeSalary('senior-1', { seniorSharePercent: 80 }, 'admin-1')
    expect(h.userRow.seniorSharePercent).toBe(26)
    expect(h.userRow.pendingSeniorSharePercent).toBe(80)
    expect(updated.pendingSeniorSharePercent).toBe(80)
    expect(h.approvals.proposeInTx).toHaveBeenCalledWith(
      h.txHandle,
      expect.objectContaining({
        subjectType: 'USER_SENIOR_SHARE',
        subjectId: 'senior-1',
        approverUserIds: ['senior-1'],
        proposedByUserId: 'admin-1',
      }),
    )
  })

  it('throws BadRequestException when seniorSharePercent changes but no actorId is supplied', async () => {
    const h = buildHarness({ seniorSharePercent: 26, pendingSeniorSharePercent: null })
    await expect(h.service.changeSalary('senior-1', { seniorSharePercent: 80 })).rejects.toThrow(
      'Смена доли требует определённого инициатора запроса',
    )
  })

  it('no-ops: response pendingSeniorSharePercent is NOT patched when the requested value equals the current one', async () => {
    const h = buildHarness({ seniorSharePercent: 26, pendingSeniorSharePercent: null })
    const updated = await h.service.changeSalary('senior-1', { seniorSharePercent: 26 }, 'admin-1')
    expect(h.approvals.proposeInTx).not.toHaveBeenCalled()
    expect(updated.pendingSeniorSharePercent).toBeNull()
    expect(h.userRow.pendingSeniorSharePercent).toBeNull()
  })

  // task-648-fix-round-1 (AC9 mutation-gate gap-fill): the test above's
  // `cancelSeniorShareChangeCore` call SUCCEEDS by default (harness's
  // `cancelInTx` mock has no state to check), so `proposeSeniorShareChangeInTx`
  // returns the TRUTHY `{ pendingSeniorSharePercent: null }` object there —
  // not the literal `null` early-return this test targets. Only forcing
  // `cancelInTx` to genuinely throw NotFoundException (nothing open to
  // cancel — the majority real-world case for a plain resubmit) reaches
  // that branch, which is what makes `if (shareChangeResult)` vs
  // `if (true)` an observable difference: the mutated version would try to
  // read `.pendingSeniorSharePercent` off `null` and throw a TypeError.
  it("changeSalary no-op with genuinely NOTHING pending: shareChangeResult is null, response keeps updateUserRow's own value untouched", async () => {
    const h = buildHarness({ seniorSharePercent: 26, pendingSeniorSharePercent: null })
    h.approvals.cancelInTx.mockRejectedValue(
      new NotFoundException('Подтверждение не найдено или уже закрыто'),
    )
    const updated = await h.service.changeSalary('senior-1', { seniorSharePercent: 26 }, 'admin-1')
    expect(updated.pendingSeniorSharePercent).toBeNull()
  })
})

// task-648-fix-round-1 (mutation-gate NoCoverage gap-fill, mirrors the
// identical `ProjectsService.cancelSeniorShareChange` block in
// projects.pending-share.spec.ts). NOTHING previously called the PUBLIC
// `cancelSeniorShareChange` directly — every existing test above reaches
// `cancelSeniorShareChangeCore` only through the private no-op branch inside
// `proposeSeniorShareChangeInTx`, which never exercises this method's own
// RBAC gate (`role !== 'ADMIN'`) or its post-write `findById`/`!viewer`
// guard. The mutation gate's own report flagged this exact span
// (users.service.ts:302-313) as NoCoverage with no integration-spec hint.
describe('UsersService.cancelSeniorShareChange — RBAC + actual effect', () => {
  it('rejects a SENIOR caller (RBAC: only ADMIN may cancel a base-share proposal)', async () => {
    const h = buildHarness()
    await expect(h.service.cancelSeniorShareChange('senior-1', seniorUser)).rejects.toThrow(
      'Отменить предложение по доле может только ADMIN',
    )
    expect(h.approvals.cancelInTx).not.toHaveBeenCalled()
  })

  it('ADMIN: calls approvals.cancelInTx with the exact subject, and clears pendingSeniorSharePercent on the user row', async () => {
    const h = buildHarness({ seniorSharePercent: 26, pendingSeniorSharePercent: 55 })
    await h.service.cancelSeniorShareChange('senior-1', adminUser)
    expect(h.approvals.cancelInTx).toHaveBeenCalledWith(h.txHandle, 'USER_SENIOR_SHARE', 'senior-1')
    expect(h.userRow.pendingSeniorSharePercent).toBeNull()
    // The ACTIVE value is untouched — cancel withdraws the PROPOSAL, never
    // the percent that is already live.
    expect(h.userRow.seniorSharePercent).toBe(26)
  })

  it('a genuine cancelInTx failure (not NotFoundException) propagates instead of being swallowed', async () => {
    const h = buildHarness({ pendingSeniorSharePercent: 55 })
    h.approvals.cancelInTx.mockRejectedValue(new Error('db connection lost'))
    await expect(h.service.cancelSeniorShareChange('senior-1', adminUser)).rejects.toThrow(
      'db connection lost',
    )
  })

  // CI mutation-gate finding (this round, caught on a fresh runner — NOT
  // reproduced by the same gate run locally, a coverage-analysis ordering
  // difference, not a reason to trust the local run over CI's): the write
  // itself succeeds (real proposal existed, real cancel ran) — this is the
  // SEPARATE defensive guard on the re-fetch used to build the allow-listed
  // response (`buildProfileView`'s own subject), same reasoning as
  // approve's/reject's identical tests above. Missed when
  // `cancelSeniorShareChange`'s own describe block was first written this
  // round — the sibling methods already had this test, this one didn't.
  it('throws (generic) ForbiddenException if the post-write viewer re-fetch comes back empty', async () => {
    const h = buildHarness({ pendingSeniorSharePercent: 55 })
    vi.spyOn(h.service, 'findById').mockResolvedValue(undefined)
    await expect(h.service.cancelSeniorShareChange('senior-1', adminUser)).rejects.toThrow(
      ForbiddenException,
    )
  })
})
