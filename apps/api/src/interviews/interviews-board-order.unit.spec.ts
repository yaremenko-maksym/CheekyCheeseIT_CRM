/**
 * CR2-L-1 — the Kanban board's row order must be TOTAL.
 *
 * `position` is not unique: the sourcing queue gives a new SUBMITTED card `max(position) + 1`
 * read inside its own transaction, so two concurrent submits for one senior can tie. With
 * `[stage, position]` alone a tie leaves the order to whatever Postgres returns, and two reads
 * of the same board can disagree — cards appear to swap places on refresh.
 *
 * This is the mutation-gate twin of that fix: the gate runs the UNIT suite only and cannot
 * execute an `*.integration.spec.ts` at all (`.claude/rules/common/mutation-gate-integration-specs.md`),
 * so without this file the `orderBy` array on `findBySenior` is invisible to
 * `mutation-gate.mjs --changed`. The real-DB proof that Postgres then actually returns the tied
 * rows in `created_at` order is the `LIST 1b.` case in `interviews-rbac.integration.spec.ts`.
 *
 * It asserts the COMPILED SQL of each `orderBy` entry, not that "findMany was called": drop an
 * entry, reorder two, or swap `asc` for `desc`, and the expected array no longer matches.
 */
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SessionUser } from '@crm/shared'
import { describe, expect, it } from 'vitest'

import { InterviewsService } from './interviews.service'

const ADMIN = {
  id: '0b0a0000-0000-4000-aa00-000000000001',
  email: 'board-order-admin@test.spec',
  displayName: 'Board Order Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 50,
  legalFullName: null,
} satisfies SessionUser

const SENIOR_ID = '0b0a0000-0000-4000-aa00-000000000002'

describe('InterviewsService.findBySenior — board ordering', () => {
  it('orders by stage, then position, then created_at, then id', async () => {
    let captured: SQL[] | undefined
    const db = {
      db: {
        query: {
          interviews: {
            findMany: (args: { orderBy: SQL[] }) => {
              captured = args.orderBy
              return Promise.resolve([])
            },
          },
        },
      },
    }

    const service = new InterviewsService(db as never, {} as never, {} as never)
    await service.findBySenior(SENIOR_ID, ADMIN)

    const dialect = new PgDialect()
    expect(captured?.map((entry) => dialect.sqlToQuery(entry).sql)).toEqual([
      '"interviews"."stage" asc',
      '"interviews"."position" asc',
      '"interviews"."created_at" asc',
      '"interviews"."id" asc',
    ])
  })
})

describe('InterviewsService.move — position renormalisation order (SO-L-2)', () => {
  it('orders old and new column queries by position, then created_at, then id', async () => {
    const cardId = '0b0a0000-0000-4000-aa00-000000000003'
    const card = {
      id: cardId,
      seniorId: SENIOR_ID,
      stage: 'APPLIED',
      position: 0,
      companyName: 'Acme Corp',
      senior: { displayName: 'Senior Name' },
      hr: null,
      createdAt: new Date('2026-11-19T10:00:00Z'),
      updatedAt: new Date('2026-11-19T10:00:00Z'),
    }

    const capturedOrderBy: SQL[][] = []
    const fakeUpdate = {
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }

    const tx = {
      execute: () => Promise.resolve({ rows: [{ id: cardId, stage: card.stage }] }),
      update: () => fakeUpdate,
      query: {
        interviews: {
          findMany: (args: { orderBy: SQL[] }) => {
            capturedOrderBy.push(args.orderBy)
            return Promise.resolve([])
          },
          findFirst: () => Promise.resolve(card),
        },
      },
    }

    const db = {
      db: {
        query: {
          interviews: {
            findFirst: () => Promise.resolve(card),
          },
        },
        transaction: async <T>(cb: (txArg: typeof tx) => Promise<T>): Promise<T> => cb(tx),
      },
    }

    const accessPolicy = {
      assertUpdateAccess: () => Promise.resolve(),
    }

    const service = new InterviewsService(db as never, {} as never, accessPolicy as never)
    await service.move(cardId, { stage: 'HR_SCREEN', position: 1 }, ADMIN)

    const dialect = new PgDialect()
    const expected = [
      '"interviews"."position" asc',
      '"interviews"."created_at" asc',
      '"interviews"."id" asc',
    ]

    expect(capturedOrderBy.length).toBe(2)
    expect(capturedOrderBy[0]?.map((entry) => dialect.sqlToQuery(entry).sql)).toEqual(expected)
    expect(capturedOrderBy[1]?.map((entry) => dialect.sqlToQuery(entry).sql)).toEqual(expected)
  })

  it('renumbers column cards placing moved card at targetIndex (CR4-M-1, SPEC-L-1, SPEC-L-2)', async () => {
    const cardId = '0b0a0000-0000-4000-aa00-000000000003'
    const incumbentAId = '0b0a0000-0000-4000-aa00-000000000004'
    const incumbentBId = '0b0a0000-0000-4000-aa00-000000000005'

    const card = {
      id: cardId,
      seniorId: SENIOR_ID,
      stage: 'HR_SCREEN',
      position: 3,
      companyName: 'Acme Corp',
      senior: { displayName: 'Senior Name' },
      hr: null,
      createdAt: new Date('2026-11-19T10:00:03Z'),
      updatedAt: new Date('2026-11-19T10:00:03Z'),
    }

    const updates: Array<{ whereArg: unknown; setArg: unknown }> = []
    const tx = {
      execute: () => Promise.resolve({ rows: [{ id: cardId, stage: card.stage }] }),
      update: () => ({
        set: (setArg: unknown) => ({
          where: (whereArg: unknown) => {
            updates.push({ whereArg, setArg })
            return Promise.resolve()
          },
        }),
      }),
      query: {
        interviews: {
          findMany: () =>
            Promise.resolve([
              { id: incumbentAId, position: 0 },
              { id: incumbentBId, position: 1 },
            ]),
          findFirst: () => Promise.resolve(card),
        },
      },
    }

    const db = {
      db: {
        query: {
          interviews: {
            findFirst: () => Promise.resolve(card),
          },
        },
        transaction: async <T>(cb: (txArg: typeof tx) => Promise<T>): Promise<T> => cb(tx),
      },
    }

    const service = new InterviewsService(
      db as never,
      {} as never,
      {
        assertUpdateAccess: () => Promise.resolve(),
      } as never,
    )

    // Move cardId to position 1 in same stage HR_SCREEN
    await service.move(cardId, { stage: 'HR_SCREEN', position: 1 }, ADMIN)

    const dialect = new PgDialect()
    // Initial update sets { stage, updatedAt } on cardId only (R5-L-4: no position write)
    expect(updates[0]?.setArg).not.toHaveProperty('position')
    expect(updates[0]?.setArg).toEqual({ stage: 'HR_SCREEN', updatedAt: expect.any(Date) })
    // Renumbering updates should renumber [incumbentAId, cardId, incumbentBId] to [0, 1, 2]
    const renumberedUpdates = updates.slice(1).map((u) => ({
      id: dialect.sqlToQuery(u.whereArg as SQL).params[0] as string,
      position: (u.setArg as { position: number }).position,
    }))

    expect(renumberedUpdates).toEqual([
      { id: incumbentAId, position: 0 },
      { id: cardId, position: 1 },
      { id: incumbentBId, position: 2 },
    ])
  })
})

describe('InterviewsService.move — concurrent-move serialisation (R5-L-5)', () => {
  const cardId = '0b0a0000-0000-4000-aa00-000000000003'
  const otherCardId = '0b0a0000-0000-4000-aa00-000000000001'

  async function runMove(lockedRows: Array<{ id: string; stage: string }>) {
    // The pre-transaction read says SUBMITTED; the locked rows may say otherwise.
    const card = {
      id: cardId,
      seniorId: SENIOR_ID,
      stage: 'SUBMITTED',
      position: 0,
      companyName: 'Acme Corp',
      senior: { displayName: 'Senior Name' },
      hr: null,
      createdAt: new Date('2026-11-19T10:00:00Z'),
      updatedAt: new Date('2026-11-19T10:00:00Z'),
    }

    const events: string[] = []
    const lockQueries: SQL[] = []
    const findManyWhere: SQL[] = []
    const tx = {
      execute: (q: SQL) => {
        events.push('lock')
        lockQueries.push(q)
        return Promise.resolve({ rows: lockedRows })
      },
      update: () => ({
        set: () => ({
          where: () => {
            events.push('update')
            return Promise.resolve()
          },
        }),
      }),
      query: {
        interviews: {
          findMany: (args: { where: SQL }) => {
            findManyWhere.push(args.where)
            return Promise.resolve([])
          },
          findFirst: () => Promise.resolve(card),
        },
      },
    }

    const db = {
      db: {
        query: { interviews: { findFirst: () => Promise.resolve(card) } },
        transaction: async <T>(cb: (txArg: typeof tx) => Promise<T>): Promise<T> => cb(tx),
      },
    }

    const service = new InterviewsService(
      db as never,
      {} as never,
      { assertUpdateAccess: () => Promise.resolve() } as never,
    )
    const dialect = new PgDialect()
    const moved = service.move(cardId, { stage: 'HR_SCREEN', position: 0 }, ADMIN)
    return {
      moved,
      events,
      lockQueries: () => lockQueries.map((q) => dialect.sqlToQuery(q)),
      oldColumnParams: () => dialect.sqlToQuery(findManyWhere[0]!).params,
    }
  }

  it('locks every card of the senior FOR NO KEY UPDATE, in id order, before any write, and takes the old stage from the locked row', async () => {
    // A concurrent move already put the card in OFFER_RECEIVED; another card precedes it.
    const result = await runMove([
      { id: otherCardId, stage: 'ARCHIVED' },
      { id: cardId, stage: 'OFFER_RECEIVED' },
    ])
    await result.moved

    expect(result.events[0]).toBe('lock')
    expect(result.events.filter((e) => e === 'lock').length).toBe(1)
    const [lock] = result.lockQueries()
    expect(lock?.sql).toMatch(
      /SELECT id, stage FROM interviews\s+WHERE senior_id = \$1::uuid\s+ORDER BY id\s+FOR NO KEY UPDATE/,
    )
    expect(lock?.params).toEqual([SENIOR_ID])
    // The old column renormalised is the moved card's locked stage, not the other card's
    // and not the stale pre-transaction one.
    expect(result.oldColumnParams()).toContain('OFFER_RECEIVED')
    expect(result.oldColumnParams()).not.toContain('ARCHIVED')
    expect(result.oldColumnParams()).not.toContain('SUBMITTED')
  })

  it('is a 404 with no write when the moved card is not among the locked rows (CR6-L-2)', async () => {
    const result = await runMove([{ id: otherCardId, stage: 'ARCHIVED' }])

    await expect(result.moved).rejects.toMatchObject({
      status: 404,
      response: { code: 'INTERVIEW_NOT_FOUND' },
    })
    expect(result.events).toEqual(['lock'])
  })
})

describe('InterviewsService.create — position under the board lock (CR6-L-3)', () => {
  it('locks the senior board inside the transaction, then counts the column there', async () => {
    const createdId = '0b0a0000-0000-4000-aa00-000000000006'
    const events: string[] = []
    const lockQueries: SQL[] = []
    const inserted: Array<Record<string, unknown>> = []
    const tx = {
      execute: (q: SQL) => {
        events.push('lock')
        lockQueries.push(q)
        return Promise.resolve({ rows: [] })
      },
      select: () => ({
        from: () => ({
          where: () => {
            events.push('count')
            return Promise.resolve([{ value: 2 }])
          },
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          events.push('insert')
          inserted.push(values)
          return { returning: () => Promise.resolve([{ id: createdId, ...values }]) }
        },
      }),
    }
    const row = {
      id: createdId,
      seniorId: SENIOR_ID,
      stage: 'HR_SCREEN',
      position: 2,
      companyName: 'Acme Corp',
      senior: { displayName: 'Senior Name' },
      hr: null,
      createdAt: new Date('2026-11-19T10:00:00Z'),
      updatedAt: new Date('2026-11-19T10:00:00Z'),
    }
    const db = {
      db: {
        query: { interviews: { findFirst: () => Promise.resolve(row) } },
        transaction: async <T>(cb: (txArg: typeof tx) => Promise<T>): Promise<T> => cb(tx),
      },
    }

    const service = new InterviewsService(db as never, {} as never, {} as never)
    await service.create({ seniorId: SENIOR_ID, companyName: 'Acme Corp' } as never, ADMIN)

    expect(events).toEqual(['lock', 'count', 'insert'])
    const lock = new PgDialect().sqlToQuery(lockQueries[0]!)
    expect(lock.sql).toMatch(
      /FROM interviews\s+WHERE senior_id = \$1::uuid\s+ORDER BY id\s+FOR NO KEY UPDATE/,
    )
    expect(lock.params).toEqual([SENIOR_ID])
    expect(inserted[0]?.['position']).toBe(2)
  })
})
