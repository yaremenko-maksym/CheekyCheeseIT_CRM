/**
 * Characterization of the on-chain claim registry surface of TransactionsService:
 *
 *   public   releaseOnChainHash, inspectOnChainHash
 *   private  describeReferent, resolveReceiptHashTransition,
 *            recordReclaimAfterRelease, recordReceiptClaimDivergence,
 *            recordUnclaimedCredit
 *
 * Their only collaborators are `this.db` and `this.logger`. Real-DB behaviour is
 * covered by onchain-tx-cross-path.integration.spec.ts; THESE unit tests pin the
 * observable contract against a recording drizzle double so the mutation gate
 * (which runs the unit suite only) has a net under the code.
 *
 * Pins CURRENT behaviour: which rows are read, which audit rows are written, in
 * which order relative to the transaction boundary, and what is returned.
 *
 * The double mirrors the drizzle surface these methods touch:
 *   db.transaction(cb)                          — cb receives the same client
 *   db.update(t).set(v).where(w).returning(c)   — releaseConsumedTxHash
 *   db.insert(t).values(v)                      — audit journal
 *   db.query.consumedTxHashes.findFirst/findMany
 *   db.query.transactions.findFirst
 *   db.query.payoutRequests.findFirst
 */
import { ForbiddenException } from '@nestjs/common'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { COMPANY_ACCOUNT_FUNDING_SOURCE } from './company-account-balance'
import {
  consumedTxHashes,
  payoutRequests,
  transactionAuditLog,
  transactions,
} from '../database/schema'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

const H1 = `0x${'a'.repeat(64)}`
const H2 = `0x${'b'.repeat(64)}`
const H1_URL_UPPER = `https://etherscan.io/tx/0x${'A'.repeat(64)}`

const ADMIN: SessionUser = {
  id: 'admin-actor',
  role: 'ADMIN',
  displayName: 'Admin Actor',
  email: 'admin@x.com',
  avatarUrl: null,
  seniorSharePercent: 0,
}
const ACCOUNTANT: SessionUser = { ...ADMIN, id: 'acc-actor', role: 'ACCOUNTANT' }
const SENIOR: SessionUser = { ...ADMIN, id: 'senior-actor', role: 'SENIOR' }
const JUNIOR: SessionUser = { ...ADMIN, id: 'junior-actor', role: 'JUNIOR' }
const HR: SessionUser = { ...ADMIN, id: 'hr-actor', role: 'HR' }
const DROP: SessionUser = { ...ADMIN, id: 'drop-actor', role: 'DROP' }

interface Doubles {
  /** rows `update(...).returning()` yields (release) */
  released?: Array<{ txHash: string; purpose: string; referenceId: string | null }>
  consumedFindFirst?: { purpose: string; referenceId: string | null } | undefined
  consumedFindMany?: Array<Record<string, unknown>>
  txRow?: Record<string, unknown> | undefined
  payoutRow?: Record<string, unknown> | undefined
  payoutRequestRow?: Record<string, unknown> | undefined
}

function makeHarness(d: Doubles = {}) {
  const events: string[] = []
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = []
  const updates: Array<{
    table: unknown
    set: Record<string, unknown>
    where: unknown
    returning: unknown
  }> = []

  const consumedFindFirst = vi.fn(async (_a: unknown) => d.consumedFindFirst)
  const consumedFindMany = vi.fn(async (_a: unknown) => d.consumedFindMany ?? [])
  const txFindFirst = vi.fn(async (_a: unknown) => d.txRow)
  const payoutRequestFindFirst = vi.fn(async (_a: unknown) => d.payoutRequestRow)
  // The PAYOUT branch reads `transactions.findFirst` too; a dedicated payout row
  // takes precedence there so one double serves both branches.
  txFindFirst.mockImplementation(async () => d.payoutRow ?? d.txRow)

  const client = {
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      events.push('tx-begin')
      const out = await cb(client)
      events.push('tx-end')
      return out
    }),
    update: vi.fn((table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: unknown) => ({
          returning: async (returning: unknown) => {
            events.push('update')
            updates.push({ table, set, where, returning })
            return d.released ?? []
          },
        }),
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        events.push('insert')
        inserts.push({ table, values })
      },
    })),
    query: {
      consumedTxHashes: { findFirst: consumedFindFirst, findMany: consumedFindMany },
      transactions: { findFirst: txFindFirst },
      payoutRequests: { findFirst: payoutRequestFindFirst },
    },
  }
  const svc = makeTransactionsService({ db: { db: client } as never })
  const logger = (svc as unknown as { logger: { warn: (m: string) => void } }).logger
  const warn = vi.spyOn(logger, 'warn').mockImplementation((m: string) => {
    events.push(`warn:${m}`)
  })
  const priv = svc as unknown as {
    describeReferent: (
      tx: unknown,
      purpose: string,
      referenceId: string | null,
    ) => Promise<Record<string, unknown>>
    resolveReceiptHashTransition: (
      tx: Record<string, unknown>,
      next: string | null,
    ) => Promise<Record<string, unknown>>
    recordReclaimAfterRelease: (tx: unknown, p: Record<string, unknown>) => Promise<void>
    recordReceiptClaimDivergence: (tx: unknown, p: Record<string, unknown>) => Promise<void>
    recordUnclaimedCredit: (tx: unknown, p: Record<string, unknown>) => Promise<void>
  }
  return {
    svc,
    priv,
    client,
    events,
    inserts,
    updates,
    warn,
    consumedFindFirst,
    consumedFindMany,
    txFindFirst,
    payoutRequestFindFirst,
  }
}

const MISSING = {
  exists: false,
  settled: false,
  status: null,
  fundingSource: null,
  currency: null,
  creditsCompanyAccount: false,
}

describe('releaseOnChainHash', () => {
  it.each([
    ['SENIOR', SENIOR],
    ['JUNIOR', JUNIOR],
    ['HR', HR],
    ['ACCOUNTANT', ACCOUNTANT],
    ['DROP', DROP],
  ])('%s is forbidden before any db work', async (_n, user) => {
    const h = makeHarness()
    await expect(h.svc.releaseOnChainHash(H1, 'typo', user)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    expect(h.client.transaction).not.toHaveBeenCalled()
    expect(h.warn).not.toHaveBeenCalled()
  })

  it('rejects a value with no on-chain hash as 400 FINANCE_TX_HASH_INVALID, before the reason check', async () => {
    const h = makeHarness()
    // Reason is also empty: the hash error must win (order of the guards).
    await expect(h.svc.releaseOnChainHash('0xSIM-not-a-hash', '   ', ADMIN)).rejects.toMatchObject({
      response: { code: 'FINANCE_TX_HASH_INVALID', statusCode: 400 },
      status: 400,
    })
    expect(h.client.transaction).not.toHaveBeenCalled()
  })

  it('rejects a blank / whitespace-only reason as 400 FINANCE_TX_HASH_RELEASE_REASON_REQUIRED', async () => {
    const h = makeHarness()
    await expect(h.svc.releaseOnChainHash(H1, '  \t ', ADMIN)).rejects.toMatchObject({
      response: { code: 'FINANCE_TX_HASH_RELEASE_REASON_REQUIRED', statusCode: 400 },
      status: 400,
    })
    await expect(h.svc.releaseOnChainHash(H1, '', ADMIN)).rejects.toMatchObject({
      response: { code: 'FINANCE_TX_HASH_RELEASE_REASON_REQUIRED' },
    })
    expect(h.client.transaction).not.toHaveBeenCalled()
  })

  it('unclaimed hash → 404 FINANCE_TX_HASH_NOT_CONSUMED, nothing journaled, nothing logged', async () => {
    const h = makeHarness({ released: [] })
    await expect(h.svc.releaseOnChainHash(H1, 'why', ADMIN)).rejects.toMatchObject({
      response: { code: 'FINANCE_TX_HASH_NOT_CONSUMED', statusCode: 404 },
      status: 404,
    })
    expect(h.updates).toHaveLength(1)
    expect(h.inserts).toHaveLength(0)
    expect(h.warn).not.toHaveBeenCalled()
    expect(h.events).toEqual(['tx-begin', 'update'])
  })

  it('happy path: tombstones the normalized hash, journals inside the tx, logs after commit, returns released + referent', async () => {
    const REF = 'tx-row-1'
    const h = makeHarness({
      released: [{ txHash: H1, purpose: 'ADMIN_INCOME', referenceId: REF }],
      txRow: {
        type: 'ADMIN_INCOME',
        status: 'PAID',
        currency: 'USDT',
        fundingSource: 'COMPANY_ACCOUNT',
      },
    })

    const res = await h.svc.releaseOnChainHash(H1_URL_UPPER, '  typo in hash  ', ADMIN)

    // update: consumed_tx_hashes tombstone, trimmed reason, actor, a Date
    expect(h.updates).toHaveLength(1)
    const upd = h.updates[0]!
    expect(upd.table).toBe(consumedTxHashes)
    expect(upd.set.releasedBy).toBe('admin-actor')
    expect(upd.set.releasedReason).toBe('typo in hash')
    expect(upd.set.releasedAt).toBeInstanceOf(Date)
    expect(Object.keys(upd.set).sort()).toEqual(['releasedAt', 'releasedBy', 'releasedReason'])
    expect(upd.where).toEqual(
      and(eq(consumedTxHashes.txHash, H1), isNull(consumedTxHashes.releasedAt)),
    )
    expect(upd.returning).toEqual({
      txHash: consumedTxHashes.txHash,
      purpose: consumedTxHashes.purpose,
      referenceId: consumedTxHashes.referenceId,
    })

    const referent = {
      exists: true,
      settled: true,
      status: 'PAID',
      fundingSource: 'COMPANY_ACCOUNT',
      currency: 'USDT',
      creditsCompanyAccount: true,
    }
    // journal row
    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0]!.table).toBe(transactionAuditLog)
    expect(h.inserts[0]!.values).toEqual({
      actorId: 'admin-actor',
      targetId: REF,
      action: 'ONCHAIN_HASH_RELEASED',
      metadata: {
        txHash: H1,
        purpose: 'ADMIN_INCOME',
        referenceId: REF,
        reason: 'typo in hash',
        referent,
      },
    })

    // returned shape
    expect(res).toEqual({ txHash: H1, purpose: 'ADMIN_INCOME', referenceId: REF, referent })

    // log strictly AFTER the commit, exact text
    expect(h.events).toEqual([
      'tx-begin',
      'update',
      'insert',
      'tx-end',
      'warn:[onchain-registry] hash RELEASED by admin admin-actor — ' +
        'purpose=ADMIN_INCOME referenceId=tx-row-1 referentSettled=true ' +
        'referentCreditsCompanyAccount=true. The transfer can be settled again.',
    ])
  })

  it('attributes the journal row to the impersonator when impersonating', async () => {
    const h = makeHarness({
      released: [{ txHash: H1, purpose: 'ADMIN_INCOME', referenceId: 'r1' }],
    })
    await h.svc.releaseOnChainHash(H1, 'r', { ...ADMIN, impersonatorId: 'real-admin' })
    expect(h.inserts[0]!.values.actorId).toBe('real-admin')
    // the tombstone still names the session user
    expect(h.updates[0]!.set.releasedBy).toBe('admin-actor')
    // log names the session user
    expect(h.events.at(-1)).toContain('RELEASED by admin admin-actor')
  })

  it('claim with no referenceId: audit target falls back to the actor, referent is "missing", log says referenceId=none', async () => {
    const h = makeHarness({
      released: [{ txHash: H1, purpose: 'PAYOUT', referenceId: null }],
    })
    const res = await h.svc.releaseOnChainHash(H1, 'orphan', ADMIN)

    expect(res).toEqual({ txHash: H1, purpose: 'PAYOUT', referenceId: null, referent: MISSING })
    expect(h.inserts[0]!.values).toEqual({
      actorId: 'admin-actor',
      targetId: 'admin-actor',
      action: 'ONCHAIN_HASH_RELEASED',
      metadata: {
        txHash: H1,
        purpose: 'PAYOUT',
        referenceId: null,
        reason: 'orphan',
        referent: MISSING,
      },
    })
    // no referent lookup at all when there is no referenceId
    expect(h.txFindFirst).not.toHaveBeenCalled()
    expect(h.payoutRequestFindFirst).not.toHaveBeenCalled()
    expect(h.events.at(-1)).toBe(
      'warn:[onchain-registry] hash RELEASED by admin admin-actor — ' +
        'purpose=PAYOUT referenceId=none referentSettled=false ' +
        'referentCreditsCompanyAccount=false. The transfer can be settled again.',
    )
  })

  it('log reflects a settled-but-not-crediting referent (CASH payout is spent without entering the pool)', async () => {
    const h = makeHarness({
      released: [{ txHash: H1, purpose: 'PAYOUT', referenceId: 'pr-1' }],
      payoutRow: { status: 'PAID', fundingSource: null, currency: 'USDT' },
    })
    const res = await h.svc.releaseOnChainHash(H1, 'r', ADMIN)
    expect(res.referent).toEqual({
      exists: true,
      settled: true,
      status: 'PAID',
      fundingSource: null,
      currency: 'USDT',
      creditsCompanyAccount: false,
    })
    expect(h.events.at(-1)).toContain('referentSettled=true referentCreditsCompanyAccount=false.')
  })
})

describe('inspectOnChainHash', () => {
  it.each([
    ['SENIOR', SENIOR],
    ['JUNIOR', JUNIOR],
    ['HR', HR],
    ['DROP', DROP],
  ])('%s is forbidden before any db work', async (_n, user) => {
    const h = makeHarness()
    await expect(h.svc.inspectOnChainHash(H1, user)).rejects.toBeInstanceOf(ForbiddenException)
    expect(h.consumedFindMany).not.toHaveBeenCalled()
  })

  it('rejects a non-hash as 400 FINANCE_TX_HASH_INVALID', async () => {
    const h = makeHarness()
    await expect(h.svc.inspectOnChainHash('0xMANUAL-123', ADMIN)).rejects.toMatchObject({
      response: { code: 'FINANCE_TX_HASH_INVALID', statusCode: 400 },
      status: 400,
    })
    expect(h.consumedFindMany).not.toHaveBeenCalled()
  })

  it.each([
    ['ADMIN', ADMIN],
    ['ACCOUNTANT', ACCOUNTANT],
  ])(
    '%s may inspect; unknown hash → { txHash (normalized), claimed:false } and nothing else',
    async (_n, user) => {
      const h = makeHarness({ consumedFindMany: [] })
      const res = await h.svc.inspectOnChainHash(H1_URL_UPPER, user)
      expect(res).toEqual({ txHash: H1, claimed: false })
      expect(Object.keys(res)).toEqual(['txHash', 'claimed'])
      expect(h.consumedFindMany).toHaveBeenCalledWith({ where: eq(consumedTxHashes.txHash, H1) })
      // no referent lookup for an unknown hash
      expect(h.txFindFirst).not.toHaveBeenCalled()
    },
  )

  it('active claim: claimed:true, ISO dates, null release fields, referent described', async () => {
    const created = new Date('2026-05-01T10:00:00.000Z')
    const h = makeHarness({
      consumedFindMany: [
        {
          txHash: H1,
          purpose: 'COMPANY_DEPOSIT',
          referenceId: 'dep-1',
          consumedByUserId: 'u-1',
          createdAt: created,
          releasedAt: null,
          releasedBy: null,
          releasedReason: null,
        },
      ],
      txRow: { type: 'COMPANY_DEPOSIT', status: 'PAID', currency: 'USDT', fundingSource: null },
    })
    const res = await h.svc.inspectOnChainHash(H1, ADMIN)
    expect(res).toEqual({
      txHash: H1,
      claimed: true,
      purpose: 'COMPANY_DEPOSIT',
      referenceId: 'dep-1',
      consumedByUserId: 'u-1',
      consumedAt: '2026-05-01T10:00:00.000Z',
      releasedAt: null,
      releasedBy: null,
      releasedReason: null,
      referent: {
        exists: true,
        settled: true,
        status: 'PAID',
        fundingSource: null,
        currency: 'USDT',
        creditsCompanyAccount: true,
      },
    })
  })

  it('released tombstone: claimed:false with release facts and ISO releasedAt', async () => {
    const h = makeHarness({
      consumedFindMany: [
        {
          txHash: H1,
          purpose: 'ADMIN_INCOME',
          referenceId: null,
          consumedByUserId: null,
          createdAt: new Date('2026-05-01T10:00:00.000Z'),
          releasedAt: new Date('2026-05-02T11:30:00.000Z'),
          releasedBy: 'admin-1',
          releasedReason: 'typo',
        },
      ],
    })
    const res = await h.svc.inspectOnChainHash(H1, ACCOUNTANT)
    expect(res).toEqual({
      txHash: H1,
      claimed: false,
      purpose: 'ADMIN_INCOME',
      referenceId: null,
      consumedByUserId: null,
      consumedAt: '2026-05-01T10:00:00.000Z',
      releasedAt: '2026-05-02T11:30:00.000Z',
      releasedBy: 'admin-1',
      releasedReason: 'typo',
      referent: MISSING,
    })
  })

  it('MED-J: re-claim after release — the ACTIVE claim wins over a newer-listed tombstone', async () => {
    const tomb = {
      txHash: H1,
      purpose: 'ADMIN_INCOME',
      referenceId: 'old',
      consumedByUserId: 'u-old',
      createdAt: new Date('2026-05-03T00:00:00.000Z'),
      releasedAt: new Date('2026-05-04T00:00:00.000Z'),
      releasedBy: 'admin-1',
      releasedReason: 'r',
    }
    const active = {
      txHash: H1,
      purpose: 'PAYOUT',
      referenceId: 'new',
      consumedByUserId: 'u-new',
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      releasedAt: null,
      releasedBy: null,
      releasedReason: null,
    }
    const h = makeHarness({ consumedFindMany: [tomb, active] })
    const res = await h.svc.inspectOnChainHash(H1, ADMIN)
    expect(res).toMatchObject({ claimed: true, purpose: 'PAYOUT', referenceId: 'new' })
  })

  it('with only tombstones, the NEWEST one is reported regardless of list order', async () => {
    const mk = (ref: string, created: string, released: string) => ({
      txHash: H1,
      purpose: 'ADMIN_INCOME',
      referenceId: ref,
      consumedByUserId: null,
      createdAt: new Date(created),
      releasedAt: new Date(released),
      releasedBy: 'a',
      releasedReason: 'r',
    })
    const oldest = mk('oldest', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    const newest = mk('newest', '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z')
    const mid = mk('mid', '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z')
    for (const order of [
      [oldest, newest, mid],
      [newest, oldest, mid],
      [mid, oldest, newest],
    ]) {
      const h = makeHarness({ consumedFindMany: order })
      const res = await h.svc.inspectOnChainHash(H1, ADMIN)
      expect(res).toMatchObject({ claimed: false, referenceId: 'newest' })
    }
  })

  it('describes the referent through the pooled client with the claim purpose/referenceId', async () => {
    const h = makeHarness({
      consumedFindMany: [
        {
          txHash: H1,
          purpose: 'PAYOUT',
          referenceId: 'pr-9',
          consumedByUserId: 'u',
          createdAt: new Date('2026-05-01T00:00:00.000Z'),
          releasedAt: null,
          releasedBy: null,
          releasedReason: null,
        },
      ],
      payoutRow: {
        status: 'PAID',
        fundingSource: COMPANY_ACCOUNT_FUNDING_SOURCE,
        currency: 'USDT',
      },
    })
    const res = (await h.svc.inspectOnChainHash(H1, ADMIN)) as { referent: Record<string, unknown> }
    expect(res.referent).toMatchObject({ exists: true, settled: true, creditsCompanyAccount: true })
    expect(h.txFindFirst).toHaveBeenCalledTimes(1)
  })
})

describe('describeReferent', () => {
  it('no referenceId → missing, for any purpose, without querying', async () => {
    const h = makeHarness()
    expect(await h.priv.describeReferent(h.client, 'PAYOUT', null)).toEqual(MISSING)
    expect(await h.priv.describeReferent(h.client, 'ADMIN_INCOME', null)).toEqual(MISSING)
    expect(h.txFindFirst).not.toHaveBeenCalled()
    expect(h.payoutRequestFindFirst).not.toHaveBeenCalled()
  })

  describe('PAYOUT', () => {
    it('queries the newest PAYOUT ledger row for the request (deterministic pick)', async () => {
      const h = makeHarness({
        payoutRow: { status: 'PENDING', fundingSource: null, currency: 'USDT' },
      })
      await h.priv.describeReferent(h.client, 'PAYOUT', 'pr-1')
      expect(h.txFindFirst).toHaveBeenCalledWith({
        where: and(eq(transactions.payoutRequestId, 'pr-1'), eq(transactions.type, 'PAYOUT')),
        orderBy: [desc(transactions.createdAt)],
        columns: { status: true, fundingSource: true, currency: true },
      })
    })

    it('PAID + COMPANY_ACCOUNT marker + USDT → settled and credits the pool', async () => {
      const h = makeHarness({
        payoutRow: {
          status: 'PAID',
          fundingSource: COMPANY_ACCOUNT_FUNDING_SOURCE,
          currency: 'USDT',
        },
      })
      expect(await h.priv.describeReferent(h.client, 'PAYOUT', 'pr-1')).toEqual({
        exists: true,
        settled: true,
        status: 'PAID',
        fundingSource: COMPANY_ACCOUNT_FUNDING_SOURCE,
        currency: 'USDT',
        creditsCompanyAccount: true,
      })
      expect(h.payoutRequestFindFirst).not.toHaveBeenCalled()
    })

    it('PAID but no company marker (CASH / ADMIN_USDT) → settled, does NOT credit', async () => {
      const h = makeHarness({
        payoutRow: { status: 'PAID', fundingSource: null, currency: 'USDT' },
      })
      expect(await h.priv.describeReferent(h.client, 'PAYOUT', 'pr-1')).toMatchObject({
        settled: true,
        creditsCompanyAccount: false,
        fundingSource: null,
      })
    })

    it('PAID with company marker but non-USDT currency → does NOT credit', async () => {
      const h = makeHarness({
        payoutRow: {
          status: 'PAID',
          fundingSource: COMPANY_ACCOUNT_FUNDING_SOURCE,
          currency: 'EUR',
        },
      })
      expect(await h.priv.describeReferent(h.client, 'PAYOUT', 'pr-1')).toMatchObject({
        settled: true,
        currency: 'EUR',
        creditsCompanyAccount: false,
      })
    })

    it('not PAID (marker + USDT present) → not settled, does NOT credit', async () => {
      const h = makeHarness({
        payoutRow: {
          status: 'PENDING',
          fundingSource: COMPANY_ACCOUNT_FUNDING_SOURCE,
          currency: 'USDT',
        },
      })
      expect(await h.priv.describeReferent(h.client, 'PAYOUT', 'pr-1')).toEqual({
        exists: true,
        settled: false,
        status: 'PENDING',
        fundingSource: COMPANY_ACCOUNT_FUNDING_SOURCE,
        currency: 'USDT',
        creditsCompanyAccount: false,
      })
    })

    it('no ledger stub but payout_request PAID (imported payout) → exists + settled, funding unknown, no credit', async () => {
      const h = makeHarness({ payoutRequestRow: { status: 'PAID', txHash: H1 } })
      expect(await h.priv.describeReferent(h.client, 'PAYOUT', 'pr-imp')).toEqual({
        exists: true,
        settled: true,
        status: 'PAID',
        fundingSource: null,
        currency: null,
        creditsCompanyAccount: false,
      })
      expect(h.payoutRequestFindFirst).toHaveBeenCalledWith({
        where: eq(payoutRequests.id, 'pr-imp'),
        columns: { status: true, txHash: true },
      })
    })

    it('no ledger stub, payout_request not PAID → exists but not settled', async () => {
      const h = makeHarness({ payoutRequestRow: { status: 'PENDING', txHash: null } })
      expect(await h.priv.describeReferent(h.client, 'PAYOUT', 'pr-2')).toEqual({
        exists: true,
        settled: false,
        status: 'PENDING',
        fundingSource: null,
        currency: null,
        creditsCompanyAccount: false,
      })
    })

    it('neither ledger stub nor payout_request → missing', async () => {
      const h = makeHarness()
      expect(await h.priv.describeReferent(h.client, 'PAYOUT', 'pr-3')).toEqual(MISSING)
    })
  })

  describe('non-PAYOUT purposes (read the transaction by id)', () => {
    it('looks the row up by id with the narrow column set', async () => {
      const h = makeHarness({
        txRow: { type: 'ADMIN_INCOME', status: 'PENDING', currency: 'USDT', fundingSource: null },
      })
      await h.priv.describeReferent(h.client, 'ADMIN_INCOME', 'tx-1')
      expect(h.txFindFirst).toHaveBeenCalledWith({
        where: eq(transactions.id, 'tx-1'),
        columns: { type: true, status: true, currency: true, fundingSource: true },
      })
      expect(h.payoutRequestFindFirst).not.toHaveBeenCalled()
    })

    it('row gone → missing', async () => {
      const h = makeHarness()
      expect(await h.priv.describeReferent(h.client, 'ADMIN_INCOME', 'gone')).toEqual(MISSING)
    })

    it('COMPANY_DEPOSIT PAID USDT → credits (no funding-source condition)', async () => {
      const h = makeHarness({
        txRow: { type: 'COMPANY_DEPOSIT', status: 'PAID', currency: 'USDT', fundingSource: null },
      })
      expect(await h.priv.describeReferent(h.client, 'COMPANY_DEPOSIT', 'd')).toEqual({
        exists: true,
        settled: true,
        status: 'PAID',
        fundingSource: null,
        currency: 'USDT',
        creditsCompanyAccount: true,
      })
    })

    it('COMPANY_DEPOSIT PAID but non-USDT → settled, does NOT credit', async () => {
      const h = makeHarness({
        txRow: { type: 'COMPANY_DEPOSIT', status: 'PAID', currency: 'USD', fundingSource: null },
      })
      expect(await h.priv.describeReferent(h.client, 'COMPANY_DEPOSIT', 'd')).toMatchObject({
        settled: true,
        currency: 'USD',
        creditsCompanyAccount: false,
      })
    })

    it('COMPANY_DEPOSIT USDT but not PAID → not settled, does NOT credit', async () => {
      const h = makeHarness({
        txRow: {
          type: 'COMPANY_DEPOSIT',
          status: 'PENDING',
          currency: 'USDT',
          fundingSource: null,
        },
      })
      expect(await h.priv.describeReferent(h.client, 'COMPANY_DEPOSIT', 'd')).toMatchObject({
        settled: false,
        status: 'PENDING',
        creditsCompanyAccount: false,
      })
    })

    it('ADMIN_INCOME PAID USDT with the company marker → credits', async () => {
      const h = makeHarness({
        txRow: {
          type: 'ADMIN_INCOME',
          status: 'PAID',
          currency: 'USDT',
          fundingSource: COMPANY_ACCOUNT_FUNDING_SOURCE,
        },
      })
      expect(await h.priv.describeReferent(h.client, 'ADMIN_INCOME', 'i')).toEqual({
        exists: true,
        settled: true,
        status: 'PAID',
        fundingSource: COMPANY_ACCOUNT_FUNDING_SOURCE,
        currency: 'USDT',
        creditsCompanyAccount: true,
      })
    })

    it('ADMIN_INCOME PAID USDT personal (no marker) → settled, does NOT credit', async () => {
      const h = makeHarness({
        txRow: { type: 'ADMIN_INCOME', status: 'PAID', currency: 'USDT', fundingSource: null },
      })
      expect(await h.priv.describeReferent(h.client, 'ADMIN_INCOME', 'i')).toMatchObject({
        settled: true,
        creditsCompanyAccount: false,
      })
    })

    it('ADMIN_INCOME with the marker but non-USDT / not PAID → does NOT credit', async () => {
      const eur = makeHarness({
        txRow: {
          type: 'ADMIN_INCOME',
          status: 'PAID',
          currency: 'EUR',
          fundingSource: COMPANY_ACCOUNT_FUNDING_SOURCE,
        },
      })
      expect(await eur.priv.describeReferent(eur.client, 'ADMIN_INCOME', 'i')).toMatchObject({
        creditsCompanyAccount: false,
      })
      const pending = makeHarness({
        txRow: {
          type: 'ADMIN_INCOME',
          status: 'PENDING',
          currency: 'USDT',
          fundingSource: COMPANY_ACCOUNT_FUNDING_SOURCE,
        },
      })
      expect(
        await pending.priv.describeReferent(pending.client, 'ADMIN_INCOME', 'i'),
      ).toMatchObject({
        settled: false,
        creditsCompanyAccount: false,
      })
    })

    it('any other row type (e.g. a payout/salary row reached by transaction id) never credits, even PAID USDT with the marker', async () => {
      const h = makeHarness({
        txRow: {
          type: 'SALARY',
          status: 'PAID',
          currency: 'USDT',
          fundingSource: COMPANY_ACCOUNT_FUNDING_SOURCE,
        },
      })
      expect(await h.priv.describeReferent(h.client, 'COMPANY_DEPOSIT', 's')).toMatchObject({
        exists: true,
        settled: true,
        creditsCompanyAccount: false,
      })
    })
  })
})

describe('resolveReceiptHashTransition', () => {
  const ownRow = (over: Record<string, unknown> = {}) => ({
    id: 'tx-own',
    type: 'ADMIN_INCOME',
    fundingSource: COMPANY_ACCOUNT_FUNDING_SOURCE,
    txHash: null,
    ...over,
  })
  const NOOP = { txHashPatch: {}, claimHash: null, staleClaim: false }

  it('a row that does not consume a transfer (not ADMIN_INCOME) → no-op, no registry read', async () => {
    const h = makeHarness()
    const res = await h.priv.resolveReceiptHashTransition(
      ownRow({ type: 'PAYOUT', txHash: H2 }),
      H1_URL_UPPER,
    )
    expect(res).toEqual(NOOP)
    expect(h.consumedFindFirst).not.toHaveBeenCalled()
  })

  it('ADMIN_INCOME that is not company-pool funded → no-op, no registry read', async () => {
    const h = makeHarness()
    const res = await h.priv.resolveReceiptHashTransition(
      ownRow({ fundingSource: null }),
      H1_URL_UPPER,
    )
    expect(res).toEqual(NOOP)
    expect(h.consumedFindFirst).not.toHaveBeenCalled()
  })

  it('unchanged evidence (same hash, even in another notation) → no-op', async () => {
    const h = makeHarness()
    expect(await h.priv.resolveReceiptHashTransition(ownRow({ txHash: H1 }), H1_URL_UPPER)).toEqual(
      NOOP,
    )
    expect(h.consumedFindFirst).not.toHaveBeenCalled()
  })

  it('no hash before and none now → no-op (not a stale claim)', async () => {
    const h = makeHarness()
    expect(
      await h.priv.resolveReceiptHashTransition(ownRow({ txHash: null }), 'https://example.com/x'),
    ).toEqual(NOOP)
    expect(await h.priv.resolveReceiptHashTransition(ownRow({ txHash: null }), null)).toEqual(NOOP)
  })

  it('new evidence drops the hash while a claim stands → staleClaim, recorded hash and claim both kept', async () => {
    const h = makeHarness()
    const res = await h.priv.resolveReceiptHashTransition(
      ownRow({ txHash: H1 }),
      'https://example.com/receipt.pdf',
    )
    expect(res).toEqual({ txHashPatch: {}, claimHash: null, staleClaim: true })
    expect(h.consumedFindFirst).not.toHaveBeenCalled()
    const resNull = await h.priv.resolveReceiptHashTransition(ownRow({ txHash: H1 }), null)
    expect(resNull).toEqual({ txHashPatch: {}, claimHash: null, staleClaim: true })
  })

  it('first hash on the row, not yet consumed → patch the column and claim it', async () => {
    const h = makeHarness({ consumedFindFirst: undefined })
    const res = await h.priv.resolveReceiptHashTransition(ownRow({ txHash: null }), H1_URL_UPPER)
    expect(res).toEqual({ txHashPatch: { txHash: H1 }, claimHash: H1, staleClaim: false })
    expect(h.consumedFindFirst).toHaveBeenCalledWith({
      where: and(eq(consumedTxHashes.txHash, H1), isNull(consumedTxHashes.releasedAt)),
      columns: { purpose: true, referenceId: true },
    })
  })

  it('hash swapped to a different, unconsumed one → patch to the new hash and claim it', async () => {
    const h = makeHarness()
    const res = await h.priv.resolveReceiptHashTransition(ownRow({ txHash: H2 }), H1)
    expect(res).toEqual({ txHashPatch: { txHash: H1 }, claimHash: H1, staleClaim: false })
  })

  it('new hash already owned by THIS row → patch the column, claim nothing again', async () => {
    const h = makeHarness({ consumedFindFirst: { purpose: 'ADMIN_INCOME', referenceId: 'tx-own' } })
    const res = await h.priv.resolveReceiptHashTransition(ownRow({ txHash: null }), H1)
    expect(res).toEqual({ txHashPatch: { txHash: H1 }, claimHash: null, staleClaim: false })
  })

  it('new hash owned by ANOTHER row → 400 FINANCE_TX_HASH_ALREADY_CONSUMED', async () => {
    const h = makeHarness({ consumedFindFirst: { purpose: 'PAYOUT', referenceId: 'someone-else' } })
    await expect(
      h.priv.resolveReceiptHashTransition(ownRow({ txHash: null }), H1),
    ).rejects.toMatchObject({
      response: { code: 'FINANCE_TX_HASH_ALREADY_CONSUMED', statusCode: 400 },
      status: 400,
    })
  })

  it('new hash owned by a claim with no referenceId → also a different owner → 400', async () => {
    const h = makeHarness({ consumedFindFirst: { purpose: 'PAYOUT', referenceId: null } })
    await expect(
      h.priv.resolveReceiptHashTransition(ownRow({ txHash: null }), H1),
    ).rejects.toMatchObject({ response: { code: 'FINANCE_TX_HASH_ALREADY_CONSUMED' } })
  })
})

describe('audit record helpers', () => {
  it('recordReclaimAfterRelease: journals the normalized hash, falls back target to actor, warns', async () => {
    const h = makeHarness()
    await h.priv.recordReclaimAfterRelease(h.client, {
      path: 'createAdminIncome',
      txHash: H1_URL_UPPER,
      referenceId: 'tx-7',
      actorId: 'actor-1',
    })
    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0]!.table).toBe(transactionAuditLog)
    expect(h.inserts[0]!.values).toEqual({
      actorId: 'actor-1',
      targetId: 'tx-7',
      action: 'ONCHAIN_HASH_RECLAIMED_AFTER_RELEASE',
      metadata: { path: 'createAdminIncome', txHash: H1, referenceId: 'tx-7' },
    })
    expect(h.events).toEqual([
      'insert',
      'warn:[onchain-registry] previously RELEASED hash consumed again — ' +
        'path=createAdminIncome referenceId=tx-7 actorId=actor-1.',
    ])
  })

  it('recordReclaimAfterRelease: no referenceId → target is the actor, log says none', async () => {
    const h = makeHarness()
    await h.priv.recordReclaimAfterRelease(h.client, {
      path: 'p',
      txHash: H2,
      referenceId: null,
      actorId: 'actor-2',
    })
    expect(h.inserts[0]!.values).toEqual({
      actorId: 'actor-2',
      targetId: 'actor-2',
      action: 'ONCHAIN_HASH_RECLAIMED_AFTER_RELEASE',
      metadata: { path: 'p', txHash: H2, referenceId: null },
    })
    expect(h.events[1]).toBe(
      'warn:[onchain-registry] previously RELEASED hash consumed again — ' +
        'path=p referenceId=none actorId=actor-2.',
    )
  })

  it('recordReceiptClaimDivergence: journals against the transaction and warns', async () => {
    const h = makeHarness()
    await h.priv.recordReceiptClaimDivergence(h.client, {
      path: 'attachOrReplaceReceipt',
      transactionId: 'tx-9',
      actorId: 'actor-3',
    })
    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0]!.table).toBe(transactionAuditLog)
    expect(h.inserts[0]!.values).toEqual({
      actorId: 'actor-3',
      targetId: 'tx-9',
      action: 'RECEIPT_DROPPED_ONCHAIN_HASH',
      metadata: {
        path: 'attachOrReplaceReceipt',
        reason: 'new-receipt-carries-no-tx-hash-existing-claim-kept',
      },
    })
    expect(h.events).toEqual([
      'insert',
      'warn:[onchain-registry] receipt replaced with one carrying NO tx hash on a crediting row — ' +
        'path=attachOrReplaceReceipt transactionId=tx-9 actorId=actor-3. ' +
        'The previous claim is kept; use releaseOnChainHash if it was wrong.',
    ])
  })

  it('recordUnclaimedCredit: journals against the transaction and warns', async () => {
    const h = makeHarness()
    await h.priv.recordUnclaimedCredit(h.client, {
      path: 'declareUsdtProjectIncome',
      transactionId: 'tx-11',
      actorId: 'actor-4',
    })
    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0]!.table).toBe(transactionAuditLog)
    expect(h.inserts[0]!.values).toEqual({
      actorId: 'actor-4',
      targetId: 'tx-11',
      action: 'CREDIT_WITHOUT_ONCHAIN_CLAIM',
      metadata: { path: 'declareUsdtProjectIncome', reason: 'receipt-link-carries-no-tx-hash' },
    })
    expect(h.events).toEqual([
      'insert',
      'warn:[onchain-registry] company-account credit WITHOUT an on-chain claim — ' +
        'path=declareUsdtProjectIncome transactionId=tx-11 actorId=actor-4. ' +
        'The receipt link carries no 0x+64hex tx hash, so the transfer stays spendable ' +
        'by another settlement path. Verify the receipt.',
    ])
  })
})
