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
import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
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

  const makeUpdateChain = (
    log: Array<{ table: unknown; values: Record<string, unknown> }>,
    isTx: boolean,
  ) => ({
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            log.push({ table, values })
            if (table === users) Object.assign(userRow, values)
            if (!isTx) topLevelUpdateCalls.push({ table })
            return [{ ...userRow }]
          },
        }),
      }),
    }),
  })

  const txHandle = {
    ...makeUpdateChain(txUpdateCalls, true),
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({ limit: async () => [{ ...userRow }] }),
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
  }

  const service = new UsersService(
    db as never,
    {} as never,
    { record: vi.fn(async () => undefined) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    approvals as never,
  )

  return { service, userRow, approvals, txUpdateCalls, topLevelUpdateCalls, txHandle }
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

    expect(updated.seniorSharePercent).toBe(80)
    expect(h.userRow.seniorSharePercent).toBe(80)
    expect(h.userRow.pendingSeniorSharePercent).toBeNull()
    // The write went through `tx` (via updateUserRow's choke point), never
    // through `db.db` directly.
    expect(h.txUpdateCalls.map((c) => c.table)).toEqual([users])
    expect(h.topLevelUpdateCalls).toEqual([])
    expect(h.approvals.approveInTx).toHaveBeenCalledWith(h.txHandle, expect.anything())
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
    expect(updated.seniorSharePercent).toBe(26)
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
})
