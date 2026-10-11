/**
 * AdminEditService — unit-level (doubles for db, claim registry, edit cascade,
 * invoices).
 *
 * The cascade branch is pinned by `cascade-apply.unit.spec.ts` through the
 * TransactionsService facade. This file pins what is observable at the
 * collaborator seam on the NON-cascade path: the RBAC / row-type gates, which
 * columns an edit writes (and which it leaves alone), the receipt XOR rule, the
 * receipt-hash claim arguments, the audit-journal payloads and the returned id.
 */
import { ForbiddenException } from '@nestjs/common'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { AdminEditService } from './admin-edit.service'

const consumeTxHashMock = vi.hoisted(() => vi.fn())
const assertBindableMock = vi.hoisted(() => vi.fn())

vi.mock('./onchain-tx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./onchain-tx')>()),
  consumeTxHash: consumeTxHashMock,
}))
vi.mock('./receipt.util', () => ({ assertReceiptDocumentBindable: assertBindableMock }))

const dialect = new PgDialect()
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
  legalFullName: null,
}
const TX_ID = 'tx-1'

function txRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TX_ID,
    type: 'EXPENSE',
    status: 'PENDING',
    amount: '100.000000',
    currency: 'USDT',
    receiverLabel: 'Acme',
    receiverId: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    salaryMonth: null,
    salaryOrigin: null,
    settledAmount: null,
    deletedAt: null,
    payoutRequestId: null,
    ...overrides,
  }
}

interface Written {
  table: string
  values: Record<string, unknown>
}

function tableOf(t: unknown): string {
  // Drizzle tables carry their SQL name under a well-known symbol; the public
  // `getTableName` is overkill for a double — compare by the column set.
  const cols = Object.keys(t as object)
  if (cols.includes('actorId')) return 'transaction_audit_log'
  if (cols.includes('sourceTransactionId')) return 'pending_obligations'
  return 'transactions'
}

function makeCtx(opts: { row?: Record<string, unknown> | undefined; noRow?: boolean } = {}) {
  const row = opts.noRow ? undefined : txRow(opts.row)
  const updates: Array<{ table: string; set: Record<string, unknown>; where: unknown }> = []
  const inserts: Written[] = []
  const findFirst = vi.fn(async (_args?: unknown) => row)

  const dbtx = {
    update: vi.fn((t: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: unknown) => {
          updates.push({ table: tableOf(t), set, where })
          const rows = [{ id: TX_ID }]
          return Object.assign(Promise.resolve(rows), {
            returning: () => Promise.resolve(rows),
          })
        },
      }),
    })),
    insert: vi.fn((t: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table: tableOf(t), values })
        return Promise.resolve([{ id: 'x' }])
      },
    })),
  }
  const db = {
    db: {
      query: { transactions: { findFirst } },
      transaction: vi.fn(async (cb: (tx: typeof dbtx) => Promise<unknown>) => cb(dbtx)),
      insert: dbtx.insert,
    },
  }

  const onChainClaim = {
    resolveReceiptHashTransition: vi.fn(async () => ({
      txHashPatch: {},
      claimHash: null as string | null,
      staleClaim: false,
    })),
    recordReclaimAfterRelease: vi.fn(async () => undefined),
    recordReceiptClaimDivergence: vi.fn(async () => undefined),
  }
  const invoices = {
    voidAndReissueInvoiceForAmountEdit: vi.fn(async () => 'NOT_NEEDED'),
    reissueSalaryInvoiceIfVoided: vi.fn(async () => 'NOT_NEEDED'),
    canRepairSalaryInvoice: vi.fn(async () => false),
  }
  const svc = new AdminEditService(
    db as never,
    onChainClaim as never,
    {} as never,
    invoices as never,
  )
  return { svc, db, findFirst, dbtx, updates, inserts, onChainClaim, invoices }
}

function txUpdate(ctx: ReturnType<typeof makeCtx>) {
  return ctx.updates.find((u) => u.table === 'transactions')!
}
function journal(ctx: ReturnType<typeof makeCtx>, action: string) {
  return ctx.inserts.filter(
    (i) => i.table === 'transaction_audit_log' && i.values.action === action,
  )
}

beforeEach(() => {
  consumeTxHashMock.mockReset()
  assertBindableMock.mockReset()
  assertBindableMock.mockResolvedValue(undefined)
  consumeTxHashMock.mockResolvedValue({ reclaimedAfterRelease: false })
})

describe('AdminEditService.adminUpdateTransaction — gates', () => {
  it('refuses a non-ADMIN before touching the database', async () => {
    const ctx = makeCtx()
    await expect(
      ctx.svc.adminUpdateTransaction(TX_ID, { notes: 'x' }, { ...ADMIN, role: 'SENIOR' }),
    ).rejects.toBeInstanceOf(ForbiddenException)
    expect(ctx.findFirst).not.toHaveBeenCalled()
  })

  it('looks the row up by the requested id', async () => {
    const ctx = makeCtx()
    await ctx.svc.adminUpdateTransaction(TX_ID, { notes: 'x' }, ADMIN)
    const args = ctx.findFirst.mock.calls[0]![0] as { where: unknown }
    expect(paramsOf(args.where)).toEqual([TX_ID])
  })

  it('404s a missing row', async () => {
    const ctx = makeCtx({ noRow: true })
    await expect(
      ctx.svc.adminUpdateTransaction(TX_ID, { notes: 'x' }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'FINANCE_TRANSACTION_NOT_FOUND' } })
  })

  it.each(['PAYOUT', 'PAYOUT_ADMIN', 'PAYOUT_CONFIRMED'])(
    'refuses editing a %s row',
    async (type) => {
      const ctx = makeCtx({ row: { type } })
      await expect(
        ctx.svc.adminUpdateTransaction(TX_ID, { notes: 'x' }, ADMIN),
      ).rejects.toMatchObject({ response: { code: 'FINANCE_EDIT_PAYOUT_FORBIDDEN' } })
      expect(ctx.db.db.transaction).not.toHaveBeenCalled()
    },
  )

  it('refuses a row linked to a payout request', async () => {
    const ctx = makeCtx({ row: { payoutRequestId: 'pr-1' } })
    await expect(
      ctx.svc.adminUpdateTransaction(TX_ID, { notes: 'x' }, ADMIN),
    ).rejects.toMatchObject({
      response: { code: 'FINANCE_EDIT_LINKED_TO_PAYOUT_REQUEST_FORBIDDEN' },
    })
  })

  it('refuses a currency change on a PAID row', async () => {
    const ctx = makeCtx({ row: { status: 'PAID' } })
    await expect(
      ctx.svc.adminUpdateTransaction(TX_ID, { currency: 'EUR' }, ADMIN),
    ).rejects.toMatchObject({ response: { code: expect.any(String) } })
    expect(ctx.db.db.transaction).not.toHaveBeenCalled()
  })

  it('lets an unchanged currency / salaryMonth through on a PAID row (change-based guard)', async () => {
    const ctx = makeCtx({ row: { status: 'PAID', salaryMonth: '2026-08' } })
    await expect(
      ctx.svc.adminUpdateTransaction(
        TX_ID,
        { currency: 'USDT', salaryMonth: '2026-08', notes: 'n' },
        ADMIN,
      ),
    ).resolves.toEqual({ id: TX_ID })
  })
})

describe('AdminEditService.adminUpdateTransaction — written columns', () => {
  it('writes only the fields that were sent', async () => {
    const ctx = makeCtx()
    await ctx.svc.adminUpdateTransaction(TX_ID, { notes: 'hello' }, ADMIN)
    const set = txUpdate(ctx).set
    expect(Object.keys(set).sort()).toEqual(['notes', 'updatedAt'])
    expect(set.notes).toBe('hello')
  })

  it('writes currency, category and salaryMonth under their column names', async () => {
    const ctx = makeCtx()
    await ctx.svc.adminUpdateTransaction(
      TX_ID,
      { currency: 'EUR', category: 'Beta', salaryMonth: '2026-09' },
      ADMIN,
    )
    const set = txUpdate(ctx).set
    expect(Object.keys(set).sort()).toEqual([
      'currency',
      'receiverLabel',
      'salaryMonth',
      'updatedAt',
    ])
    expect(set.currency).toBe('EUR')
    expect(set.receiverLabel).toBe('Beta')
    expect(set.salaryMonth).toBe('2026-09')
  })

  it('writes an explicit null note', async () => {
    const ctx = makeCtx()
    await ctx.svc.adminUpdateTransaction(TX_ID, { notes: null }, ADMIN)
    expect(txUpdate(ctx).set.notes).toBeNull()
  })

  it('merges the hash patch the claim registry resolved', async () => {
    const ctx = makeCtx()
    ctx.onChainClaim.resolveReceiptHashTransition.mockResolvedValue({
      txHashPatch: { txHash: '0xabc' },
      claimHash: null,
      staleClaim: false,
    })
    await ctx.svc.adminUpdateTransaction(TX_ID, { receiptExternalUrl: 'https://x/0xabc' }, ADMIN)
    expect(txUpdate(ctx).set.txHash).toBe('0xabc')
  })
})

describe('AdminEditService.adminUpdateTransaction — receipt XOR', () => {
  it('no receipt field sent: no receipt columns, no hash transition', async () => {
    const ctx = makeCtx({ row: { receiptDocumentId: 'd0', receiptExternalUrl: 'u0' } })
    await ctx.svc.adminUpdateTransaction(TX_ID, { notes: 'n' }, ADMIN)
    const set = txUpdate(ctx).set
    expect('receiptDocumentId' in set).toBe(false)
    expect('receiptExternalUrl' in set).toBe(false)
    expect(ctx.onChainClaim.resolveReceiptHashTransition).not.toHaveBeenCalled()
    expect(assertBindableMock).not.toHaveBeenCalled()
  })

  it('a new document wipes the url', async () => {
    const ctx = makeCtx({ row: { receiptExternalUrl: 'u0' } })
    await ctx.svc.adminUpdateTransaction(TX_ID, { receiptDocumentId: 'd1' }, ADMIN)
    const set = txUpdate(ctx).set
    expect(set.receiptDocumentId).toBe('d1')
    expect(set.receiptExternalUrl).toBeNull()
  })

  it('clearing the document keeps the stored url', async () => {
    const ctx = makeCtx({ row: { receiptDocumentId: 'd0', receiptExternalUrl: 'u0' } })
    await ctx.svc.adminUpdateTransaction(TX_ID, { receiptDocumentId: null }, ADMIN)
    const set = txUpdate(ctx).set
    expect(set.receiptDocumentId).toBeNull()
    expect(set.receiptExternalUrl).toBe('u0')
  })

  it('a new url wipes the document', async () => {
    const ctx = makeCtx({ row: { receiptDocumentId: 'd0' } })
    await ctx.svc.adminUpdateTransaction(TX_ID, { receiptExternalUrl: 'u1' }, ADMIN)
    const set = txUpdate(ctx).set
    expect(set.receiptExternalUrl).toBe('u1')
    expect(set.receiptDocumentId).toBeNull()
  })

  it('clearing the url keeps the stored document', async () => {
    const ctx = makeCtx({ row: { receiptDocumentId: 'd0', receiptExternalUrl: 'u0' } })
    await ctx.svc.adminUpdateTransaction(TX_ID, { receiptExternalUrl: null }, ADMIN)
    const set = txUpdate(ctx).set
    expect(set.receiptExternalUrl).toBeNull()
    expect(set.receiptDocumentId).toBe('d0')
  })

  it('both sent: each takes its own value', async () => {
    const ctx = makeCtx()
    await ctx.svc.adminUpdateTransaction(
      TX_ID,
      { receiptDocumentId: 'd1', receiptExternalUrl: 'u1' },
      ADMIN,
    )
    const set = txUpdate(ctx).set
    expect(set.receiptDocumentId).toBe('d1')
    expect(set.receiptExternalUrl).toBe('u1')
  })

  it('asks the hash registry with the stored row and the resolved url', async () => {
    const ctx = makeCtx({ row: { receiptExternalUrl: 'u0' } })
    await ctx.svc.adminUpdateTransaction(TX_ID, { receiptDocumentId: 'd1' }, ADMIN)
    expect(ctx.onChainClaim.resolveReceiptHashTransition).toHaveBeenCalledWith(
      expect.objectContaining({ id: TX_ID }),
      null,
    )
    const ctx2 = makeCtx()
    await ctx2.svc.adminUpdateTransaction(TX_ID, { receiptExternalUrl: 'u9' }, ADMIN)
    expect(ctx2.onChainClaim.resolveReceiptHashTransition).toHaveBeenCalledWith(
      expect.objectContaining({ id: TX_ID }),
      'u9',
    )
  })

  it('binds a changed document to the row receiver, falling back to the caller', async () => {
    const ctx = makeCtx({ row: { receiverId: 'recv-1' } })
    await ctx.svc.adminUpdateTransaction(TX_ID, { receiptDocumentId: 'd1' }, ADMIN)
    expect(assertBindableMock).toHaveBeenCalledWith(ctx.db.db, 'd1', ADMIN, {
      expectedOwnerId: 'recv-1',
    })
    assertBindableMock.mockClear()
    const ctx2 = makeCtx()
    await ctx2.svc.adminUpdateTransaction(TX_ID, { receiptDocumentId: 'd1' }, ADMIN)
    expect(assertBindableMock).toHaveBeenCalledWith(ctx2.db.db, 'd1', ADMIN, {
      expectedOwnerId: ADMIN.id,
    })
  })

  it('does not re-bind an unchanged document', async () => {
    const ctx = makeCtx({ row: { receiptDocumentId: 'd0' } })
    await ctx.svc.adminUpdateTransaction(TX_ID, { receiptDocumentId: 'd0' }, ADMIN)
    expect(assertBindableMock).not.toHaveBeenCalled()
  })
})

describe('AdminEditService.adminUpdateTransaction — audit journal', () => {
  it('writes no money-change entry for a metadata-only edit or unchanged values', async () => {
    const ctx = makeCtx({ row: { salaryMonth: '2026-08' } })
    await ctx.svc.adminUpdateTransaction(
      TX_ID,
      { notes: 'n', currency: 'USDT', category: 'Acme', salaryMonth: '2026-08' },
      ADMIN,
    )
    expect(journal(ctx, 'AMOUNT_OR_RECEIVER_CHANGE')).toHaveLength(0)
  })

  it('journals a currency change with before/after, and nothing else', async () => {
    const ctx = makeCtx()
    await ctx.svc.adminUpdateTransaction(TX_ID, { currency: 'EUR' }, ADMIN)
    const [entry] = journal(ctx, 'AMOUNT_OR_RECEIVER_CHANGE')
    expect(entry!.values.targetId).toBe(TX_ID)
    expect(entry!.values.metadata).toEqual({ currency: { before: 'USDT', after: 'EUR' } })
  })

  it('journals a receiver-label change with before/after, and nothing else', async () => {
    const ctx = makeCtx()
    await ctx.svc.adminUpdateTransaction(TX_ID, { category: 'Beta' }, ADMIN)
    const [entry] = journal(ctx, 'AMOUNT_OR_RECEIVER_CHANGE')
    expect(entry!.values.metadata).toEqual({ receiverLabel: { before: 'Acme', after: 'Beta' } })
  })

  it('journals a salary-month change with before/after, and nothing else', async () => {
    const ctx = makeCtx({ row: { salaryMonth: '2026-08' } })
    await ctx.svc.adminUpdateTransaction(TX_ID, { salaryMonth: '2026-09' }, ADMIN)
    const [entry] = journal(ctx, 'AMOUNT_OR_RECEIVER_CHANGE')
    expect(entry!.values.metadata).toEqual({
      salaryMonth: { before: '2026-08', after: '2026-09' },
    })
  })

  it('attributes the journal row to the impersonator when there is one, else the caller', async () => {
    const ctx = makeCtx()
    await ctx.svc.adminUpdateTransaction(
      TX_ID,
      { currency: 'EUR' },
      { ...ADMIN, impersonatorId: 'real-admin' },
    )
    expect(journal(ctx, 'AMOUNT_OR_RECEIVER_CHANGE')[0]!.values.actorId).toBe('real-admin')
    const ctx2 = makeCtx()
    await ctx2.svc.adminUpdateTransaction(TX_ID, { currency: 'EUR' }, ADMIN)
    expect(journal(ctx2, 'AMOUNT_OR_RECEIVER_CHANGE')[0]!.values.actorId).toBe(ADMIN.id)
  })
})

describe('AdminEditService.adminUpdateTransaction — on-chain claim', () => {
  it('claims nothing when the transition carries no hash', async () => {
    const ctx = makeCtx()
    await ctx.svc.adminUpdateTransaction(TX_ID, { receiptExternalUrl: 'u' }, ADMIN)
    expect(consumeTxHashMock).not.toHaveBeenCalled()
    expect(ctx.onChainClaim.recordReceiptClaimDivergence).not.toHaveBeenCalled()
  })

  it('consumes the resolved hash for this row, without a reclaim record on a fresh claim', async () => {
    const ctx = makeCtx()
    ctx.onChainClaim.resolveReceiptHashTransition.mockResolvedValue({
      txHashPatch: {},
      claimHash: '0xabc',
      staleClaim: false,
    })
    await ctx.svc.adminUpdateTransaction(TX_ID, { receiptExternalUrl: 'u' }, ADMIN)
    expect(consumeTxHashMock).toHaveBeenCalledWith(ctx.dbtx, {
      txHash: '0xabc',
      purpose: 'ADMIN_INCOME',
      referenceId: TX_ID,
      consumedByUserId: ADMIN.id,
    })
    expect(ctx.onChainClaim.recordReclaimAfterRelease).not.toHaveBeenCalled()
  })

  it('records a reclaim-after-release against the actor', async () => {
    const ctx = makeCtx()
    ctx.onChainClaim.resolveReceiptHashTransition.mockResolvedValue({
      txHashPatch: {},
      claimHash: '0xabc',
      staleClaim: false,
    })
    consumeTxHashMock.mockResolvedValue({ reclaimedAfterRelease: true })
    await ctx.svc.adminUpdateTransaction(
      TX_ID,
      { receiptExternalUrl: 'u' },
      { ...ADMIN, impersonatorId: 'real-admin' },
    )
    expect(ctx.onChainClaim.recordReclaimAfterRelease).toHaveBeenCalledWith(ctx.dbtx, {
      path: 'adminUpdateTransaction',
      txHash: '0xabc',
      referenceId: TX_ID,
      actorId: 'real-admin',
    })
  })

  it('records a stale-claim divergence against the actor', async () => {
    const ctx = makeCtx()
    ctx.onChainClaim.resolveReceiptHashTransition.mockResolvedValue({
      txHashPatch: {},
      claimHash: null,
      staleClaim: true,
    })
    await ctx.svc.adminUpdateTransaction(TX_ID, { receiptExternalUrl: 'u' }, ADMIN)
    expect(ctx.onChainClaim.recordReceiptClaimDivergence).toHaveBeenCalledWith(ctx.dbtx, {
      path: 'adminUpdateTransaction',
      transactionId: TX_ID,
      actorId: ADMIN.id,
    })
  })
})

describe('AdminEditService.adminUpdateTransaction — result', () => {
  it('returns just the edited id when no invoice step failed', async () => {
    const ctx = makeCtx()
    await expect(
      ctx.svc.adminUpdateTransaction(TX_ID, { notes: 'n' }, ADMIN),
    ).resolves.toStrictEqual({
      id: TX_ID,
    })
  })

  it('flags a self-repairable invoice failure on the edited salary', async () => {
    const ctx = makeCtx({ row: { type: 'SALARY', status: 'PAID' } })
    ctx.invoices.reissueSalaryInvoiceIfVoided.mockResolvedValue('REISSUE_FAILED' as never)
    ctx.invoices.canRepairSalaryInvoice.mockResolvedValue(true)
    await expect(ctx.svc.adminUpdateTransaction(TX_ID, { notes: 'n' }, ADMIN)).resolves.toEqual({
      id: TX_ID,
      invoiceReissueIncomplete: 'SELF_REPAIRABLE',
    })
    expect(journal(ctx, 'INVOICE_REISSUE_FAILED')[0]!.values.metadata).toEqual({
      stage: 'REISSUE',
    })
  })

  it('asks for a manual check when the repair probe cannot promise a fix or throws', async () => {
    const ctx = makeCtx({ row: { type: 'SALARY', status: 'PAID' } })
    ctx.invoices.reissueSalaryInvoiceIfVoided.mockResolvedValue('VOID_FAILED' as never)
    ctx.invoices.canRepairSalaryInvoice.mockRejectedValue(new Error('boom'))
    await expect(ctx.svc.adminUpdateTransaction(TX_ID, { notes: 'n' }, ADMIN)).resolves.toEqual({
      id: TX_ID,
      invoiceReissueIncomplete: 'MANUAL_CHECK',
    })
  })
})
