/**
 * Direct unit tests for DropSelfService — the query SHAPE each self-view method
 * sends to the database (what is bound, how it is ordered, which relation it
 * loads) and the exact boundaries of the date window. The behavioural contract
 * is covered through the facade in transactions.drop-self-feeds.spec.ts and
 * transactions.drop-self-summary.spec.ts; this file pins what a canned
 * `findMany` stub cannot see on its own.
 */
import { describe, expect, it, vi } from 'vitest'
import { dropIncomesQuerySchema } from '@crm/shared'
import type { DropIncomesQuery, SessionUser } from '@crm/shared'
import { DropSelfService } from './drop-self.service'
import { collectParamValues } from './__test-helpers__/drizzle-where-introspection'

const DROP_ID = 'drop-A'

const dropUser: SessionUser = {
  id: DROP_ID,
  role: 'DROP',
  displayName: 'Drop A',
  email: 'drop-a@test.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

function q(overrides: Partial<DropIncomesQuery> = {}): DropIncomesQuery {
  return dropIncomesQuerySchema.parse(overrides)
}

function makeService(rows: unknown[] = [], self: unknown = undefined) {
  const findMany = vi.fn((_args?: unknown) => Promise.resolve(rows))
  const findFirst = vi.fn((_args?: unknown) => Promise.resolve(self))
  const db = { db: { query: { transactions: { findMany }, users: { findFirst } } } }
  const nbu = { getRates: () => Promise.resolve({}) }
  const svc = new DropSelfService(db as never, nbu as never)
  return { svc, findMany, findFirst }
}

function lastArgs(mock: { mock: { calls: unknown[][] } }): {
  where?: unknown
  orderBy?: unknown[]
  with?: unknown
} {
  return mock.mock.calls[mock.mock.calls.length - 1]![0] as never
}

function row(createdAt: Date) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'DROP_INCOME',
    status: 'PENDING',
    amount: '10',
    currency: 'USDT',
    senderLabel: 'Co',
    createdAt,
  }
}

describe('DropSelfService.getDropSelfSummary — query shape', () => {
  it('looks the caller up by their own id', async () => {
    const { svc, findFirst } = makeService([], {
      id: DROP_ID,
      displayName: 'Drop A',
      dropSharePercent: 30,
    })
    await svc.getDropSelfSummary(dropUser)
    expect(collectParamValues(lastArgs(findFirst).where)).toEqual([DROP_ID])
  })
})

describe('DropSelfService.getDropSelfIncomes — query shape', () => {
  it('orders newest-first with exactly one key and loads only the project companyName', async () => {
    const { svc, findMany } = makeService([])
    await svc.getDropSelfIncomes(dropUser, q())
    const args = lastArgs(findMany)
    expect(args.orderBy).toHaveLength(1)
    expect(args.with).toEqual({ project: { columns: { companyName: true } } })
  })
})

describe('DropSelfService.getDropSelfIncomes — date-window boundaries', () => {
  it('includes a row created exactly at the start of the `from` day', async () => {
    const { svc } = makeService([row(new Date('2026-06-01T00:00:00.000Z'))])
    const res = await svc.getDropSelfIncomes(dropUser, q({ from: '2026-06-01' }))
    expect(res.total).toBe(1)
  })

  it('excludes a row created one millisecond before the `from` day', async () => {
    const { svc } = makeService([row(new Date('2026-05-31T23:59:59.999Z'))])
    const res = await svc.getDropSelfIncomes(dropUser, q({ from: '2026-06-01' }))
    expect(res.total).toBe(0)
  })

  it('includes a row created at the last millisecond of the `to` day', async () => {
    const { svc } = makeService([row(new Date('2026-06-15T23:59:59.999Z'))])
    const res = await svc.getDropSelfIncomes(dropUser, q({ to: '2026-06-15' }))
    expect(res.total).toBe(1)
  })

  it('excludes a row created one millisecond after the `to` day', async () => {
    const { svc } = makeService([row(new Date('2026-06-16T00:00:00.000Z'))])
    const res = await svc.getDropSelfIncomes(dropUser, q({ to: '2026-06-15' }))
    expect(res.total).toBe(0)
  })
})

describe('DropSelfService.getDropSelfPayments — query shape', () => {
  it('binds the PAYOUT type and the caller as sender, ordered newest-first', async () => {
    const { svc, findMany } = makeService([])
    await svc.getDropSelfPayments(dropUser)
    const args = lastArgs(findMany)
    expect(collectParamValues(args.where).sort()).toEqual([DROP_ID, 'PAYOUT'].sort())
    expect(args.orderBy).toHaveLength(1)
  })
})
