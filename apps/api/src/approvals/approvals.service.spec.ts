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
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { ApprovalsService } from './approvals.service'
import { approvals } from '../database/schema'
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

/**
 * Serializes a drizzle-orm `SQL` condition (e.g. the argument `.where(...)`
 * was called with) into a string, for an EXACT structural comparison
 * against a hand-built "expected" condition — see the `getRejectionReasons`
 * test below for why exact-match, not substring: a `pgEnum` column carries
 * its full `enumValues` (e.g. `["PENDING","APPROVED","REJECTED"]`) as
 * metadata on EVERY comparison against it, so `.toContain('REJECTED')`
 * would still pass even if the actual compared-against value were mutated
 * to `""` — the string is present in the column's own definition either
 * way. Comparing the WHOLE serialized shape against a condition built with
 * the SAME drizzle helpers cancels out identical metadata on both sides and
 * leaves only genuine differences (the compared value, the column, the
 * combinator) able to fail the assertion.
 *
 * A plain `JSON.stringify` throws on these objects (a column's `.table`
 * back-references the column itself); the WeakSet guard here drops any
 * object already visited, regardless of key name, which is what makes it
 * safe for arbitrary drizzle-orm versions, not just the one this file
 * happened to be written against.
 */
function serializeSqlCondition(condition: unknown): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(condition, (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return undefined
      seen.add(value)
    }
    return value
  })
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
    expect((err as Error).message).toBe('Согласование не найдено или уже погашено')
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
    expect((err as Error).message).toBe('Согласование уже получило ответ')
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
    expect((err as Error).message).toBe('Согласование не найдено или уже погашено')
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
    expect((err as Error).message).toBe('Согласование уже получило ответ')
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

describe('ApprovalsService.getRejectionReasons', () => {
  it('empty input never touches the DB (the caller-side guard exists for this, but the internal one is a backstop)', async () => {
    const select = vi.fn()
    const service = new ApprovalsService({ db: { select } } as unknown as DatabaseService)

    const result = await service.getRejectionReasons(SUBJECT_TYPE, [])

    expect(result).toEqual(new Map())
    expect(select).not.toHaveBeenCalled()
  })

  it('maps each REJECTED row to its reason, keyed by subjectId, querying only live (non-superseded) REJECTED rows of the given type', async () => {
    const rows = [
      { subjectId: 'proj-1', rejectionReason: 'Бюджет не подтверждён' },
      { subjectId: 'proj-2', rejectionReason: 'Не согласен с условиями' },
    ]
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => Promise.resolve(rows)),
    }
    const select = vi.fn(() => chain)
    const service = new ApprovalsService({ db: { select } } as unknown as DatabaseService)

    const result = await service.getRejectionReasons(SUBJECT_TYPE, ['proj-1', 'proj-2', 'proj-3'])

    expect(select).toHaveBeenCalledWith({
      subjectId: expect.anything(),
      rejectionReason: expect.anything(),
    })
    // Pins the actual WHERE predicate content — a mutant that swaps
    // 'REJECTED' for '' (or drops the subjectType/supersededAt legs) changes
    // this string but not `rows` (the chain is a stub, not a real filter),
    // so this is the assertion that actually observes the SQL, not just the
    // canned resolved value. Exact-match against a condition built with the
    // SAME drizzle helpers — see `serializeSqlCondition`'s own doc for why
    // NOT a substring check (the enum column's metadata already contains
    // the literal "REJECTED" regardless of what value was compared).
    const whereArg = chain.where.mock.calls[0]?.[0]
    const expectedWhere = and(
      eq(approvals.subjectType, SUBJECT_TYPE),
      inArray(approvals.subjectId, ['proj-1', 'proj-2', 'proj-3']),
      eq(approvals.status, 'REJECTED'),
      isNull(approvals.supersededAt),
    )
    expect(serializeSqlCondition(whereArg)).toBe(serializeSqlCondition(expectedWhere))
    expect(result).toEqual(
      new Map([
        ['proj-1', 'Бюджет не подтверждён'],
        ['proj-2', 'Не согласен с условиями'],
      ]),
    )
    // proj-3 was asked for but had no live REJECTED row (e.g. re-proposed
    // since) — absent from the map, not an empty-string entry.
    expect(result.has('proj-3')).toBe(false)
  })

  it('a row with a null/blank reason (defensive — the DB CHECK constraint should prevent this) is excluded, not mapped to null', async () => {
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => Promise.resolve([{ subjectId: 'proj-1', rejectionReason: null }])),
    }
    const service = new ApprovalsService({
      db: { select: vi.fn(() => chain) },
    } as unknown as DatabaseService)

    const result = await service.getRejectionReasons(SUBJECT_TYPE, ['proj-1'])

    expect(result.has('proj-1')).toBe(false)
  })
})

// SPEC-M-2 (PR #646 fix-round 1). Mirror of the getRejectionReasons block
// above — same batching contract, same "querying only live PENDING rows"
// concern, different status/shape (Set of approver ids per subject, not a
// single reason string, since a subject can have UP TO TWO live PENDING rows
// at once — this is exactly the case the method exists to distinguish from
// "one decided, one didn't").
describe('ApprovalsService.getPendingApproverIds', () => {
  it('empty input never touches the DB (the caller-side guard exists for this, but the internal one is a backstop)', async () => {
    const select = vi.fn()
    const service = new ApprovalsService({ db: { select } } as unknown as DatabaseService)

    const result = await service.getPendingApproverIds(SUBJECT_TYPE, [])

    expect(result).toEqual(new Map())
    expect(select).not.toHaveBeenCalled()
  })

  it('groups PENDING rows by subjectId into a Set of approverUserId, querying only live (non-superseded) PENDING rows of the given type', async () => {
    const rows = [
      { subjectId: 'proj-1', approverUserId: SENIOR_ID },
      { subjectId: 'proj-1', approverUserId: DROP_ID },
      { subjectId: 'proj-2', approverUserId: SENIOR_ID },
    ]
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => Promise.resolve(rows)),
    }
    const select = vi.fn(() => chain)
    const service = new ApprovalsService({ db: { select } } as unknown as DatabaseService)

    const result = await service.getPendingApproverIds(SUBJECT_TYPE, ['proj-1', 'proj-2', 'proj-3'])

    expect(select).toHaveBeenCalledWith({
      subjectId: expect.anything(),
      approverUserId: expect.anything(),
    })
    // Exact-match against a condition built with the SAME drizzle helpers —
    // see getRejectionReasons's own test above for why not a substring check.
    const whereArg = chain.where.mock.calls[0]?.[0]
    const expectedWhere = and(
      eq(approvals.subjectType, SUBJECT_TYPE),
      inArray(approvals.subjectId, ['proj-1', 'proj-2', 'proj-3']),
      eq(approvals.status, 'PENDING'),
      isNull(approvals.supersededAt),
    )
    expect(serializeSqlCondition(whereArg)).toBe(serializeSqlCondition(expectedWhere))
    expect(result.get('proj-1')).toEqual(new Set([SENIOR_ID, DROP_ID]))
    expect(result.get('proj-2')).toEqual(new Set([SENIOR_ID]))
    // proj-3 was asked for but had no live PENDING row (e.g. both already
    // decided) — absent from the map, not an empty Set entry. Callers treat
    // absence and an empty Set identically (`?.has(id) ?? false`).
    expect(result.has('proj-3')).toBe(false)
  })

  it('two PENDING rows for the SAME subject and approver (should not happen — one live row per approver per generation) still dedupe via Set, not an inflated Set', async () => {
    const rows = [
      { subjectId: 'proj-1', approverUserId: SENIOR_ID },
      { subjectId: 'proj-1', approverUserId: SENIOR_ID },
    ]
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => Promise.resolve(rows)),
    }
    const service = new ApprovalsService({
      db: { select: vi.fn(() => chain) },
    } as unknown as DatabaseService)

    const result = await service.getPendingApproverIds(SUBJECT_TYPE, ['proj-1'])

    expect(result.get('proj-1')?.size).toBe(1)
  })
})
