/**
 * AdminIncomeService — unit-level (doubles for db, claim registry, lifecycle).
 *
 * The collaborator returns the created / replayed row id; the viewer-scoped
 * read-back stays on TransactionsService (covered by admin-income-unified and
 * usdt-income-idempotency specs, which spy on the facade's `findOne`). This file
 * pins what is observable only at the collaborator seam: RBAC gates, the exact
 * inserted row, the on-chain claim arguments and the audit-journal calls, the
 * `where` predicates of the lookups, and the returned id.
 */
import { ForbiddenException } from '@nestjs/common'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getTableName } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { COMPANY_ACCOUNT_RECEIVER } from '@crm/shared'
import { AdminIncomeService } from './admin-income.service'

const consumeTxHashMock = vi.hoisted(() => vi.fn())
const assertBindableMock = vi.hoisted(() => vi.fn())
const bookObligationsMock = vi.hoisted(() => vi.fn())
const seniorSnapshotMock = vi.hoisted(() => vi.fn())
const dropShareMock = vi.hoisted(() => vi.fn())

vi.mock('./onchain-tx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./onchain-tx')>()),
  consumeTxHash: consumeTxHashMock,
}))
vi.mock('./receipt.util', () => ({ assertReceiptDocumentBindable: assertBindableMock }))
vi.mock('./company-obligations.util', () => ({ bookCompanyObligations: bookObligationsMock }))
vi.mock('./senior-share-snapshot.util', () => ({ resolveSeniorShareSnapshot: seniorSnapshotMock }))
vi.mock('./drop-share-resolver', () => ({ resolveDropShare: dropShareMock }))

const dialect = new PgDialect()
/** Renders a drizzle `where` to its bound parameters (independent of the code under test). */
function paramsOf(where: unknown): unknown[] {
  return dialect.sqlToQuery(where as never).params
}

const ADMIN: SessionUser = {
  id: 'admin-caller',
  role: 'ADMIN',
  displayName: 'Admin Caller',
  email: 'admin@x.com',
  avatarUrl: null,
  seniorSharePercent: 0,
}
const ACCOUNTANT: SessionUser = { ...ADMIN, id: 'accountant-caller', role: 'ACCOUNTANT' }
const JUNIOR: SessionUser = { ...ADMIN, id: 'junior-caller', role: 'JUNIOR' }

const PROJECT_ID = 'project-1'
const HASH = '0x' + 'ab'.repeat(32)
const EXPLORER_URL = `https://etherscan.io/tx/${HASH}`
const KEY = 'a1a2a3a4-0000-4000-8000-000000000001'

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    seniorId: ADMIN.id,
    dropId: null,
    companyName: 'Test Co',
    paymentType: 'FOP',
    status: 'ACTIVE',
    ...overrides,
  }
}

interface Harness {
  svc: AdminIncomeService
  inserted: Array<Record<string, unknown>>
  auditInserts: Array<Record<string, unknown>>
  projectsFindFirst: ReturnType<typeof vi.fn>
  usersFindFirst: ReturnType<typeof vi.fn>
  txFindFirst: ReturnType<typeof vi.fn>
  transaction: ReturnType<typeof vi.fn>
  onChainClaim: {
    recordUnclaimedCredit: ReturnType<typeof vi.fn>
    recordReclaimAfterRelease: ReturnType<typeof vi.fn>
  }
  lifecycle: { afterTransactionCreated: ReturnType<typeof vi.fn> }
  dbtx: unknown
}

function make(
  opts: {
    projectRow?: Record<string, unknown> | undefined
    users?: Array<Record<string, unknown> | undefined>
    replay?: Record<string, unknown> | undefined
    transactionError?: unknown
    committedAfterRace?: Record<string, unknown> | undefined
  } = {},
): Harness {
  const inserted: Array<Record<string, unknown>> = []
  // SR-809-L-3: audit rows are kept APART from ledger rows. The mock used to
  // ignore the table argument, so a transaction_audit_log insert landed in
  // `inserted` next to the transaction it describes — which both hid the audit
  // write from assertions and quietly polluted every exact-row expectation.
  const auditInserts: Array<Record<string, unknown>> = []
  const userQueue = [...(opts.users ?? [])]
  const dbtx = {
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        if (getTableName(table as never) === 'transaction_audit_log') {
          auditInserts.push(row)
          return { returning: async () => [row] }
        }
        const withId = { id: 'new-tx-id', ...row }
        inserted.push(withId)
        return { returning: async () => [withId] }
      },
    }),
  }
  const projectsFindFirst = vi.fn(async () => ('projectRow' in opts ? opts.projectRow : project()))
  const usersFindFirst = vi.fn(async () => userQueue.shift())
  const replayQueue = [opts.replay, opts.committedAfterRace]
  const txFindFirst = vi.fn(async () => replayQueue.shift())
  const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    if (opts.transactionError) throw opts.transactionError
    return cb(dbtx)
  })
  const db = {
    db: {
      transaction,
      query: {
        projects: { findFirst: projectsFindFirst },
        users: { findFirst: usersFindFirst },
        transactions: { findFirst: txFindFirst },
      },
    },
  }
  const onChainClaim = {
    recordUnclaimedCredit: vi.fn(async () => undefined),
    recordReclaimAfterRelease: vi.fn(async () => undefined),
  }
  const lifecycle = { afterTransactionCreated: vi.fn(async () => undefined) }
  const svc = new AdminIncomeService(db as never, onChainClaim as never, lifecycle as never)
  return {
    svc,
    inserted,
    auditInserts,
    projectsFindFirst,
    usersFindFirst,
    txFindFirst,
    transaction,
    onChainClaim,
    lifecycle,
    dbtx,
  }
}

const uniqueViolation = Object.assign(new Error('dup'), { code: '23505' })

beforeEach(() => {
  consumeTxHashMock.mockReset()
  consumeTxHashMock.mockResolvedValue({ claimed: true, reclaimedAfterRelease: false })
  assertBindableMock.mockReset()
  bookObligationsMock.mockReset()
  seniorSnapshotMock.mockReset()
  seniorSnapshotMock.mockResolvedValue({ value: 30, source: 'USER_DEFAULT' })
  dropShareMock.mockReset()
  dropShareMock.mockReturnValue({ value: 5, source: 'PROJECT' })
})

describe('AdminIncomeService.createAdminIncome', () => {
  it('rejects any role other than ADMIN / ACCOUNTANT before touching the db', async () => {
    const h = make()
    await expect(
      h.svc.createAdminIncome(
        {
          projectId: PROJECT_ID,
          amount: 10,
          currency: 'UAH',
          receiptExternalUrl: 'https://x.io/r',
        },
        JUNIOR,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)
    expect(h.projectsFindFirst).not.toHaveBeenCalled()
  })

  it('loads the project by the requested id', async () => {
    const h = make()
    await h.svc.createAdminIncome(
      { projectId: PROJECT_ID, amount: 10, currency: 'UAH', receiptExternalUrl: 'https://x.io/r' },
      ADMIN,
    )
    const [args] = h.projectsFindFirst.mock.calls[0] as unknown as [{ where: unknown }]
    expect(paramsOf(args.where)).toEqual([PROJECT_ID])
  })

  it('ADMIN on a project owned by someone else → FINANCE_INCOME_OWN_PROJECTS_ONLY', async () => {
    const h = make({ projectRow: project({ seniorId: 'someone-else' }) })
    await expect(
      h.svc.createAdminIncome(
        {
          projectId: PROJECT_ID,
          amount: 10,
          currency: 'UAH',
          receiptExternalUrl: 'https://x.io/r',
        },
        ADMIN,
      ),
    ).rejects.toMatchObject({ response: { code: 'FINANCE_INCOME_OWN_PROJECTS_ONLY' } })
    expect(h.transaction).not.toHaveBeenCalled()
  })

  describe('ACCOUNTANT project-owner lookup', () => {
    it('looks the owner up by the project seniorId', async () => {
      const h = make({
        projectRow: project({ seniorId: 'owner-admin' }),
        users: [{ id: 'owner-admin', role: 'ADMIN', archivedAt: null }],
      })
      await h.svc.createAdminIncome(
        {
          projectId: PROJECT_ID,
          amount: 10,
          currency: 'UAH',
          receiptExternalUrl: 'https://x.io/r',
        },
        ACCOUNTANT,
      )
      const [args] = h.usersFindFirst.mock.calls[0] as unknown as [{ where: unknown }]
      expect(paramsOf(args.where)).toEqual(['owner-admin'])
      expect(h.inserted[0]).toMatchObject({ receiverId: 'owner-admin', createdBy: ACCOUNTANT.id })
    })

    it('owner missing → FINANCE_ADMIN_INCOME_PROJECT_MUST_BE_ADMIN_OWNED (not a TypeError)', async () => {
      const h = make({ projectRow: project({ seniorId: 'ghost' }), users: [undefined] })
      await expect(
        h.svc.createAdminIncome(
          {
            projectId: PROJECT_ID,
            amount: 10,
            currency: 'UAH',
            receiptExternalUrl: 'https://x.io/r',
          },
          ACCOUNTANT,
        ),
      ).rejects.toMatchObject({
        response: { code: 'FINANCE_ADMIN_INCOME_PROJECT_MUST_BE_ADMIN_OWNED' },
      })
    })

    it('owner that is not an ADMIN → FINANCE_ADMIN_INCOME_PROJECT_MUST_BE_ADMIN_OWNED', async () => {
      const h = make({
        projectRow: project({ seniorId: 'sen' }),
        users: [{ id: 'sen', role: 'SENIOR', archivedAt: null }],
      })
      await expect(
        h.svc.createAdminIncome(
          {
            projectId: PROJECT_ID,
            amount: 10,
            currency: 'UAH',
            receiptExternalUrl: 'https://x.io/r',
          },
          ACCOUNTANT,
        ),
      ).rejects.toMatchObject({
        response: { code: 'FINANCE_ADMIN_INCOME_PROJECT_MUST_BE_ADMIN_OWNED' },
      })
    })
  })

  describe('receipt rules', () => {
    it('company-pool income is USDT: a file receipt is refused even though the supplied currency is UAH', async () => {
      const h = make()
      await expect(
        h.svc.createAdminIncome(
          {
            projectId: PROJECT_ID,
            amount: 10,
            currency: 'UAH',
            receiptDocumentId: 'doc-1',
            receiverId: COMPANY_ACCOUNT_RECEIVER,
          },
          ADMIN,
        ),
      ).rejects.toMatchObject({ status: 400 })
      expect(h.transaction).not.toHaveBeenCalled()
    })

    it('a non-USDT income accepts a file receipt and binds it before inserting', async () => {
      const h = make()
      await h.svc.createAdminIncome(
        { projectId: PROJECT_ID, amount: 10, currency: 'UAH', receiptDocumentId: 'doc-1' },
        ADMIN,
      )
      expect(assertBindableMock).toHaveBeenCalledWith(expect.anything(), 'doc-1', ADMIN)
      expect(h.inserted[0]).toMatchObject({ receiptDocumentId: 'doc-1', receiptExternalUrl: null })
    })

    it('no document → the bindable check is not run', async () => {
      const h = make()
      await h.svc.createAdminIncome(
        {
          projectId: PROJECT_ID,
          amount: 10,
          currency: 'UAH',
          receiptExternalUrl: 'https://x.io/r',
        },
        ADMIN,
      )
      expect(assertBindableMock).not.toHaveBeenCalled()
    })
  })

  // SR-809-H-1 / owner decision D-2, at THIS call site. The policy itself is
  // covered exhaustively in transaction-date-policy.spec.ts; what these pin is
  // that `createAdminIncome` actually passes the caller's role and the EXECUTED
  // flow, and records the justification. Without them the mutation gate leaves
  // `flow: 'EXECUTED'` and the whole options object alive: nothing observed the
  // difference between an EXECUTED flow and no flow at all.
  describe('transaction-date policy (SR-809-H-1)', () => {
    const base = {
      projectId: PROJECT_ID,
      amount: 10,
      currency: 'EUR' as const,
      receiptExternalUrl: 'https://x.io/r',
    }
    const dayOffset = (days: number) =>
      new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

    it('refuses a future date — an income records money already received', async () => {
      const h = make()
      await expect(
        h.svc.createAdminIncome({ ...base, txDate: dayOffset(1) }, ADMIN),
      ).rejects.toMatchObject({
        response: { code: 'FINANCE_TX_DATE_IN_FUTURE', statusCode: 400 },
      })
      expect(h.inserted).toHaveLength(0)
    })

    it('refuses a far backdate with no reason, and accepts it with one', async () => {
      const refused = make()
      await expect(
        refused.svc.createAdminIncome({ ...base, txDate: dayOffset(-200) }, ADMIN),
      ).rejects.toMatchObject({
        response: { code: 'FINANCE_TX_DATE_BACKDATE_REASON_REQUIRED', statusCode: 400 },
      })
      expect(refused.inserted).toHaveLength(0)

      const allowed = make()
      await allowed.svc.createAdminIncome(
        { ...base, txDate: dayOffset(-200), backdateReason: 'ledger import' },
        ADMIN,
      )
      expect(allowed.inserted).toHaveLength(1)
    })

    it('records the justification on the audit trail for an out-of-window backdate only', async () => {
      const backdated = make()
      await backdated.svc.createAdminIncome(
        { ...base, txDate: dayOffset(-200), backdateReason: '  ledger import  ' },
        ADMIN,
      )
      expect(backdated.auditInserts).toEqual([
        {
          actorId: ADMIN.id,
          targetId: 'new-tx-id',
          action: 'TX_DATE_BACKDATED',
          metadata: { txDate: dayOffset(-200), backdateReason: 'ledger import' },
        },
      ])

      // An ordinary in-window date had no exemption to justify, so nothing is written.
      const ordinary = make()
      await ordinary.svc.createAdminIncome({ ...base, txDate: dayOffset(-3) }, ADMIN)
      expect(ordinary.auditInserts).toEqual([])
    })
  })

  describe('inserted row', () => {
    it('personal income: exact row, no claim, defaults nullable fields to null', async () => {
      const h = make()
      const out = await h.svc.createAdminIncome(
        {
          projectId: PROJECT_ID,
          amount: 12.5,
          currency: 'EUR',
          receiptExternalUrl: 'https://x.io/r',
        },
        ADMIN,
      )
      expect(out).toEqual({ id: 'new-tx-id' })
      expect(h.inserted[0]).toMatchObject({
        type: 'ADMIN_INCOME',
        status: 'PAID',
        amount: '12.5',
        currency: 'EUR',
        senderId: null,
        senderLabel: 'Test Co',
        receiverId: ADMIN.id,
        projectId: PROJECT_ID,
        receiptDocumentId: null,
        receiptExternalUrl: 'https://x.io/r',
        txHash: null,
        notes: null,
        fundingSource: null,
        createdBy: ADMIN.id,
      })
      expect(h.inserted[0]!['txDate']).toBeInstanceOf(Date)
      expect(consumeTxHashMock).not.toHaveBeenCalled()
      expect(h.lifecycle.afterTransactionCreated).toHaveBeenCalledWith(
        'new-tx-id',
        expect.objectContaining({ id: 'new-tx-id' }),
        ADMIN,
      )
    })

    it('carries notes through and records the extracted hash even when not claiming', async () => {
      const h = make()
      await h.svc.createAdminIncome(
        {
          projectId: PROJECT_ID,
          amount: 1,
          currency: 'UAH',
          receiptExternalUrl: EXPLORER_URL,
          notes: 'March invoice',
        },
        ADMIN,
      )
      expect(h.inserted[0]).toMatchObject({ notes: 'March invoice', txHash: HASH })
      expect(consumeTxHashMock).not.toHaveBeenCalled()
    })
  })

  describe('company-funded claim', () => {
    const data = {
      projectId: PROJECT_ID,
      amount: 100,
      currency: 'UAH',
      receiptExternalUrl: EXPLORER_URL,
      receiverId: COMPANY_ACCOUNT_RECEIVER,
    }

    it('forces USDT, marks the pool, and claims the hash with the exact arguments', async () => {
      const h = make()
      await h.svc.createAdminIncome(data, ADMIN)
      expect(h.inserted[0]).toMatchObject({
        currency: 'USDT',
        fundingSource: 'COMPANY_ACCOUNT',
        receiverId: ADMIN.id,
      })
      expect(consumeTxHashMock).toHaveBeenCalledWith(h.dbtx, {
        txHash: EXPLORER_URL,
        purpose: 'ADMIN_INCOME',
        referenceId: 'new-tx-id',
        consumedByUserId: ADMIN.id,
      })
      expect(h.onChainClaim.recordUnclaimedCredit).not.toHaveBeenCalled()
      expect(h.onChainClaim.recordReclaimAfterRelease).not.toHaveBeenCalled()
    })

    it('an unclaimable receipt is journaled with the acting user', async () => {
      consumeTxHashMock.mockResolvedValue({ claimed: false, reclaimedAfterRelease: false })
      const h = make()
      await h.svc.createAdminIncome(data, ADMIN)
      expect(h.onChainClaim.recordUnclaimedCredit).toHaveBeenCalledWith(h.dbtx, {
        path: 'createAdminIncome',
        transactionId: 'new-tx-id',
        actorId: ADMIN.id,
      })
      expect(h.onChainClaim.recordReclaimAfterRelease).not.toHaveBeenCalled()
    })

    it('the journal actor is the impersonator when one is present', async () => {
      consumeTxHashMock.mockResolvedValue({ claimed: false, reclaimedAfterRelease: false })
      const h = make()
      await h.svc.createAdminIncome(data, { ...ADMIN, impersonatorId: 'real-admin' })
      expect(h.onChainClaim.recordUnclaimedCredit).toHaveBeenCalledWith(
        h.dbtx,
        expect.objectContaining({ actorId: 'real-admin' }),
      )
    })

    it('a hash re-spent after release journals the second half of the pair', async () => {
      consumeTxHashMock.mockResolvedValue({ claimed: true, reclaimedAfterRelease: true })
      const h = make()
      await h.svc.createAdminIncome(data, { ...ADMIN, impersonatorId: 'real-admin' })
      expect(h.onChainClaim.recordReclaimAfterRelease).toHaveBeenCalledWith(h.dbtx, {
        path: 'createAdminIncome',
        txHash: EXPLORER_URL,
        referenceId: 'new-tx-id',
        actorId: 'real-admin',
      })
      expect(h.onChainClaim.recordUnclaimedCredit).not.toHaveBeenCalled()
    })

    it('reclaim journal falls back to the caller when there is no impersonator', async () => {
      consumeTxHashMock.mockResolvedValue({ claimed: true, reclaimedAfterRelease: true })
      const h = make()
      await h.svc.createAdminIncome(data, ADMIN)
      expect(h.onChainClaim.recordReclaimAfterRelease).toHaveBeenCalledWith(
        h.dbtx,
        expect.objectContaining({ actorId: ADMIN.id }),
      )
    })
  })

  describe('failure mapping', () => {
    it('a unique violation (hash already consumed) → clean 400 FINANCE_TX_HASH_ALREADY_CONSUMED', async () => {
      const h = make({ transactionError: uniqueViolation })
      await expect(
        h.svc.createAdminIncome(
          {
            projectId: PROJECT_ID,
            amount: 1,
            currency: 'UAH',
            receiptExternalUrl: 'https://x.io/r',
          },
          ADMIN,
        ),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'FINANCE_TX_HASH_ALREADY_CONSUMED' },
      })
      expect(h.lifecycle.afterTransactionCreated).not.toHaveBeenCalled()
    })

    it('any other db failure is rethrown unchanged', async () => {
      const boom = new Error('boom')
      const h = make({ transactionError: boom })
      await expect(
        h.svc.createAdminIncome(
          {
            projectId: PROJECT_ID,
            amount: 1,
            currency: 'UAH',
            receiptExternalUrl: 'https://x.io/r',
          },
          ADMIN,
        ),
      ).rejects.toBe(boom)
    })
  })
})

describe('AdminIncomeService.declareUsdtProjectIncome', () => {
  const base = {
    projectId: PROJECT_ID,
    amount: 250,
    receiverId: COMPANY_ACCOUNT_RECEIVER,
    idempotencyKey: KEY,
    receiptExternalUrl: EXPLORER_URL,
  }
  const usdtProject = project({ paymentType: 'USDT' })

  it('non-ADMIN → 403 before the replay lookup', async () => {
    const h = make()
    await expect(h.svc.declareUsdtProjectIncome(base, ACCOUNTANT)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    expect(h.txFindFirst).not.toHaveBeenCalled()
  })

  it('replay: looks the key up as ADMIN_INCOME and returns the existing id with no write', async () => {
    const h = make({ replay: { id: 'existing-id' } })
    const out = await h.svc.declareUsdtProjectIncome(base, ADMIN)
    expect(out).toEqual({ id: 'existing-id' })
    const [args] = h.txFindFirst.mock.calls[0] as unknown as [{ where: unknown }]
    expect(paramsOf(args.where)).toEqual(['ADMIN_INCOME', KEY])
    expect(h.transaction).not.toHaveBeenCalled()
    expect(h.projectsFindFirst).not.toHaveBeenCalled()
  })

  it('a file receipt is refused for USDT income before the project is loaded', async () => {
    const h = make({ projectRow: usdtProject })
    await expect(
      h.svc.declareUsdtProjectIncome(
        { ...base, receiptExternalUrl: undefined, receiptDocumentId: 'doc-1' },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 400 })
    expect(h.projectsFindFirst).not.toHaveBeenCalled()
  })

  it('a non-USDT project → FINANCE_USDT_INCOME_PROJECT_TYPE_MISMATCH', async () => {
    const h = make({ projectRow: project({ paymentType: 'FOP' }) })
    await expect(h.svc.declareUsdtProjectIncome(base, ADMIN)).rejects.toMatchObject({
      response: { code: 'FINANCE_USDT_INCOME_PROJECT_TYPE_MISMATCH' },
    })
  })

  it('company pool: inserts the exact row, claims the hash, books obligations, returns the id', async () => {
    const h = make({ projectRow: usdtProject })
    const out = await h.svc.declareUsdtProjectIncome(
      { ...base, notes: 'n', receiptExternalUrl: EXPLORER_URL },
      ADMIN,
    )
    expect(out).toEqual({ id: 'new-tx-id' })
    expect(h.inserted[0]).toMatchObject({
      type: 'ADMIN_INCOME',
      status: 'PAID',
      amount: '250',
      currency: 'USDT',
      senderId: null,
      senderLabel: 'Test Co',
      receiverId: ADMIN.id,
      projectId: PROJECT_ID,
      fundingSource: 'COMPANY_ACCOUNT',
      idempotencyKey: KEY,
      receiptDocumentId: null,
      receiptExternalUrl: EXPLORER_URL,
      txHash: HASH,
      notes: 'n',
      createdBy: ADMIN.id,
    })
    expect(consumeTxHashMock).toHaveBeenCalledWith(h.dbtx, {
      txHash: EXPLORER_URL,
      purpose: 'ADMIN_INCOME',
      referenceId: 'new-tx-id',
      consumedByUserId: ADMIN.id,
    })
    expect(bookObligationsMock).toHaveBeenCalledWith(
      h.dbtx,
      expect.objectContaining({
        incomeAmount: 250,
        projectId: PROJECT_ID,
        companyName: 'Test Co',
        createdBy: ADMIN.id,
        incomeTransactionId: 'new-tx-id',
        senior: null,
        drop: null,
        notePrefix: 'USDT income',
      }),
    )
  })

  it('personal receiver: must be an active ADMIN, is credited, and nothing is claimed', async () => {
    const h = make({
      projectRow: usdtProject,
      users: [{ id: 'other-admin', role: 'ADMIN', archivedAt: null }],
    })
    await h.svc.declareUsdtProjectIncome({ ...base, receiverId: 'other-admin' }, ADMIN)
    const [args] = h.usersFindFirst.mock.calls[0] as unknown as [{ where: unknown }]
    expect(paramsOf(args.where)).toEqual(['other-admin'])
    expect(h.inserted[0]).toMatchObject({ receiverId: 'other-admin', fundingSource: null })
    expect(consumeTxHashMock).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', undefined],
    ['not an admin', { id: 'x', role: 'SENIOR', archivedAt: null }],
    ['archived', { id: 'x', role: 'ADMIN', archivedAt: new Date() }],
  ])('receiver %s → FINANCE_INCOME_RECEIVER_MUST_BE_ACTIVE_ADMIN', async (_label, user) => {
    const h = make({ projectRow: usdtProject, users: [user] })
    await expect(
      h.svc.declareUsdtProjectIncome({ ...base, receiverId: 'x' }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'FINANCE_INCOME_RECEIVER_MUST_BE_ACTIVE_ADMIN' } })
  })

  it('unclaimable hash and re-spend after release are journaled with the declaring path', async () => {
    consumeTxHashMock.mockResolvedValue({ claimed: false, reclaimedAfterRelease: true })
    const h = make({ projectRow: usdtProject })
    await h.svc.declareUsdtProjectIncome(base, { ...ADMIN, impersonatorId: 'real-admin' })
    expect(h.onChainClaim.recordUnclaimedCredit).toHaveBeenCalledWith(h.dbtx, {
      path: 'declareUsdtProjectIncome',
      transactionId: 'new-tx-id',
      actorId: 'real-admin',
    })
    expect(h.onChainClaim.recordReclaimAfterRelease).toHaveBeenCalledWith(h.dbtx, {
      path: 'declareUsdtProjectIncome',
      txHash: EXPLORER_URL,
      referenceId: 'new-tx-id',
      actorId: 'real-admin',
    })
  })

  it('a claimed, first-time hash is not journaled; the actor falls back to the caller', async () => {
    const h = make({ projectRow: usdtProject })
    await h.svc.declareUsdtProjectIncome(base, ADMIN)
    expect(h.onChainClaim.recordUnclaimedCredit).not.toHaveBeenCalled()
    expect(h.onChainClaim.recordReclaimAfterRelease).not.toHaveBeenCalled()
  })

  it('journal actor falls back to the caller when unclaimed without impersonation', async () => {
    consumeTxHashMock.mockResolvedValue({ claimed: false, reclaimedAfterRelease: true })
    const h = make({ projectRow: usdtProject })
    await h.svc.declareUsdtProjectIncome(base, ADMIN)
    expect(h.onChainClaim.recordUnclaimedCredit).toHaveBeenCalledWith(
      h.dbtx,
      expect.objectContaining({ actorId: ADMIN.id }),
    )
    expect(h.onChainClaim.recordReclaimAfterRelease).toHaveBeenCalledWith(
      h.dbtx,
      expect.objectContaining({ actorId: ADMIN.id }),
    )
  })

  describe('obligation parties', () => {
    const senior = { id: 'sen-1', role: 'SENIOR', seniorSharePercent: 40 }
    const dropUser = { id: 'drop-1', role: 'DROP', dropSharePercent: 7 }
    const withParties = () =>
      make({
        projectRow: project({
          paymentType: 'USDT',
          seniorId: 'sen-1',
          dropId: 'drop-1',
          seniorSharePercentOverride: 35,
          dropSharePercentOverride: 9,
        }),
        users: [senior, dropUser],
      })

    it('loads senior and drop by the project ids and books both with their share snapshots', async () => {
      const h = withParties()
      await h.svc.declareUsdtProjectIncome(base, ADMIN)
      const seniorArgs = h.usersFindFirst.mock.calls[0] as unknown as [{ where: unknown }]
      const dropArgs = h.usersFindFirst.mock.calls[1] as unknown as [{ where: unknown }]
      expect(paramsOf(seniorArgs[0].where)).toEqual(['sen-1'])
      expect(paramsOf(dropArgs[0].where)).toEqual(['drop-1'])
      expect(seniorSnapshotMock).toHaveBeenCalledWith(
        expect.anything(),
        { seniorSharePercentOverride: 35 },
        { id: 'sen-1', seniorSharePercent: 40 },
      )
      expect(dropShareMock).toHaveBeenCalledWith(
        { dropSharePercentOverride: 9 },
        { dropSharePercent: 7 },
      )
      expect(bookObligationsMock).toHaveBeenCalledWith(
        h.dbtx,
        expect.objectContaining({
          senior: {
            id: 'sen-1',
            role: 'SENIOR',
            shareSnapshot: { value: 30, source: 'USER_DEFAULT' },
          },
          drop: { id: 'drop-1', shareSnapshot: { value: 5, source: 'PROJECT' } },
        }),
      )
    })

    it('books the income row own txDate as the obligation date', async () => {
      const h = withParties()
      // SR-809-H-1 / D-2: 2020 is far outside the 31-day backdating window, so
      // an ADMIN now has to say WHY. The reason is what makes this legal; the
      // date itself is still honoured exactly as before.
      await h.svc.declareUsdtProjectIncome(
        { ...base, txDate: '2020-01-15', backdateReason: 'historical ledger import' },
        ADMIN,
      )
      const [, params] = bookObligationsMock.mock.calls[0] as unknown as [unknown, { txDate: Date }]
      expect(params.txDate).toBe(h.inserted[0]!['txDate'])
      expect((params.txDate as Date).toISOString().slice(0, 10)).toBe('2020-01-15')
      // SR-809-L-3: and the reason that made this backdate legal is on the trail.
      expect(h.auditInserts).toEqual([
        {
          actorId: ADMIN.id,
          targetId: 'new-tx-id',
          action: 'TX_DATE_BACKDATED',
          metadata: { txDate: '2020-01-15', backdateReason: 'historical ledger import' },
        },
      ])
    })

    it('writes no audit row for an in-window date — there was no exemption to justify', async () => {
      const h = withParties()
      const recent = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10)
      await h.svc.declareUsdtProjectIncome({ ...base, txDate: recent }, ADMIN)
      expect(h.auditInserts).toEqual([])
    })

    it('refuses the same far-backdated income when the ADMIN gives no reason (SR-809-H-1 / D-2)', async () => {
      const h = withParties()
      await expect(
        h.svc.declareUsdtProjectIncome({ ...base, txDate: '2020-01-15' }, ADMIN),
      ).rejects.toMatchObject({
        response: { code: 'FINANCE_TX_DATE_BACKDATE_REASON_REQUIRED', statusCode: 400 },
      })
      expect(h.inserted).toHaveLength(0)
    })

    it('refuses a future income date outright — a reason does not make money arrive tomorrow', async () => {
      const h = withParties()
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
      await expect(
        h.svc.declareUsdtProjectIncome(
          { ...base, txDate: tomorrow, backdateReason: 'anything' },
          ADMIN,
        ),
      ).rejects.toMatchObject({
        response: { code: 'FINANCE_TX_DATE_IN_FUTURE', statusCode: 400 },
      })
      expect(h.inserted).toHaveLength(0)
    })

    it('a party whose share snapshot cannot be resolved is not booked', async () => {
      seniorSnapshotMock.mockResolvedValue(null)
      dropShareMock.mockReturnValue(null)
      const h = withParties()
      await h.svc.declareUsdtProjectIncome(base, ADMIN)
      expect(bookObligationsMock).toHaveBeenCalledWith(
        h.dbtx,
        expect.objectContaining({ senior: null, drop: null }),
      )
    })
  })

  describe('concurrent race on the idempotency key', () => {
    it('unique violation + committed winner → returns the winner id', async () => {
      const h = make({
        projectRow: usdtProject,
        transactionError: uniqueViolation,
        committedAfterRace: { id: 'winner-id' },
      })
      const out = await h.svc.declareUsdtProjectIncome(base, ADMIN)
      expect(out).toEqual({ id: 'winner-id' })
      const [args] = h.txFindFirst.mock.calls[1] as unknown as [{ where: unknown }]
      expect(paramsOf(args.where)).toEqual(['ADMIN_INCOME', KEY])
    })

    it('unique violation without a winner → FINANCE_TX_HASH_ALREADY_CONSUMED (400)', async () => {
      const h = make({ projectRow: usdtProject, transactionError: uniqueViolation })
      await expect(h.svc.declareUsdtProjectIncome(base, ADMIN)).rejects.toMatchObject({
        status: 400,
        response: { code: 'FINANCE_TX_HASH_ALREADY_CONSUMED' },
      })
    })

    it('any other failure is rethrown unchanged', async () => {
      const boom = new Error('boom')
      const h = make({ projectRow: usdtProject, transactionError: boom })
      await expect(h.svc.declareUsdtProjectIncome(base, ADMIN)).rejects.toBe(boom)
    })
  })
})
