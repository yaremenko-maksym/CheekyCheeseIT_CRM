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
  // SR-M-4 — the disagreement that tells a failed VOID from an ordinary
  // invoice: what `/verify` confirms vs what the row now says.
  amount: string
  signedAmountSnapshot: string | null
}

const PAID_SALARY_NO_INVOICE: State = {
  type: 'SALARY',
  status: 'PAID',
  payoutRequestId: null,
  invoiceDocumentId: null,
  hasVoidedInvoice: true,
  amount: '48867.000000',
  signedAmountSnapshot: null,
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
      // SR-M-3 added two ordered reads (newest active COMPANY signature, last
      // recorded void failure) — the double answers them in call order.
      orderBy: () => chain,
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
    amount: '48867.000000',
  }

  it('carries every column plus the countersigned figure (SR-M-4)', async () => {
    await expect(
      withReads([ROW], [{ id: 'sig-1' }], [{ amountSnapshot: '48675.000000' }])(),
    ).resolves.toEqual({
      ...ROW,
      hasVoidedInvoice: true,
      signedAmountSnapshot: '48675.000000',
    })
  })

  it('no voided signature and no countersignature → both absent', async () => {
    await expect(withReads([ROW], [], [])()).resolves.toEqual({
      ...ROW,
      hasVoidedInvoice: false,
      signedAmountSnapshot: null,
    })
  })

  it('no row → null', async () => {
    await expect(withReads([], [{ id: 'sig-1' }])()).resolves.toBeNull()
  })
})

/**
 * SR-M-3 (security-review round 2) — the VOID stage is repairable too.
 *
 * When voiding failed, the edit is committed but the OLD, counterparty-signed
 * invoice is still current: the public QR check keeps confirming the old
 * figure. `isSalaryAwaitingReissue` could not see that case (it requires
 * `invoice_document_id IS NULL`), so the toast's advice — «збережіть ще раз» —
 * was not actionable. The repair now recognises it and retries void+reissue.
 *
 * How the state is recognised, and why it is idempotent: a void stamps
 * `voided_at` on every active signature, and `autoCreate` gives each fresh
 * invoice a new COMPANY signature. So «the active COMPANY signature is OLDER
 * than the last recorded VOID failure» means exactly «that failed void left
 * this document in place». After a successful repair the new document's
 * signature is newer, and the same question answers no.
 */

type RepairState = State

/** A PAID salary whose failed void left the old countersigned invoice current. */
const VOID_STAGE: RepairState = {
  type: 'SALARY',
  status: 'PAID',
  payoutRequestId: null,
  invoiceDocumentId: 'doc-old',
  hasVoidedInvoice: false,
  amount: '48867.000000',
  // What `/verify` still confirms — the figure before the edit.
  signedAmountSnapshot: '48675.000000',
}

function makeRepairService(states: Array<RepairState | null>) {
  const svc = Object.create(InvoicesService.prototype) as InvoicesService
  const queue = [...states]
  const internals = svc as unknown as Record<string, unknown>
  internals['logger'] = new Logger('test')
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  const voidCall = vi.fn(() => Promise.resolve({ hadInvoice: true, wasSigned: true }))
  internals['voidInvoiceForAmountEdit'] = voidCall
  const reissue = vi.fn(() => Promise.resolve())
  internals['reissueInvoiceIfStillPaid'] = reissue
  internals['loadReissueState'] = vi.fn(() => Promise.resolve(queue.shift() ?? null))
  return { svc, voidCall, reissue }
}

describe('reissueSalaryInvoiceIfVoided — the VOID stage (SR-M-3)', () => {
  it('retries the void AND the re-issue when a failed void left the old invoice current', async () => {
    const { svc, voidCall, reissue } = makeRepairService([
      VOID_STAGE,
      { ...VOID_STAGE, invoiceDocumentId: 'doc-new' },
    ])
    await expect(svc.reissueSalaryInvoiceIfVoided('tx', 'actor')).resolves.toBe('REISSUED')
    expect(voidCall).toHaveBeenCalledWith('tx', 'actor')
    expect(reissue).toHaveBeenCalledWith('tx')
  })

  it('reports VOID_FAILED again when the retried void throws once more', async () => {
    const { svc, reissue } = makeRepairService([VOID_STAGE])
    const internals = svc as unknown as Record<string, unknown>
    internals['voidInvoiceForAmountEdit'] = vi.fn(() => Promise.reject(new Error('still locked')))
    await expect(svc.reissueSalaryInvoiceIfVoided('tx', 'actor')).resolves.toBe('VOID_FAILED')
    expect(reissue).not.toHaveBeenCalled()
  })

  it('is idempotent: once the repair issued a fresh invoice, a further save does nothing', async () => {
    // A fresh document has no countersignature yet — the shape a successful
    // repair leaves behind, and nothing for `/verify` to disagree with.
    const { svc, voidCall, reissue } = makeRepairService([
      { ...VOID_STAGE, invoiceDocumentId: 'doc-new', signedAmountSnapshot: null },
    ])
    await expect(svc.reissueSalaryInvoiceIfVoided('tx', 'actor')).resolves.toBe('NOT_NEEDED')
    expect(voidCall).not.toHaveBeenCalled()
    expect(reissue).not.toHaveBeenCalled()
  })

  it('leaves an ordinary invoice alone when the signed figure still matches the row (SR-L-7)', async () => {
    // Equal figures, not merely «no marker»: the document attests exactly what
    // the row says, so there is nothing out of step to repair.
    const { svc, voidCall } = makeRepairService([
      { ...VOID_STAGE, signedAmountSnapshot: '48867.000000' },
    ])
    await expect(svc.reissueSalaryInvoiceIfVoided('tx', 'actor')).resolves.toBe('NOT_NEEDED')
    expect(voidCall).not.toHaveBeenCalled()
  })

  it('the REISSUE stage still repairs without touching the void path', async () => {
    const REISSUE_STAGE: RepairState = {
      ...VOID_STAGE,
      invoiceDocumentId: null,
      hasVoidedInvoice: true,
      signedAmountSnapshot: null,
    }
    const { svc, voidCall, reissue } = makeRepairService([
      REISSUE_STAGE,
      { ...REISSUE_STAGE, invoiceDocumentId: 'doc-2' },
    ])
    await expect(svc.reissueSalaryInvoiceIfVoided('tx', 'actor')).resolves.toBe('REISSUED')
    expect(voidCall).not.toHaveBeenCalled()
    expect(reissue).toHaveBeenCalledWith('tx')
  })

  it('a document nobody countersigned is left to the REISSUE branch, not retried', async () => {
    // Nothing is confirming a stale figure — `/verify` has no countersignature
    // to read — so this is not the damage SR-M-4 is about.
    const { svc, voidCall } = makeRepairService([{ ...VOID_STAGE, signedAmountSnapshot: null }])
    await expect(svc.reissueSalaryInvoiceIfVoided('tx', 'actor')).resolves.toBe('NOT_NEEDED')
    expect(voidCall).not.toHaveBeenCalled()
  })

  it('a document with no countersignature at all is left alone', async () => {
    const { svc, voidCall, reissue } = makeRepairService([
      { ...VOID_STAGE, signedAmountSnapshot: null },
    ])
    await expect(svc.reissueSalaryInvoiceIfVoided('tx', 'actor')).resolves.toBe('NOT_NEEDED')
    expect(voidCall).not.toHaveBeenCalled()
    expect(reissue).not.toHaveBeenCalled()
  })

  it('a row awaiting RE-ISSUE is never sent down the void path, even with a void failure on record', async () => {
    // The document is already gone: there is nothing to void, and retrying the
    // void would ask `voidInvoiceForAmountEdit` to act on nothing.
    const { svc, voidCall, reissue } = makeRepairService([
      {
        ...VOID_STAGE,
        invoiceDocumentId: null,
        hasVoidedInvoice: true,
        signedAmountSnapshot: '48675.000000',
      },
      { ...VOID_STAGE, invoiceDocumentId: 'doc-new', signedAmountSnapshot: null },
    ])
    await expect(svc.reissueSalaryInvoiceIfVoided('tx', 'actor')).resolves.toBe('REISSUED')
    expect(voidCall).not.toHaveBeenCalled()
    expect(reissue).toHaveBeenCalledWith('tx')
  })

  it.each<[string, Partial<RepairState>]>([
    ['it is not a salary', { type: 'SENIOR_INCOME' }],
    ['it is not paid', { status: 'PENDING' }],
    ['it is linked to a payout', { payoutRequestId: 'pr' }],
  ])('does not retry the void when %s', async (_label, patch) => {
    const { svc, voidCall } = makeRepairService([{ ...VOID_STAGE, ...patch }])
    await expect(svc.reissueSalaryInvoiceIfVoided('tx', 'actor')).resolves.toBe('NOT_NEEDED')
    expect(voidCall).not.toHaveBeenCalled()
  })
})

/**
 * COPY-M-6 — `canRepairSalaryInvoice` only ever picks a MESSAGE, so what it
 * must never do is answer «yes» where the repair would return `NOT_NEEDED`.
 * Same predicates as the repair itself, asked without doing anything.
 */
describe('canRepairSalaryInvoice — may a re-save fix this row?', () => {
  it('yes for a document still confirming a stale figure (the VOID stage)', async () => {
    const { svc, voidCall, reissue } = makeRepairService([VOID_STAGE])
    await expect(svc.canRepairSalaryInvoice('tx')).resolves.toBe(true)
    // It answers a question; it must not act on it.
    expect(voidCall).not.toHaveBeenCalled()
    expect(reissue).not.toHaveBeenCalled()
  })

  it('yes for a salary whose invoice was voided and never replaced (the REISSUE stage)', async () => {
    const { svc } = makeRepairService([
      {
        ...VOID_STAGE,
        invoiceDocumentId: null,
        hasVoidedInvoice: true,
        signedAmountSnapshot: null,
      },
    ])
    await expect(svc.canRepairSalaryInvoice('tx')).resolves.toBe(true)
  })

  it('no when the signed figure and the row agree — nothing is out of step', async () => {
    const { svc } = makeRepairService([{ ...VOID_STAGE, signedAmountSnapshot: '48867.000000' }])
    await expect(svc.canRepairSalaryInvoice('tx')).resolves.toBe(false)
  })

  it('no for a salary that never had an invoice at all', async () => {
    const { svc } = makeRepairService([
      {
        ...VOID_STAGE,
        invoiceDocumentId: null,
        hasVoidedInvoice: false,
        signedAmountSnapshot: null,
      },
    ])
    await expect(svc.canRepairSalaryInvoice('tx')).resolves.toBe(false)
  })

  it.each<[string, Partial<RepairState>]>([
    ['it is not a salary', { type: 'SENIOR_INCOME' }],
    ['it is not paid', { status: 'PENDING' }],
    ['it is linked to a payout', { payoutRequestId: 'pr' }],
  ])('no when %s', async (_label, patch) => {
    const { svc } = makeRepairService([{ ...VOID_STAGE, ...patch }])
    await expect(svc.canRepairSalaryInvoice('tx')).resolves.toBe(false)
  })

  it('no for a row that vanished', async () => {
    const { svc } = makeRepairService([null])
    await expect(svc.canRepairSalaryInvoice('tx')).resolves.toBe(false)
  })
})
