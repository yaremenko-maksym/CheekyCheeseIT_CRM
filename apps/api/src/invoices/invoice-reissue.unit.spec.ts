import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '@nestjs/common'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

import {
  invoiceSignatures,
  nonDeletedTransactions,
  transactionAuditLog,
  transactions,
} from '../database/schema'
import { InvoicesService } from './invoices.service'

/**
 * Characterization net for the void / re-issue cluster of `InvoicesService`
 * (`voidInvoiceForAmountEdit`, `reissueInvoiceIfStillPaid`,
 * `voidAndReissueInvoiceForAmountEdit`, `loadReissueState`, the state
 * predicates, `reissueAndVerify`) written BEFORE the cluster moves into its own
 * service, so the move is mutation-clean without Stryker directives.
 *
 * Complements `invoice-reissue-outcome.unit.spec.ts` (decisions over a stubbed
 * state) and the `reissueInvoiceIfStillPaid` block of `invoices.service.spec.ts`
 * (type dispatch). What those cannot see — and this file pins — is the QUERY
 * the cluster sends: a recording drizzle double captures every chain in call
 * order and each WHERE is compiled to SQL + params, so a dropped conjunct, a
 * flipped `isNull`/`isNotNull`, a changed signer role / audit action / stage
 * literal or a lost row lock changes the compiled text and fails here.
 */

const dialect = new PgDialect()
const compile = (s: SQL | undefined) => {
  expect(s).toBeDefined()
  const { sql, params } = dialect.sqlToQuery(s as SQL)
  return { sql, params }
}

interface Call {
  kind: 'select' | 'update' | 'softDelete'
  cols?: Record<string, unknown>
  table?: unknown
  where?: SQL
  lock?: unknown
  order?: SQL[]
  limit?: number
  set?: Record<string, unknown>
  args?: unknown[]
}

/**
 * Recording double of drizzle's builder. Selects consume `answers` in call
 * order; the builder is thenable so a chain ending at `.where()` (no `.limit`)
 * resolves too. `transaction(cb)` hands the SAME double to `cb`, so the
 * transactional reads/writes land in the same ordered log.
 */
function recorder(answers: unknown[][] = []) {
  const calls: Call[] = []
  const queue = [...answers]
  const builder = (call: Call) => {
    const b: Record<string, unknown> = {
      from: (t: unknown) => ((call.table = t), b),
      where: (w: SQL) => ((call.where = w), b),
      for: (m: unknown) => ((call.lock = m), b),
      orderBy: (...o: SQL[]) => ((call.order = o), b),
      limit: (n: number) => ((call.limit = n), b),
      set: (v: Record<string, unknown>) => ((call.set = v), b),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(call.kind === 'select' ? (queue.shift() ?? []) : undefined).then(res, rej),
    }
    calls.push(call)
    return b
  }
  const db = {
    select: (cols?: Record<string, unknown>) => builder({ kind: 'select', cols }),
    update: (table: unknown) => builder({ kind: 'update', table }),
    transaction: <T>(cb: (tx: unknown) => Promise<T>) => cb(db),
  }
  return { db, calls }
}

function makeService(answers: unknown[][] = []) {
  const { db, calls } = recorder(answers)
  const svc = Object.create(InvoicesService.prototype) as InvoicesService
  const internals = svc as unknown as Record<string, unknown>
  internals['logger'] = new Logger('test')
  internals['db'] = { db }
  const softDeleteInternal = vi.fn((...args: unknown[]) => {
    calls.push({ kind: 'softDelete', args })
    return Promise.resolve()
  })
  internals['documentsService'] = { softDeleteInternal }
  return { svc, calls, internals, softDeleteInternal }
}

const NOW = new Date('2026-10-12T09:30:00.000Z')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// voidInvoiceForAmountEdit
// ---------------------------------------------------------------------------

describe('voidInvoiceForAmountEdit — one locked transaction, three writes', () => {
  const TX_ROW = { id: 'tx-1', invoiceDocumentId: 'doc-1' }

  it('locks the live transaction row (FOR UPDATE, deleted_at IS NULL, limit 1) before anything else', async () => {
    const { svc, calls } = makeService([[TX_ROW], []])
    await svc.voidInvoiceForAmountEdit('tx-1', 'actor-1')

    const first = calls[0]!
    expect(first.kind).toBe('select')
    expect(first.cols).toBeUndefined() // select() — the whole row, not a projection
    expect(compile(first.where)).toEqual({
      sql: '("transactions"."id" = $1 and "transactions"."deleted_at" is null)',
      params: ['tx-1'],
    })
    expect(first.lock).toBe('update')
    expect(first.limit).toBe(1)
  })

  it('no such live row → nothing voided, nothing written', async () => {
    const { svc, calls, softDeleteInternal } = makeService([[]])
    await expect(svc.voidInvoiceForAmountEdit('tx-1', 'actor-1')).resolves.toEqual({
      hadInvoice: false,
      wasSigned: false,
    })
    expect(calls).toHaveLength(1)
    expect(softDeleteInternal).not.toHaveBeenCalled()
  })

  it('row without an invoice → hadInvoice:false, no signature read, no writes', async () => {
    const { svc, calls, softDeleteInternal } = makeService([
      [{ ...TX_ROW, invoiceDocumentId: null }],
    ])
    await expect(svc.voidInvoiceForAmountEdit('tx-1', 'actor-1')).resolves.toEqual({
      hadInvoice: false,
      wasSigned: false,
    })
    expect(calls).toHaveLength(1)
    expect(softDeleteInternal).not.toHaveBeenCalled()
  })

  it('reads the ACTIVE signatures, soft-deletes the document, void-stamps every active signature, nulls the FK — in that order', async () => {
    const { svc, calls, softDeleteInternal, internals } = makeService([
      [TX_ROW],
      [{ signerRole: 'COMPANY' }, { signerRole: 'COUNTERPARTY' }],
    ])
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)

    await expect(svc.voidInvoiceForAmountEdit('tx-1', 'actor-1')).resolves.toEqual({
      hadInvoice: true,
      wasSigned: true,
    })

    expect(calls.map((c) => c.kind)).toEqual(['select', 'select', 'softDelete', 'update', 'update'])

    const sigsRead = calls[1]!
    expect(Object.keys(sigsRead.cols ?? {})).toEqual(['signerRole'])
    expect(compile(sigsRead.where)).toEqual({
      sql: '("invoice_signatures"."transaction_id" = $1 and "invoice_signatures"."voided_at" is null)',
      params: ['tx-1'],
    })
    expect(sigsRead.limit).toBeUndefined()

    // the document, the actor, and the SAME transaction handle (not the pool)
    expect(softDeleteInternal).toHaveBeenCalledTimes(1)
    expect(softDeleteInternal).toHaveBeenCalledWith(
      'doc-1',
      'actor-1',
      (internals['db'] as { db: unknown }).db,
    )

    const sigVoid = calls[3]!
    expect(sigVoid.set).toEqual({ voidedAt: NOW })
    expect(compile(sigVoid.where)).toEqual({
      sql: '("invoice_signatures"."transaction_id" = $1 and "invoice_signatures"."voided_at" is null)',
      params: ['tx-1'],
    })

    const fkNull = calls[4]!
    expect(fkNull.set).toEqual({ invoiceDocumentId: null, updatedAt: NOW })
    expect(compile(fkNull.where)).toEqual({
      sql: '"transactions"."id" = $1',
      params: ['tx-1'],
    })

    expect(log).toHaveBeenCalledWith('voidInvoiceForAmountEdit: tx=tx-1 wasSigned=true doc=doc-1')
  })

  it('writes target the RAW tables (invoice_signatures, transactions), not the view', async () => {
    const { svc, calls } = makeService([[TX_ROW], []])
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    await svc.voidInvoiceForAmountEdit('tx-1', 'actor-1')
    expect(calls[0]!.table).toBe(transactions)
    expect(calls[1]!.table).toBe(invoiceSignatures)
    expect(calls[3]!.table).toBe(invoiceSignatures)
    expect(calls[4]!.table).toBe(transactions)
  })

  it('only a COMPANY signature → wasSigned:false (the invoice is still voided)', async () => {
    const { svc, softDeleteInternal } = makeService([[TX_ROW], [{ signerRole: 'COMPANY' }]])
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    await expect(svc.voidInvoiceForAmountEdit('tx-1', 'actor-1')).resolves.toEqual({
      hadInvoice: true,
      wasSigned: false,
    })
    expect(softDeleteInternal).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('voidInvoiceForAmountEdit: tx=tx-1 wasSigned=false doc=doc-1')
  })

  it('no signatures at all → wasSigned:false', async () => {
    const { svc } = makeService([[TX_ROW], []])
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    await expect(svc.voidInvoiceForAmountEdit('tx-1', 'actor-1')).resolves.toEqual({
      hadInvoice: true,
      wasSigned: false,
    })
  })

  it('a failing soft-delete aborts BEFORE the signature and FK writes (all-or-nothing)', async () => {
    const { svc, calls, softDeleteInternal } = makeService([[TX_ROW], []])
    softDeleteInternal.mockRejectedValueOnce(new Error('boom'))
    await expect(svc.voidInvoiceForAmountEdit('tx-1', 'actor-1')).rejects.toThrow('boom')
    expect(calls.filter((c) => c.kind === 'update')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// reissueInvoiceIfStillPaid — the read it stands on
// ---------------------------------------------------------------------------

describe('reissueInvoiceIfStillPaid — the row read', () => {
  it('reads the whole row from the soft-delete VIEW, by id, limit 1', async () => {
    const { svc, calls, internals } = makeService([[]])
    internals['autoCreateForSalary'] = vi.fn()
    await svc.reissueInvoiceIfStillPaid('tx-9')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.cols).toBeUndefined()
    expect(compile(calls[0]!.where)).toEqual({
      sql: '"non_deleted_transactions"."id" = $1',
      params: ['tx-9'],
    })
    expect(calls[0]!.limit).toBe(1)
    expect(calls[0]!.table).toBe(nonDeletedTransactions)
  })

  it.each([
    ['SALARY', 'autoCreateForSalary', 'autoCreateForSeniorPayout'],
    ['SENIOR_INCOME', 'autoCreateForSeniorPayout', 'autoCreateForSalary'],
  ])('%s → exactly %s, with the row id', async (type, expected, other) => {
    const { svc, internals } = makeService([
      [{ id: 'tx-9', type, status: 'PAID', payoutRequestId: null }],
    ])
    const hit = vi.fn(() => Promise.resolve())
    const miss = vi.fn(() => Promise.resolve())
    internals[expected] = hit
    internals[other] = miss
    await svc.reissueInvoiceIfStillPaid('tx-9')
    expect(hit).toHaveBeenCalledExactlyOnceWith('tx-9')
    expect(miss).not.toHaveBeenCalled()
  })

  it.each([
    ['not PAID', { status: 'PENDING', payoutRequestId: null }],
    ['payout-linked', { status: 'PAID', payoutRequestId: 'pr-1' }],
    ['PAYOUT-type', { type: 'PAYOUT', status: 'PAID', payoutRequestId: null }],
    ['DROP_INCOME-type', { type: 'DROP_INCOME', status: 'PAID', payoutRequestId: null }],
  ])('a %s row is a pure no-op — neither trigger fires', async (_l, patch) => {
    const { svc, calls, internals } = makeService([[{ id: 'tx-9', type: 'SALARY', ...patch }]])
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const salary = vi.fn(() => Promise.resolve())
    const senior = vi.fn(() => Promise.resolve())
    internals['autoCreateForSalary'] = salary
    internals['autoCreateForSeniorPayout'] = senior
    await expect(svc.reissueInvoiceIfStillPaid('tx-9')).resolves.toBeUndefined()
    expect(salary).not.toHaveBeenCalled()
    expect(senior).not.toHaveBeenCalled()
    // the single row read is all that happened: no writes, no warning
    expect(calls.map((c) => c.kind)).toEqual(['select'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('a failure is logged as a warning that names the row and the cause, and never thrown', async () => {
    const { svc, internals } = makeService([
      [{ id: 'tx-9', type: 'SALARY', status: 'PAID', payoutRequestId: null }],
    ])
    internals['autoCreateForSalary'] = vi.fn(() => Promise.reject(new Error('pdf down')))
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    await expect(svc.reissueInvoiceIfStillPaid('tx-9')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'reissueInvoiceIfStillPaid: auto-create failed for tx=tx-9: pdf down',
    )
  })
})

// ---------------------------------------------------------------------------
// loadReissueState — the five queries, compiled
// ---------------------------------------------------------------------------

describe('loadReissueState — the exact queries', () => {
  const ROW = {
    type: 'SALARY',
    status: 'PAID',
    payoutRequestId: null,
    invoiceDocumentId: null,
    amount: '100.000000',
  }
  const load = (svc: InvoicesService) =>
    (svc as unknown as { loadReissueState: (id: string) => Promise<unknown> }).loadReissueState(
      'tx-7',
    )

  it('no row → null after ONE query (the signature / journal probes are not sent)', async () => {
    const { svc, calls } = makeService([[]])
    await expect(load(svc)).resolves.toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('sends five reads in a fixed order, each with its exact predicate, ordering and limit', async () => {
    const { svc, calls } = makeService([[ROW], [], [], [], []])
    await load(svc)

    expect(calls.map((c) => c.kind)).toEqual(['select', 'select', 'select', 'select', 'select'])
    const [row, voided, counter, company, failure] = calls as [Call, Call, Call, Call, Call]

    expect(row.table).toBe(nonDeletedTransactions)
    expect([voided.table, counter.table, company.table]).toEqual([
      invoiceSignatures,
      invoiceSignatures,
      invoiceSignatures,
    ])
    expect(failure.table).toBe(transactionAuditLog)

    // 1. the transaction row — through the VIEW, projection of five columns
    expect(Object.keys(row.cols ?? {})).toEqual([
      'type',
      'status',
      'payoutRequestId',
      'invoiceDocumentId',
      'amount',
    ])
    expect(compile(row.where)).toEqual({
      sql: '"non_deleted_transactions"."id" = $1',
      params: ['tx-7'],
    })
    expect(row.limit).toBe(1)

    // 2. a VOIDED signature exists (isNotNull) — the durable «an invoice was taken away»
    expect(Object.keys(voided.cols ?? {})).toEqual(['id'])
    expect(compile(voided.where)).toEqual({
      sql: '("invoice_signatures"."transaction_id" = $1 and "invoice_signatures"."voided_at" is not null)',
      params: ['tx-7'],
    })
    expect(voided.order).toBeUndefined()
    expect(voided.limit).toBe(1)

    // 3. the ACTIVE COUNTERPARTY snapshot, newest first
    expect(Object.keys(counter.cols ?? {})).toEqual(['amountSnapshot'])
    expect(compile(counter.where)).toEqual({
      sql: '("invoice_signatures"."transaction_id" = $1 and "invoice_signatures"."signer_role" = $2 and "invoice_signatures"."voided_at" is null)',
      params: ['tx-7', 'COUNTERPARTY'],
    })
    expect(counter.order!.map((o) => compile(o).sql)).toEqual([
      '"invoice_signatures"."signed_at" desc',
    ])
    expect(counter.limit).toBe(1)

    // 4. the ACTIVE COMPANY signature, newest first
    expect(Object.keys(company.cols ?? {})).toEqual(['signedAt'])
    expect(compile(company.where)).toEqual({
      sql: '("invoice_signatures"."transaction_id" = $1 and "invoice_signatures"."signer_role" = $2 and "invoice_signatures"."voided_at" is null)',
      params: ['tx-7', 'COMPANY'],
    })
    expect(company.order!.map((o) => compile(o).sql)).toEqual([
      '"invoice_signatures"."signed_at" desc',
    ])
    expect(company.limit).toBe(1)

    // 5. the last recorded VOID-stage failure in the audit journal
    expect(Object.keys(failure.cols ?? {})).toEqual(['createdAt'])
    expect(compile(failure.where)).toEqual({
      sql: `("transaction_audit_log"."target_id" = $1 and "transaction_audit_log"."action" = $2 and "transaction_audit_log"."metadata" ->> 'stage' = 'VOID')`,
      params: ['tx-7', 'INVOICE_REISSUE_FAILED'],
    })
    expect(failure.order!.map((o) => compile(o).sql)).toEqual([
      '"transaction_audit_log"."created_at" desc',
    ])
    expect(failure.limit).toBe(1)
  })

  it('maps the answers: row columns spread, boolean from the voided probe, nulls for absent witnesses', async () => {
    const signedAt = new Date('2026-10-01T00:00:00.000Z')
    const failedAt = new Date('2026-10-02T00:00:00.000Z')
    const { svc } = makeService([
      [ROW],
      [{ id: 'sig' }],
      [{ amountSnapshot: '90.000000' }],
      [{ signedAt }],
      [{ createdAt: failedAt }],
    ])
    await expect(load(svc)).resolves.toEqual({
      ...ROW,
      hasVoidedInvoice: true,
      signedAmountSnapshot: '90.000000',
      activeCompanySignedAt: signedAt,
      lastVoidFailureAt: failedAt,
    })
  })

  it('a null amount_snapshot on an existing countersignature stays null (pre-snapshot rows)', async () => {
    const { svc } = makeService([[ROW], [], [{ amountSnapshot: null }], [], []])
    await expect(load(svc)).resolves.toMatchObject({ signedAmountSnapshot: null })
  })
})

// ---------------------------------------------------------------------------
// state predicates through the public surface
// ---------------------------------------------------------------------------

describe('canRepairSalaryInvoice / reissueSalaryInvoiceIfVoided over the REAL state read', () => {
  const ROW = {
    type: 'SALARY',
    status: 'PAID',
    payoutRequestId: null,
    invoiceDocumentId: 'doc-old',
    amount: '100.000000',
  }

  /** answers for one loadReissueState: row, voided, counterparty, company, failure */
  const state = (
    row: Record<string, unknown>,
    opts: {
      voided?: boolean
      snapshot?: string | null
      companyAt?: Date | null
      failureAt?: Date | null
    } = {},
  ): unknown[][] => [
    [row],
    opts.voided ? [{ id: 's' }] : [],
    opts.snapshot === undefined || opts.snapshot === null
      ? []
      : [{ amountSnapshot: opts.snapshot }],
    opts.companyAt ? [{ signedAt: opts.companyAt }] : [],
    opts.failureAt ? [{ createdAt: opts.failureAt }] : [],
  ]

  it('countersigned figure that differs only below 6 decimals is NOT a disagreement', async () => {
    const { svc } = makeService(state(ROW, { snapshot: '100.0000004' }))
    await expect(svc.canRepairSalaryInvoice('tx')).resolves.toBe(false)
  })

  it('countersigned figure differing at the 6th decimal IS a disagreement', async () => {
    const { svc } = makeService(state(ROW, { snapshot: '100.000001' }))
    await expect(svc.canRepairSalaryInvoice('tx')).resolves.toBe(true)
  })

  it('same number, different textual scale (100 vs 100.000000) agrees', async () => {
    const { svc } = makeService(state(ROW, { snapshot: '100' }))
    await expect(svc.canRepairSalaryInvoice('tx')).resolves.toBe(false)
  })

  it('journal witness: failure newer than the live company signature → repairable', async () => {
    const { svc } = makeService(
      state(ROW, {
        companyAt: new Date('2026-10-01T00:00:00Z'),
        failureAt: new Date('2026-10-02T00:00:00Z'),
      }),
    )
    await expect(svc.canRepairSalaryInvoice('tx')).resolves.toBe(true)
  })

  it('journal witness: failure OLDER than the live company signature → already repaired', async () => {
    const { svc } = makeService(
      state(ROW, {
        companyAt: new Date('2026-10-02T00:00:00Z'),
        failureAt: new Date('2026-10-01T00:00:00Z'),
      }),
    )
    await expect(svc.canRepairSalaryInvoice('tx')).resolves.toBe(false)
  })

  it('journal witness: failure on record, no live company signature → repairable', async () => {
    const { svc } = makeService(state(ROW, { failureAt: new Date('2026-10-02T00:00:00Z') }))
    await expect(svc.canRepairSalaryInvoice('tx')).resolves.toBe(true)
  })

  it('journal witness: no failure on record, no snapshot → not repairable', async () => {
    const { svc } = makeService(state(ROW, { companyAt: new Date('2026-10-02T00:00:00Z') }))
    await expect(svc.canRepairSalaryInvoice('tx')).resolves.toBe(false)
  })

  it('REISSUE stage: no document + a voided signature → repairable; without the voided signature → not', async () => {
    const gone = { ...ROW, invoiceDocumentId: null }
    await expect(
      makeService(state(gone, { voided: true })).svc.canRepairSalaryInvoice('tx'),
    ).resolves.toBe(true)
    await expect(
      makeService(state(gone, { voided: false })).svc.canRepairSalaryInvoice('tx'),
    ).resolves.toBe(false)
  })

  it('a live document with a voided signature on record (an earlier repair) is not «awaiting re-issue»', async () => {
    await expect(
      makeService(state(ROW, { voided: true })).svc.canRepairSalaryInvoice('tx'),
    ).resolves.toBe(false)
  })

  it('reissueSalaryInvoiceIfVoided: REISSUE stage → state(5) · row read(1) · autoCreateForSalary · state(5) → REISSUED', async () => {
    const { svc, calls, internals } = makeService([
      ...state({ ...ROW, invoiceDocumentId: null }, { voided: true }),
      [{ id: 'tx', type: 'SALARY', status: 'PAID', payoutRequestId: null }],
      ...state({ ...ROW, invoiceDocumentId: 'doc-new' }),
    ])
    const autoCreateForSalary = vi.fn(() => Promise.resolve())
    internals['autoCreateForSalary'] = autoCreateForSalary
    await expect(svc.reissueSalaryInvoiceIfVoided('tx', 'actor')).resolves.toBe('REISSUED')
    expect(autoCreateForSalary).toHaveBeenCalledExactlyOnceWith('tx')
    expect(calls.filter((c) => c.kind === 'select')).toHaveLength(11)
  })
})

// ---------------------------------------------------------------------------
// voidAndReissueInvoiceForAmountEdit / reissueAndVerify — orchestration
// ---------------------------------------------------------------------------

describe('voidAndReissueInvoiceForAmountEdit — sequencing and verdict', () => {
  type S = {
    type: string
    status: string
    payoutRequestId: string | null
    invoiceDocumentId: string | null
    hasVoidedInvoice: boolean
  }
  const PAID_SALARY: S = {
    type: 'SALARY',
    status: 'PAID',
    payoutRequestId: null,
    invoiceDocumentId: null,
    hasVoidedInvoice: true,
  }

  function make(opts: { hadInvoice: boolean; states: Array<S | null> }) {
    const svc = Object.create(InvoicesService.prototype) as InvoicesService
    const internals = svc as unknown as Record<string, unknown>
    internals['logger'] = new Logger('test')
    const order: string[] = []
    const queue = [...opts.states]
    internals['voidInvoiceForAmountEdit'] = vi.fn((...a: unknown[]) => {
      order.push(`void(${a.join(',')})`)
      return Promise.resolve({ hadInvoice: opts.hadInvoice, wasSigned: false })
    })
    internals['reissueInvoiceIfStillPaid'] = vi.fn((id: string) => {
      order.push(`reissue(${id})`)
      return Promise.resolve()
    })
    internals['loadReissueState'] = vi.fn((id: string) => {
      order.push(`load(${id})`)
      return Promise.resolve(queue.shift() ?? null)
    })
    return { svc, order }
  }

  it('hadInvoice → void(tx, actor) → reissue(tx) → one verdict read; the awaiting-reissue probe is skipped', async () => {
    const { svc, order } = make({
      hadInvoice: true,
      states: [{ ...PAID_SALARY, invoiceDocumentId: 'doc-2' }],
    })
    await expect(svc.voidAndReissueInvoiceForAmountEdit('tx', 'actor')).resolves.toBe('REISSUED')
    expect(order).toEqual(['void(tx,actor)', 'reissue(tx)', 'load(tx)'])
  })

  it('no invoice → the awaiting-reissue probe runs first (one extra state read), then reissue, then verdict', async () => {
    const { svc, order } = make({
      hadInvoice: false,
      states: [PAID_SALARY, { ...PAID_SALARY, invoiceDocumentId: 'doc-3' }],
    })
    await expect(svc.voidAndReissueInvoiceForAmountEdit('tx', 'actor')).resolves.toBe('REISSUED')
    expect(order).toEqual(['void(tx,actor)', 'load(tx)', 'reissue(tx)', 'load(tx)'])
  })

  it.each<[string, Partial<S>]>([
    ['not a salary', { type: 'SENIOR_INCOME' }],
    ['not paid', { status: 'PENDING' }],
    ['payout-linked', { payoutRequestId: 'pr' }],
    ['a live document is present', { invoiceDocumentId: 'doc-x' }],
    ['no voided signature on record', { hasVoidedInvoice: false }],
  ])('no invoice and %s → NOT_NEEDED without re-issuing', async (_l, patch) => {
    const { svc, order } = make({ hadInvoice: false, states: [{ ...PAID_SALARY, ...patch }] })
    await expect(svc.voidAndReissueInvoiceForAmountEdit('tx', 'actor')).resolves.toBe('NOT_NEEDED')
    expect(order).toEqual(['void(tx,actor)', 'load(tx)'])
  })

  it('no invoice and the row vanished → NOT_NEEDED', async () => {
    const { svc } = make({ hadInvoice: false, states: [null] })
    await expect(svc.voidAndReissueInvoiceForAmountEdit('tx', 'actor')).resolves.toBe('NOT_NEEDED')
  })

  it('verdict: a non-salary income whose document landed is REISSUED (the verdict is not salary-gated)', async () => {
    const { svc } = make({
      hadInvoice: true,
      states: [{ ...PAID_SALARY, type: 'SENIOR_INCOME', invoiceDocumentId: 'doc-5' }],
    })
    await expect(svc.voidAndReissueInvoiceForAmountEdit('tx', 'actor')).resolves.toBe('REISSUED')
  })

  it('verdict: the row vanished after the re-issue → NOT_NEEDED', async () => {
    const { svc } = make({ hadInvoice: true, states: [null] })
    await expect(svc.voidAndReissueInvoiceForAmountEdit('tx', 'actor')).resolves.toBe('NOT_NEEDED')
  })

  it('a failed void logs error(tx, cause) and stops: no state read, no re-issue', async () => {
    const { svc, order } = make({ hadInvoice: true, states: [] })
    ;(svc as unknown as Record<string, unknown>)['voidInvoiceForAmountEdit'] = vi.fn(() =>
      Promise.reject(new Error('lock timeout')),
    )
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    await expect(svc.voidAndReissueInvoiceForAmountEdit('tx', 'actor')).resolves.toBe('VOID_FAILED')
    expect(error).toHaveBeenCalledExactlyOnceWith(
      'voidAndReissueInvoiceForAmountEdit: void failed for tx=tx: lock timeout',
    )
    expect(order).toEqual([])
  })
})

describe('reissueSalaryInvoiceIfVoided — VOID-retry routing keeps the actor', () => {
  it('a stale countersigned document routes to void+reissue with the SAME tx and actor', async () => {
    const svc = Object.create(InvoicesService.prototype) as InvoicesService
    const internals = svc as unknown as Record<string, unknown>
    const outcome = vi.fn(() => Promise.resolve('REISSUED'))
    internals['voidAndReissueInvoiceForAmountEdit'] = outcome
    internals['loadReissueState'] = vi.fn(() =>
      Promise.resolve({
        type: 'SALARY',
        status: 'PAID',
        payoutRequestId: null,
        invoiceDocumentId: 'doc-old',
        hasVoidedInvoice: false,
        amount: '100.000000',
        signedAmountSnapshot: '90.000000',
        activeCompanySignedAt: null,
        lastVoidFailureAt: null,
      }),
    )
    await expect(svc.reissueSalaryInvoiceIfVoided('tx-1', 'actor-1')).resolves.toBe('REISSUED')
    expect(outcome).toHaveBeenCalledExactlyOnceWith('tx-1', 'actor-1')
  })
})
