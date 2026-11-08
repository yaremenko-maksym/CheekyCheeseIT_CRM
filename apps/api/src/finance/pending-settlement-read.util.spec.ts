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

function makeDb(rows: { obligation?: unknown; tx?: unknown; project?: unknown }) {
  const calls = {
    obligation: [] as Call[],
    tx: [] as Call[],
    project: [] as Call[],
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

  /** A filter-honouring double: returns only rows whose id is in the compiled `inArray`, in store order. */
  function makeBatchDb(store: {
    users?: Array<{ id: string; displayName: string }>
    txs?: Array<{ id: string; projectId: string | null }>
    projects?: Array<{ id: string; name: string }>
  }) {
    const table = <T extends { id: string }>(stored: T[] = []) =>
      vi.fn(async ({ where }: Call) => {
        const ids = compiled(where).params
        return stored.filter((r) => ids.includes(r.id))
      })
    const users = table(store.users)
    const txs = table(store.txs)
    const projects = table(store.projects)
    const db = {
      query: {
        users: { findMany: users },
        transactions: { findMany: txs },
        projects: { findMany: projects },
      },
    } as unknown as Db
    return { db, users, txs, projects }
  }

  const argOf = (fn: ReturnType<typeof vi.fn>) => compiled((fn.mock.calls[0]![0] as Call).where)

  it('joins senior / debtor / project names and ISO-formats createdAt', async () => {
    const { db, users, txs, projects } = makeBatchDb({
      users: [
        { id: 'u-sen', displayName: 'Senior' },
        { id: 'u-deb', displayName: 'Debtor' },
      ],
      txs: [{ id: 'tx-1', projectId: 'p-1' }],
      projects: [{ id: 'p-1', name: 'Proj' }],
    })
    const out = await denormalise(db, [row({ debtorType: 'DROP', debtorUserId: 'u-deb' })])
    expect(argOf(users)).toMatchObject({
      sql: '"users"."id" in ($1, $2)',
      params: ['u-sen', 'u-deb'],
    })
    expect(argOf(txs)).toMatchObject({ sql: '"transactions"."id" in ($1)', params: ['tx-1'] })
    expect(argOf(projects)).toMatchObject({ sql: '"projects"."id" in ($1)', params: ['p-1'] })
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

  it('issues one query per table regardless of row count, with de-duplicated ids', async () => {
    const { db, users, txs, projects } = makeBatchDb({
      users: [
        { id: 'u-sen', displayName: 'Senior' },
        { id: 'u-deb', displayName: 'Debtor' },
      ],
      txs: [
        { id: 'tx-1', projectId: 'p-1' },
        { id: 'tx-2', projectId: 'p-1' },
      ],
      projects: [{ id: 'p-1', name: 'Proj' }],
    })
    await denormalise(db, [
      row({ id: 'a', debtorUserId: 'u-deb' }),
      row({ id: 'b', debtorUserId: 'u-deb', sourceTransactionId: 'tx-2' }),
      row({ id: 'c', sourceTransactionId: 'tx-2' }),
    ])
    expect(users).toHaveBeenCalledTimes(1)
    expect(txs).toHaveBeenCalledTimes(1)
    expect(projects).toHaveBeenCalledTimes(1)
    expect(argOf(users).params).toEqual(['u-sen', 'u-deb'])
    expect(argOf(txs).params).toEqual(['tx-1', 'tx-2'])
    expect(argOf(projects).params).toEqual(['p-1'])
  })

  it('never binds a null debtor id into the users query', async () => {
    const { db, users } = makeBatchDb({ users: [{ id: 'u-sen', displayName: 'Senior' }] })
    const out = await denormalise(db, [row()])
    expect(argOf(users).params).toEqual(['u-sen'])
    expect(out[0]).toMatchObject({ debtorUserId: null, debtorName: null, seniorName: 'Senior' })
  })

  it('falls back when the creditor and debtor users are missing, keeping the raw ids', async () => {
    const { db } = makeBatchDb({ txs: [{ id: 'tx-1', projectId: null }] })
    const out = await denormalise(db, [row({ debtorType: 'DROP', debtorUserId: 'u-gone' })])
    expect(out[0]).toMatchObject({
      seniorId: 'u-sen',
      seniorName: '—',
      debtorUserId: 'u-gone',
      debtorName: null,
    })
  })

  it('yields null project fields and skips the projects query when the source tx is missing', async () => {
    const { db, projects } = makeBatchDb({ users: [{ id: 'u-sen', displayName: 'Senior' }] })
    const out = await denormalise(db, [row()])
    expect(out[0]).toMatchObject({
      sourceTransactionId: 'tx-1',
      projectId: null,
      projectName: null,
    })
    expect(projects).not.toHaveBeenCalled()
  })

  it('skips the projects query when no source tx has a projectId', async () => {
    const { db, projects } = makeBatchDb({ txs: [{ id: 'tx-1', projectId: null }] })
    const out = await denormalise(db, [row()])
    expect(out[0]).toMatchObject({ projectId: null, projectName: null })
    expect(projects).not.toHaveBeenCalled()
  })

  it('yields null project fields when the project row is missing', async () => {
    const { db, projects } = makeBatchDb({ txs: [{ id: 'tx-1', projectId: 'p-gone' }] })
    const out = await denormalise(db, [row()])
    expect(out[0]).toMatchObject({ projectId: null, projectName: null })
    expect(argOf(projects).params).toEqual(['p-gone'])
  })

  it('returns [] and issues no query for no rows', async () => {
    const { db, users, txs, projects } = makeBatchDb({})
    expect(await denormalise(db, [])).toEqual([])
    expect(users).not.toHaveBeenCalled()
    expect(txs).not.toHaveBeenCalled()
    expect(projects).not.toHaveBeenCalled()
  })

  it('keeps input order and per-row attribution when the database returns another order', async () => {
    const { db } = makeBatchDb({
      users: [
        { id: 'u-2', displayName: 'Second' },
        { id: 'u-1', displayName: 'First' },
      ],
      txs: [
        { id: 'tx-3', projectId: null },
        { id: 'tx-2', projectId: 'p-2' },
        { id: 'tx-1', projectId: 'p-1' },
      ],
      projects: [
        { id: 'p-2', name: 'Two' },
        { id: 'p-1', name: 'One' },
      ],
    })
    const out = await denormalise(db, [
      row({ id: 'a', creditorUserId: 'u-1', debtorUserId: 'u-2', sourceTransactionId: 'tx-1' }),
      row({ id: 'b', creditorUserId: 'u-2', debtorUserId: 'u-1', sourceTransactionId: 'tx-2' }),
      row({ id: 'c', creditorUserId: 'u-1', sourceTransactionId: 'tx-3' }),
    ])
    expect(
      out.map((r) => [r.obligationId, r.seniorName, r.debtorName, r.projectId, r.projectName]),
    ).toEqual([
      ['a', 'First', 'Second', 'p-1', 'One'],
      ['b', 'Second', 'First', 'p-2', 'Two'],
      ['c', 'First', null, null, null],
    ])
  })
})
