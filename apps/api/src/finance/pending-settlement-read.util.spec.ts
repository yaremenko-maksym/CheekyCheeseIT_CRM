/**
 * Unit doubles for the pending-settlement read utils (L3 extraction).
 * The compiled WHERE of every read is asserted via `PgDialect` (real Drizzle
 * SQL), so a widened / dropped filter is caught, not just "something resolved".
 */
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { denormalise, loadObligation, resolveSource } from './pending-settlement-read.util'

type Db = Parameters<typeof loadObligation>[0]

const compiled = (where: unknown) => new PgDialect().sqlToQuery(where as SQL)

interface Call {
  where: unknown
}

function makeDb(rows: {
  obligation?: unknown
  tx?: unknown
  project?: unknown
  users?: Record<string, unknown>
}) {
  const calls = {
    obligation: [] as Call[],
    tx: [] as Call[],
    project: [] as Call[],
    user: [] as Call[],
  }
  const db = {
    query: {
      pendingObligations: {
        findFirst: vi.fn(async (a: Call) => (calls.obligation.push(a), rows.obligation)),
      },
      transactions: {
        findFirst: vi.fn(async (a: Call) => (calls.tx.push(a), rows.tx)),
      },
      projects: {
        findFirst: vi.fn(async (a: Call) => (calls.project.push(a), rows.project)),
      },
      users: {
        findFirst: vi.fn(async (a: Call) => {
          calls.user.push(a)
          const id = compiled(a.where).params[0] as string
          return rows.users?.[id]
        }),
      },
    },
  }
  return { db: db as unknown as Db, calls }
}

describe('loadObligation', () => {
  it('reads by id only (no status scope) and returns the row', async () => {
    const row = { id: 'ob-1' }
    const { db, calls } = makeDb({ obligation: row })
    await expect(loadObligation(db, 'ob-1')).resolves.toBe(row)
    const q = compiled(calls.obligation[0]!.where)
    expect(q.sql).toBe('"pending_obligations"."id" = $1')
    expect(q.params).toEqual(['ob-1'])
  })

  it('throws 404 FINANCE_OBLIGATION_NOT_FOUND when missing', async () => {
    const { db } = makeDb({ obligation: undefined })
    await expect(loadObligation(db, 'x')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FINANCE_OBLIGATION_NOT_FOUND', statusCode: 404 }),
    })
  })
})

describe('resolveSource', () => {
  const baseTx = {
    projectId: 'p-1',
    type: 'DROP_PENDING_PAYOUT',
    dropCascadeOrigin: false,
    seniorSharePercent: null,
    dropSharePercent: 40,
    settledCurrency: 'USD',
    settledAmount: '12.5',
    fundingSource: 'COMPANY_ACCOUNT',
    senderId: 's-1',
    senderLabel: 'Sender',
    txDate: new Date('2026-01-02T00:00:00Z'),
    createdAt: new Date('2026-01-03T00:00:00Z'),
  }

  it('maps every source field and the project, reading by tx id then project id', async () => {
    const { db, calls } = makeDb({ tx: baseTx, project: { id: 'p-1', name: 'Proj', extra: 1 } })
    const out = await resolveSource(db, 'tx-1')
    expect(out).toEqual({
      project: { id: 'p-1', name: 'Proj' },
      sourceType: 'DROP_PENDING_PAYOUT',
      sourceDropCascadeOrigin: false,
      sourceSeniorSharePercent: null,
      sourceDropSharePercent: 40,
      sourceSettledCurrency: 'USD',
      sourceSettledAmount: '12.5',
      sourceFundingSource: 'COMPANY_ACCOUNT',
      sourceSenderId: 's-1',
      sourceSenderLabel: 'Sender',
      sourceTxDate: baseTx.txDate,
      sourceCreatedAt: baseTx.createdAt,
    })
    expect(compiled(calls.tx[0]!.where)).toMatchObject({
      sql: '"transactions"."id" = $1',
      params: ['tx-1'],
    })
    expect(compiled(calls.project[0]!.where)).toMatchObject({
      sql: '"projects"."id" = $1',
      params: ['p-1'],
    })
  })

  it('skips the project read when the source has no projectId', async () => {
    const { db, calls } = makeDb({ tx: { ...baseTx, projectId: null } })
    const out = await resolveSource(db, 'tx-1')
    expect(out.project).toBeNull()
    expect(out.sourceType).toBe('DROP_PENDING_PAYOUT')
    expect(calls.project).toHaveLength(0)
  })

  it('yields project null when the project row is missing', async () => {
    const { db } = makeDb({ tx: baseTx, project: undefined })
    expect((await resolveSource(db, 'tx-1')).project).toBeNull()
  })

  it('returns the all-null shape when the source row is missing (defense-in-depth)', async () => {
    const { db, calls } = makeDb({ tx: undefined })
    const out = await resolveSource(db, 'tx-1')
    expect(out.project).toBeNull()
    expect(out.sourceType).toBeNull()
    expect(out.sourceDropCascadeOrigin).toBeNull()
    expect(calls.project).toHaveLength(0)
  })
})

describe('denormalise', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'ob-1',
    creditorUserId: 'u-sen',
    debtorType: 'COMPANY' as const,
    debtorUserId: null as string | null,
    sourceTransactionId: 'tx-1',
    amount: '10',
    currency: 'USDT',
    createdAt: new Date('2026-02-03T04:05:06.000Z'),
    ...over,
  })

  it('joins senior / debtor / project names and ISO-formats createdAt', async () => {
    const { db } = makeDb({
      users: { 'u-sen': { displayName: 'Senior' }, 'u-deb': { displayName: 'Debtor' } },
      tx: { projectId: 'p-1' },
      project: { id: 'p-1', name: 'Proj' },
    })
    const out = await denormalise(db, [row({ debtorType: 'DROP', debtorUserId: 'u-deb' })])
    expect(out).toEqual([
      {
        obligationId: 'ob-1',
        sourceTransactionId: 'tx-1',
        debtorType: 'DROP',
        debtorUserId: 'u-deb',
        debtorName: 'Debtor',
        seniorId: 'u-sen',
        seniorName: 'Senior',
        projectId: 'p-1',
        projectName: 'Proj',
        amount: '10',
        currency: 'USDT',
        createdAt: '2026-02-03T04:05:06.000Z',
      },
    ])
  })

  it('falls back: no debtor user, missing senior → "—", no source project → nulls', async () => {
    const { db, calls } = makeDb({ users: {}, tx: undefined })
    const out = await denormalise(db, [row()])
    expect(out[0]).toMatchObject({
      debtorName: null,
      seniorName: '—',
      projectId: null,
      projectName: null,
    })
    expect(calls.user).toHaveLength(1)
    expect(calls.project).toHaveLength(0)
  })

  it('returns [] for no rows and preserves row order', async () => {
    const { db } = makeDb({ users: {} })
    expect(await denormalise(db, [])).toEqual([])
    const out = await denormalise(db, [row({ id: 'a' }), row({ id: 'b' })])
    expect(out.map((r) => r.obligationId)).toEqual(['a', 'b'])
  })
})
