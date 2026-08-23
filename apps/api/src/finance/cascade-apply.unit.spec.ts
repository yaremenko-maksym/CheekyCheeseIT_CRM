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
    pendingObligations: { findMany: vi.fn(async () => obligations) },
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
          const rows =
            tableName(t) === 'pending_obligations' && patch.status === 'PENDING'
              ? (cfg.revertClaimRows ?? [{ id: SENIOR_OBL_ID }])
              : tableName(t) === 'transactions' && patch.type === undefined
                ? (cfg.mainUpdateRows ?? [{ id: SOURCE_ID }])
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

  return { db: db as never, ops, dbtx }
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

  it('NON_USDT_CURRENCY does NOT block — such rows are outside the ledger terms entirely', async () => {
    // A drop obligation settled in UAH: fundingSource stays null (addendum
    // §1.5), so it is in no ledger term; the revert is ordinary.
    const derivatives = [
      settledDerivativeRow({
        id: DROP_DERIV_ID,
        type: 'PAYOUT_DROP',
        settledAmount: '20000.000000',
        settledCurrency: 'UAH',
        settledSharePercent: 10,
        fundingSource: null,
      }),
    ]
    const obligations = [
      obligationRow({ id: DROP_OBL_ID, sourceTransactionId: DROP_DERIV_ID, status: 'PAID' }),
    ]
    const { db, ops } = makeDouble({ derivatives, obligations })
    const svc = makeTransactionsService({ db })
    stubFindOne(svc)
    const version = computeCascadeVersion(snapshotFrom({ derivatives, obligations }))
    await svc.adminUpdateTransaction(SOURCE_ID, { amount: 2000, cascadeVersion: version }, ADMIN)
    expect(derivativeWrites(ops)).toHaveLength(1)
    expect(derivativeWrites(ops)[0]!.set.type).toBe('DROP_PENDING_PAYOUT')
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

  it('a DROP derivative restores into dropSharePercent instead', async () => {
    const { ops } = await runRevert({
      derivatives: [
        settledDerivativeRow({
          id: DROP_DERIV_ID,
          type: 'PAYOUT_DROP',
          settledSharePercent: 10,
          settledAmount: '100.000000',
          amount: '100.000000',
        }),
      ],
      obligations: [
        obligationRow({
          id: DROP_OBL_ID,
          sourceTransactionId: DROP_DERIV_ID,
          status: 'PAID',
          amount: '100.000000',
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
