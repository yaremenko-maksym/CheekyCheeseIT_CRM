/**
 * task-cascade-apply (task 3 of the paid-transaction-edit-cascade
 * decomposition) — UNIT double for `adminUpdateTransaction`'s cascade branch
 * and its private `applyEditCascade`.
 *
 * WHY THIS FILE EXISTS ALONGSIDE `cascade-apply.integration.spec.ts`: the
 * mutation gate drives Stryker against the UNIT suite only —
 * `apps/api/vitest.config.mts` structurally excludes every
 * `*.integration.spec.ts` from a non-integration run, so Stryker never sees
 * that file at all (`.claude/rules/common/mutation-gate-integration-specs.md`).
 * Without this double, every money-writing branch below reports
 * `NoCoverage`/`Survived` no matter how good the real-DB coverage is. The
 * integration spec keeps verifying the real thing against real Postgres; this
 * file is what makes the gate able to see the lines. Neither replaces the
 * other.
 *
 * The double captures the ORDER and the CONTENT of every write, which is what
 * three of the ADR's risks are actually about:
 *   - risk 13 (ABBA deadlock): `pending_obligations` → `lockCompanyAccount` →
 *     `transactions`, in that order and no other (addendum §1.9);
 *   - risk 14: the advisory lock is taken, exactly once, BEFORE any
 *     `transactions` write;
 *   - risks 1b / 16 / 17: WHICH rows get written and with WHAT number.
 *
 * The captured amounts are checked against a plan produced by the REAL
 * `resolveEditCascade` (never a re-implementation here) — a test that computed
 * the expected share the same way the code does would pass under any mutation
 * of that arithmetic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { BadRequestException, ConflictException, ForbiddenException, Logger } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { resolveEditCascade, computeCascadeVersion, type CascadeSnapshot } from '@crm/shared'

import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { pendingObligations, transactionAuditLog, transactions } from '../database/schema'
import type { TransactionsService } from './transactions.service'
import type { InvoicesService } from '../invoices/invoices.service'

const ADMIN: SessionUser = {
  id: '11111111-0000-4000-aa00-000000000001',
  email: 'cascade-apply-unit-admin@test.spec',
  displayName: 'Admin A',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
const SENIOR_USER: SessionUser = { ...ADMIN, role: 'SENIOR' }

const SOURCE_ID = '22222222-0000-4000-bb00-000000000001'
const SENIOR_DERIV_ID = '33333333-0000-4000-8c00-000000000001'
const DROP_DERIV_ID = '33333333-0000-4000-8c00-000000000002'
const SENIOR_OBL_ID = '44444444-0000-4000-8d00-000000000001'
const DROP_OBL_ID = '44444444-0000-4000-8d00-000000000002'

const T_SOURCE = new Date('2026-08-01T00:00:00.000Z')
const T_DERIV = new Date('2026-08-02T00:00:00.000Z')
const T_OBL = new Date('2026-08-02T00:00:00.000Z')

const COMPANY_ACCOUNT = 'COMPANY_ACCOUNT'

// ---------------------------------------------------------------------------
// Row builders — DB-shaped rows (strings for numerics, Date for timestamps),
// exactly what `loadCascadeSnapshot` reads.
// ---------------------------------------------------------------------------

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SOURCE_ID,
    type: 'ADMIN_INCOME',
    status: 'PAID',
    amount: '1000.000000',
    currency: 'USDT',
    payoutRequestId: null,
    deletedAt: null,
    updatedAt: T_SOURCE,
    originalAmount: null,
    receiverLabel: 'Acme',
    receiptDocumentId: null,
    receiptExternalUrl: null,
    receiverId: null,
    salaryMonth: null,
    notes: null,
    settledAmount: null,
    ...overrides,
  }
}

/** A senior IOU that has NOT been settled — obligation still PENDING. */
function pendingDerivativeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SENIOR_DERIV_ID,
    type: 'SENIOR_PENDING_PAYOUT',
    status: 'PENDING_PAYMENT',
    amount: '260.000000',
    currency: 'USDT',
    updatedAt: T_DERIV,
    seniorSharePercent: 26,
    dropSharePercent: null,
    settledAmount: null,
    settledCurrency: null,
    settledSharePercent: null,
    fundingSource: null,
    deletedAt: null,
    sourceIncomeTransactionId: SOURCE_ID,
    ...overrides,
  }
}

/** A senior IOU that WAS settled from the company account — the revert case. */
function settledDerivativeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SENIOR_DERIV_ID,
    type: 'SENIOR_INCOME',
    status: 'PAID',
    amount: '260.000000',
    currency: 'USDT',
    updatedAt: T_DERIV,
    seniorSharePercent: null,
    dropSharePercent: null,
    settledAmount: '260.000000',
    settledCurrency: 'USDT',
    settledSharePercent: 26,
    fundingSource: COMPANY_ACCOUNT,
    deletedAt: null,
    sourceIncomeTransactionId: SOURCE_ID,
    ...overrides,
  }
}

function obligationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SENIOR_OBL_ID,
    sourceTransactionId: SENIOR_DERIV_ID,
    closingTransactionId: null,
    status: 'PENDING',
    amount: '260.000000',
    currency: 'USDT',
    updatedAt: T_OBL,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// The DB double.
// ---------------------------------------------------------------------------

type Op =
  | { kind: 'select'; table: string; projection: unknown }
  | { kind: 'returning'; table: string; projection: unknown }
  | { kind: 'lock'; table: string; projection: unknown; where: unknown[] }
  | { kind: 'advisory' }
  | { kind: 'update'; table: string; set: Record<string, unknown>; where: unknown[] }
  | { kind: 'insert'; table: string; values: Record<string, unknown> }

/**
 * The bound parameters of an UPDATE's WHERE clause, compiled by the REAL
 * Postgres dialect drizzle itself uses. Needed because two different
 * `pending_obligations` UPDATEs run in one edit — the source row's own #598
 * sync and the cascade's writes on the derivatives — and they are
 * distinguishable only by WHICH rows they target.
 *
 * `sqlToQuery` rather than an `inspect()` substring search: drizzle pgEnum
 * columns carry every enum value as static AST metadata, so a substring search
 * "finds" 'PENDING' regardless of what is actually bound (the trap documented
 * in company-account-balance-currency.spec.ts).
 */
function whereParams(clause: unknown): unknown[] {
  try {
    return new PgDialect().sqlToQuery(clause as SQL).params
  } catch {
    return []
  }
}

function tableName(t: unknown): string {
  if (t === transactions) return 'transactions'
  if (t === pendingObligations) return 'pending_obligations'
  if (t === transactionAuditLog) return 'transaction_audit_log'
  return 'unknown'
}

/** An object that is BOTH awaitable and further chainable (drizzle builders are). */
function thenable<T>(value: T, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    then: (res: (v: T) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(value).then(res, rej),
  }
}

interface DbleConfig {
  source?: Record<string, unknown>
  derivatives?: Array<Record<string, unknown>>
  obligations?: Array<Record<string, unknown>>
  signatures?: Array<{ transactionId: string }>
  /** Rows returned by the conditional revert UPDATE on pending_obligations. */
  revertClaimRows?: Array<{ id: string }>
  /** Rows returned by the main transactions UPDATE (empty ⇒ "row was deleted"). */
  mainUpdateRows?: Array<{ id: string }>
  /**
   * Rows returned by the AC5 branch's `transactions` UPDATE — the one scoped to
   * `status = 'PENDING_PAYMENT'` (SR-M-1). Empty ⇒ the row left that status
   * under us, which must abort the whole edit rather than leave the obligation
   * updated and the transaction not.
   */
  derivativeUpdateRows?: Array<{ id: string }>
  /**
   * Per-call answers for `transactions.findFirst`. Call 1 is the
   * pre-transaction read in `adminUpdateTransaction`; call 2 is
   * `loadCascadeSnapshot`'s own read INSIDE the transaction. Lets a test make
   * the row vanish between the two.
   */
  sourceReads?: Array<Record<string, unknown> | undefined>
}

function makeDouble(cfg: DbleConfig = {}) {
  const ops: Op[] = []
  const source = cfg.source ?? sourceRow()
  const derivatives = cfg.derivatives ?? []
  const obligations = cfg.obligations ?? []
  const signatures = cfg.signatures ?? []
  let sourceReadCall = 0

  const relationalQueries = {
    transactions: {
      findFirst: vi.fn(async () => (cfg.sourceReads ? cfg.sourceReads[sourceReadCall++] : source)),
      findMany: vi.fn(async () => derivatives),
    },
    pendingObligations: { findMany: vi.fn(async (_args?: unknown) => obligations) },
    invoiceSignatures: { findMany: vi.fn(async () => signatures) },
  }

  const dbtx = {
    query: relationalQueries,
    execute: vi.fn(async () => {
      ops.push({ kind: 'advisory' })
      return undefined
    }),
    select: vi.fn((projection: unknown) => ({
      from: (t: unknown) => ({
        where: (clause: unknown) => {
          ops.push({ kind: 'select', table: tableName(t), projection })
          // Awaited directly ⇒ the id-discovery read. Chained through
          // `.orderBy().for()` ⇒ a lock acquisition.
          return thenable(
            t === transactions ? derivatives.map((d) => ({ id: d.id as string })) : [],
            {
              orderBy: () => ({
                for: (strength: string) => {
                  ops.push({
                    kind: 'lock',
                    table: `${tableName(t)}:${strength}`,
                    projection,
                    where: whereParams(clause),
                  })
                  return Promise.resolve([])
                },
              }),
            },
          )
        },
      }),
    })),
    update: vi.fn((t: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (clause: unknown) => {
          ops.push({ kind: 'update', table: tableName(t), set: patch, where: whereParams(clause) })
          // Routed by CONTENT, never by call position: the revert claim is the
          // one pending_obligations UPDATE that flips status back to PENDING.
          const whereBinds = whereParams(clause)
          const rows =
            tableName(t) === 'pending_obligations' && patch.status === 'PENDING'
              ? (cfg.revertClaimRows ?? [{ id: SENIOR_OBL_ID }])
              : tableName(t) === 'transactions' && patch.type === undefined
                ? // The AC5 derivative write and the SOURCE row's own edit are
                  // both "no type change"; they are told apart by WHICH row the
                  // WHERE binds.
                  whereBinds.includes(SOURCE_ID)
                  ? (cfg.mainUpdateRows ?? [{ id: SOURCE_ID }])
                  : (cfg.derivativeUpdateRows ?? [{ id: 'affected' }])
                : [{ id: 'affected' }]
          return thenable(rows, {
            returning: (proj: unknown) => {
              ops.push({ kind: 'returning', table: tableName(t), projection: proj })
              return Promise.resolve(rows)
            },
          })
        },
      }),
    })),
    insert: vi.fn((t: unknown) => ({
      values: (values: Record<string, unknown>) => {
        ops.push({ kind: 'insert', table: tableName(t), values })
        return thenable([{ id: 'inserted' }], {
          returning: () => Promise.resolve([{ id: 'inserted' }]),
        })
      },
    })),
  }

  const db = {
    db: {
      ...dbtx,
      transaction: vi.fn(async (cb: (tx: typeof dbtx) => Promise<unknown>) => cb(dbtx)),
    },
  }

  return { db: db as never, ops, dbtx, relationalQueries }
}

/**
 * Builds the SAME snapshot `loadCascadeSnapshot` would build from the given
 * rows, so a test can call the REAL resolver for its expectations instead of
 * re-deriving a share by hand.
 */
function snapshotFrom(cfg: {
  source?: Record<string, unknown>
  derivatives?: Array<Record<string, unknown>>
  obligations?: Array<Record<string, unknown>>
}): CascadeSnapshot {
  const source = cfg.source ?? sourceRow()
  const derivatives = cfg.derivatives ?? []
  const obligations = cfg.obligations ?? []
  const oblByDeriv = new Map(obligations.map((o) => [o.sourceTransactionId as string, o]))
  return {
    source: {
      id: source.id as string,
      type: source.type as string,
      status: source.status as string,
      amount: Number(source.amount),
      currency: source.currency as 'USDT',
      payoutRequestId: source.payoutRequestId as string | null,
      updatedAt: (source.updatedAt as Date).toISOString(),
      hasSignedInvoice: false,
      originalAmount: source.originalAmount === null ? null : Number(source.originalAmount),
      settledAmount:
        source.settledAmount === null || source.settledAmount === undefined
          ? null
          : Number(source.settledAmount),
      hasClosedObligation: (cfg.obligations ?? []).some(
        (o) =>
          o.status === 'PAID' &&
          (o.sourceTransactionId === source.id || o.closingTransactionId === source.id),
      ),
    },
    derivatives: derivatives.map((d) => {
      const o = oblByDeriv.get(d.id as string)
      return {
        id: d.id as string,
        type: d.type as string,
        status: d.status as string,
        amount: Number(d.amount),
        currency: d.currency as 'USDT',
        updatedAt: (d.updatedAt as Date).toISOString(),
        sharePercent: (d.seniorSharePercent ?? d.dropSharePercent ?? null) as number | null,
        settledAmount: d.settledAmount === null ? null : Number(d.settledAmount),
        settledCurrency: d.settledCurrency as 'USDT' | null,
        settledSharePercent: d.settledSharePercent as number | null,
        fundingSource: d.fundingSource as string | null,
        hasSignedInvoice: false,
        obligation: o
          ? {
              id: o.id as string,
              status: o.status as 'PENDING' | 'PAID' | 'CANCELLED',
              amount: Number(o.amount),
              currency: o.currency as 'USDT',
              updatedAt: (o.updatedAt as Date).toISOString(),
            }
          : null,
      }
    }),
  }
}

function stubFindOne(svc: TransactionsService) {
  vi.spyOn(svc, 'findOne').mockResolvedValue({ id: SOURCE_ID } as never)
}

function makeInvoicesSpy() {
  return {
    autoCreateForPayout: vi.fn().mockResolvedValue(undefined),
    autoCreateForIncome: vi.fn().mockResolvedValue(undefined),
    autoCreateForSeniorPayout: vi.fn().mockResolvedValue(undefined),
    autoCreateForSalary: vi.fn().mockResolvedValue(undefined),
    voidAndReissueInvoiceForAmountEdit: vi.fn().mockResolvedValue(undefined),
  } as unknown as InvoicesService
}

/** Writes to `transactions` that flip a derivative's type/status (the revert). */
function derivativeWrites(ops: Op[]) {
  return ops.filter(
    (o): o is Extract<Op, { kind: 'update' }> =>
      o.kind === 'update' && o.table === 'transactions' && o.set.type !== undefined,
  )
}

/** Every UPDATE on `table` whose WHERE binds one of the given ids. */
function updatesTargeting(ops: Op[], table: string, ...ids: string[]) {
  return ops.filter(
    (o): o is Extract<Op, { kind: 'update' }> =>
      o.kind === 'update' && o.table === table && ids.some((id) => o.where.includes(id)),
  )
}

function journalEntries(ops: Op[], action: string) {
  return ops.filter(
    (o): o is Extract<Op, { kind: 'insert' }> =>
      o.kind === 'insert' && o.table === 'transaction_audit_log' && o.values.action === action,
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// AC1 — BIZ-18 is narrowed to currency + salaryMonth, never to amount.
// ---------------------------------------------------------------------------

describe('AC1: BIZ-18 narrowed surgically', () => {
  it('still refuses a CURRENCY change on a PAID row', async () => {
    const { db } = makeDouble()
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    await expect(
      svc.adminUpdateTransaction(SOURCE_ID, { currency: 'EUR' }, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('still refuses a SALARY MONTH change on a PAID row', async () => {
    const { db } = makeDouble({ source: sourceRow({ salaryMonth: '2026-07' }) })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    await expect(
      svc.adminUpdateTransaction(SOURCE_ID, { salaryMonth: '2026-08' }, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('a metadata-only edit on a PAID row is still allowed and needs no preview token', async () => {
    const { db, ops } = makeDouble()
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    await svc.adminUpdateTransaction(SOURCE_ID, { notes: 'corrected' }, ADMIN)
    expect(ops.some((o) => o.kind === 'advisory')).toBe(false)
  })

  it('non-ADMIN is refused before anything is read', async () => {
    const { db } = makeDouble()
    const svc = makeTransactionsService({ db })
    await expect(
      svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000 }, SENIOR_USER),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })
})

// ---------------------------------------------------------------------------
// AC2 — the preview token is mandatory and is checked under lock.
// ---------------------------------------------------------------------------

describe('AC2: mandatory preview + optimistic lock', () => {
  it('a PAID amount edit WITHOUT cascadeVersion is refused, and nothing is written', async () => {
    const { db, ops } = makeDouble()
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    await expect(
      svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000 }, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(ops).toEqual([])
  })

  it('the refusal text tells the operator to open the preview', async () => {
    const { db } = makeDouble()
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    await expect(svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000 }, ADMIN)).rejects.toThrow(
      /предпросмотр/i,
    )
  })

  it('a STALE cascadeVersion is a 409 and writes nothing', async () => {
    const { db, ops } = makeDouble({
      derivatives: [pendingDerivativeRow()],
      obligations: [obligationRow()],
    })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    await expect(
      svc.adminUpdateTransaction(
        SOURCE_ID,
        { amount: 2000, cascadeVersion: 'src:stale:2020-01-01T00:00:00.000Z' },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(ops.filter((o) => o.kind === 'update' || o.kind === 'insert')).toEqual([])
  })

  it('a MATCHING cascadeVersion is accepted and the edit goes through', async () => {
    const derivatives = [pendingDerivativeRow()]
    const obligations = [obligationRow()]
    const { db, ops } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)
    expect(derivativeWrites(ops)).toHaveLength(0) // still-PENDING branch keeps the type
    expect(ops.some((o) => o.kind === 'update' && o.table === 'pending_obligations')).toBe(true)
  })

  it('a non-PAID amount edit needs no token at all (the guard is about settled rows)', async () => {
    const { db, ops } = makeDouble({ source: sourceRow({ status: 'VALIDATED' }) })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000 }, ADMIN)
    expect(ops.some((o) => o.kind === 'advisory')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC3 / risks 13-14 — lock order and the advisory lock.
// ---------------------------------------------------------------------------

describe('AC3: lock order pending_obligations → lockCompanyAccount → transactions', () => {
  function orderedLockOps(ops: Op[]) {
    return ops
      .filter((o) => o.kind === 'lock' || o.kind === 'advisory')
      .map((o) => (o.kind === 'advisory' ? 'advisory' : o.table))
  }

  it('takes the three locks in exactly the mandated order (addendum §1.9)', async () => {
    const derivatives = [settledDerivativeRow()]
    const obligations = [obligationRow({ status: 'PAID' })]
    const { db, ops } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)

    expect(orderedLockOps(ops)).toEqual([
      'pending_obligations:update',
      'advisory',
      'transactions:update',
    ])
  })

  it('takes the company-account advisory lock exactly once, BEFORE any transactions write', async () => {
    const derivatives = [settledDerivativeRow()]
    const obligations = [obligationRow({ status: 'PAID' })]
    const { db, ops } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)

    const advisoryAt = ops.findIndex((o) => o.kind === 'advisory')
    const firstTxWriteAt = ops.findIndex((o) => o.kind === 'update' && o.table === 'transactions')
    expect(ops.filter((o) => o.kind === 'advisory')).toHaveLength(1)
    expect(advisoryAt).toBeGreaterThanOrEqual(0)
    expect(advisoryAt).toBeLessThan(firstTxWriteAt)
  })
})

// ---------------------------------------------------------------------------
// AC4 — blocking conditions refuse the WHOLE cascade before any write.
// ---------------------------------------------------------------------------

describe('AC4: blocking conditions', () => {
  it('NO_SHARE_SNAPSHOT (no percent to recompute from) refuses the whole edit', async () => {
    const derivatives = [
      settledDerivativeRow({ settledSharePercent: null, seniorSharePercent: null }),
    ]
    const obligations = [obligationRow({ status: 'PAID' })]
    const { db, ops } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
    // The message must name THIS reason — otherwise the test would also pass
    // on the pre-change behaviour, where BIZ-18 refused every PAID amount edit
    // wholesale and the specific refusal did not exist yet.
    await expect(
      svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN),
    ).rejects.toThrow(/процент/i)
    expect(ops.filter((o) => o.kind === 'update' || o.kind === 'insert')).toEqual([])
  })

  it('OBLIGATION_CURRENCY_MISMATCH refuses the whole edit (backlog 95)', async () => {
    const derivatives = [pendingDerivativeRow()]
    const obligations = [obligationRow({ currency: 'EUR' })]
    const { db, ops } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
    await expect(
      svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN),
    ).rejects.toThrow(/валют/i)
    expect(ops.filter((o) => o.kind === 'update' || o.kind === 'insert')).toEqual([])
  })

  it('ONE bad derivative blocks the OTHER, healthy one too — the cascade is all-or-nothing', async () => {
    const derivatives = [
      pendingDerivativeRow(),
      pendingDerivativeRow({
        id: DROP_DERIV_ID,
        type: 'DROP_PENDING_PAYOUT',
        seniorSharePercent: null,
        dropSharePercent: null,
      }),
    ]
    const obligations = [
      obligationRow(),
      obligationRow({ id: DROP_OBL_ID, sourceTransactionId: DROP_DERIV_ID }),
    ]
    const { db, ops } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
    await expect(
      svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN),
    ).rejects.toThrow(/процент/i)
    expect(ops.filter((o) => o.kind === 'update' || o.kind === 'insert')).toEqual([])
  })

  /**
   * AC15 / addendum §1.14 (SR-M-3). REVERSES a first-round assumption of this
   * task, which called `NON_USDT_CURRENCY` non-blocking. That reasoning rested
   * on "the top-up works"; for drop it does not, so the premise went and the
   * conclusion with it. Reverting a row whose remainder is not computable
   * leaves an obligation nobody can close — and a reopened obligation is a
   * claim of a debt to a person, not a bookkeeping detail.
   */
  it('AC15: a settled obligation whose accumulator is in another currency BLOCKS — its remainder is not computable', async () => {
    // A SENIOR obligation closed in USD against a USDT income — BIZ-03 allows
    // both currencies for a senior settle, so this is an ordinary reachable
    // state, and it isolates the currency case from the drop case below.
    // `fundingSource: null` because a non-USDT settle is by construction
    // ADMIN_PERSONAL (addendum §1.5).
    const derivatives = [settledDerivativeRow({ settledCurrency: 'USD', fundingSource: null })]
    const obligations = [obligationRow({ status: 'PAID' })]
    const { db, ops } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
    await expect(
      svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN),
    ).rejects.toThrow(/Остаток к доплате в такой паре не вычисляется/)
    expect(ops.filter((o) => o.kind === 'update' || o.kind === 'insert')).toEqual([])
  })

  it('AC15: a settled DROP obligation blocks even in matching currency — the top-up branch does not exist yet', async () => {
    const derivatives = [
      settledDerivativeRow({
        id: DROP_DERIV_ID,
        type: 'PAYOUT_DROP',
        settledAmount: '100.000000',
        settledSharePercent: 10,
        amount: '100.000000',
        fundingSource: null,
      }),
    ]
    const obligations = [
      obligationRow({
        id: DROP_OBL_ID,
        sourceTransactionId: DROP_DERIV_ID,
        status: 'PAID',
        amount: '100.000000',
      }),
    ]
    const { db, ops } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
    await expect(
      svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN),
    ).rejects.toThrow(/доплата по нему пока не поддерживается/)
    expect(ops.filter((o) => o.kind === 'update' || o.kind === 'insert')).toEqual([])
  })

  it('AC15: the drop refusal reads as "not built yet", never as "something is broken"', async () => {
    const derivatives = [
      settledDerivativeRow({
        id: DROP_DERIV_ID,
        type: 'PAYOUT_DROP',
        settledAmount: '100.000000',
        settledSharePercent: 10,
        amount: '100.000000',
        fundingSource: null,
      }),
    ]
    const obligations = [
      obligationRow({
        id: DROP_OBL_ID,
        sourceTransactionId: DROP_DERIV_ID,
        status: 'PAID',
        amount: '100.000000',
      }),
    ]
    const { db } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
    let caught: unknown
    try {
      await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)
    } catch (e) {
      caught = e
    }
    const message = (caught as Error).message
    expect(message).toContain('закрытие остатка — отдельная задача')
    expect(message).not.toMatch(/ошибк/i)
    expect(message).not.toMatch(/невозможн/i)
    expect(message).not.toMatch(/поврежд/i)
  })

  it('AC15: the currency refusal spells out both units and what it means', async () => {
    const derivatives = [settledDerivativeRow({ settledCurrency: 'USD', fundingSource: null })]
    const obligations = [obligationRow({ status: 'PAID' })]
    const { db } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
    let caught: unknown
    try {
      await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)
    } catch (e) {
      caught = e
    }
    const message = (caught as Error).message
    expect(message).toContain('уже выплаченное учтено в USD')
    expect(message).toContain('а пересчитанная доля — в USDT')
    expect(message).toContain('вернуть строку в ожидание выплаты нельзя: её нечем будет закрыть')
  })

  it('AC15: an accumulator with NO currency label at all is described as unknown, not as null', async () => {
    // "There is no label" is not "the label matches" — the resolver already
    // treats it as a mismatch, and the refusal has to read like a sentence.
    const derivatives = [settledDerivativeRow({ settledCurrency: null, fundingSource: null })]
    const obligations = [obligationRow({ status: 'PAID' })]
    const { db } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
    await expect(
      svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN),
    ).rejects.toThrow(/учтено в неизвестной валюте/)
  })

  it('AC15: the drop refusal names the consequence, not just the prohibition', async () => {
    const derivatives = [
      settledDerivativeRow({
        id: DROP_DERIV_ID,
        type: 'PAYOUT_DROP',
        settledAmount: '100.000000',
        settledSharePercent: 10,
        amount: '100.000000',
        fundingSource: null,
      }),
    ]
    const obligations = [
      obligationRow({
        id: DROP_OBL_ID,
        sourceTransactionId: DROP_DERIV_ID,
        status: 'PAID',
        amount: '100.000000',
      }),
    ]
    const { db } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
    let caught: unknown
    try {
      await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)
    } catch (e) {
      caught = e
    }
    const message = (caught as Error).message
    expect(message).toContain('по обязательству дропа уже есть выплата')
    expect(message).toContain(
      'Правка дохода вернула бы обязательство в ожидание выплаты, закрыть которое сейчас',
    )
    expect(message).toContain('нечем')
  })

  it('AC15: the dead-end checks apply ONLY to a revert — an OPEN obligation with a foreign accumulator still updates', async () => {
    // A row settled in USD and reverted earlier: its obligation is open again,
    // so nothing is being reverted now and there is no dead end to walk into.
    // Gating the checks on `needsReconfirm` is what keeps this case working.
    const derivatives = [
      pendingDerivativeRow({
        settledAmount: '260.000000',
        settledCurrency: 'USD',
        settledSharePercent: 26,
      }),
    ]
    const obligations = [obligationRow()]
    const { db, ops } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)
    expect(updatesTargeting(ops, 'transactions', SENIOR_DERIV_ID)).toHaveLength(1)
  })

  it('AC15: the currency check looks at THAT warning, not at "any warning at all"', async () => {
    // A reverting derivative carrying a DIFFERENT warning (a counterparty-
    // signed invoice) must still go through: the cascade voids and re-issues
    // the invoice, it does not refuse over it.
    const derivatives = [settledDerivativeRow()]
    const obligations = [obligationRow({ status: 'PAID' })]
    const { db, ops } = makeDouble({
      derivatives,
      obligations,
      signatures: [{ transactionId: SENIOR_DERIV_ID }],
    })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)
    expect(derivativeWrites(ops)).toHaveLength(1)
  })

  it('AC15: a SENIOR revert in matching currency is unaffected by either dead-end check', async () => {
    const derivatives = [settledDerivativeRow()]
    const obligations = [obligationRow({ status: 'PAID' })]
    const { db, ops } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)
    expect(derivativeWrites(ops)).toHaveLength(1)
  })

  it('refuses an amount edit on a row that already records a FACT of payment (ADR AC5 §5)', async () => {
    // `originalAmount` non-null ⇒ `exchangeRate = amount / originalAmount` is
    // stored on the row. BIZ-18 used to block this; narrowing it must not
    // open it.
    const { db, ops } = makeDouble({ source: sourceRow({ originalAmount: '41500.000000' }) })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(
      snapshotFrom({ source: sourceRow({ originalAmount: '41500.000000' }) }),
    )
    await expect(
      svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN),
    ).rejects.toThrow(/факт платежа/i)
    expect(ops.filter((o) => o.kind === 'update' || o.kind === 'insert')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// AC13 / test-AC 18b — the edited row may itself stand in a ledger term.
//
// SR-H-1: a settled senior row is editable through every existing guard — the
// flip clears `payoutRequestId` (guard 2 lets it through) and leaves
// `originalAmount` NULL on the senior branch (the C2 guard lets it through) —
// while term 7 debits the company account by that row's `amount`. Editing it
// down raises the balance by the difference. AC6's reconciliation cannot see
// it: that walks `plan.derivatives`, and here the edited row IS the source.
//
// The rule: an amount edit is allowed when `amount` is OUR OWN record of a
// figure, and refused when the number has a SECOND CARRIER the edit does not
// move.
// ---------------------------------------------------------------------------

describe('AC13: the edited row must not itself be a ledger fact', () => {
  async function attemptEdit(sourceOverrides: Record<string, unknown>, cfg: DbleConfig = {}) {
    const source = sourceRow(sourceOverrides)
    const { db, ops } = makeDouble({ ...cfg, source })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(
      snapshotFrom({ source, derivatives: cfg.derivatives, obligations: cfg.obligations }),
    )
    const result = svc.adminUpdateTransaction(
      SOURCE_ID,
      { amount: 26, cascadeVersion: version },
      ADMIN,
    )
    return { result, ops }
  }

  // ── the four predicates, one test each ────────────────────────────────────

  it('refuses a row carrying a fact-of-payment triplet (original_amount)', async () => {
    const { result, ops } = await attemptEdit({ originalAmount: '41500.000000' })
    await expect(result).rejects.toThrow(/факт платежа/i)
    expect(ops.filter((o) => o.kind === 'update' || o.kind === 'insert')).toEqual([])
  })

  it('refuses a row carrying an accumulator of actual payouts (settled_amount)', async () => {
    // The SR-H-1 shape exactly: a flipped SENIOR_INCOME. No originalAmount, no
    // payoutRequestId — every pre-existing guard waves it through.
    const { result, ops } = await attemptEdit({
      type: 'SENIOR_INCOME',
      settledAmount: '260.000000',
      originalAmount: null,
      payoutRequestId: null,
    })
    await expect(result).rejects.toThrow(/подтверждена фактическими выплатами/)
    expect(ops.filter((o) => o.kind === 'update' || o.kind === 'insert')).toEqual([])
  })

  it('refuses a legacy row closed BEFORE the accumulator column existed', async () => {
    // `settled_amount` is null (pre-#599) but the row still closes an
    // obligation. The obligation is keyed on `source_transaction_id = the row
    // itself`, which is correct because a settle flips the row in place.
    const { result, ops } = await attemptEdit(
      { type: 'SENIOR_INCOME', settledAmount: null },
      {
        obligations: [obligationRow({ sourceTransactionId: SOURCE_ID, status: 'PAID' })],
      },
    )
    await expect(result).rejects.toThrow(/закрытым обязательством/)
    expect(ops.filter((o) => o.kind === 'update' || o.kind === 'insert')).toEqual([])
  })

  it('refuses a company deposit — its figure was observed on-chain', async () => {
    const { result, ops } = await attemptEdit({ type: 'COMPANY_DEPOSIT' })
    await expect(result).rejects.toThrow(/сверена с блокчейном/)
    expect(ops.filter((o) => o.kind === 'update' || o.kind === 'insert')).toEqual([])
  })

  // ── the negatives, which matter just as much ──────────────────────────────
  //
  // Without these AC13 could quietly kill the whole feature and no test would
  // notice: these three types have NO second carrier, so an edit there means
  // "we wrote down the wrong number" and the ledger is obliged to follow.

  for (const editableType of ['ADMIN_INCOME', 'EXPENSE', 'DIVIDEND_TO_ADMIN'] as const) {
    it(`still allows editing a PAID ${editableType} — it has no second carrier of the amount`, async () => {
      const { result, ops } = await attemptEdit({ type: editableType })
      await expect(result).resolves.toBeDefined()
      expect(ops.some((o) => o.kind === 'update' && o.table === 'transactions')).toBe(true)
    })
  }

  it('an OPEN obligation on the edited row does not block it — that is the ordinary IOU case', async () => {
    // Only `status = 'PAID'` counts. An open obligation on the row is exactly
    // what #598 keeps in step with it, and blocking here would break L3's fix.
    const { result } = await attemptEdit(
      { type: 'SENIOR_PENDING_PAYOUT', status: 'PENDING_PAYMENT' },
      { obligations: [obligationRow({ sourceTransactionId: SOURCE_ID, status: 'PENDING' })] },
    )
    await expect(result).resolves.toBeDefined()
  })

  /**
   * The trap AC13 names explicitly. The cascade writes `amount` on derivatives
   * whose `settledAmount` is non-null constantly — that is AC5/AC6, its
   * ordinary work. If this predicate were hoisted into a shared helper and
   * called from `applyEditCascade`, the cascade would start refusing itself.
   * Both directions, one test each.
   */
  it('the predicate applies ONLY to the edited row: a derivative with an accumulator is still reverted', async () => {
    const derivatives = [settledDerivativeRow()] // settledAmount = 260
    const obligations = [obligationRow({ status: 'PAID' })]
    const { db, ops } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)
    expect(derivativeWrites(ops)).toHaveLength(1)
  })

  it('…while editing that SAME derivative row directly is refused', async () => {
    const { result } = await attemptEdit({
      id: SOURCE_ID,
      type: 'SENIOR_INCOME',
      settledAmount: '260.000000',
    })
    await expect(result).rejects.toThrow(/подтверждена фактическими выплатами/)
  })

  it('only a CLOSED obligation on the edited row counts — an open one is the ordinary IOU case', async () => {
    // The predicate is `status === 'PAID'`, not "an obligation exists". An OPEN
    // obligation on the edited row is exactly what #598 keeps in step with it,
    // so treating mere existence as disqualifying would undo L3's fix.
    const source = sourceRow({ type: 'ADMIN_INCOME', status: 'PAID' })
    const { db } = makeDouble({
      source,
      obligations: [obligationRow({ sourceTransactionId: SOURCE_ID, status: 'PENDING' })],
    })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(
      snapshotFrom({
        source,
        obligations: [obligationRow({ sourceTransactionId: SOURCE_ID, status: 'PENDING' })],
      }),
    )
    await expect(
      svc.adminUpdateTransaction(SOURCE_ID, { amount: 26, cascadeVersion: version }, ADMIN),
    ).resolves.toBeDefined()
  })

  /**
   * SR-H-3 (security-review round 3) — the SAME predicate, for the epoch
   * BEFORE the settle-in-place ADR of 2026-07-14.
   *
   * Back then closing an obligation INSERTED a second transaction instead of
   * flipping the IOU on the spot, so on such a row
   * `source_transaction_id !== closing_transaction_id`: the former points at
   * the still-hanging IOU, the latter at the row that paid it. Keying only on
   * `source_transaction_id` therefore never finds the obligation the EDITED
   * row closed — and the other three predicates are empty for that same
   * population by construction (`original_amount` landed 2026-08-05 and
   * `settled_amount` 2026-08-22, both explicitly "no backfill by design").
   * A legacy row would pass all four and stay editable, with exactly the
   * vanishing debit AC13 exists to prevent.
   *
   * A one-time data-fix DID re-point some of these rows on production
   * (`2026-07-15_settle_phantom_cleanup_auto.sql`, applied in PR #382 and then
   * de-wired). It does not cover this case: its repoint is scoped to
   * obligations whose OLD source row is still a `*_PENDING_PAYOUT` in
   * `PENDING_PAYMENT` — a phantom IOU it was about to delete. Anything else
   * keeps `closing <> source` to this day. The predicate is made independent
   * of what that script reached, rather than depending on it.
   */
  it('refuses a row that closed an obligation in the PRE-flip epoch (source ≠ closing id)', async () => {
    const legacyIou = '55555555-0000-4000-8e00-000000000001'
    const { result, ops } = await attemptEdit(
      // Every pre-existing guard is blind to this row on purpose: no
      // fact-of-payment triplet, no accumulator, no payout request.
      { type: 'SENIOR_INCOME', settledAmount: null, originalAmount: null, payoutRequestId: null },
      {
        obligations: [
          obligationRow({
            id: '44444444-0000-4000-8d00-000000000009',
            sourceTransactionId: legacyIou,
            closingTransactionId: SOURCE_ID,
            status: 'PAID',
          }),
        ],
      },
    )
    await expect(result).rejects.toThrow(/закрытым обязательством/)
    expect(ops.filter((o) => o.kind === 'update' || o.kind === 'insert')).toEqual([])
  })

  it('a legacy obligation the row closed but did NOT settle (CANCELLED) does not block it', async () => {
    // `status === 'PAID'` is the whole predicate on both keys. A cancelled
    // obligation was written off, not paid — no money stands behind it, so
    // nothing pins the row's amount.
    const legacyIou = '55555555-0000-4000-8e00-000000000002'
    const { result } = await attemptEdit(
      { type: 'ADMIN_INCOME' },
      {
        obligations: [
          obligationRow({
            id: '44444444-0000-4000-8d00-00000000000a',
            sourceTransactionId: legacyIou,
            closingTransactionId: SOURCE_ID,
            status: 'CANCELLED',
          }),
        ],
      },
    )
    await expect(result).resolves.toBeDefined()
  })

  it('the obligations read reaches rows keyed by closing_transaction_id, not only by source', async () => {
    // The JS predicate above can only refuse a row the QUERY brought back.
    // Without the `closing_transaction_id` disjunct in the WHERE, real
    // Postgres returns nothing for a legacy obligation and the guard is blind
    // no matter how the predicate is written. The unit double answers every
    // `findMany` with the same canned list, so what is asserted here is that
    // the clause BINDS the source id on that second key; the round-trip that
    // proves the rows actually come back is the integration spec's
    // (`mutation-gate-integration-specs.md`).
    const derivatives = [pendingDerivativeRow()]
    const obligations = [obligationRow()]
    const { db, relationalQueries } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)

    const call = relationalQueries.pendingObligations.findMany.mock.calls[0]![0] as {
      where: unknown
    }
    const bound = whereParams(call.where)
    // Twice: once in the `source_transaction_id` list, once as the
    // `closing_transaction_id` equality. Plus the 'PAID' literal that scopes
    // the second key.
    expect(bound.filter((v) => v === SOURCE_ID)).toHaveLength(2)
    expect(bound).toContain('PAID')
  })

  it('the obligations read covers the SOURCE id as well as every derivative id', async () => {
    // AC13's data comes from the query that already runs — no second
    // round-trip. If the id list were emptied, the source could never be found
    // to be a closed obligation and the guard would be blind.
    const derivatives = [pendingDerivativeRow()]
    const obligations = [obligationRow()]
    const { db, relationalQueries } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)

    const call = relationalQueries.pendingObligations.findMany.mock.calls[0]![0] as {
      where: unknown
    }
    const bound = whereParams(call.where)
    expect(bound).toContain(SOURCE_ID)
    expect(bound).toContain(SENIOR_DERIV_ID)
  })
})

// ---------------------------------------------------------------------------
// CR-M-1 — the preview and the write must agree about WHAT IS EDITABLE.
// ---------------------------------------------------------------------------

/**
 * CR-M-1 (code-review round 3). `GET :id/edit-preview` kept answering
 * `editable: true` for rows the `PATCH` now refuses under AC13, because the
 * blocked-reason enum only knew about guards 1 and 2.
 *
 * This is risk 1 of the main ADR's AC6 — "предпросмотр и факт разъезжаются" —
 * which is the reason the whole thing was built as ONE resolver behind TWO
 * wrappers. The write path is protected, so it is not a money defect; it is a
 * defect in the promise the design makes, and it surfaces the moment task 5
 * renders an edit form on a row whose save cannot succeed.
 *
 * The table below is compared AS A WHOLE, both directions. "Both said no N
 * times" is precisely the assertion that would have let this through.
 */
describe('CR-M-1: edit-preview refuses exactly where the write refuses', () => {
  /** One fixture per AC13 predicate, plus the three types that must stay editable. */
  const CASES: Array<{
    label: string
    source: Record<string, unknown>
    obligations?: Array<Record<string, unknown>>
    expected: string | null
  }> = [
    {
      label: 'fact-of-payment triplet',
      source: { originalAmount: '41500.000000' },
      expected: 'PAYMENT_FACT_RECORDED',
    },
    {
      label: 'accumulator of actual payouts',
      source: { type: 'SENIOR_INCOME', settledAmount: '260.000000' },
      expected: 'SETTLED_AMOUNT_RECORDED',
    },
    {
      label: 'closed obligation (pre-accumulator epoch)',
      source: { type: 'SENIOR_INCOME' },
      obligations: [obligationRow({ sourceTransactionId: SOURCE_ID, status: 'PAID' })],
      expected: 'CLOSES_OBLIGATION',
    },
    {
      label: 'on-chain deposit',
      source: { type: 'COMPANY_DEPOSIT' },
      expected: 'ONCHAIN_DEPOSIT',
    },
    { label: 'ordinary admin income', source: { type: 'ADMIN_INCOME' }, expected: null },
    { label: 'expense', source: { type: 'EXPENSE' }, expected: null },
    { label: 'dividend', source: { type: 'DIVIDEND_TO_ADMIN' }, expected: null },
  ]

  const NEW_AMOUNT = 26

  async function previewVerdict(c: (typeof CASES)[number]) {
    const source = sourceRow(c.source)
    const { db } = makeDouble({ source, obligations: c.obligations })
    const svc = makeTransactionsService({ db })
    const preview = await svc.getEditCascadePreview(SOURCE_ID, NEW_AMOUNT, ADMIN)
    return preview
  }

  async function writeVerdict(c: (typeof CASES)[number]) {
    const source = sourceRow(c.source)
    const { db } = makeDouble({ source, obligations: c.obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ source, obligations: c.obligations }))
    try {
      await svc.adminUpdateTransaction(
        SOURCE_ID,
        { amount: NEW_AMOUNT, cascadeVersion: version },
        ADMIN,
      )
      return null
    } catch (e) {
      return (e as Error).message
    }
  }

  it('reports the SAME set of blocked rows the write refuses — compared whole, both ways', async () => {
    const previewSaysNo: Record<string, string | null> = {}
    const writeSaysNo: Record<string, boolean> = {}
    const expectedWriteSaysNo: Record<string, boolean> = {}

    for (const c of CASES) {
      const preview = await previewVerdict(c)
      previewSaysNo[c.label] = preview.blockedReason
      writeSaysNo[c.label] = (await writeVerdict(c)) !== null
      expectedWriteSaysNo[c.label] = c.expected !== null
    }

    // Direction 1: the preview names the right reason for every row.
    expect(previewSaysNo).toEqual(
      Object.fromEntries(CASES.map((c) => [c.label, c.expected] as const)),
    )
    // Direction 2: the write agrees, row for row. Not "N and N".
    expect(writeSaysNo).toEqual(expectedWriteSaysNo)
  })

  it('carries no plan and no version on a blocked row — there is nothing to confirm', async () => {
    const preview = await previewVerdict(CASES[1]!)
    expect(preview.editable).toBe(false)
    expect(preview.plan).toBeNull()
    expect(preview.version).toBeNull()
  })

  it('still previews an UNCHANGED amount on a pinned row — the write would not refuse either', async () => {
    // AC13 only fires on `PAID && amountChanged`. Asking the preview about the
    // figure the row already holds is not an edit, and answering "blocked"
    // there would be the same divergence in the other direction.
    const source = sourceRow({ type: 'SENIOR_INCOME', settledAmount: '260.000000' })
    const { db } = makeDouble({ source })
    const svc = makeTransactionsService({ db })
    const preview = await svc.getEditCascadePreview(SOURCE_ID, Number(source.amount), ADMIN)
    expect(preview.blockedReason).toBeNull()
    expect(preview.editable).toBe(true)
  })

  it('still previews a NON-PAID row carrying an accumulator — that one is floored, not refused', async () => {
    // The reverted-derivative shape (SR-M-6). The write stores it with the
    // floor applied rather than refusing, so the preview must not refuse.
    const source = sourceRow({
      type: 'SENIOR_PENDING_PAYOUT',
      status: 'PENDING_PAYMENT',
      settledAmount: '260.000000',
    })
    const { db } = makeDouble({ source })
    const svc = makeTransactionsService({ db })
    const preview = await svc.getEditCascadePreview(SOURCE_ID, 100, ADMIN)
    expect(preview.blockedReason).toBeNull()
  })

  it('keeps guards 1 and 2 ahead of the ledger-fact reasons — the outer refusal wins', async () => {
    // A PAYOUT-family row also carries an accumulator sometimes; the operator
    // should hear the more fundamental "this family is never editable".
    const source = sourceRow({ type: 'PAYOUT', settledAmount: '260.000000' })
    const { db } = makeDouble({ source })
    const svc = makeTransactionsService({ db })
    const preview = await svc.getEditCascadePreview(SOURCE_ID, 26, ADMIN)
    expect(preview.blockedReason).toBe('PAYOUT_FAMILY')
  })
})

// ---------------------------------------------------------------------------
// SR-M-6 — the accumulator floor is a LAW, so it holds on BOTH write paths.
// ---------------------------------------------------------------------------

/**
 * SR-M-6 (security-review round 3). AC5 states the rule as a law:
 *
 * > a derivative's `amount` is never written below its `settled_amount`.
 *
 * Until now only the CASCADE enforced it. A reverted row sits at
 * `PENDING_PAYMENT`, so `isCascadeEdit` is false, AC13 is never consulted, and
 * the #598 obligation sync plus the main `transactions` UPDATE write whatever
 * figure was typed. A rule that holds on one of two write paths is not a law,
 * it is a coincidence — so the floor is applied in both places, from ONE
 * description.
 *
 * Not a dead end (hence MED, not HIGH): the settle refuses a negative
 * remainder rather than paying it. But the refusal leaves an obligation
 * asserting a debt smaller than what was already paid, and only a data fix
 * gets out of that.
 */
describe('SR-M-6: the accumulator floor holds on the direct edit path too', () => {
  /** The shape a cascade revert leaves behind: open again, accumulator intact. */
  function revertedRow(overrides: Record<string, unknown> = {}) {
    return sourceRow({
      type: 'SENIOR_PENDING_PAYOUT',
      status: 'PENDING_PAYMENT',
      amount: '520.000000',
      settledAmount: '260.000000',
      ...overrides,
    })
  }

  function writes(ops: Op[], table: string) {
    return ops.filter(
      (o): o is Extract<Op, { kind: 'update' }> => o.kind === 'update' && o.table === table,
    )
  }

  it('writes the accumulator, not the smaller typed figure, into the transactions row', async () => {
    const { db, ops } = makeDouble({ source: revertedRow() })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 100 }, ADMIN)

    expect(writes(ops, 'transactions')[0]!.set['amount']).toBe('260')
  })

  it('floors the obligation copy by the SAME figure — the two must not drift apart', async () => {
    const { db, ops } = makeDouble({ source: revertedRow() })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 100 }, ADMIN)

    expect(writes(ops, 'pending_obligations')[0]!.set['amount']).toBe('260')
  })

  it('journals what was actually stored AND what was typed — neither is allowed to vanish', async () => {
    const { db, ops } = makeDouble({ source: revertedRow() })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 100 }, ADMIN)

    const entry = journalEntries(ops, 'AMOUNT_OR_RECEIVER_CHANGE')[0]!
    const meta = entry.values['metadata'] as { amount: Record<string, unknown> }
    expect(meta.amount['before']).toBe('520.000000')
    expect(meta.amount['after']).toBe('260')
    expect(meta.amount['flooredFrom']).toBe(100)
  })

  it('is the identity above the accumulator — an ordinary edit is untouched', async () => {
    const { db, ops } = makeDouble({ source: revertedRow() })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 900 }, ADMIN)

    expect(writes(ops, 'transactions')[0]!.set['amount']).toBe('900')
    const meta = journalEntries(ops, 'AMOUNT_OR_RECEIVER_CHANGE')[0]!.values['metadata'] as {
      amount: Record<string, unknown>
    }
    expect(meta.amount['flooredFrom']).toBeUndefined()
  })

  it('is the identity for a row that never settled — first-round behaviour, byte for byte', async () => {
    // `settled_amount` NULL is the overwhelmingly common case, and it must not
    // acquire a floor of its own.
    const { db, ops } = makeDouble({ source: revertedRow({ settledAmount: null }) })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 1 }, ADMIN)

    expect(writes(ops, 'transactions')[0]!.set['amount']).toBe('1')
  })

  it('treats a MISSING accumulator column as zero, never as NaN', async () => {
    // `Number(undefined)` is NaN and `Math.max` propagates it, so a row object
    // that simply does not carry the column would store the string 'NaN' as a
    // money figure. Pinned deliberately rather than left to an unrelated
    // spec's fixture to notice.
    const { db, ops } = makeDouble({
      source: revertedRow({ settledAmount: undefined as unknown as null }),
    })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 100 }, ADMIN)

    expect(writes(ops, 'transactions')[0]!.set['amount']).toBe('100')
  })

  it('leaves a metadata-only edit alone — no amount was sent, so none is written', async () => {
    const { db, ops } = makeDouble({ source: revertedRow() })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    await svc.adminUpdateTransaction(SOURCE_ID, { notes: 'just a note' }, ADMIN)

    expect(writes(ops, 'transactions')[0]!.set['amount']).toBeUndefined()
    expect(writes(ops, 'pending_obligations')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AC5 — derivative whose obligation is still open.
// ---------------------------------------------------------------------------

describe('AC5: still-open obligation — both copies of the amount move together', () => {
  it('writes plan.newAmount to BOTH pending_obligations.amount and transactions.amount', async () => {
    const derivatives = [pendingDerivativeRow()]
    const obligations = [obligationRow()]
    const { db, ops } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const snapshot = snapshotFrom({ derivatives, obligations })
    const version = computeCascadeVersion(snapshot)
    // Expectation comes from the REAL resolver, not from arithmetic repeated here.
    const plan = resolveEditCascade(snapshot, { amount: 2000 })
    const expected = String(plan.derivatives[0]!.newAmount)

    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)

    const poWrites = updatesTargeting(ops, 'pending_obligations', SENIOR_DERIV_ID)
    const txWrites = updatesTargeting(ops, 'transactions', SENIOR_DERIV_ID)
    expect(poWrites).toHaveLength(1)
    expect(poWrites[0]!.set.amount).toBe(expected)
    // Scoped to an OPEN obligation: a closed one's amount is the historical
    // record of a settlement that already happened and must be unreachable.
    expect(poWrites[0]!.where).toContain('PENDING')
    expect(txWrites).toHaveLength(1)
    expect(txWrites[0]!.set.amount).toBe(expected)
  })

  it('does NOT change status, type or the percent snapshot on a still-open derivative', async () => {
    const derivatives = [pendingDerivativeRow()]
    const obligations = [obligationRow()]
    const { db, ops } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)

    const updates = ops.filter((o): o is Extract<Op, { kind: 'update' }> => o.kind === 'update')
    expect(updates.map((o) => o.set.type)).toEqual(updates.map(() => undefined))
    expect(updates.map((o) => o.set.settledSharePercent)).toEqual(updates.map(() => undefined))
    const txUpdates = updates.filter((o) => o.table === 'transactions')
    expect(txUpdates.map((o) => o.set.status)).toEqual(txUpdates.map(() => undefined))
  })

  it('journals CASCADE_AMOUNT_UPDATE against the DERIVATIVE, with every documented field', async () => {
    const derivatives = [pendingDerivativeRow()]
    const obligations = [obligationRow()]
    const { db, ops } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const snapshot = snapshotFrom({ derivatives, obligations })
    const plan = resolveEditCascade(snapshot, { amount: 2000 })
    await svc.adminUpdateTransaction(
      SOURCE_ID,
      { amount: 2000, cascadeVersion: computeCascadeVersion(snapshot) },
      ADMIN,
    )

    const entries = journalEntries(ops, 'CASCADE_AMOUNT_UPDATE')
    expect(entries).toHaveLength(1)
    const entry = entries[0]!.values
    expect(entry.targetId).toBe(SENIOR_DERIV_ID)
    expect(entry.actorId).toBe(ADMIN.id)
    const meta = entry.metadata as Record<string, unknown>
    expect(meta.obligationId).toBe(SENIOR_OBL_ID)
    expect(meta.causedBy).toBe(SOURCE_ID)
    expect(meta.settledAmount).toBe(0)
    expect(meta.sharePercent).toBe(26)
    expect(meta.amount).toEqual({ before: 260, after: plan.derivatives[0]!.newAmount })
  })

  /**
   * AC5 / addendum §1.7 (SR-M-4) — the accumulator floor.
   *
   * AC5 and AC7 are one law in two states: a derivative's `amount` is never
   * written below its `settled_amount`. On a closed obligation that reads "do
   * not write at all"; on an open one — a row reverted earlier that still
   * carries an accumulator — it reads `max`. Writing less makes the remainder
   * negative and leaves an obligation nobody can close.
   */
  describe('AC5: the amount is floored at the accumulator', () => {
    /** A previously-reverted row: obligation open again, 260 already paid. */
    const revertedRows = () => [
      pendingDerivativeRow({
        settledAmount: '260.000000',
        settledCurrency: 'USDT',
        amount: '520.000000',
      }),
    ]

    async function editTo(amount: number, cfg: DbleConfig = {}) {
      const derivatives = cfg.derivatives ?? revertedRows()
      const obligations = cfg.obligations ?? [obligationRow({ amount: '520.000000' })]
      const { db, ops } = makeDouble({ ...cfg, derivatives, obligations })
      const svc = makeTransactionsService({ db })
      stubFindOne(svc)
      const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
      await svc.adminUpdateTransaction(SOURCE_ID, { amount, cascadeVersion: version }, ADMIN)
      return ops
    }

    it('writes the accumulator, not the smaller new share, into BOTH copies', async () => {
      // 26% of 100 is 26 — below the 260 already paid.
      const ops = await editTo(100)
      expect(updatesTargeting(ops, 'pending_obligations', SENIOR_DERIV_ID)[0]!.set.amount).toBe(
        '260',
      )
      expect(updatesTargeting(ops, 'transactions', SENIOR_DERIV_ID)[0]!.set.amount).toBe('260')
    })

    it('journals the overpayment as well — the floor keeps the row closable, it does not hide the fact', async () => {
      const ops = await editTo(100)
      const entries = journalEntries(ops, 'CASCADE_OVERPAYMENT')
      expect(entries).toHaveLength(1)
      const meta = entries[0]!.values.metadata as Record<string, unknown>
      expect(entries[0]!.values.targetId).toBe(SENIOR_DERIV_ID)
      expect(meta.obligationId).toBe(SENIOR_OBL_ID)
      expect(meta.causedBy).toBe(SOURCE_ID)
      expect(meta.settledAmount).toBe(260)
      expect(meta.newShare).toBe(26)
      expect(meta.overpaidBy).toBe(234)
    })

    it('does NOT journal an overpayment when the new share is above the accumulator', async () => {
      // 26% of 4000 = 1040 — the floor is inert and this is an ordinary update.
      const ops = await editTo(4000)
      expect(journalEntries(ops, 'CASCADE_OVERPAYMENT')).toEqual([])
      expect(updatesTargeting(ops, 'transactions', SENIOR_DERIV_ID)[0]!.set.amount).toBe('1040')
    })

    it('journals a null obligationId for a derivative with no obligation row, rather than blowing up', async () => {
      // Same defensive shape the ordinary AC5 journal already has: a
      // derivative can legitimately carry no paired obligation, and the floor's
      // own journal entry must survive that just as well.
      const ops = await editTo(100, {
        derivatives: [
          pendingDerivativeRow({
            settledAmount: '260.000000',
            settledCurrency: 'USDT',
            amount: '520.000000',
          }),
        ],
        obligations: [],
      })
      const entries = journalEntries(ops, 'CASCADE_OVERPAYMENT')
      expect(entries).toHaveLength(1)
      expect((entries[0]!.values.metadata as Record<string, unknown>).obligationId).toBeNull()
    })

    it('is the identity for a row that never settled — first-round behaviour, byte for byte', async () => {
      const ops = await editTo(2000, {
        derivatives: [pendingDerivativeRow()],
        obligations: [obligationRow()],
      })
      expect(updatesTargeting(ops, 'transactions', SENIOR_DERIV_ID)[0]!.set.amount).toBe('520')
      expect(journalEntries(ops, 'CASCADE_OVERPAYMENT')).toEqual([])
    })
  })

  /**
   * SR-M-1 (security-review) — the derivative write carries the same structural
   * scoping its sibling obligation UPDATE has always had.
   */
  describe('AC5: the derivative write is scoped by status, like its sibling', () => {
    it('binds PENDING_PAYMENT in the WHERE and asks for the affected rows back', async () => {
      const derivatives = [pendingDerivativeRow()]
      const obligations = [obligationRow()]
      const { db, ops } = makeDouble({ derivatives, obligations })
      const svc = makeTransactionsService({ db })
      stubFindOne(svc)
      const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
      await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)

      const write = updatesTargeting(ops, 'transactions', SENIOR_DERIV_ID)[0]!
      expect(write.where).toContain('PENDING_PAYMENT')
      const returned = ops.filter(
        (o): o is Extract<Op, { kind: 'returning' }> =>
          o.kind === 'returning' && o.table === 'transactions',
      )
      expect(returned.length).toBeGreaterThan(0)
      for (const r of returned) {
        expect(Object.keys(r.projection as object)).toContain('id')
      }
    })

    it('aborts loudly when that scoped write matches nothing', async () => {
      // Leaving the obligation updated and the transaction not is precisely the
      // L3 divergence this decomposition exists to close — so zero rows must
      // roll the whole edit back, not pass silently.
      const derivatives = [pendingDerivativeRow()]
      const obligations = [obligationRow()]
      const { db } = makeDouble({ derivatives, obligations, derivativeUpdateRows: [] })
      const svc = makeTransactionsService({ db })
      stubFindOne(svc)
      const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
      await expect(
        svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN),
      ).rejects.toThrow(/больше не в статусе ожидания выплаты/)
    })
  })

  it('the source row keeps its OWN journal entry as well (AMOUNT_OR_RECEIVER_CHANGE)', async () => {
    const derivatives = [pendingDerivativeRow()]
    const obligations = [obligationRow()]
    const { db, ops } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)

    const entries = journalEntries(ops, 'AMOUNT_OR_RECEIVER_CHANGE')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.values.targetId).toBe(SOURCE_ID)
  })
})

// ---------------------------------------------------------------------------
// AC6 — reverting a settled derivative.
// ---------------------------------------------------------------------------

describe('AC6: revert of a settled derivative', () => {
  const derivatives = () => [settledDerivativeRow()]
  const obligations = () => [obligationRow({ status: 'PAID' })]

  async function runRevert(cfg: DbleConfig = {}) {
    const derivativeRows = cfg.derivatives ?? derivatives()
    const obligationRows = cfg.obligations ?? obligations()
    const invoicesService = makeInvoicesSpy()
    const { db, ops } = makeDouble({
      ...cfg,
      derivatives: derivativeRows,
      obligations: obligationRows,
    })
    const svc = makeTransactionsService({ db, invoicesService })
    stubFindOne(svc)
    const snapshot = snapshotFrom({
      source: cfg.source,
      derivatives: derivativeRows,
      obligations: obligationRows,
    })
    await svc.adminUpdateTransaction(
      SOURCE_ID,
      { amount: 2000, cascadeVersion: computeCascadeVersion(snapshot) },
      ADMIN,
    )
    return { ops, snapshot, invoicesService }
  }

  it('flips the obligation back to PENDING with a CONDITIONAL update and clears the closing link', async () => {
    const { ops } = await runRevert()
    const claims = updatesTargeting(ops, 'pending_obligations', SENIOR_OBL_ID)
    expect(claims).toHaveLength(1)
    const claim = claims[0]!
    expect(claim.set.status).toBe('PENDING')
    expect(claim.set.closingTransactionId).toBeNull()
    // Conditional on the row still being closed — a double revert must affect
    // zero rows rather than create a second open obligation (23505 territory).
    expect(claim.where).toContain('PAID')
    // …and it must ASK for the affected rows back: the whole idempotency
    // decision below is "how many rows did that conditional UPDATE touch",
    // which an UPDATE with no RETURNING clause cannot answer.
    const returned = ops.filter(
      (o): o is Extract<Op, { kind: 'returning' }> =>
        o.kind === 'returning' && o.table === 'pending_obligations',
    )
    expect(returned).toHaveLength(1)
    expect(Object.keys(returned[0]!.projection as object)).toContain('id')
  })

  it('flips the transaction back to SENIOR_PENDING_PAYOUT / PENDING_PAYMENT with the new share', async () => {
    const { ops, snapshot } = await runRevert()
    const plan = resolveEditCascade(snapshot, { amount: 2000 })
    const write = derivativeWrites(ops)[0]!
    expect(write.set.type).toBe('SENIOR_PENDING_PAYOUT')
    expect(write.set.status).toBe('PENDING_PAYMENT')
    expect(write.set.amount).toBe(String(plan.derivatives[0]!.newAmount))
  })

  it('restores the percent into the LIVE column so the next preview can recompute', async () => {
    const { ops } = await runRevert()
    const write = derivativeWrites(ops)[0]!
    expect(write.set.seniorSharePercent).toBe(26)
    // The snapshot column is a record of the last CLOSURE — a revert is not one.
    expect(write.set.settledSharePercent).toBeUndefined()
    // The origin of that percent was never snapshotted; inventing one is worse
    // than leaving the gap visible (backlog 70).
    expect(write.set.seniorSharePercentSource).toBeUndefined()
  })

  /**
   * The drop half of the type mapping AC6 requires.
   *
   * REACHABILITY, stated plainly rather than implied: with AC15 in force this
   * branch is NOT reachable in production. AC15(a) refuses every drop revert
   * whose accumulator is non-zero, and a drop revert whose accumulator IS zero
   * cannot exist — a zero accumulator means the settle closed a zero
   * obligation, which means a 0% share, which makes the recomputed share zero
   * too, which makes `needsReconfirm` false. The branch is retained because
   * AC6 requires it and because task 3b (drop top-up) lifts AC15(a) and lights
   * it up again; the snapshot below is therefore deliberately synthetic, and
   * says so, so that nobody later reads it as a live scenario.
   */
  it('a DROP derivative restores into dropSharePercent instead (branch kept for task 3b)', async () => {
    const { ops } = await runRevert({
      derivatives: [
        settledDerivativeRow({
          id: DROP_DERIV_ID,
          type: 'PAYOUT_DROP',
          settledSharePercent: 10,
          // Zero accumulator: the only shape AC15(a) lets through, and the
          // reason this test can exercise the branch at all.
          settledAmount: '0.000000',
          amount: '0.000000',
          // ADMIN_PERSONAL settle — keeps the AC6 company-account invariant
          // check (amount vs accumulator) out of the way.
          fundingSource: null,
        }),
      ],
      obligations: [
        obligationRow({
          id: DROP_OBL_ID,
          sourceTransactionId: DROP_DERIV_ID,
          status: 'PAID',
          amount: '0.000000',
        }),
      ],
    })
    const write = derivativeWrites(ops)[0]!
    expect(write.set.type).toBe('DROP_PENDING_PAYOUT')
    expect(write.set.dropSharePercent).toBe(10)
    expect(write.set.seniorSharePercent).toBeUndefined()
  })

  it('NEVER touches the monotonic accumulator or its currency label', async () => {
    const { ops } = await runRevert()
    for (const op of ops) {
      if (op.kind !== 'update') continue
      expect(op.set.settledAmount).toBeUndefined()
      expect(op.set.settledCurrency).toBeUndefined()
    }
  })

  it('does NOT erase the proof that the payment happened (funding, receipt, sender, validation, currency)', async () => {
    const { ops } = await runRevert()
    const write = derivativeWrites(ops)[0]!
    for (const preserved of [
      'fundingSource',
      'receiptDocumentId',
      'receiptExternalUrl',
      'senderId',
      'senderLabel',
      'validatedBy',
      'validatedAt',
      'currency',
      'dropCascadeOrigin',
    ]) {
      expect(write.set[preserved], `${preserved} must not be rewritten by a revert`).toBeUndefined()
    }
  })

  it('journals CASCADE_REOPEN with before/after and the settled figure', async () => {
    const { ops, snapshot } = await runRevert()
    const plan = resolveEditCascade(snapshot, { amount: 2000 })
    const entries = journalEntries(ops, 'CASCADE_REOPEN')
    expect(entries).toHaveLength(1)
    const values = entries[0]!.values
    expect(values.targetId).toBe(SENIOR_DERIV_ID)
    const meta = values.metadata as Record<string, unknown>
    expect(meta.obligationId).toBe(SENIOR_OBL_ID)
    expect(meta.causedBy).toBe(SOURCE_ID)
    expect(meta.settledAmount).toBe(260)
    expect(meta.sharePercent).toBe(26)
    expect(meta.before).toEqual({ amount: 260, type: 'SENIOR_INCOME', status: 'PAID' })
    expect(meta.after).toEqual({
      amount: plan.derivatives[0]!.newAmount,
      type: 'SENIOR_PENDING_PAYOUT',
      status: 'PENDING_PAYMENT',
    })
  })

  /**
   * Risk 17 — the invariant term 9 stands on. `settleByCompany` on the SENIOR
   * branch takes the accumulator from `pending_obligations.amount` while term
   * 7 debits `transactions.amount`, and NOTHING inside settle compares the
   * two: the equality is held by `bookCompanyObligations` and by task 0
   * (#598). A row edited BEFORE #598 can violate it — and reverting such a
   * row silently returns a different figure to the balance than the one that
   * left it. Error in the "+" direction, caught by no gate.
   */
  it('REFUSES to revert a company-funded row whose amount and settled_amount disagree', async () => {
    const derivativeRows = [settledDerivativeRow({ amount: '2000.000000' })] // settled = 260
    const obligationRows = [obligationRow({ status: 'PAID', amount: '2000.000000' })]
    const { db, ops } = makeDouble({
      derivatives: derivativeRows,
      obligations: obligationRows,
    })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(
      snapshotFrom({ derivatives: derivativeRows, obligations: obligationRows }),
    )
    await expect(
      svc.adminUpdateTransaction(SOURCE_ID, { amount: 5000, cascadeVersion: version }, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(ops.filter((o) => o.kind === 'update' || o.kind === 'insert')).toEqual([])
  })

  it('the refusal names the invariant so the operator knows what to reconcile', async () => {
    const derivativeRows = [settledDerivativeRow({ amount: '2000.000000' })]
    const obligationRows = [obligationRow({ status: 'PAID', amount: '2000.000000' })]
    const { db } = makeDouble({ derivatives: derivativeRows, obligations: obligationRows })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(
      snapshotFrom({ derivatives: derivativeRows, obligations: obligationRows }),
    )
    await expect(
      svc.adminUpdateTransaction(SOURCE_ID, { amount: 5000, cascadeVersion: version }, ADMIN),
    ).rejects.toThrow(/settled_amount/)
  })

  it('EQUAL amount and settled_amount pass the invariant check (the mirror case)', async () => {
    const { ops } = await runRevert()
    expect(derivativeWrites(ops)).toHaveLength(1)
  })

  it('a row NOT funded by the company account skips the invariant check entirely', async () => {
    // ADMIN_PERSONAL settle: `fundingSource` is null, so the row is in no
    // ledger term and term 9 has nothing to stand on for it.
    const { ops } = await runRevert({
      derivatives: [settledDerivativeRow({ amount: '2000.000000', fundingSource: null })],
      obligations: [obligationRow({ status: 'PAID', amount: '2000.000000' })],
    })
    expect(derivativeWrites(ops)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// AC7 — overpayment: write NOTHING.
// ---------------------------------------------------------------------------

describe('AC7: overpayment branch writes nothing at all', () => {
  const derivatives = () => [settledDerivativeRow({ settledAmount: '260.000000' })]
  const obligations = () => [obligationRow({ status: 'PAID' })]

  async function runOverpayment() {
    const derivativeRows = derivatives()
    const obligationRows = obligations()
    const { db, ops } = makeDouble({ derivatives: derivativeRows, obligations: obligationRows })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const snapshot = snapshotFrom({ derivatives: derivativeRows, obligations: obligationRows })
    // Cutting the income to 100 makes the recomputed share 26 — far below the
    // 260 already paid out.
    await svc.adminUpdateTransaction(
      SOURCE_ID,
      { amount: 100, cascadeVersion: computeCascadeVersion(snapshot) },
      ADMIN,
    )
    return { ops }
  }

  it('leaves the derivative transactions row alone — rewriting it would inflate the company balance', async () => {
    const { ops } = await runOverpayment()
    expect(derivativeWrites(ops)).toHaveLength(0)
    expect(updatesTargeting(ops, 'transactions', SENIOR_DERIV_ID)).toEqual([])
    // The only `transactions` write is the SOURCE row's own edit.
    const sourceWrites = updatesTargeting(ops, 'transactions', SOURCE_ID)
    expect(sourceWrites).toHaveLength(1)
    expect(sourceWrites[0]!.set.amount).toBe('100')
  })

  it('leaves the derivative obligation alone as well', async () => {
    const { ops } = await runOverpayment()
    // The SOURCE row's own #598 obligation sync still runs (it targets
    // `sourceTransactionId = SOURCE_ID`, a different row, and is unrelated to
    // the cascade) — the derivative's obligation is the one that must not move.
    expect(updatesTargeting(ops, 'pending_obligations', SENIOR_DERIV_ID, SENIOR_OBL_ID)).toEqual([])
  })

  it('journals CASCADE_OVERPAYMENT with both figures and the difference', async () => {
    const { ops } = await runOverpayment()
    const entries = journalEntries(ops, 'CASCADE_OVERPAYMENT')
    expect(entries).toHaveLength(1)
    const meta = entries[0]!.values.metadata as Record<string, unknown>
    expect(entries[0]!.values.targetId).toBe(SENIOR_DERIV_ID)
    expect(meta.obligationId).toBe(SENIOR_OBL_ID)
    expect(meta.causedBy).toBe(SOURCE_ID)
    expect(meta.settledAmount).toBe(260)
    expect(meta.newShare).toBe(26)
    expect(meta.overpaidBy).toBe(234)
  })

  it('does not journal a REOPEN or an AMOUNT_UPDATE for the same row', async () => {
    const { ops } = await runOverpayment()
    expect(journalEntries(ops, 'CASCADE_REOPEN')).toEqual([])
    expect(journalEntries(ops, 'CASCADE_AMOUNT_UPDATE')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// AC11 / risk 8b — the invoice is voided and re-issued for every row that moved.
// ---------------------------------------------------------------------------

describe('AC11: invoice void+reissue wiring', () => {
  it('fires for the SOURCE and for EACH derivative whose amount changed, once each', async () => {
    const derivativeRows = [
      pendingDerivativeRow(),
      pendingDerivativeRow({
        id: DROP_DERIV_ID,
        type: 'DROP_PENDING_PAYOUT',
        seniorSharePercent: null,
        dropSharePercent: 10,
        amount: '100.000000',
      }),
    ]
    const obligationRows = [
      obligationRow(),
      obligationRow({
        id: DROP_OBL_ID,
        sourceTransactionId: DROP_DERIV_ID,
        amount: '100.000000',
      }),
    ]
    const invoicesService = makeInvoicesSpy()
    const { db } = makeDouble({ derivatives: derivativeRows, obligations: obligationRows })
    const svc = makeTransactionsService({ db, invoicesService })
    stubFindOne(svc)
    const version = computeCascadeVersion(
      snapshotFrom({ derivatives: derivativeRows, obligations: obligationRows }),
    )
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)

    const spy = invoicesService.voidAndReissueInvoiceForAmountEdit as unknown as ReturnType<
      typeof vi.fn
    >
    const calledIds = spy.mock.calls.map((c) => c[0])
    expect(calledIds).toContain(SOURCE_ID)
    expect(calledIds).toContain(SENIOR_DERIV_ID)
    expect(calledIds).toContain(DROP_DERIV_ID)
    expect(calledIds).toHaveLength(3)
    expect(new Set(calledIds).size).toBe(3)
  })

  it('does NOT fire for a derivative on the overpayment branch — its amount did not move', async () => {
    const derivativeRows = [settledDerivativeRow()]
    const obligationRows = [obligationRow({ status: 'PAID' })]
    const invoicesService = makeInvoicesSpy()
    const { db } = makeDouble({ derivatives: derivativeRows, obligations: obligationRows })
    const svc = makeTransactionsService({ db, invoicesService })
    stubFindOne(svc)
    const version = computeCascadeVersion(
      snapshotFrom({ derivatives: derivativeRows, obligations: obligationRows }),
    )
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 100, cascadeVersion: version }, ADMIN)

    const spy = invoicesService.voidAndReissueInvoiceForAmountEdit as unknown as ReturnType<
      typeof vi.fn
    >
    expect(spy.mock.calls.map((c) => c[0])).toEqual([SOURCE_ID])
  })

  it('an invoice failure does NOT roll back the already-committed cascade', async () => {
    const derivativeRows = [pendingDerivativeRow()]
    const obligationRows = [obligationRow()]
    const invoicesService = makeInvoicesSpy()
    ;(
      invoicesService.voidAndReissueInvoiceForAmountEdit as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error('S3 is having a day'))
    const { db, ops } = makeDouble({ derivatives: derivativeRows, obligations: obligationRows })
    const svc = makeTransactionsService({ db, invoicesService })
    stubFindOne(svc)
    const version = computeCascadeVersion(
      snapshotFrom({ derivatives: derivativeRows, obligations: obligationRows }),
    )
    await expect(
      svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN),
    ).resolves.toBeDefined()
    expect(ops.some((o) => o.kind === 'update' && o.table === 'pending_obligations')).toBe(true)
  })

  it('is called AFTER the DB transaction closes — the method opens its own FOR UPDATE', async () => {
    const derivativeRows = [pendingDerivativeRow()]
    const obligationRows = [obligationRow()]
    const invoicesService = makeInvoicesSpy()
    let insideTransaction = true
    const { db } = makeDouble({ derivatives: derivativeRows, obligations: obligationRows })
    const realTransaction = (db as unknown as { db: { transaction: ReturnType<typeof vi.fn> } }).db
      .transaction
    ;(db as unknown as { db: { transaction: unknown } }).db.transaction = vi.fn(
      async (cb: (tx: unknown) => Promise<unknown>) => {
        const result = await realTransaction(cb)
        insideTransaction = false
        return result
      },
    )
    ;(
      invoicesService.voidAndReissueInvoiceForAmountEdit as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(async () => {
      expect(insideTransaction).toBe(false)
    })
    const svc = makeTransactionsService({ db, invoicesService })
    stubFindOne(svc)
    const version = computeCascadeVersion(
      snapshotFrom({ derivatives: derivativeRows, obligations: obligationRows }),
    )
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)
    expect(
      (invoicesService.voidAndReissueInvoiceForAmountEdit as unknown as ReturnType<typeof vi.fn>)
        .mock.calls.length,
    ).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// AC12 — idempotency.
// ---------------------------------------------------------------------------

describe('AC12: idempotency', () => {
  it('re-editing to the SAME amount runs no cascade, writes nothing, journals nothing', async () => {
    const derivativeRows = [pendingDerivativeRow()]
    const obligationRows = [obligationRow()]
    const { db, ops } = makeDouble({ derivatives: derivativeRows, obligations: obligationRows })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 1000 }, ADMIN)

    expect(ops.some((o) => o.kind === 'advisory')).toBe(false)
    expect(journalEntries(ops, 'AMOUNT_OR_RECEIVER_CHANGE')).toEqual([])
    expect(journalEntries(ops, 'CASCADE_AMOUNT_UPDATE')).toEqual([])
  })

  it('a revert that affects ZERO obligation rows stops there — no second journal entry', async () => {
    // The obligation was already flipped back by a concurrent winner: the
    // conditional UPDATE `WHERE status = 'PAID'` matches nothing.
    const derivativeRows = [settledDerivativeRow()]
    const obligationRows = [obligationRow({ status: 'PAID' })]
    const { db, ops } = makeDouble({
      derivatives: derivativeRows,
      obligations: obligationRows,
      revertClaimRows: [],
    })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(
      snapshotFrom({ derivatives: derivativeRows, obligations: obligationRows }),
    )
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)

    expect(journalEntries(ops, 'CASCADE_REOPEN')).toEqual([])
    expect(derivativeWrites(ops)).toHaveLength(0)
  })

  it('the cascade only ever UPDATEs derivatives — it never inserts a new transaction row', async () => {
    const derivativeRows = [settledDerivativeRow()]
    const obligationRows = [obligationRow({ status: 'PAID' })]
    const { db, ops } = makeDouble({ derivatives: derivativeRows, obligations: obligationRows })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(
      snapshotFrom({ derivatives: derivativeRows, obligations: obligationRows }),
    )
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)

    expect(ops.filter((o) => o.kind === 'insert' && o.table === 'transactions')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Refusal wording. A money refusal an operator cannot act on is only half a
// refusal — these pin the sentences that say WHAT is wrong and WHAT to do.
// ---------------------------------------------------------------------------

describe('refusal messages', () => {
  it('the PAID guard names the two fields that are still frozen, and no longer names amount', async () => {
    const { db } = makeDouble()
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    await expect(svc.adminUpdateTransaction(SOURCE_ID, { currency: 'EUR' }, ADMIN)).rejects.toThrow(
      'Cannot change currency or salary month of a settled (PAID) transaction',
    )
  })

  it('the stale-version refusal tells the operator to refresh the preview', async () => {
    const { db } = makeDouble({
      derivatives: [pendingDerivativeRow()],
      obligations: [obligationRow()],
    })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    await expect(
      svc.adminUpdateTransaction(
        SOURCE_ID,
        { amount: 2000, cascadeVersion: 'src:stale:2020-01-01T00:00:00.000Z' },
        ADMIN,
      ),
    ).rejects.toThrow(
      'Данные изменились с момента предпросмотра — обновите предпросмотр правки и повторите сохранение',
    )
  })

  it('the invariant refusal spells out both figures and who holds the equality', async () => {
    const derivativeRows = [settledDerivativeRow({ amount: '2000.000000' })]
    const obligationRows = [obligationRow({ status: 'PAID', amount: '2000.000000' })]
    const { db } = makeDouble({ derivatives: derivativeRows, obligations: obligationRows })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(
      snapshotFrom({ derivatives: derivativeRows, obligations: obligationRows }),
    )
    let caught: unknown
    try {
      await svc.adminUpdateTransaction(SOURCE_ID, { amount: 5000, cascadeVersion: version }, ADMIN)
    } catch (e) {
      caught = e
    }
    const message = (caught as Error).message
    // Each assertion pins one concatenated fragment, killing each separately.
    expect(message).toContain(`Строка ${SENIOR_DERIV_ID}: расходятся сумма строки и сумма`)
    expect(message).toContain('фактических выплат (amount = 2000, settled_amount = 260).')
    expect(message).toContain(
      'Равенство этих двух держат книжка обязательств и правка суммы (#598), а закрытие долга',
    )
    expect(message).toContain(
      'его не проверяет — поэтому при возврате в ожидание выплаты леджер вернул бы не тот дебет.',
    )
    expect(message).toContain('Строка требует ручной сверки перед правкой дохода.')
  })

  it('reports a MISSING accumulator as 0 rather than "null" in the same refusal', async () => {
    // A company-funded row whose accumulator was never written is the same
    // class of disagreement (row says 260, payments say nothing) and must be
    // refused with a figure a human can read.
    const derivativeRows = [settledDerivativeRow({ settledAmount: null, settledCurrency: null })]
    const obligationRows = [obligationRow({ status: 'PAID' })]
    const { db, ops } = makeDouble({ derivatives: derivativeRows, obligations: obligationRows })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(
      snapshotFrom({ derivatives: derivativeRows, obligations: obligationRows }),
    )
    await expect(
      svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN),
    ).rejects.toThrow('settled_amount = 0')
    expect(ops.filter((o) => o.kind === 'update' || o.kind === 'insert')).toEqual([])
  })

  it('refuses a settled derivative whose type matches no closure form, instead of guessing one', async () => {
    // Only `SENIOR_INCOME` and `PAYOUT_DROP` are shapes a settle produces.
    // Anything else closing an obligation is corrupt state: pick a type for it
    // and the row silently re-enters the ledger under the wrong term.
    const derivativeRows = [settledDerivativeRow({ type: 'SALARY' })]
    const obligationRows = [obligationRow({ status: 'PAID' })]
    const { db, ops } = makeDouble({ derivatives: derivativeRows, obligations: obligationRows })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(
      snapshotFrom({ derivatives: derivativeRows, obligations: obligationRows }),
    )
    await expect(
      svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN),
    ).rejects.toThrow(/не соответствует ни одной форме закрытия/)
    expect(derivativeWrites(ops)).toHaveLength(0)
  })

  it('refuses when the row disappears between the pre-read and the locked re-read', async () => {
    // The two reads are NOT in one transaction, so a concurrent hard delete
    // can land between them. Defence-in-depth, but a real race.
    const { db, ops } = makeDouble({ sourceReads: [sourceRow(), undefined] })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    await expect(
      svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: 'anything' }, ADMIN),
    ).rejects.toThrow(/удалена/)
    expect(ops.filter((o) => o.kind === 'update' || o.kind === 'insert')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The lock statements themselves — WHICH rows they cover.
// ---------------------------------------------------------------------------

describe('AC3: the lock statements cover the source AND every derivative', () => {
  async function runAndCollectLocks() {
    const derivativeRows = [
      pendingDerivativeRow(),
      pendingDerivativeRow({
        id: DROP_DERIV_ID,
        type: 'DROP_PENDING_PAYOUT',
        seniorSharePercent: null,
        dropSharePercent: 10,
        amount: '100.000000',
      }),
    ]
    const obligationRows = [
      obligationRow(),
      obligationRow({ id: DROP_OBL_ID, sourceTransactionId: DROP_DERIV_ID, amount: '100.000000' }),
    ]
    const { db, ops } = makeDouble({ derivatives: derivativeRows, obligations: obligationRows })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(
      snapshotFrom({ derivatives: derivativeRows, obligations: obligationRows }),
    )
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)
    return ops.filter((o): o is Extract<Op, { kind: 'lock' }> => o.kind === 'lock')
  }

  it('locks the obligations of the SOURCE and of every derivative', async () => {
    const locks = await runAndCollectLocks()
    const obligationLock = locks.find((l) => l.table.startsWith('pending_obligations'))!
    // The source id belongs in the set because the #598 sync writes ITS
    // obligation later in the same transaction — taking that row lock after
    // the advisory lock would be the inversion this order removes.
    expect(obligationLock.where).toContain(SOURCE_ID)
    expect(obligationLock.where).toContain(SENIOR_DERIV_ID)
    expect(obligationLock.where).toContain(DROP_DERIV_ID)
  })

  it('locks the SOURCE transaction row and every derivative transaction row', async () => {
    const locks = await runAndCollectLocks()
    const txLock = locks.find((l) => l.table.startsWith('transactions'))!
    expect(txLock.where).toContain(SOURCE_ID)
    expect(txLock.where).toContain(SENIOR_DERIV_ID)
    expect(txLock.where).toContain(DROP_DERIV_ID)
  })

  it('each lock statement selects a real column — an empty projection is not a query', async () => {
    const locks = await runAndCollectLocks()
    expect(locks).toHaveLength(2)
    for (const lock of locks) {
      expect(Object.keys(lock.projection as object), `${lock.table} projection`).toContain('id')
    }
  })

  it('the id-discovery read selects a real column too', async () => {
    // It is the read the whole lock set is derived FROM: an empty projection
    // there means the lock statements below cover nothing.
    const derivativeRows = [pendingDerivativeRow()]
    const obligationRows = [obligationRow()]
    const { db, ops } = makeDouble({ derivatives: derivativeRows, obligations: obligationRows })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(
      snapshotFrom({ derivatives: derivativeRows, obligations: obligationRows }),
    )
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)

    const selects = ops.filter((o): o is Extract<Op, { kind: 'select' }> => o.kind === 'select')
    expect(selects.length).toBeGreaterThan(0)
    for (const select of selects) {
      expect(Object.keys(select.projection as object), `${select.table} projection`).toContain('id')
    }
  })
})

// ---------------------------------------------------------------------------
// A derivative with NO paired obligation row.
// ---------------------------------------------------------------------------

describe('a derivative carrying no obligation row', () => {
  async function runOrphan() {
    const derivativeRows = [pendingDerivativeRow()]
    const { db, ops } = makeDouble({ derivatives: derivativeRows, obligations: [] })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives: derivativeRows }))
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)
    return ops
  }

  it('is treated as still-open (never reverted) — there is no closure to undo', async () => {
    const ops = await runOrphan()
    expect(derivativeWrites(ops)).toHaveLength(0)
    expect(journalEntries(ops, 'CASCADE_AMOUNT_UPDATE')).toHaveLength(1)
  })

  it('journals a null obligationId rather than inventing one', async () => {
    const ops = await runOrphan()
    const meta = journalEntries(ops, 'CASCADE_AMOUNT_UPDATE')[0]!.values.metadata as Record<
      string,
      unknown
    >
    expect(meta.obligationId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// A derivative whose recomputed share happens to equal what is already stored.
// ---------------------------------------------------------------------------

describe('a derivative whose amount does not actually move', () => {
  it('skips the invoice re-issue on the still-open branch — nothing changed to re-issue', async () => {
    // A 0% share: the new share is 0 and the stored amount is already 0.
    const derivativeRows = [pendingDerivativeRow({ seniorSharePercent: 0, amount: '0.000000' })]
    const obligationRows = [obligationRow({ amount: '0.000000' })]
    const invoicesService = makeInvoicesSpy()
    const { db } = makeDouble({ derivatives: derivativeRows, obligations: obligationRows })
    const svc = makeTransactionsService({ db, invoicesService })
    stubFindOne(svc)
    const version = computeCascadeVersion(
      snapshotFrom({ derivatives: derivativeRows, obligations: obligationRows }),
    )
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)

    const spy = invoicesService.voidAndReissueInvoiceForAmountEdit as unknown as ReturnType<
      typeof vi.fn
    >
    expect(spy.mock.calls.map((c) => c[0])).toEqual([SOURCE_ID])
  })

  it('DOES re-issue on the revert branch when the amount really moves (the mirror case)', async () => {
    // Stored 260, already paid 260, new share 520 — a genuine revert with a
    // genuinely new figure, so the derivative's invoice is stale and must be
    // voided and re-issued alongside the source's.
    const derivativeRows = [settledDerivativeRow({ fundingSource: null })]
    const obligationRows = [obligationRow({ status: 'PAID' })]
    const invoicesService = makeInvoicesSpy()
    const { db, ops } = makeDouble({ derivatives: derivativeRows, obligations: obligationRows })
    const svc = makeTransactionsService({ db, invoicesService })
    stubFindOne(svc)
    const version = computeCascadeVersion(
      snapshotFrom({ derivatives: derivativeRows, obligations: obligationRows }),
    )
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)

    expect(derivativeWrites(ops)).toHaveLength(1)
    const spy = invoicesService.voidAndReissueInvoiceForAmountEdit as unknown as ReturnType<
      typeof vi.fn
    >
    expect(spy.mock.calls.map((c) => c[0])).toEqual([SOURCE_ID, SENIOR_DERIV_ID])
  })

  it('skips the invoice re-issue on the revert branch too', async () => {
    // Stored amount 520 already equals 26% of the new income 2000, while only
    // 260 was actually paid — so the row IS reverted, but its figure is
    // unchanged. `fundingSource` null keeps the AC6 invariant check out of it
    // (an ADMIN_PERSONAL settle is in no ledger term).
    const derivativeRows = [
      settledDerivativeRow({
        amount: '520.000000',
        settledAmount: '260.000000',
        fundingSource: null,
      }),
    ]
    const obligationRows = [obligationRow({ status: 'PAID', amount: '520.000000' })]
    const invoicesService = makeInvoicesSpy()
    const { db, ops } = makeDouble({ derivatives: derivativeRows, obligations: obligationRows })
    const svc = makeTransactionsService({ db, invoicesService })
    stubFindOne(svc)
    const version = computeCascadeVersion(
      snapshotFrom({ derivatives: derivativeRows, obligations: obligationRows }),
    )
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)

    expect(derivativeWrites(ops)).toHaveLength(1) // the revert DID happen
    const spy = invoicesService.voidAndReissueInvoiceForAmountEdit as unknown as ReturnType<
      typeof vi.fn
    >
    expect(spy.mock.calls.map((c) => c[0])).toEqual([SOURCE_ID])
  })
})

// ---------------------------------------------------------------------------
// Invoice wiring: when it must NOT fire, and who it attributes the void to.
// ---------------------------------------------------------------------------

describe('AC11: invoice wiring boundaries', () => {
  it('does NOT fire at all on a metadata-only edit — no amount moved, no document is stale', async () => {
    const invoicesService = makeInvoicesSpy()
    const { db } = makeDouble()
    const svc = makeTransactionsService({ db, invoicesService })
    stubFindOne(svc)
    await svc.adminUpdateTransaction(SOURCE_ID, { notes: 'typo fixed' }, ADMIN)
    expect(invoicesService.voidAndReissueInvoiceForAmountEdit).not.toHaveBeenCalled()
  })

  it('attributes the void to the REAL operator under impersonation, not to the impersonated user', async () => {
    const derivativeRows = [pendingDerivativeRow()]
    const obligationRows = [obligationRow()]
    const invoicesService = makeInvoicesSpy()
    const { db } = makeDouble({ derivatives: derivativeRows, obligations: obligationRows })
    const svc = makeTransactionsService({ db, invoicesService })
    stubFindOne(svc)
    const impersonator = '99999999-0000-4000-9e00-000000000009'
    const version = computeCascadeVersion(
      snapshotFrom({ derivatives: derivativeRows, obligations: obligationRows }),
    )
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, {
      ...ADMIN,
      impersonatorId: impersonator,
    } as SessionUser)

    const spy = invoicesService.voidAndReissueInvoiceForAmountEdit as unknown as ReturnType<
      typeof vi.fn
    >
    expect(spy.mock.calls.map((c) => c[1])).toEqual([impersonator, impersonator])
  })

  it('logs the failure it swallows — silence here would hide a stale signed document', async () => {
    const derivativeRows = [pendingDerivativeRow()]
    const obligationRows = [obligationRow()]
    const invoicesService = makeInvoicesSpy()
    ;(
      invoicesService.voidAndReissueInvoiceForAmountEdit as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error('S3 is having a day'))
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    try {
      const { db } = makeDouble({ derivatives: derivativeRows, obligations: obligationRows })
      const svc = makeTransactionsService({ db, invoicesService })
      stubFindOne(svc)
      const version = computeCascadeVersion(
        snapshotFrom({ derivatives: derivativeRows, obligations: obligationRows }),
      )
      await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)

      expect(errorSpy).toHaveBeenCalledTimes(2) // source + derivative
      const [message] = errorSpy.mock.calls[0]!
      expect(message).toContain(
        'adminUpdateTransaction: invoice void+reissue failed for transaction=',
      )
      expect(message).toContain(SOURCE_ID)
      expect(message).toContain('S3 is having a day')
    } finally {
      errorSpy.mockRestore()
    }
  })
})
