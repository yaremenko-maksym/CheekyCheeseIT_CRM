/**
 * task-cascade-resolver-preview (task 2 of the paid-transaction-edit-cascade
 * decomposition) — UNIT-level double for `getEditCascadePreview` /
 * `loadCascadeSnapshot` (`transactions.service.ts`).
 *
 * WHY THIS FILE EXISTS ALONGSIDE `cascade-edit-preview.integration.spec.ts`:
 * the mutation gate (`scripts/devops/mutation-gate.mjs`) drives Stryker
 * against the UNIT suite only — `apps/api/vitest.config.mts` structurally
 * excludes every `*.integration.spec.ts` from a non-integration run, so
 * Stryker never even sees that file exist (see
 * `.claude/rules/common/mutation-gate-integration-specs.md`). Without a unit
 * double, `loadCascadeSnapshot`'s row→snapshot mapping and every branch of
 * `getEditCascadePreview` are invisible to the gate — every mutant there
 * would report `NoCoverage`/`Survived` regardless of how good the real-DB
 * integration coverage is. The integration spec keeps verifying the real
 * thing against real Postgres; THIS file is what makes the gate able to see
 * the line at all. Neither replaces the other — same AC8/AC9 behaviour,
 * proven twice, for two different reasons.
 *
 * Mocking convention follows `archived-money-out.unit.spec.ts`: a `makeDb()`
 * double built from `vi.fn()` query stubs, passed to
 * `makeTransactionsService({ db: makeDb(...) })`. Every stub that should
 * never be reached on a given branch is wired to THROW instead of silently
 * resolving — a removed early-return does not quietly pass, it reaches a
 * query that fails loudly.
 */
import { describe, expect, it, vi } from 'vitest'
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { resolveEditCascade, computeCascadeVersion, type CascadeSnapshot } from '@crm/shared'

import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { TransactionsController } from './transactions.controller'
import type { TransactionsService } from './transactions.service'

const ADMIN: SessionUser = {
  id: '11111111-0000-4000-aa00-000000000001',
  email: 'cascade-preview-unit-admin@test.spec',
  displayName: 'Admin A',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
const SENIOR: SessionUser = { ...ADMIN, role: 'SENIOR' }

const SOURCE_ID = '22222222-0000-4000-bb00-000000000001'
const SENIOR_DERIV_ID = '33333333-0000-4000-8c00-000000000001'
const DROP_DERIV_ID = '33333333-0000-4000-8c00-000000000002'
const SENIOR_OBL_ID = '44444444-0000-4000-8d00-000000000001'
const DROP_OBL_ID = '44444444-0000-4000-8d00-000000000002'

const T_SOURCE = new Date('2026-08-01T00:00:00.000Z')
const T_SENIOR_DERIV = new Date('2026-08-02T00:00:00.000Z')
const T_DROP_DERIV = new Date('2026-08-03T00:00:00.000Z')
const T_SENIOR_OBL = new Date('2026-08-02T00:00:00.000Z')
const T_DROP_OBL = new Date('2026-08-03T00:00:00.000Z')

/** A throwing stub for a query path a given test asserts is NEVER reached. */
function unreachable(label: string) {
  return vi.fn().mockRejectedValue(new Error(`DB QUERY REACHED — ${label} should not run here`))
}

/**
 * Builds the DB double `getEditCascadePreview` reads through. `findFirstImpl`
 * lets a test control the TWO separate `transactions.findFirst` calls
 * (`fetchWritableTransactionOrThrow`'s visibility read, then
 * `loadCascadeSnapshot`'s own read) independently via `mockResolvedValueOnce`.
 */
function makeDb(opts: {
  findFirstImpl: ReturnType<typeof vi.fn>
  findManyDerivatives?: ReturnType<typeof vi.fn>
  findManyObligations?: ReturnType<typeof vi.fn>
  findManySignatures?: ReturnType<typeof vi.fn>
}) {
  return {
    db: {
      query: {
        transactions: {
          findFirst: opts.findFirstImpl,
          findMany: opts.findManyDerivatives ?? unreachable('transactions.findMany'),
        },
        pendingObligations: {
          findMany: opts.findManyObligations ?? unreachable('pendingObligations.findMany'),
        },
        invoiceSignatures: {
          findMany: opts.findManySignatures ?? unreachable('invoiceSignatures.findMany'),
        },
      },
    },
  } as never
}

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
    // MED-1 (security-review round 1) — `loadCascadeSnapshot` now reads these
    // off the SOURCE row too (a SALARY source can carry its own signed
    // invoice / originalAmount). `null` here is the common case.
    originalAmount: null,
    ...overrides,
  }
}

describe('getEditCascadePreview — RBAC', () => {
  it('non-ADMIN → ForbiddenException BEFORE any DB query runs', async () => {
    const svc = makeTransactionsService({
      db: makeDb({ findFirstImpl: unreachable('transactions.findFirst') }),
    })
    await expect(svc.getEditCascadePreview(SOURCE_ID, 2000, SENIOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })
})

describe('getEditCascadePreview — 404 paths', () => {
  it('nonexistent id → NotFoundException, loadCascadeSnapshot never runs', async () => {
    const findFirstImpl = vi.fn().mockResolvedValue(undefined)
    const svc = makeTransactionsService({ db: makeDb({ findFirstImpl }) })
    await expect(svc.getEditCascadePreview(SOURCE_ID, 2000, ADMIN)).rejects.toBeInstanceOf(
      NotFoundException,
    )
  })

  it('race defense: tx exists at the visibility read but vanishes before loadCascadeSnapshot re-reads it', async () => {
    // First call = fetchWritableTransactionOrThrow's read (row exists).
    // Second call = loadCascadeSnapshot's OWN `db.query.transactions.findFirst`
    // (returns undefined) — this is the ONLY way to reach the dedicated
    // `throw new NotFoundException('Transaction not found')` guard.
    const findFirstImpl = vi
      .fn()
      .mockResolvedValueOnce(sourceRow())
      .mockResolvedValueOnce(undefined)
    const svc = makeTransactionsService({ db: makeDb({ findFirstImpl }) })
    await expect(svc.getEditCascadePreview(SOURCE_ID, 2000, ADMIN)).rejects.toThrow(
      'Transaction not found',
    )
  })
})

describe('getEditCascadePreview — guards 1 and 2 (blocked in the PLAN, loadCascadeSnapshot never runs)', () => {
  it.each(['PAYOUT', 'PAYOUT_ADMIN', 'PAYOUT_CONFIRMED'])(
    '%s → editable false, blockedReason PAYOUT_FAMILY',
    async (type) => {
      const findFirstImpl = vi.fn().mockResolvedValue(sourceRow({ type }))
      const svc = makeTransactionsService({ db: makeDb({ findFirstImpl }) })
      const result = await svc.getEditCascadePreview(SOURCE_ID, 2000, ADMIN)
      expect(result).toEqual({
        editable: false,
        blockedReason: 'PAYOUT_FAMILY',
        plan: null,
        version: null,
      })
    },
  )

  it('a row carrying payoutRequestId → editable false, blockedReason LINKED_TO_PAYOUT_REQUEST', async () => {
    const findFirstImpl = vi
      .fn()
      .mockResolvedValue(sourceRow({ type: 'SENIOR_INCOME', payoutRequestId: 'req-1' }))
    const svc = makeTransactionsService({ db: makeDb({ findFirstImpl }) })
    const result = await svc.getEditCascadePreview(SOURCE_ID, 2000, ADMIN)
    expect(result).toEqual({
      editable: false,
      blockedReason: 'LINKED_TO_PAYOUT_REQUEST',
      plan: null,
      version: null,
    })
  })
})

describe('getEditCascadePreview — no derivatives', () => {
  it('still queries obligations (AC13 needs the SOURCE row own closure) and the source signature (MED-1)', async () => {
    const findFirstImpl = vi.fn().mockResolvedValue(sourceRow())
    const findManyDerivatives = vi.fn().mockResolvedValue([])
    // task-cascade-apply (AC13): the obligations query is NO LONGER skippable
    // at zero derivatives. The edited row can ITSELF be a closed obligation
    // (a flipped SENIOR_INCOME), and refusing to edit such a row needs that
    // fact — so `sourceId` joined the same `inArray` filter rather than
    // earning a second round-trip.
    const findManyObligations = vi.fn().mockResolvedValue([])
    // MED-1 (security-review round 1): unlike `obligationRows`, the
    // signatures query is NO LONGER skippable at zero derivatives — it is
    // also how the SOURCE row's own `hasSignedInvoice` gets read (folded
    // into the same `inArray`, see `signatureQueryIds` in
    // `transactions.service.ts`).
    const findManySignatures = vi.fn().mockResolvedValue([])
    const svc = makeTransactionsService({
      db: makeDb({ findFirstImpl, findManyDerivatives, findManyObligations, findManySignatures }),
    })
    const result = await svc.getEditCascadePreview(SOURCE_ID, 2000, ADMIN)
    expect(result.editable).toBe(true)
    expect(result.blockedReason).toBeNull()
    expect(result.plan!.derivatives).toEqual([])
    expect(result.plan!.sourceAmountChanged).toBe(true)
    expect(findManyDerivatives).toHaveBeenCalledTimes(1)
    expect(findManySignatures).toHaveBeenCalledTimes(1)
    // The query still ran ONLY for the source id — not a query the
    // zero-derivative branch quietly widens.
    expect(findManySignatures.mock.calls[0]![0]).toHaveProperty('where')
  })

  it('flags the source as signed when the (only) row in the signatures query result IS the source id', async () => {
    const findFirstImpl = vi.fn().mockResolvedValue(sourceRow())
    const findManyDerivatives = vi.fn().mockResolvedValue([])
    const findManyObligations = vi.fn().mockResolvedValue([])
    const findManySignatures = vi
      .fn()
      .mockResolvedValue([{ transactionId: SOURCE_ID, signerRole: 'COUNTERPARTY' }])
    const svc = makeTransactionsService({
      db: makeDb({ findFirstImpl, findManyDerivatives, findManyObligations, findManySignatures }),
    })
    const result = await svc.getEditCascadePreview(SOURCE_ID, 2000, ADMIN)
    expect(result.plan!.sourceWarnings).toEqual([
      { code: 'SOURCE_SIGNED_INVOICE', message: expect.any(String) },
    ])
  })

  it('flags SOURCE_ORIGINAL_AMOUNT_SET when the source row itself carries originalAmount', async () => {
    const findFirstImpl = vi.fn().mockResolvedValue(sourceRow({ originalAmount: '800.000000' }))
    const findManyDerivatives = vi.fn().mockResolvedValue([])
    const findManyObligations = vi.fn().mockResolvedValue([])
    const findManySignatures = vi.fn().mockResolvedValue([])
    const svc = makeTransactionsService({
      db: makeDb({ findFirstImpl, findManyDerivatives, findManyObligations, findManySignatures }),
    })
    const result = await svc.getEditCascadePreview(SOURCE_ID, 2000, ADMIN)
    expect(result.plan!.sourceWarnings).toEqual([
      { code: 'SOURCE_ORIGINAL_AMOUNT_SET', message: expect.stringContaining('800') },
    ])
  })
})

describe('getEditCascadePreview — full row→snapshot mapping (loadCascadeSnapshot), end to end', () => {
  it('maps every field of every row shape correctly — pinned against resolveEditCascade/computeCascadeVersion run on a HAND-BUILT snapshot', async () => {
    const findFirstImpl = vi.fn().mockResolvedValue(sourceRow())
    // Two derivative rows, deliberately exercising DIFFERENT branches each:
    //   senior: still PENDING_PAYMENT, sharePercent taken from
    //     seniorSharePercent (dropSharePercent null), settledAmount/settled*
    //     all null, NOT signed.
    //   drop: already flipped to PAID, sharePercent must fall through the
    //     `??` chain to dropSharePercent (seniorSharePercent null on a
    //     flipped row), settledAmount/settledCurrency/settledSharePercent
    //     all populated, IS signed (present in signatureRows).
    const findManyDerivatives = vi.fn().mockResolvedValue([
      {
        id: SENIOR_DERIV_ID,
        type: 'SENIOR_PENDING_PAYOUT',
        status: 'PENDING_PAYMENT',
        amount: '260.000000',
        currency: 'USDT',
        updatedAt: T_SENIOR_DERIV,
        seniorSharePercent: 26,
        dropSharePercent: null,
        settledAmount: null,
        settledCurrency: null,
        settledSharePercent: null,
      },
      {
        id: DROP_DERIV_ID,
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '50.000000',
        currency: 'UAH',
        updatedAt: T_DROP_DERIV,
        seniorSharePercent: null,
        dropSharePercent: 5,
        settledAmount: '50.000000',
        settledCurrency: 'UAH',
        settledSharePercent: 5,
      },
    ])
    const findManyObligations = vi.fn().mockResolvedValue([
      {
        id: SENIOR_OBL_ID,
        sourceTransactionId: SENIOR_DERIV_ID,
        status: 'PENDING',
        amount: '260.000000',
        updatedAt: T_SENIOR_OBL,
      },
      {
        id: DROP_OBL_ID,
        sourceTransactionId: DROP_DERIV_ID,
        status: 'PAID',
        amount: '50.000000',
        updatedAt: T_DROP_OBL,
      },
    ])
    // Only the DROP derivative carries a signature — proves the mapping does
    // NOT flag the senior row too (a `.some()`/broad-match mutant would).
    const findManySignatures = vi
      .fn()
      .mockResolvedValue([{ transactionId: DROP_DERIV_ID, signerRole: 'COUNTERPARTY' }])
    const svc = makeTransactionsService({
      db: makeDb({ findFirstImpl, findManyDerivatives, findManyObligations, findManySignatures }),
    })

    const result = await svc.getEditCascadePreview(SOURCE_ID, 2000, ADMIN)

    // The snapshot `loadCascadeSnapshot` SHOULD have built from the rows
    // above, constructed BY HAND from the same mock data (not read back from
    // the service) — an independent expectation, not a tautology.
    const expectedSnapshot: CascadeSnapshot = {
      source: {
        id: SOURCE_ID,
        type: 'ADMIN_INCOME',
        status: 'PAID',
        amount: 1000,
        currency: 'USDT',
        payoutRequestId: null,
        updatedAt: T_SOURCE.toISOString(),
        // MED-1: the signature fixture below only tags DROP_DERIV_ID, and
        // `sourceRow()`'s default `originalAmount` is null.
        hasSignedInvoice: false,
        originalAmount: null,
      },
      derivatives: [
        {
          id: SENIOR_DERIV_ID,
          type: 'SENIOR_PENDING_PAYOUT',
          status: 'PENDING_PAYMENT',
          amount: 260,
          currency: 'USDT',
          updatedAt: T_SENIOR_DERIV.toISOString(),
          sharePercent: 26,
          settledAmount: null,
          settledCurrency: null,
          settledSharePercent: null,
          hasSignedInvoice: false,
          obligation: {
            id: SENIOR_OBL_ID,
            status: 'PENDING',
            amount: 260,
            updatedAt: T_SENIOR_OBL.toISOString(),
          },
        },
        {
          id: DROP_DERIV_ID,
          type: 'PAYOUT_DROP',
          status: 'PAID',
          amount: 50,
          currency: 'UAH',
          updatedAt: T_DROP_DERIV.toISOString(),
          sharePercent: 5, // fell through seniorSharePercent(null) ?? dropSharePercent(5)
          settledAmount: 50,
          settledCurrency: 'UAH',
          settledSharePercent: 5,
          hasSignedInvoice: true,
          obligation: {
            id: DROP_OBL_ID,
            status: 'PAID',
            amount: 50,
            updatedAt: T_DROP_OBL.toISOString(),
          },
        },
      ],
    }
    const expectedResponse = {
      editable: true,
      blockedReason: null,
      plan: resolveEditCascade(expectedSnapshot, { amount: 2000 }),
      version: computeCascadeVersion(expectedSnapshot),
    }
    expect(result).toEqual(expectedResponse)
    // Sanity floor so this test cannot pass by accident on two empty plans.
    expect(result.plan!.derivatives).toHaveLength(2)

    // Every query the private `loadCascadeSnapshot` makes carries a `where`
    // filter — a gutted `findFirst({})`/`findMany({})` (dropping the filter
    // entirely, not just narrowing it) is distinguishable THIS way even
    // though a mock that ignores its arguments cannot see a NARROWER filter
    // change (see the Stryker suppressions in transactions.service.ts for
    // the mutants that genuinely require a real Postgres round-trip instead).
    expect(findFirstImpl.mock.calls[1]![0]).toHaveProperty('where')
    expect(findManyDerivatives.mock.calls[0]![0]).toHaveProperty('where')
    expect(findManyObligations.mock.calls[0]![0]).toHaveProperty('where')
    expect(findManySignatures.mock.calls[0]![0]).toHaveProperty('where')
  })
})

describe('loadCascadeSnapshot (private) — settledAmount null-vs-zero mapping', () => {
  it('maps a NULL settled_amount to null, not 0 (transactions.service.ts:3250)', async () => {
    // `resolveDerivative` itself folds a snapshot settledAmount of `null` and
    // of `0` to the IDENTICAL final plan value via `derivative.settledAmount
    // ?? 0` — so a mutant that turns loadCascadeSnapshot's own
    // `!== null ? Number(...) : null` into `true ? Number(...) : null`
    // (`Number(null) === 0`) is invisible through the PUBLIC
    // `getEditCascadePreview` response no matter what fixture is used. The
    // only way to pin this field is to read `loadCascadeSnapshot`'s own
    // return value directly. `private` is a compile-time-only TypeScript
    // annotation (this class has no `#private` fields), so calling it this
    // way is a real method call, not a hack around genuine encapsulation.
    const dbDouble = makeDb({
      findFirstImpl: vi.fn().mockResolvedValue(sourceRow()),
      findManyDerivatives: vi.fn().mockResolvedValue([
        {
          id: SENIOR_DERIV_ID,
          type: 'SENIOR_INCOME',
          status: 'PAID',
          amount: '260.000000',
          currency: 'USDT',
          updatedAt: T_SENIOR_DERIV,
          seniorSharePercent: null,
          dropSharePercent: null,
          settledAmount: null,
          settledCurrency: null,
          settledSharePercent: 26,
        },
      ]),
      findManyObligations: vi.fn().mockResolvedValue([
        {
          id: SENIOR_OBL_ID,
          sourceTransactionId: SENIOR_DERIV_ID,
          status: 'PAID',
          amount: '260.000000',
          updatedAt: T_SENIOR_OBL,
        },
      ]),
      findManySignatures: vi.fn().mockResolvedValue([]),
    })
    const svc = makeTransactionsService({ db: dbDouble }) as unknown as {
      loadCascadeSnapshot: (db: unknown, id: string) => Promise<CascadeSnapshot | null>
    }

    const snapshot = await svc.loadCascadeSnapshot(dbDouble.db, SOURCE_ID)

    expect(snapshot!.derivatives[0]!.settledAmount).toBeNull()
  })
})

describe('TransactionsController.getEditCascadePreview — controller-level wiring', () => {
  it('parses the query and forwards the COERCED amount + id + user to the service, returning its result verbatim', async () => {
    const expectedResult = {
      editable: true,
      blockedReason: null,
      plan: null,
      version: 'v1',
    } as never
    const svcSpy = vi.fn().mockResolvedValue(expectedResult)
    const controller = new TransactionsController({
      getEditCascadePreview: svcSpy,
    } as unknown as TransactionsService)

    const result = await controller.getEditCascadePreview(SOURCE_ID, { amount: '2000' }, ADMIN)

    // `amount` must be the COERCED number 2000, not the raw string '2000' —
    // the query schema's `z.coerce.number()` doing its job.
    expect(svcSpy).toHaveBeenCalledWith(SOURCE_ID, 2000, ADMIN)
    expect(result).toBe(expectedResult)
  })
})
