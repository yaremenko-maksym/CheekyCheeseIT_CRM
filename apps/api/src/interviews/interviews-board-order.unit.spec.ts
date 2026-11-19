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
    // Initial update sets { stage, position: 1 } on cardId
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
