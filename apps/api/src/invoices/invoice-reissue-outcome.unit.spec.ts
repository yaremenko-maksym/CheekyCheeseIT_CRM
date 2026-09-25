import { describe, expect, it, vi } from 'vitest'
import { Logger } from '@nestjs/common'

import { InvoicesService } from './invoices.service'

/**
 * task-paid-salary-amount-edit (SR-M-1) — the OUTCOME of an invoice void +
 * re-issue after an edit. Before, both failure modes were log lines; now each
 * is a value the caller journals and reports.
 *
 * Seam: the service's own three collaborators on this path —
 * `voidInvoiceForAmountEdit`, `reissueInvoiceIfStillPaid` and the state read
 * `loadReissueState` — stubbed on an instance. The DB shape of that read is a
 * two-query select, exercised against real Postgres by the edit's integration
 * specs; here only the decision is under test.
 */

type State = {
  type: string
  status: string
  payoutRequestId: string | null
  invoiceDocumentId: string | null
  hasVoidedInvoice: boolean
}

const PAID_SALARY_NO_INVOICE: State = {
  type: 'SALARY',
  status: 'PAID',
  payoutRequestId: null,
  invoiceDocumentId: null,
  hasVoidedInvoice: true,
}

function makeService(opts: {
  voidResult?: { hadInvoice: boolean; wasSigned: boolean } | Error
  /** Successive answers of the state read (before / after the re-issue). */
  states: Array<State | null>
}) {
  const svc = Object.create(InvoicesService.prototype) as InvoicesService
  const states = [...opts.states]
  const internals = svc as unknown as Record<string, unknown>
  internals['logger'] = new Logger('test')
  const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  internals['voidInvoiceForAmountEdit'] = vi.fn(() =>
    opts.voidResult instanceof Error
      ? Promise.reject(opts.voidResult)
      : Promise.resolve(opts.voidResult ?? { hadInvoice: true, wasSigned: true }),
  )
  const reissue = vi.fn(() => Promise.resolve())
  internals['reissueInvoiceIfStillPaid'] = reissue
  internals['loadReissueState'] = vi.fn(() => Promise.resolve(states.shift() ?? null))
  return { svc, reissue, logError }
}

describe('voidAndReissueInvoiceForAmountEdit — outcome', () => {
  it('void throws → VOID_FAILED, and no re-issue is attempted on top of a live invoice', async () => {
    const { svc, reissue, logError } = makeService({
      voidResult: new Error('lock timeout'),
      states: [],
    })
    await expect(svc.voidAndReissueInvoiceForAmountEdit('tx', 'actor')).resolves.toBe('VOID_FAILED')
    expect(reissue).not.toHaveBeenCalled()
    // The log line still names the row and the cause — the journal line the
    // caller writes says THAT it failed, this says WHY.
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('void failed for tx=tx: lock timeout'),
    )
  })

  it('voided, and a document landed on the row → REISSUED', async () => {
    const { svc, reissue } = makeService({
      states: [{ ...PAID_SALARY_NO_INVOICE, invoiceDocumentId: 'doc-2' }],
    })
    await expect(svc.voidAndReissueInvoiceForAmountEdit('tx', 'actor')).resolves.toBe('REISSUED')
    expect(reissue).toHaveBeenCalledWith('tx')
  })

  it('voided, but the row is still without a document → REISSUE_FAILED', async () => {
    const { svc } = makeService({ states: [PAID_SALARY_NO_INVOICE] })
    await expect(svc.voidAndReissueInvoiceForAmountEdit('tx', 'actor')).resolves.toBe(
      'REISSUE_FAILED',
    )
  })

  it('voided a row the cascade reverted to pending → nothing was due, NOT_NEEDED', async () => {
    const { svc } = makeService({
      states: [{ ...PAID_SALARY_NO_INVOICE, status: 'PENDING_PAYMENT' }],
    })
    await expect(svc.voidAndReissueInvoiceForAmountEdit('tx', 'actor')).resolves.toBe('NOT_NEEDED')
  })

  it('a row linked to a payout is never reported as missing its own invoice', async () => {
    const { svc } = makeService({ states: [{ ...PAID_SALARY_NO_INVOICE, payoutRequestId: 'pr' }] })
    await expect(svc.voidAndReissueInvoiceForAmountEdit('tx', 'actor')).resolves.toBe('NOT_NEEDED')
  })

  it('no invoice now, but a salary whose invoice an EARLIER edit voided → re-issued (was skipped forever)', async () => {
    const { svc, reissue } = makeService({
      voidResult: { hadInvoice: false, wasSigned: false },
      states: [PAID_SALARY_NO_INVOICE, { ...PAID_SALARY_NO_INVOICE, invoiceDocumentId: 'doc-3' }],
    })
    await expect(svc.voidAndReissueInvoiceForAmountEdit('tx', 'actor')).resolves.toBe('REISSUED')
    expect(reissue).toHaveBeenCalledWith('tx')
  })

  it('no invoice now and none ever (imported history) → NOT_NEEDED, no surprise signing request', async () => {
    const { svc, reissue } = makeService({
      voidResult: { hadInvoice: false, wasSigned: false },
      states: [{ ...PAID_SALARY_NO_INVOICE, hasVoidedInvoice: false }],
    })
    await expect(svc.voidAndReissueInvoiceForAmountEdit('tx', 'actor')).resolves.toBe('NOT_NEEDED')
    expect(reissue).not.toHaveBeenCalled()
  })
})

describe('reissueSalaryInvoiceIfVoided — «повторное сохранение чинит»', () => {
  it('repairs a PAID salary whose invoice was voided and never replaced', async () => {
    const { svc, reissue } = makeService({
      states: [PAID_SALARY_NO_INVOICE, { ...PAID_SALARY_NO_INVOICE, invoiceDocumentId: 'doc-4' }],
    })
    await expect(svc.reissueSalaryInvoiceIfVoided('tx')).resolves.toBe('REISSUED')
    expect(reissue).toHaveBeenCalledWith('tx')
  })

  it('reports a repair that did not land', async () => {
    const { svc } = makeService({ states: [PAID_SALARY_NO_INVOICE, PAID_SALARY_NO_INVOICE] })
    await expect(svc.reissueSalaryInvoiceIfVoided('tx')).resolves.toBe('REISSUE_FAILED')
  })

  it.each<[string, Partial<State>]>([
    ['it still has its invoice', { invoiceDocumentId: 'doc-1' }],
    ['it never had one', { hasVoidedInvoice: false }],
    ['it is not a salary', { type: 'SENIOR_INCOME' }],
    ['it is not paid', { status: 'PENDING' }],
    ['it is linked to a payout', { payoutRequestId: 'pr' }],
  ])('leaves the row alone when %s', async (_label, patch) => {
    const { svc, reissue } = makeService({ states: [{ ...PAID_SALARY_NO_INVOICE, ...patch }] })
    await expect(svc.reissueSalaryInvoiceIfVoided('tx')).resolves.toBe('NOT_NEEDED')
    expect(reissue).not.toHaveBeenCalled()
  })

  it('a row that vanished is left alone', async () => {
    const { svc, reissue } = makeService({ states: [null] })
    await expect(svc.reissueSalaryInvoiceIfVoided('tx')).resolves.toBe('NOT_NEEDED')
    expect(reissue).not.toHaveBeenCalled()
  })
})

/**
 * `loadReissueState` — the state read the decisions above stand on. A thin
 * double of drizzle's `select().from().where().limit()` chain: the two queries
 * answer in order (the row, then the voided-signature probe). The query SHAPE
 * is exercised against real Postgres by the edit's integration specs; this
 * pins what the method makes of the answers, which the gate can see.
 */
describe('loadReissueState — what the two reads become', () => {
  function withReads(...answers: unknown[][]) {
    const svc = Object.create(InvoicesService.prototype) as InvoicesService
    const queue = [...answers]
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(queue.shift() ?? []),
    }
    ;(svc as unknown as Record<string, unknown>)['db'] = { db: { select: () => chain } }
    const load = (svc as unknown as { loadReissueState: (id: string) => Promise<unknown> })
      .loadReissueState
    return () => load.call(svc, 'tx')
  }

  const ROW = {
    type: 'SALARY',
    status: 'PAID',
    payoutRequestId: null,
    invoiceDocumentId: null,
  }

  it('a row with a voided signature on record → hasVoidedInvoice: true, every column carried', async () => {
    await expect(withReads([ROW], [{ id: 'sig-1' }])()).resolves.toEqual({
      ...ROW,
      hasVoidedInvoice: true,
    })
  })

  it('no voided signature → hasVoidedInvoice: false', async () => {
    await expect(withReads([ROW], [])()).resolves.toEqual({ ...ROW, hasVoidedInvoice: false })
  })

  it('no row → null', async () => {
    await expect(withReads([], [{ id: 'sig-1' }])()).resolves.toBeNull()
  })
})
