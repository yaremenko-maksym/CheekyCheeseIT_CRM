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
 * rows in `created_at` order is `interviews-board-order.integration.spec.ts`.
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
