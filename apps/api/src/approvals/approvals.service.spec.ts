/**
 * Unit tests for ApprovalsService — the mocked-DB counterpart to
 * `approvals.integration.spec.ts`. Per
 * `.claude/rules/common/mutation-gate-integration-specs.md`, Stryker cannot
 * execute the integration spec at all, so THIS file is what the mutation gate
 * actually sees — it covers:
 *   - every Zod-validation branch (proven here to throw BEFORE the DB is
 *     ever touched — a poisoned db stub makes "never touched" an assertion,
 *     not an assumption)
 *   - the two ways approve()/reject() legitimately fail to apply
 *     (NotFoundException / ConflictException)
 *   - the happy paths, with the exact update()/insert() payloads asserted
 *   - getStatus()'s four-way aggregation, tested as pure logic by stubbing
 *     out listLive() (real listLive()/cascade behaviour is what the
 *     integration spec proves against a real Postgres — mocking a multi-row
 *     transactional UPDATE here would just restate it, not verify it).
 */
import { describe, expect, it, vi } from 'vitest'
import { ConflictException, NotFoundException } from '@nestjs/common'
import { ApprovalsService } from './approvals.service'
import type { DatabaseService } from '../database/database.service'

const SUBJECT_TYPE = 'TEST_SUBJECT'
const SUBJECT_ID = 'b1000000-0000-4000-a000-000000000001'
const SENIOR_ID = 'b1000000-0000-4000-a000-000000000002'
const DROP_ID = 'b1000000-0000-4000-a000-000000000003'
const ADMIN_ID = 'b1000000-0000-4000-a000-000000000004'

// ---------------------------------------------------------------------------
// Row fixture
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'b1000000-0000-4000-a000-000000000101',
    subjectType: SUBJECT_TYPE,
    subjectId: SUBJECT_ID,
    approverUserId: SENIOR_ID,
    status: 'PENDING' as const,
    rejectionReason: null,
    decidedAt: null,
    proposedByUserId: ADMIN_ID,
    supersededAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Chain builders — each call to tx.select()/tx.update()/tx.insert() must
// return an INDEPENDENT chain instance (a test may issue several distinct
// calls per method within one service call, e.g. reject()'s row-update THEN
// its sibling-supersede update), so these are factories, not singletons.
// ---------------------------------------------------------------------------

function makeSelectForUpdateChain(row: unknown | null) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    for: vi.fn(() => chain),
    limit: vi.fn().mockResolvedValue(row ? [row] : []),
  }
  return chain
}

/**
 * `lockLiveRows`'s chain shape (CR-H-1 fix) — `.select().from().where()
 * .orderBy().for('update')`, resolving to ALL live rows for the subject in
 * one call, unlike `makeSelectForUpdateChain`'s single-row `.limit(1)`
 * shape (still used by `loadLiveRowForUpdate`/approve()).
 */
function makeSelectAllForUpdateChain(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    for: vi.fn().mockResolvedValue(rows),
  }
  return chain
}

/**
 * `.where(...)` must be BOTH directly awaitable (the sibling-supersede
 * cascade never calls `.returning()`) AND further chainable to
 * `.returning()` (the row-level update does) — same duality
 * `update(...).set(...).where(...)` has for real drizzle query builders,
 * which implement `PromiseLike` themselves.
 */
function makeUpdateChain(returningRows: unknown[]) {
  const whereResult = {
    returning: vi.fn().mockResolvedValue(returningRows),
    then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(returningRows).then(resolve, reject),
  }
  const chain = {
    set: vi.fn(() => chain),
    where: vi.fn(() => whereResult),
  }
  return chain
}

function makeInsertChain(returningRows: unknown[]) {
  const valuesFn = vi.fn(() => ({ returning: vi.fn().mockResolvedValue(returningRows) }))
  return { values: valuesFn }
}

/** A db stub whose every query method throws — proves "validation ran before any DB call". */
function makePoisonedDb(): DatabaseService {
  const explode = () => {
    throw new Error('DB REACHED — validation should have thrown first')
  }
  return {
    db: {
      transaction: explode,
      select: explode,
      insert: explode,
      update: explode,
    },
  } as unknown as DatabaseService
}

function makeService(txHandle: Record<string, unknown>) {
  const db = {
    db: { transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txHandle)) },
  } as unknown as DatabaseService
  return new ApprovalsService(db)
}

/** Runs `fn`, returns the rejection it throws (never the resolved value). */
async function catchRejection(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  throw new Error('expected fn() to reject, but it resolved')
}

// ---------------------------------------------------------------------------
// Zod validation — throws before the DB is ever touched
// ---------------------------------------------------------------------------

describe('ApprovalsService — input validation runs before any DB call', () => {
  it('propose() rejects an empty approverUserIds array', async () => {
    const service = new ApprovalsService(makePoisonedDb())
    await expect(
      service.propose({
        subjectType: SUBJECT_TYPE,
        subjectId: SUBJECT_ID,
        approverUserIds: [],
        proposedByUserId: ADMIN_ID,
      }),
    ).rejects.toThrow()
  })

  it('propose() rejects duplicate approverUserIds', async () => {
    const service = new ApprovalsService(makePoisonedDb())
    await expect(
      service.propose({
        subjectType: SUBJECT_TYPE,
        subjectId: SUBJECT_ID,
        approverUserIds: [SENIOR_ID, SENIOR_ID],
        proposedByUserId: ADMIN_ID,
      }),
    ).rejects.toThrow()
  })

  it('reject() rejects a blank reason', async () => {
    const service = new ApprovalsService(makePoisonedDb())
    await expect(
      service.reject({
        subjectType: SUBJECT_TYPE,
        subjectId: SUBJECT_ID,
        approverUserId: SENIOR_ID,
        reason: '   ',
      }),
    ).rejects.toThrow()
  })

  it('reject() rejects a missing reason field entirely', async () => {
    const service = new ApprovalsService(makePoisonedDb())
    await expect(
      service.reject({
        subjectType: SUBJECT_TYPE,
        subjectId: SUBJECT_ID,
        approverUserId: SENIOR_ID,
      } as never),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// propose() — happy path
// ---------------------------------------------------------------------------

describe('ApprovalsService.propose', () => {
  it('supersedes any live rows for the subject, then inserts one PENDING row per approver', async () => {
    const supersedeChain = makeUpdateChain([])
    const insertChain = makeInsertChain([
      makeRow({ id: 'b1000000-0000-4000-a000-000000000102', approverUserId: SENIOR_ID }),
      makeRow({ id: 'b1000000-0000-4000-a000-000000000103', approverUserId: DROP_ID }),
    ])
    const { values: valuesFn } = insertChain
    // CR-H-1 (code-review, PR #624): supersedeLiveRows now locks the live
    // rows (a SELECT … ORDER BY id FOR UPDATE) BEFORE writing to them —
    // same deterministic-order-first shape reject() uses. No live rows for
    // this fresh subject, so the lock query resolves empty.
    const lockChain = makeSelectAllForUpdateChain([])
    const txHandle = {
      select: vi.fn(() => lockChain),
      update: vi.fn(() => supersedeChain),
      insert: vi.fn(() => insertChain),
    }

    const service = makeService(txHandle)
    const result = await service.propose({
      subjectType: SUBJECT_TYPE,
      subjectId: SUBJECT_ID,
      approverUserIds: [SENIOR_ID, DROP_ID],
      proposedByUserId: ADMIN_ID,
    })

    expect(txHandle.select).toHaveBeenCalledTimes(1)
    expect(lockChain.orderBy).toHaveBeenCalledTimes(1)
    expect(lockChain.for).toHaveBeenCalledWith('update')
    expect(txHandle.update).toHaveBeenCalledTimes(1)
    // The supersede update must actually SET supersededAt — not a no-op {}
    // (kills the ObjectLiteral→{} mutant on supersedeLiveRows).
    const supersedeSetArg = supersedeChain.set.mock.calls[0]![0] as Record<string, unknown>
    expect(supersedeSetArg).toHaveProperty('supersededAt')
    expect(supersedeSetArg['supersededAt']).toBeInstanceOf(Date)

    expect(valuesFn).toHaveBeenCalledTimes(1)
    const insertedRows = valuesFn.mock.calls[0]![0] as Array<Record<string, unknown>>
    expect(insertedRows).toHaveLength(2)
    expect(insertedRows.map((r) => r['approverUserId'])).toEqual([SENIOR_ID, DROP_ID])
    expect(insertedRows.every((r) => r['status'] === 'PENDING')).toBe(true)
    expect(insertedRows.every((r) => r['proposedByUserId'] === ADMIN_ID)).toBe(true)

    expect(result).toHaveLength(2)
    expect(result.map((r) => r.approverUserId)).toEqual([SENIOR_ID, DROP_ID])
    expect(result.every((r) => r.status === 'PENDING')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// approve()
// ---------------------------------------------------------------------------

describe('ApprovalsService.approve', () => {
  it('throws NotFoundException with the exact user-facing message when there is no live row', async () => {
    const selectChain = makeSelectForUpdateChain(null)
    const txHandle = { select: vi.fn(() => selectChain), update: vi.fn() }
    const service = makeService(txHandle)

    const err = await catchRejection(() =>
      service.approve({
        subjectType: SUBJECT_TYPE,
        subjectId: SUBJECT_ID,
        approverUserId: SENIOR_ID,
      }),
    )
    expect(err).toBeInstanceOf(NotFoundException)
    expect((err as Error).message).toBe('Подтверждение не найдено или уже закрыто')
    expect(txHandle.update).not.toHaveBeenCalled()
    // The row lookup must lock FOR UPDATE, not for an empty/mutated mode
    // (kills the StringLiteral→"" mutant on .for('update')).
    expect(selectChain.for).toHaveBeenCalledWith('update')
  })

  it('throws ConflictException with the exact user-facing message when the row already left PENDING', async () => {
    const decidedRow = makeRow({ status: 'APPROVED', decidedAt: new Date('2026-09-01T01:00:00Z') })
    const txHandle = { select: vi.fn(() => makeSelectForUpdateChain(decidedRow)), update: vi.fn() }
    const service = makeService(txHandle)

    const err = await catchRejection(() =>
      service.approve({
        subjectType: SUBJECT_TYPE,
        subjectId: SUBJECT_ID,
        approverUserId: SENIOR_ID,
      }),
    )
    expect(err).toBeInstanceOf(ConflictException)
    expect((err as Error).message).toBe('Подтверждение уже получило ответ')
    expect(txHandle.update).not.toHaveBeenCalled()
  })

  it('sets status=APPROVED and stamps decidedAt on the live PENDING row', async () => {
    const pendingRow = makeRow()
    const updatedRow = makeRow({ status: 'APPROVED', decidedAt: new Date('2026-09-01T02:00:00Z') })
    const updateChain = makeUpdateChain([updatedRow])
    const txHandle = {
      select: vi.fn(() => makeSelectForUpdateChain(pendingRow)),
      update: vi.fn(() => updateChain),
    }
    const service = makeService(txHandle)

    const result = await service.approve({
      subjectType: SUBJECT_TYPE,
      subjectId: SUBJECT_ID,
      approverUserId: SENIOR_ID,
    })

    expect(result.status).toBe('APPROVED')
    expect(result.decidedAt).toBe('2026-09-01T02:00:00.000Z')
    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>
    expect(setArg['status']).toBe('APPROVED')
    expect(setArg['decidedAt']).toBeInstanceOf(Date)
  })

  it('throws a generic Error if the update somehow returns no row (defensive branch)', async () => {
    const pendingRow = makeRow()
    const emptyUpdateChain = makeUpdateChain([]) // .returning() resolves []
    const txHandle = {
      select: vi.fn(() => makeSelectForUpdateChain(pendingRow)),
      update: vi.fn(() => emptyUpdateChain),
    }
    const service = makeService(txHandle)

    await expect(
      service.approve({
        subjectType: SUBJECT_TYPE,
        subjectId: SUBJECT_ID,
        approverUserId: SENIOR_ID,
      }),
    ).rejects.toThrow('Failed to record approval')
  })
})

// ---------------------------------------------------------------------------
// reject()
// ---------------------------------------------------------------------------

describe('ApprovalsService.reject', () => {
  it('locates the response by approverUserId, not by array position (kills the find(r=>true) mutant)', async () => {
    // The FIRST locked row deliberately belongs to a DIFFERENT approver
    // whose row is already decided — if reject() picked "whatever
    // lockLiveRows returned first" instead of "the live row matching
    // input.approverUserId", it would run assertRespondable against THAT
    // row (APPROVED, not PENDING) and throw ConflictException, even though
    // the caller's OWN row is still PENDING and perfectly respondable.
    const otherApproverDecided = makeRow({
      id: 'b1000000-0000-4000-a000-000000000201',
      approverUserId: DROP_ID,
      status: 'APPROVED',
      decidedAt: new Date('2026-09-01T00:30:00Z'),
    })
    const ownPendingRow = makeRow({ id: 'b1000000-0000-4000-a000-000000000202' })
    const rejectedRow = makeRow({
      id: 'b1000000-0000-4000-a000-000000000202',
      status: 'REJECTED',
      rejectionReason: 'Не согласен',
      decidedAt: new Date('2026-09-01T03:30:00Z'),
    })
    const txHandle = {
      select: vi.fn(() => makeSelectAllForUpdateChain([otherApproverDecided, ownPendingRow])),
      update: vi.fn(() => makeUpdateChain([rejectedRow])),
    }
    const service = makeService(txHandle)

    const result = await service.reject({
      subjectType: SUBJECT_TYPE,
      subjectId: SUBJECT_ID,
      approverUserId: SENIOR_ID,
      reason: 'Не согласен',
    })
    expect(result.status).toBe('REJECTED')
  })

  it('throws NotFoundException with the exact user-facing message when there is no live row', async () => {
    // CR-H-1 (code-review, PR #624): reject() now locks EVERY live row for
    // the subject (lockLiveRows), not just the caller's own — no live rows
    // at all means .find() cannot locate one for SENIOR_ID either.
    const selectChain = makeSelectAllForUpdateChain([])
    const txHandle = { select: vi.fn(() => selectChain), update: vi.fn() }
    const service = makeService(txHandle)

    const err = await catchRejection(() =>
      service.reject({
        subjectType: SUBJECT_TYPE,
        subjectId: SUBJECT_ID,
        approverUserId: SENIOR_ID,
        reason: 'Не согласен',
      }),
    )
    expect(err).toBeInstanceOf(NotFoundException)
    expect((err as Error).message).toBe('Подтверждение не найдено или уже закрыто')
    expect(txHandle.update).not.toHaveBeenCalled()
    expect(selectChain.orderBy).toHaveBeenCalledTimes(1)
    expect(selectChain.for).toHaveBeenCalledWith('update')
  })

  it('throws ConflictException with the exact user-facing message when the row already left PENDING', async () => {
    const decidedRow = makeRow({ status: 'REJECTED', decidedAt: new Date(), rejectionReason: 'x' })
    const txHandle = {
      select: vi.fn(() => makeSelectAllForUpdateChain([decidedRow])),
      update: vi.fn(),
    }
    const service = makeService(txHandle)

    const err = await catchRejection(() =>
      service.reject({
        subjectType: SUBJECT_TYPE,
        subjectId: SUBJECT_ID,
        approverUserId: SENIOR_ID,
        reason: 'Ещё раз',
      }),
    )
    expect(err).toBeInstanceOf(ConflictException)
    expect((err as Error).message).toBe('Подтверждение уже получило ответ')
    expect(txHandle.update).not.toHaveBeenCalled()
  })

  it('throws a generic Error if the row-update somehow returns no row (defensive branch)', async () => {
    const pendingRow = makeRow()
    const emptyUpdateChain = makeUpdateChain([]) // .returning() resolves []
    const txHandle = {
      select: vi.fn(() => makeSelectAllForUpdateChain([pendingRow])),
      update: vi.fn(() => emptyUpdateChain),
    }
    const service = makeService(txHandle)

    await expect(
      service.reject({
        subjectType: SUBJECT_TYPE,
        subjectId: SUBJECT_ID,
        approverUserId: SENIOR_ID,
        reason: 'Не согласен',
      }),
    ).rejects.toThrow('Failed to record rejection')
  })

  it('sets status=REJECTED with the reason on the row, THEN supersedes every other live sibling', async () => {
    const pendingRow = makeRow()
    const rejectedRow = makeRow({
      status: 'REJECTED',
      rejectionReason: 'Не согласен с условиями',
      decidedAt: new Date('2026-09-01T03:00:00Z'),
    })
    const rowUpdateChain = makeUpdateChain([rejectedRow])
    const cascadeChain = makeUpdateChain([])
    const updateCalls: unknown[] = []
    const txHandle = {
      select: vi.fn(() => makeSelectAllForUpdateChain([pendingRow])),
      update: vi.fn(() => {
        // First call = the row itself (returning()); second = the cascade
        // (awaited directly, no returning()). A fresh chain each time,
        // exactly like two independent drizzle `.update()` calls.
        const chain = updateCalls.length === 0 ? rowUpdateChain : cascadeChain
        updateCalls.push(chain)
        return chain
      }),
    }
    const service = makeService(txHandle)

    const result = await service.reject({
      subjectType: SUBJECT_TYPE,
      subjectId: SUBJECT_ID,
      approverUserId: SENIOR_ID,
      reason: 'Не согласен с условиями',
    })

    expect(result.status).toBe('REJECTED')
    expect(result.rejectionReason).toBe('Не согласен с условиями')
    expect(txHandle.update).toHaveBeenCalledTimes(2)

    const rowSetArg = rowUpdateChain.set.mock.calls[0]![0] as Record<string, unknown>
    expect(rowSetArg['status']).toBe('REJECTED')
    expect(rowSetArg['rejectionReason']).toBe('Не согласен с условиями')

    const cascadeSetArg = cascadeChain.set.mock.calls[0]![0] as Record<string, unknown>
    expect(cascadeSetArg).toHaveProperty('supersededAt')
    expect(cascadeSetArg['status']).toBeUndefined() // cascade never touches status/reason on siblings
  })
})

// ---------------------------------------------------------------------------
// cancel() — task-648-fix-round-1 (SR-H-1)
// ---------------------------------------------------------------------------

describe('ApprovalsService.cancel', () => {
  it('throws NotFoundException with the exact user-facing message when there is no live row at all', async () => {
    const selectChain = makeSelectAllForUpdateChain([])
    const txHandle = { select: vi.fn(() => selectChain), update: vi.fn() }
    const service = makeService(txHandle)

    const err = await catchRejection(() => service.cancel(SUBJECT_TYPE, SUBJECT_ID))
    expect(err).toBeInstanceOf(NotFoundException)
    expect((err as Error).message).toBe('Подтверждение не найдено или уже закрыто')
    expect(txHandle.update).not.toHaveBeenCalled()
  })

  // This is the test that must fail RED before the `pendingRows.filter(...)`
  // guard exists: a version of cancelInTx that only checked "any live row"
  // (matching lockLiveRows' own liveRows.length, the same shape reject()
  // uses) would happily cancel an ALREADY-APPROVED single-approver row here
  // — misrepresenting a real, already-applied decision as withdrawn.
  it('throws NotFoundException (nothing OPEN to cancel) when the only live row already left PENDING', async () => {
    const approvedRow = makeRow({ status: 'APPROVED', decidedAt: new Date() })
    const txHandle = {
      select: vi.fn(() => makeSelectAllForUpdateChain([approvedRow])),
      update: vi.fn(),
    }
    const service = makeService(txHandle)

    const err = await catchRejection(() => service.cancel(SUBJECT_TYPE, SUBJECT_ID))
    expect(err).toBeInstanceOf(NotFoundException)
    expect((err as Error).message).toBe('Подтверждение не найдено или уже закрыто')
    expect(txHandle.update).not.toHaveBeenCalled()
  })

  it('sets status=CANCELLED + decidedAt + supersededAt on the PENDING row, in ONE update (no per-row .returning() round-trip)', async () => {
    const pendingRow = makeRow()
    const updateChain = makeUpdateChain([])
    const txHandle = {
      select: vi.fn(() => makeSelectAllForUpdateChain([pendingRow])),
      update: vi.fn(() => updateChain),
    }
    const service = makeService(txHandle)

    await service.cancel(SUBJECT_TYPE, SUBJECT_ID)

    expect(txHandle.update).toHaveBeenCalledTimes(1)
    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>
    expect(setArg['status']).toBe('CANCELLED')
    expect(setArg['decidedAt']).toBeInstanceOf(Date)
    expect(setArg['supersededAt']).toBeInstanceOf(Date)
    // Cancel never asks for or writes a reason — distinct from reject().
    expect(setArg).not.toHaveProperty('rejectionReason')
  })

  it('a mix of one APPROVED sibling + one PENDING row still cancels (the PENDING one) instead of 404ing', async () => {
    // Hypothetical multi-approver subject: proves the guard is "at least one
    // PENDING row", not "every live row is PENDING" — a partially-approved
    // generation can still have its remaining open ask withdrawn.
    const approvedSibling = makeRow({
      id: 'b1000000-0000-4000-a000-000000000301',
      approverUserId: DROP_ID,
      status: 'APPROVED',
      decidedAt: new Date(),
    })
    const pendingRow = makeRow({ id: 'b1000000-0000-4000-a000-000000000302' })
    const updateChain = makeUpdateChain([])
    const txHandle = {
      select: vi.fn(() => makeSelectAllForUpdateChain([approvedSibling, pendingRow])),
      update: vi.fn(() => updateChain),
    }
    const service = makeService(txHandle)

    await service.cancel(SUBJECT_TYPE, SUBJECT_ID)
    expect(txHandle.update).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// getStatus() — pure aggregation logic, listLive() stubbed
// ---------------------------------------------------------------------------

describe('ApprovalsService.getStatus', () => {
  it('is NONE when there are no live rows', async () => {
    const service = makeService({})
    vi.spyOn(service, 'listLive').mockResolvedValue([])
    expect(await service.getStatus(SUBJECT_TYPE, SUBJECT_ID)).toBe('NONE')
  })

  it('is PENDING when at least one live row still awaits a response (partial agreement)', async () => {
    const service = makeService({})
    vi.spyOn(service, 'listLive').mockResolvedValue([
      {
        ...makeRow({ status: 'APPROVED' }),
        createdAt: 'x',
        decidedAt: 'x',
        supersededAt: null,
      } as never,
      {
        ...makeRow({ status: 'PENDING' }),
        createdAt: 'x',
        decidedAt: null,
        supersededAt: null,
      } as never,
    ])
    expect(await service.getStatus(SUBJECT_TYPE, SUBJECT_ID)).toBe('PENDING')
  })

  it('is APPROVED when every live row is APPROVED', async () => {
    const service = makeService({})
    vi.spyOn(service, 'listLive').mockResolvedValue([
      {
        ...makeRow({ status: 'APPROVED' }),
        createdAt: 'x',
        decidedAt: 'x',
        supersededAt: null,
      } as never,
      {
        ...makeRow({ status: 'APPROVED' }),
        createdAt: 'x',
        decidedAt: 'x',
        supersededAt: null,
      } as never,
    ])
    expect(await service.getStatus(SUBJECT_TYPE, SUBJECT_ID)).toBe('APPROVED')
  })

  it('is REJECTED when any live row is REJECTED, even if others are APPROVED', async () => {
    const service = makeService({})
    vi.spyOn(service, 'listLive').mockResolvedValue([
      {
        ...makeRow({ status: 'APPROVED' }),
        createdAt: 'x',
        decidedAt: 'x',
        supersededAt: null,
      } as never,
      {
        ...makeRow({ status: 'REJECTED', rejectionReason: 'x' }),
        createdAt: 'x',
        decidedAt: 'x',
        supersededAt: null,
      } as never,
    ])
    expect(await service.getStatus(SUBJECT_TYPE, SUBJECT_ID)).toBe('REJECTED')
  })
})
