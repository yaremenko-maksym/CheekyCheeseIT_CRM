/**
 * Characterization of `EditCascadeService.applyEditCascade` — the cluster that
 * a later leaf extraction moves out of `edit-cascade.service.ts`.
 *
 * Why a SECOND unit spec next to `cascade-apply.unit.spec.ts`: that one drives
 * the cluster through `TransactionsService.adminUpdateTransaction`; this one
 * calls the method DIRECTLY with hand-built snapshot + plan objects, so the
 * moved code is pinned independently of whichever facade ends up calling it,
 * and so branches the resolver would never hand over (a plan carrying a
 * warning code the test chooses) are reachable.
 *
 * Every WHERE / SET is compiled through the real Postgres dialect, so the
 * assertions are on the exact SQL text and bound parameters, not on a
 * substring of an AST.
 *
 * Money invariants carried by the cluster and pinned here:
 *  - ledger term 9 (AC7): a settled obligation whose recomputed share is NOT
 *    above what was paid is NEVER rewritten — only journaled — so the company
 *    balance cannot grow by money that already left;
 *  - the revert (AC6) is a conditional UPDATE on `status = 'PAID'` and its
 *    zero-row result stops the row from being journaled twice;
 *  - the open-obligation write is floored at `settled_amount`
 *    (monotonicity), and only when the units are comparable;
 *  - the write is all-or-nothing: every refusal happens before the first write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { HttpException, Logger } from '@nestjs/common'
import type { CascadePlan, CascadeSnapshot } from '@crm/shared'

import { EditCascadeService } from './edit-cascade.service'
import { pendingObligations, transactionAuditLog, transactions } from '../database/schema'

const ACTOR = '11111111-0000-4000-aa00-000000000001'
const SOURCE_ID = '22222222-0000-4000-bb00-000000000001'
const D1 = '33333333-0000-4000-8c00-000000000001'
const D2 = '33333333-0000-4000-8c00-000000000002'
const OBL1 = '44444444-0000-4000-8d00-000000000001'
const OBL2 = '44444444-0000-4000-8d00-000000000002'
const T = '2026-08-02T00:00:00.000Z'

type DerivSnap = CascadeSnapshot['derivatives'][number]
type DerivPlan = CascadePlan['derivatives'][number]

function snapDeriv(over: Partial<DerivSnap> = {}): DerivSnap {
  return {
    id: D1,
    type: 'SENIOR_PENDING_PAYOUT',
    receiverName: null,
    status: 'PENDING_PAYMENT',
    amount: 260,
    currency: 'USDT',
    updatedAt: T,
    sharePercent: 26,
    settledAmount: null,
    settledCurrency: null,
    settledSharePercent: null,
    fundingSource: null,
    originalAmount: null,
    originalCurrency: null,
    exchangeRate: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    txDate: null,
    hasSignedInvoice: false,
    obligation: { id: OBL1, status: 'PENDING', amount: 260, currency: 'USDT', updatedAt: T },
    ...over,
  } as DerivSnap
}

function planDeriv(over: Partial<DerivPlan> = {}): DerivPlan {
  return {
    id: D1,
    type: 'SENIOR_PENDING_PAYOUT',
    receiverName: null,
    oldAmount: 260,
    newAmount: 500,
    recomputedShare: 500,
    sharePercent: 26,
    currency: 'USDT',
    settledAmount: 0,
    settledCurrency: null,
    remainingToPay: null,
    needsReconfirm: false,
    warnings: [],
    ...over,
  } as DerivPlan
}

function snapshotOf(...derivatives: DerivSnap[]): CascadeSnapshot {
  return { source: { id: SOURCE_ID }, derivatives } as unknown as CascadeSnapshot
}

function planOf(...derivatives: DerivPlan[]): CascadePlan {
  return { sourceId: SOURCE_ID, derivatives } as unknown as CascadePlan
}

type Op =
  | { kind: 'update'; table: string; set: Record<string, unknown>; sql: string; params: unknown[] }
  | { kind: 'returning'; table: string }
  | { kind: 'insert'; table: string; values: Record<string, unknown> }

function compile(clause: unknown): { sql: string; params: unknown[] } {
  const q = new PgDialect().sqlToQuery(clause as SQL)
  return { sql: q.sql, params: q.params }
}

function tableName(t: unknown): string {
  if (t === transactions) return 'transactions'
  if (t === pendingObligations) return 'pending_obligations'
  if (t === transactionAuditLog) return 'transaction_audit_log'
  return 'unknown'
}

function makeTx(
  opts: { revertRows?: Array<{ id: string }>; derivativeRows?: Array<{ id: string }> } = {},
) {
  const ops: Op[] = []
  const tx = {
    update: (t: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (clause: unknown) => {
          const { sql, params } = compile(clause)
          ops.push({ kind: 'update', table: tableName(t), set, sql, params })
          const rows =
            tableName(t) === 'pending_obligations' && set.status === 'PENDING'
              ? (opts.revertRows ?? [{ id: OBL1 }])
              : (opts.derivativeRows ?? [{ id: D1 }])
          return {
            returning: () => {
              ops.push({ kind: 'returning', table: tableName(t) })
              return Promise.resolve(rows)
            },
            then: (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res),
          }
        },
      }),
    }),
    insert: (t: unknown) => ({
      values: (values: Record<string, unknown>) => {
        ops.push({ kind: 'insert', table: tableName(t), values })
        return Promise.resolve([{ id: 'inserted' }])
      },
    }),
  }
  return { tx: tx as never, ops }
}

const svc = new EditCascadeService({ db: {} } as never)

async function apply(
  snapshot: CascadeSnapshot,
  plan: CascadePlan,
  txOpts?: Parameters<typeof makeTx>[0],
) {
  const { tx, ops } = makeTx(txOpts)
  const result = await svc.applyEditCascade(tx, snapshot, plan, ACTOR)
  return { result, ops }
}

async function refusal(
  snapshot: CascadeSnapshot,
  plan: CascadePlan,
  txOpts?: Parameters<typeof makeTx>[0],
) {
  const { tx, ops } = makeTx(txOpts)
  const err = await svc.applyEditCascade(tx, snapshot, plan, ACTOR).then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(HttpException)
  const http = err as HttpException
  return { status: http.getStatus(), body: http.getResponse() as Record<string, unknown>, ops }
}

const audits = (ops: Op[], action: string) =>
  ops.filter(
    (o): o is Extract<Op, { kind: 'insert' }> =>
      o.kind === 'insert' && o.table === 'transaction_audit_log' && o.values.action === action,
  )

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.restoreAllMocks()
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
})

// ---------------------------------------------------------------------------
describe('applyEditCascade — phase 1 refusals (all before the first write)', () => {
  it('a derivative with no share snapshot (newAmount null) is refused with 400 and logged', async () => {
    const r = await refusal(snapshotOf(snapDeriv()), planOf(planDeriv({ newAmount: null })))
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ code: 'FINANCE_DERIVATIVE_ROW_NO_SHARE_SNAPSHOT' })
    expect(r.ops).toEqual([])
    expect(warn).toHaveBeenCalledWith(`Derivative row ${D1}: no share-percent snapshot`)
  })

  it('an OBLIGATION_CURRENCY_MISMATCH warning refuses the edit with its own code', async () => {
    const r = await refusal(
      snapshotOf(snapDeriv()),
      planOf(planDeriv({ warnings: [{ code: 'OBLIGATION_CURRENCY_MISMATCH', params: {} }] })),
    )
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ code: 'FINANCE_DERIVATIVE_ROW_OBLIGATION_CURRENCY_MISMATCH' })
    expect(r.ops).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      `Derivative row ${D1}: obligation currency mismatch with source`,
    )
  })

  it('an unrelated warning does not refuse (the check reads the code, not "any warning")', async () => {
    const { ops } = await apply(
      snapshotOf(snapDeriv()),
      planOf(planDeriv({ warnings: [{ code: 'OVERPAYMENT', params: {} }] })),
    )
    expect(ops.length).toBeGreaterThan(0)
  })

  describe('ledger-term-9 invariant: a revert needs amount == settled_amount on a company-funded row', () => {
    const settled = (over: Partial<DerivSnap> = {}) =>
      snapDeriv({
        type: 'SENIOR_INCOME',
        status: 'PAID',
        fundingSource: 'COMPANY_ACCOUNT',
        settledAmount: 260,
        settledCurrency: 'USDT',
        obligation: { id: OBL1, status: 'PAID', amount: 260, currency: 'USDT', updatedAt: T },
        ...over,
      })
    const revert = (over: Partial<DerivPlan> = {}) =>
      planDeriv({ needsReconfirm: true, settledAmount: 260, settledCurrency: 'USDT', ...over })

    it('refuses when amount and settled_amount diverge, logging both figures', async () => {
      const r = await refusal(snapshotOf(settled({ amount: 2000 })), planOf(revert()))
      expect(r.status).toBe(400)
      expect(r.body).toMatchObject({ code: 'FINANCE_ROW_AMOUNT_MISMATCH' })
      expect(r.ops).toEqual([])
      expect(warn).toHaveBeenCalledWith(
        `Row ${D1} needsReconfirm: amount=2000 settled=260 — see PR #598`,
      )
    })

    it('treats a missing accumulator as 0 in the comparison', async () => {
      const r = await refusal(snapshotOf(settled({ settledAmount: null })), planOf(revert()))
      expect(r.body).toMatchObject({ code: 'FINANCE_ROW_AMOUNT_MISMATCH' })
      expect(warn).toHaveBeenCalledWith(
        `Row ${D1} needsReconfirm: amount=260 settled=0 — see PR #598`,
      )
    })

    it('does not refuse when the two figures agree', async () => {
      const { ops } = await apply(snapshotOf(settled()), planOf(revert()))
      expect(ops.length).toBeGreaterThan(0)
    })

    it('does not apply to a row that is not company-funded', async () => {
      const { ops } = await apply(
        snapshotOf(settled({ amount: 2000, fundingSource: 'CLIENT' as never })),
        planOf(revert()),
      )
      expect(ops.length).toBeGreaterThan(0)
    })

    it('does not apply when nothing is being reverted (needsReconfirm false)', async () => {
      const { ops } = await apply(
        snapshotOf(settled({ amount: 2000 })),
        planOf(revert({ needsReconfirm: false })),
      )
      expect(audits(ops, 'CASCADE_OVERPAYMENT')).toHaveLength(1)
    })

    it('a sub-epsilon difference is not a divergence', async () => {
      const { ops } = await apply(snapshotOf(settled({ amount: 260.0000001 })), planOf(revert()))
      expect(ops.length).toBeGreaterThan(0)
    })
  })

  it('a revert on a row with an UNKNOWN accumulator is refused (would pay the whole share twice)', async () => {
    const r = await refusal(
      snapshotOf(snapDeriv({ settledAmount: null })),
      planOf(planDeriv({ needsReconfirm: true })),
    )
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ code: 'FINANCE_DERIVATIVE_ROW_SETTLED_AMOUNT_UNKNOWN' })
    expect(r.ops).toEqual([])
    expect(warn).toHaveBeenCalledWith(`Derivative row ${D1}: settled amount unknown`)
  })

  it('a NULL accumulator without a revert is fine (the ordinary open IOU)', async () => {
    const { ops } = await apply(snapshotOf(snapDeriv()), planOf(planDeriv()))
    expect(ops.length).toBeGreaterThan(0)
  })

  describe('AC15(b): an incomparable currency pair blocks a revert only', () => {
    const settled = snapDeriv({
      type: 'SENIOR_INCOME',
      status: 'PAID',
      settledAmount: 5000,
      settledCurrency: 'UAH' as never,
      obligation: { id: OBL1, status: 'PAID', amount: 5000, currency: 'USDT', updatedAt: T },
    })
    const nonUsdt = { code: 'NON_USDT_CURRENCY', params: {} } as const

    it('refuses with both units in the params', async () => {
      const r = await refusal(
        snapshotOf(settled),
        planOf(
          planDeriv({
            needsReconfirm: true,
            settledAmount: 5000,
            settledCurrency: 'UAH' as never,
            warnings: [nonUsdt],
          }),
        ),
      )
      expect(r.status).toBe(400)
      expect(r.body).toMatchObject({
        code: 'FINANCE_DERIVATIVE_ROW_CURRENCY_PAIR_UNRESOLVABLE',
        params: { settledCurrency: 'UAH', currency: 'USDT' },
      })
      expect(r.ops).toEqual([])
      expect(warn).toHaveBeenCalledWith(
        `Derivative row ${D1}: currency pair unresolvable (settled=UAH, new=USDT)`,
      )
    })

    it('names an accumulator with no currency label UNKNOWN', async () => {
      const r = await refusal(
        snapshotOf(settled),
        planOf(planDeriv({ needsReconfirm: true, settledAmount: 5000, warnings: [nonUsdt] })),
      )
      expect(r.body).toMatchObject({ params: { settledCurrency: 'UNKNOWN', currency: 'USDT' } })
      expect(warn).toHaveBeenCalledWith(
        `Derivative row ${D1}: currency pair unresolvable (settled=UNKNOWN, new=USDT)`,
      )
    })

    it('is ignored without a revert', async () => {
      const { ops } = await apply(
        snapshotOf(snapDeriv()),
        planOf(planDeriv({ warnings: [nonUsdt] })),
      )
      expect(ops.some((o) => o.kind === 'update')).toBe(true)
    })

    it('reads that warning code, not "any warning"', async () => {
      const { ops } = await apply(
        snapshotOf(settled),
        planOf(
          planDeriv({
            needsReconfirm: true,
            settledAmount: 5000,
            settledCurrency: 'UAH' as never,
            warnings: [{ code: 'OVERPAYMENT', params: {} }],
          }),
        ),
      )
      expect(audits(ops, 'CASCADE_REOPEN')).toHaveLength(1)
    })
  })

  it('is all-or-nothing: one bad derivative AFTER a healthy one writes nothing at all', async () => {
    const r = await refusal(
      snapshotOf(snapDeriv(), snapDeriv({ id: D2, obligation: null })),
      planOf(planDeriv(), planDeriv({ id: D2, newAmount: null })),
    )
    expect(r.body).toMatchObject({ code: 'FINANCE_DERIVATIVE_ROW_NO_SHARE_SNAPSHOT' })
    expect(r.ops).toEqual([])
    expect(warn).toHaveBeenCalledWith(`Derivative row ${D2}: no share-percent snapshot`)
  })

  it('an empty plan writes nothing and reports nothing changed', async () => {
    const { result, ops } = await apply(snapshotOf(), planOf())
    expect(result).toEqual({ changedDerivativeIds: [] })
    expect(ops).toEqual([])
  })
})

// ---------------------------------------------------------------------------
describe('applyEditCascade — AC7 / ledger term 9: closed and NOT underpaid → journal only', () => {
  const closed = () =>
    snapDeriv({
      type: 'SENIOR_INCOME',
      status: 'PAID',
      amount: 300,
      settledAmount: 300,
      settledCurrency: 'USDT',
      obligation: { id: OBL1, status: 'PAID', amount: 300, currency: 'USDT', updatedAt: T },
    })

  it('writes NO update (the amount stays at what physically left) and journals the overpayment exactly', async () => {
    const { result, ops } = await apply(
      snapshotOf(closed()),
      planOf(
        planDeriv({
          newAmount: 300,
          recomputedShare: 100.1234567,
          settledAmount: 300,
          settledCurrency: 'USDT',
        }),
      ),
    )
    expect(ops).toEqual([
      {
        kind: 'insert',
        table: 'transaction_audit_log',
        values: {
          actorId: ACTOR,
          targetId: D1,
          action: 'CASCADE_OVERPAYMENT',
          metadata: {
            obligationId: OBL1,
            causedBy: SOURCE_ID,
            settledAmount: 300,
            newShare: 100.1234567,
            overpaidBy: 199.876543,
          },
        },
      },
    ])
    expect(result).toEqual({ changedDerivativeIds: [] })
  })

  it('continues to the NEXT derivative after the journal-only one', async () => {
    const { result, ops } = await apply(
      snapshotOf(
        closed(),
        snapDeriv({ id: D2, obligation: { ...snapDeriv().obligation!, id: OBL2 } }),
      ),
      planOf(
        planDeriv({ newAmount: 300, recomputedShare: 100, settledAmount: 300 }),
        planDeriv({ id: D2, newAmount: 500 }),
      ),
    )
    expect(audits(ops, 'CASCADE_OVERPAYMENT')).toHaveLength(1)
    expect(ops.filter((o) => o.kind === 'update')).toHaveLength(2)
    expect(result.changedDerivativeIds).toEqual([D2])
  })
})

// ---------------------------------------------------------------------------
describe('applyEditCascade — AC6: closed and underpaid → revert to awaiting payment', () => {
  const settledSenior = (over: Partial<DerivSnap> = {}) =>
    snapDeriv({
      type: 'SENIOR_INCOME',
      status: 'PAID',
      amount: 260,
      sharePercent: null,
      settledAmount: 260,
      settledCurrency: 'USDT',
      settledSharePercent: 26,
      fundingSource: 'COMPANY_ACCOUNT',
      receiptExternalUrl: 'https://etherscan.io/tx/0xabc',
      txDate: T,
      obligation: { id: OBL1, status: 'PAID', amount: 260, currency: 'USDT', updatedAt: T },
      ...over,
    })
  const revertPlan = (over: Partial<DerivPlan> = {}) =>
    planDeriv({
      newAmount: 520,
      recomputedShare: 520,
      sharePercent: 26,
      settledAmount: 260,
      settledCurrency: 'USDT',
      needsReconfirm: true,
      ...over,
    })

  it('issues the exact conditional obligation claim, then the exact transactions rewrite, then the journal — in that order', async () => {
    const { result, ops } = await apply(snapshotOf(settledSenior()), planOf(revertPlan()))

    expect(ops).toHaveLength(4)
    const [claim, ret, rewrite, journal] = ops
    expect(claim).toMatchObject({
      kind: 'update',
      table: 'pending_obligations',
      set: { status: 'PENDING', closingTransactionId: null, amount: '520' },
      sql: '("pending_obligations"."id" = $1 and "pending_obligations"."status" = $2)',
      params: [OBL1, 'PAID'],
    })
    expect((claim as { set: { updatedAt: unknown } }).set.updatedAt).toBeInstanceOf(Date)
    expect(ret).toEqual({ kind: 'returning', table: 'pending_obligations' })

    const r = rewrite as Extract<Op, { kind: 'update' }>
    expect(r.table).toBe('transactions')
    expect(r.sql).toBe('"transactions"."id" = $1')
    expect(r.params).toEqual([D1])
    expect(r.set).toEqual({
      type: 'SENIOR_PENDING_PAYOUT',
      status: 'PENDING_PAYMENT',
      amount: '520',
      seniorSharePercent: 26,
      originalAmount: null,
      originalCurrency: null,
      exchangeRate: null,
      notes: `Повернення в очікування виплати після зміни суми доходу (зобов'язання ${OBL1})`,
      updatedAt: expect.any(Date),
    })
    // The accumulator, receipt, payer, date and currency are self-standing
    // records of a payment that happened: none of them may be in the SET.
    for (const kept of [
      'settledAmount',
      'settledCurrency',
      'settledSharePercent',
      'receiptExternalUrl',
      'receiptDocumentId',
      'txDate',
      'fundingSource',
      'currency',
      'dropSharePercent',
    ]) {
      expect(r.set).not.toHaveProperty(kept)
    }

    expect(journal).toEqual({
      kind: 'insert',
      table: 'transaction_audit_log',
      values: {
        actorId: ACTOR,
        targetId: D1,
        action: 'CASCADE_REOPEN',
        metadata: {
          obligationId: OBL1,
          causedBy: SOURCE_ID,
          settledAmount: 260,
          sharePercent: 26,
          before: {
            amount: 260,
            type: 'SENIOR_INCOME',
            status: 'PAID',
            originalAmount: null,
            originalCurrency: null,
            exchangeRate: null,
            receiptDocumentId: null,
            receiptExternalUrl: 'https://etherscan.io/tx/0xabc',
            txDate: T,
          },
          after: { amount: 520, type: 'SENIOR_PENDING_PAYOUT', status: 'PENDING_PAYMENT' },
        },
      },
    })
    expect(result).toEqual({ changedDerivativeIds: [D1] })
  })

  it('a DROP row reopens as DROP_PENDING_PAYOUT with the percent in the DROP column, and journals the retracted payment-fact triplet', async () => {
    const { result, ops } = await apply(
      snapshotOf(
        settledSenior({
          id: D2,
          type: 'PAYOUT_DROP',
          originalAmount: 100,
          originalCurrency: 'USDT',
          exchangeRate: '1.00000000',
          receiptDocumentId: 'doc-1',
          obligation: { id: OBL2, status: 'PAID', amount: 260, currency: 'USDT', updatedAt: T },
        }),
      ),
      planOf(revertPlan({ id: D2, type: 'PAYOUT_DROP', sharePercent: 10 })),
    )
    const rewrite = ops.find((o) => o.kind === 'update' && o.table === 'transactions') as Extract<
      Op,
      { kind: 'update' }
    >
    expect(rewrite.set).toMatchObject({
      type: 'DROP_PENDING_PAYOUT',
      status: 'PENDING_PAYMENT',
      dropSharePercent: 10,
      originalAmount: null,
      originalCurrency: null,
      exchangeRate: null,
    })
    expect(rewrite.set).not.toHaveProperty('seniorSharePercent')
    expect(rewrite.params).toEqual([D2])
    const [j] = audits(ops, 'CASCADE_REOPEN')
    expect(j.values.targetId).toBe(D2)
    expect(j.values.metadata).toMatchObject({
      obligationId: OBL2,
      sharePercent: 10,
      before: {
        type: 'PAYOUT_DROP',
        originalAmount: 100,
        originalCurrency: 'USDT',
        exchangeRate: '1.00000000',
        receiptDocumentId: 'doc-1',
      },
      after: { type: 'DROP_PENDING_PAYOUT' },
    })
    expect(result.changedDerivativeIds).toEqual([D2])
  })

  it('an already-reverted row (claim returns zero rows) is neither rewritten, nor journaled, nor reported', async () => {
    const { result, ops } = await apply(snapshotOf(settledSenior()), planOf(revertPlan()), {
      revertRows: [],
    })
    expect(ops.filter((o) => o.kind === 'update')).toHaveLength(1)
    expect(ops.filter((o) => o.kind === 'insert')).toEqual([])
    expect(result).toEqual({ changedDerivativeIds: [] })
  })

  it('a zero-row claim moves on to the next derivative instead of ending the cascade', async () => {
    const { result, ops } = await apply(
      snapshotOf(settledSenior(), snapDeriv({ id: D2, obligation: null })),
      planOf(revertPlan(), planDeriv({ id: D2, newAmount: 500 })),
      { revertRows: [] },
    )
    expect(result.changedDerivativeIds).toEqual([D2])
    expect(ops.some((o) => o.kind === 'update' && o.table === 'transactions')).toBe(true)
  })

  it('a row closed by an unusual type is refused AFTER the claim, with 400', async () => {
    const r = await refusal(
      snapshotOf(settledSenior({ type: 'EXPENSE' })),
      planOf(revertPlan({ type: 'EXPENSE' })),
    )
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ code: 'FINANCE_DERIVATIVE_ROW_TYPE_MISMATCH_FOR_REOPEN' })
    expect(warn).toHaveBeenCalledWith(
      `Derivative row ${D1}: closed by unusual type EXPENSE, can't reopen`,
    )
    // The claim has been issued (the surrounding DB transaction rolls it back);
    // nothing past it was.
    expect(r.ops.filter((o) => o.kind === 'update')).toHaveLength(1)
    expect(r.ops.filter((o) => o.kind === 'insert')).toEqual([])
  })

  it('does not list the row as changed when the revert leaves the amount where it was', async () => {
    const { result, ops } = await apply(
      snapshotOf(settledSenior()),
      planOf(revertPlan({ newAmount: 260, recomputedShare: 260 })),
    )
    expect(audits(ops, 'CASCADE_REOPEN')).toHaveLength(1)
    expect(result.changedDerivativeIds).toEqual([])
  })
})

// ---------------------------------------------------------------------------
describe('applyEditCascade — AC5: still-open obligation', () => {
  it('writes the SAME figure to both copies with exact scoped WHEREs, then journals', async () => {
    const { result, ops } = await apply(snapshotOf(snapDeriv()), planOf(planDeriv()))

    expect(ops).toHaveLength(4)
    const [obl, txUpd, ret, journal] = ops
    expect(obl).toMatchObject({
      kind: 'update',
      table: 'pending_obligations',
      set: { amount: '500', updatedAt: expect.any(Date) },
      sql: '("pending_obligations"."source_transaction_id" = $1 and "pending_obligations"."status" = $2)',
      params: [D1, 'PENDING'],
    })
    expect(txUpd).toMatchObject({
      kind: 'update',
      table: 'transactions',
      set: { amount: '500', updatedAt: expect.any(Date) },
      sql: '("transactions"."id" = $1 and "transactions"."status" = $2)',
      params: [D1, 'PENDING_PAYMENT'],
    })
    // Only amount + updatedAt: no status/type/percent/triplet rewrite.
    expect(Object.keys((obl as { set: object }).set).sort()).toEqual(['amount', 'updatedAt'])
    expect(Object.keys((txUpd as { set: object }).set).sort()).toEqual(['amount', 'updatedAt'])
    expect(ret).toEqual({ kind: 'returning', table: 'transactions' })
    expect(journal).toEqual({
      kind: 'insert',
      table: 'transaction_audit_log',
      values: {
        actorId: ACTOR,
        targetId: D1,
        action: 'CASCADE_AMOUNT_UPDATE',
        metadata: {
          obligationId: OBL1,
          causedBy: SOURCE_ID,
          settledAmount: 0,
          sharePercent: 26,
          amount: { before: 260, after: 500 },
        },
      },
    })
    expect(audits(ops, 'CASCADE_OVERPAYMENT')).toEqual([])
    expect(result).toEqual({ changedDerivativeIds: [D1] })
  })

  it('journals obligationId null when the row has no obligation', async () => {
    const { ops } = await apply(snapshotOf(snapDeriv({ obligation: null })), planOf(planDeriv()))
    expect(audits(ops, 'CASCADE_AMOUNT_UPDATE')[0].values.metadata).toMatchObject({
      obligationId: null,
    })
  })

  it('refuses loudly when the transactions row left PENDING_PAYMENT under us (zero rows)', async () => {
    const r = await refusal(snapshotOf(snapDeriv()), planOf(planDeriv()), { derivativeRows: [] })
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ code: 'FINANCE_SHARE_LEFT_PENDING_DURING_SAVE' })
    // no journal for a write that did not happen
    expect(r.ops.filter((o) => o.kind === 'insert')).toEqual([])
  })

  it('an unchanged amount is written but not reported as changed (no invoice reissue)', async () => {
    const { result, ops } = await apply(
      snapshotOf(snapDeriv()),
      planOf(planDeriv({ newAmount: 260, recomputedShare: 260 })),
    )
    expect(ops.filter((o) => o.kind === 'update')).toHaveLength(2)
    expect(result.changedDerivativeIds).toEqual([])
  })

  it('a sub-epsilon move is not a change', async () => {
    const { result } = await apply(
      snapshotOf(snapDeriv()),
      planOf(planDeriv({ newAmount: 260.0000001, recomputedShare: 260.0000001 })),
    )
    expect(result.changedDerivativeIds).toEqual([])
  })

  describe('settled_amount monotonicity: the stored figure is never below the accumulator', () => {
    const withAccumulator = (over: Partial<DerivSnap> = {}) =>
      snapDeriv({
        amount: 150,
        settledAmount: 150,
        settledCurrency: 'USDT',
        ...over,
      })
    const plan = (over: Partial<DerivPlan> = {}) =>
      planDeriv({
        newAmount: 100,
        recomputedShare: 100,
        settledAmount: 150,
        settledCurrency: 'USDT',
        ...over,
      })

    it('floors BOTH copies at the accumulator and journals the overpayment AFTER the amount update', async () => {
      const { result, ops } = await apply(snapshotOf(withAccumulator()), planOf(plan()))
      const updates = ops.filter((o): o is Extract<Op, { kind: 'update' }> => o.kind === 'update')
      expect(updates.map((u) => [u.table, u.set.amount])).toEqual([
        ['pending_obligations', '150'],
        ['transactions', '150'],
      ])
      const inserts = ops.filter((o) => o.kind === 'insert') as Array<
        Extract<Op, { kind: 'insert' }>
      >
      expect(inserts.map((i) => i.values.action)).toEqual([
        'CASCADE_AMOUNT_UPDATE',
        'CASCADE_OVERPAYMENT',
      ])
      expect(inserts[0].values.metadata).toMatchObject({
        settledAmount: 150,
        amount: { before: 150, after: 150 },
      })
      expect(inserts[1].values).toEqual({
        actorId: ACTOR,
        targetId: D1,
        action: 'CASCADE_OVERPAYMENT',
        metadata: {
          obligationId: OBL1,
          causedBy: SOURCE_ID,
          settledAmount: 150,
          newShare: 100,
          overpaidBy: 50,
        },
      })
      // the floor held the stored amount where it was: no reissue
      expect(result.changedDerivativeIds).toEqual([])
    })

    it('is the identity above the accumulator — no overpayment entry', async () => {
      const { ops } = await apply(
        snapshotOf(withAccumulator()),
        planOf(plan({ newAmount: 400, recomputedShare: 400 })),
      )
      const updates = ops.filter((o): o is Extract<Op, { kind: 'update' }> => o.kind === 'update')
      expect(updates.map((u) => u.set.amount)).toEqual(['400', '400'])
      expect(audits(ops, 'CASCADE_OVERPAYMENT')).toEqual([])
    })

    it('the overpayment entry fires on the SHARE vs the floor, even when the plan already floored newAmount', async () => {
      const { ops } = await apply(
        snapshotOf(withAccumulator()),
        planOf(plan({ newAmount: 150, recomputedShare: 100 })),
      )
      expect(audits(ops, 'CASCADE_OVERPAYMENT')).toHaveLength(1)
    })

    it('does NOT floor across different units (accumulator in UAH, share in USDT)', async () => {
      const { ops } = await apply(
        snapshotOf(withAccumulator({ settledAmount: 5000, settledCurrency: 'UAH' as never })),
        planOf(plan({ settledAmount: 5000, settledCurrency: 'UAH' as never })),
      )
      const updates = ops.filter((o): o is Extract<Op, { kind: 'update' }> => o.kind === 'update')
      expect(updates.map((u) => u.set.amount)).toEqual(['100', '100'])
      expect(audits(ops, 'CASCADE_OVERPAYMENT')).toEqual([])
    })
  })

  it('processes derivatives in plan order and reports the changed ones in that order', async () => {
    const { result, ops } = await apply(
      snapshotOf(
        snapDeriv(),
        snapDeriv({
          id: D2,
          obligation: { id: OBL2, status: 'PENDING', amount: 260, currency: 'USDT', updatedAt: T },
        }),
      ),
      planOf(planDeriv({ id: D2, newAmount: 600, recomputedShare: 600 }), planDeriv()),
    )
    const targets = ops
      .filter((o): o is Extract<Op, { kind: 'update' }> => o.kind === 'update')
      .map((o) => o.params[0])
    expect(targets).toEqual([D2, D2, D1, D1])
    expect(result.changedDerivativeIds).toEqual([D2, D1])
  })
})
