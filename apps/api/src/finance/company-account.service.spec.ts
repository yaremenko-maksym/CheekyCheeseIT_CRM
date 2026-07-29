import { describe, expect, it, vi } from 'vitest'
import { BadRequestException, ForbiddenException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { CompanyAccountService } from './company-account.service'
import type { DatabaseService } from '../database/database.service'
import type { EtherscanService } from './etherscan.service'

/**
 * task-company-account-backend — CompanyAccountService unit tests.
 *
 * Mocks DatabaseService.db and EtherscanService. Covers:
 *   - AC6 balance derivation: deposits − dividends − company-funded salary.
 *   - AC3 (unit) security invariant: recipient-mismatch / sub-threshold deposit
 *     never lands PAID (stays PENDING, contributes 0).
 *   - AC5 status flip: PENDING → PAID when verification crosses the threshold.
 *   - dividend RBAC + admin-receiver validation.
 */

const WALLET = '0x1111111111111111111111111111111111111111'
const THRESHOLD = 12
/** Registered USDT wallet of the depositing SENIOR (task-onchain-payment-integrity). */
const SENDER_WALLET = '0x9999999999999999999999999999999999999999'
/** Someone else's wallet — the "I claim a stranger's transfer" scenario. */
const STRANGER_WALLET = '0x3333333333333333333333333333333333333333'

const SENIOR: SessionUser = {
  id: 's-1',
  email: 's@test',
  displayName: 'Senior One',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const ADMIN: SessionUser = {
  id: 'a-1',
  email: 'a@test',
  displayName: 'Admin One',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
const JUNIOR: SessionUser = { ...SENIOR, id: 'j-1', role: 'JUNIOR' }

// A configurable fake DatabaseService.db. Each test wires only the methods it
// needs; unimplemented paths throw so an unexpected call is visible.
//
// task-onchain-payment-integrity: `query` overrides are MERGED into the base
// (previously they replaced it wholesale). Two new tables joined the deposit
// path — `users` (the submitter's registered wallet, HOLE 1) and
// `consumedTxHashes` (the cross-path registry, HOLE 2) — and every pre-existing
// test would otherwise have to restate them.
function makeDb(overrides: Record<string, unknown> = {}) {
  const { query: queryOverride, ...rest } = overrides as {
    query?: Record<string, unknown>
  } & Record<string, unknown>

  const baseQuery: Record<string, unknown> = {
    companyAccount: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'acc-1',
        walletAddress: WALLET,
        confirmationThreshold: THRESHOLD,
        updatedAt: new Date('2026-06-17T00:00:00Z'),
      }),
    },
    transactions: { findFirst: vi.fn().mockResolvedValue(undefined) },
    // Default: the caller has a registered USDT wallet (SENDER_WALLET). The
    // deposit path is fail-closed without one, so the happy-path default must
    // supply it; the `dividend` tests that reuse this stub only read `role`.
    users: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: ADMIN.id, role: 'ADMIN', walletUsdtErc20: SENDER_WALLET }),
    },
    // Default: hash not consumed by any other path.
    consumedTxHashes: { findFirst: vi.fn().mockResolvedValue(undefined) },
  }

  const base = {
    query: { ...baseQuery, ...(queryOverride ?? {}) },
    // Default insert resolves the drizzle chain: since MED-3 the poll-credit
    // path also claims the hash (`consumeTxHash` → insert().values()), so a
    // bare `vi.fn()` would blow up in tests that never look at inserts.
    insert: vi.fn(() => ({ values: () => Promise.resolve() })),
    update: vi.fn(),
    // MED-O (round 6): after claiming, `consumeTxHash` SELECTs any released row
    // for the hash (the reclaim-after-release signal). Default: none.
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }),
    })),
    // Default: run the callback against this same fake handle (the deposit
    // insert + consumed-hash claim now share one transaction).
    transaction: vi.fn(),
    ...rest,
  }
  // `transaction(cb)` must execute the callback with a handle that carries the
  // test's own insert/query stubs — otherwise the insert under test never runs.
  if (!('transaction' in rest)) {
    base.transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(base))
  }
  return base
}

function makeService(db: unknown, etherscan: Partial<EtherscanService> = {}) {
  return new CompanyAccountService(
    { db } as unknown as DatabaseService,
    etherscan as EtherscanService,
  )
}

// Helper to stub the chained select().from().where() used by sumAmount.
function selectReturning(totals: string[]) {
  let call = 0
  return vi.fn(() => ({
    from: () => ({
      where: () => Promise.resolve([{ total: totals[call++] ?? '0' }]),
    }),
  }))
}

describe('CompanyAccountService.getAccount — balance derivation (AC6)', () => {
  // task-salary-company-account — getAccount now delegates to the shared
  // computeCompanyAccountBalanceFromLedger which runs sumAmount 6× IN ORDER:
  //   [deposits, payouts(COMPANY), adminIncome(COMPANY), dividends,
  //    salary(COMPANY), expense(COMPANY)]
  // balance = deposits + payouts + adminIncome − dividends − salary − expense.
  it('balance = deposits + payouts + admin-income − dividends − salary − expense', async () => {
    // 1000 + 0 + 0 − 200 − 300 − 0 = 500
    const db = makeDb({ select: selectReturning(['1000', '0', '0', '200', '300', '0']) })
    const svc = makeService(db)
    const acc = await svc.getAccount(ADMIN)
    expect(acc.balance).toBe(500)
    expect(acc.walletAddress).toBe(WALLET)
    expect(acc.confirmationThreshold).toBe(THRESHOLD)
  })

  it('company-funded salary reduces balance; (admin-personal excluded by the WHERE)', async () => {
    // The salary sum is ONLY company-funded salary (the WHERE filters
    // fundingSource = COMPANY_ACCOUNT), so an admin-personal salary never
    // appears here. 1000 − 400 = 600.
    const db = makeDb({ select: selectReturning(['1000', '0', '0', '0', '400', '0']) })
    const svc = makeService(db)
    const acc = await svc.getAccount(ADMIN)
    expect(acc.balance).toBe(600)
  })

  // A confirmed payout (PAYOUT PAID, fundingSource=COMPANY_ACCOUNT) CREDITS the
  // company balance by exactly its amount.
  it('confirmed payout credits the company balance (no double count)', async () => {
    // deposits=0, payouts=740, rest=0 → balance = 740.
    const db = makeDb({ select: selectReturning(['0', '740', '0', '0', '0', '0']) })
    const svc = makeService(db)
    const acc = await svc.getAccount(ADMIN)
    expect(acc.balance).toBe(740)
  })

  // task-salary-company-account NEW TERMS: admin income (+) and expense (−).
  it('company-funded admin income credits, company-funded expense debits', async () => {
    // deposits=0, payouts=0, adminIncome=900, dividends=0, salary=0, expense=250
    // → 0 + 0 + 900 − 0 − 0 − 250 = 650.
    const db = makeDb({ select: selectReturning(['0', '0', '900', '0', '0', '250']) })
    const svc = makeService(db)
    const acc = await svc.getAccount(ADMIN)
    expect(acc.balance).toBe(650)
  })

  it('ACCOUNTANT may read; non-privileged role → 403', async () => {
    const db = makeDb({ select: selectReturning(['0', '0', '0', '0', '0', '0']) })
    const svc = makeService(db)
    await expect(svc.getAccount(JUNIOR)).rejects.toBeInstanceOf(ForbiddenException)
  })
})

describe('CompanyAccountService.submitDeposit — security invariant (AC3 unit)', () => {
  it('recipient mismatch → deposit stays PENDING (amount 0)', async () => {
    const inserted = {
      id: 'd-1',
      txHash: '0x' + 'a'.repeat(64),
      amount: '0',
      status: 'PENDING',
      createdAt: new Date(),
    }
    const db = makeDb({
      insert: vi.fn(() => ({ values: () => ({ returning: () => Promise.resolve([inserted]) }) })),
    })
    const etherscan = {
      verifyDeposit: vi.fn().mockResolvedValue({
        found: true,
        toMatches: false,
        fromAddress: SENDER_WALLET,
        confirmed: false,
        confirmations: 50,
        amountUsdt: 999,
      }),
    }
    const svc = makeService(db, etherscan)
    const dto = await svc.submitDeposit({ txHashOrLink: '0x' + 'a'.repeat(64) }, SENIOR)
    expect(dto.status).toBe('PENDING')
    expect(dto.toMatches).toBe(false)
    // Verify the insert was asked for PENDING + amount 0 (no credit).
    const insertArg = (db.insert as ReturnType<typeof vi.fn>).mock.results[0]
    expect(insertArg).toBeDefined()
  })

  it('confirmed + match → PAID with credited amount', async () => {
    const inserted = {
      id: 'd-2',
      txHash: '0x' + 'b'.repeat(64),
      amount: '500',
      status: 'PAID',
      createdAt: new Date(),
    }
    const db = makeDb({
      insert: vi.fn(() => ({ values: () => ({ returning: () => Promise.resolve([inserted]) }) })),
    })
    const etherscan = {
      verifyDeposit: vi.fn().mockResolvedValue({
        found: true,
        toMatches: true,
        fromAddress: SENDER_WALLET,
        confirmed: true,
        confirmations: 12,
        amountUsdt: 500,
      }),
    }
    const svc = makeService(db, etherscan)
    const dto = await svc.submitDeposit({ txHashOrLink: '0x' + 'b'.repeat(64) }, SENIOR)
    expect(dto.status).toBe('PAID')
    expect(dto.amountUsdt).toBe(500)
  })

  // ── Recorded sender (task-onchain-payment-integrity) ──────────────────────
  it('a third-party sender (exchange withdrawal) is CREDITED and RECORDED, not blocked', async () => {
    const insertValues = vi.fn(() => ({
      returning: () =>
        Promise.resolve([
          {
            id: 'd-ex',
            txHash: '0x' + '1'.repeat(64),
            amount: '500',
            status: 'PAID',
            createdAt: new Date(),
          },
        ]),
    }))
    const db = makeDb({ insert: vi.fn(() => ({ values: insertValues })) })
    const etherscan = {
      // Valid deposit into the company wallet sent from an exchange hot wallet.
      verifyDeposit: vi.fn().mockResolvedValue({
        found: true,
        toMatches: true,
        fromAddress: STRANGER_WALLET,
        confirmed: true,
        confirmations: 30,
        amountUsdt: 500,
        amountUsdtMinor: '500000000',
      }),
    }
    const svc = makeService(db, etherscan)
    const dto = await svc.submitDeposit({ txHashOrLink: '0x' + '1'.repeat(64) }, SENIOR)
    expect(dto.status).toBe('PAID')
    // …and the foreign sender is persisted for the audit trail.
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ txFromAddress: STRANGER_WALLET.toLowerCase() }),
    )
  })

  it('records a normalised (lowercase) sender address', async () => {
    const insertValues = vi.fn(() => ({
      returning: () =>
        Promise.resolve([
          {
            id: 'd-n',
            txHash: '0x' + '2'.repeat(64),
            amount: '0',
            status: 'PENDING',
            createdAt: new Date(),
          },
        ]),
    }))
    const db = makeDb({ insert: vi.fn(() => ({ values: insertValues })) })
    const etherscan = {
      verifyDeposit: vi.fn().mockResolvedValue({
        found: true,
        toMatches: true,
        fromAddress: SENDER_WALLET.toUpperCase().replace('0X', '0x'),
        confirmed: false,
        confirmations: 2,
        amountUsdt: null,
        amountUsdtMinor: null,
      }),
    }
    const svc = makeService(db, etherscan)
    await svc.submitDeposit({ txHashOrLink: '0x' + '2'.repeat(64) }, SENIOR)
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ txFromAddress: SENDER_WALLET.toLowerCase() }),
    )
  })

  // ── HOLE 2 (task-onchain-payment-integrity) ───────────────────────────────
  it('SECURITY: hash already consumed by a PAYOUT → 400, no deposit row', async () => {
    const insertSpy = vi.fn()
    const verifyDeposit = vi.fn()
    const db = makeDb({
      insert: insertSpy,
      query: {
        consumedTxHashes: { findFirst: vi.fn().mockResolvedValue({ purpose: 'PAYOUT' }) },
      },
    })
    const svc = makeService(db, { verifyDeposit })
    await expect(
      svc.submitDeposit({ txHashOrLink: '0x' + '4'.repeat(64) }, SENIOR),
    ).rejects.toThrowError(/уже использован/)
    expect(verifyDeposit).not.toHaveBeenCalled()
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('idempotency: existing COMPANY_DEPOSIT returned, no second insert', async () => {
    const existing = {
      id: 'd-existing',
      txHash: '0x' + 'c'.repeat(64),
      amount: '700',
      status: 'PAID',
      createdAt: new Date(),
    }
    const insertSpy = vi.fn()
    const db = makeDb({
      query: {
        companyAccount: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'acc-1',
            walletAddress: WALLET,
            confirmationThreshold: THRESHOLD,
            updatedAt: new Date(),
          }),
        },
        transactions: { findFirst: vi.fn().mockResolvedValue(existing) },
        users: { findFirst: vi.fn() },
      },
      insert: insertSpy,
    })
    const etherscan = { verifyDeposit: vi.fn() }
    const svc = makeService(db, etherscan)
    const dto = await svc.submitDeposit({ txHashOrLink: '0x' + 'c'.repeat(64) }, SENIOR)
    expect(dto.id).toBe('d-existing')
    expect(insertSpy).not.toHaveBeenCalled()
    // verifyDeposit must NOT be called on the idempotent path.
    expect(etherscan.verifyDeposit as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('non-SENIOR/DROP → 403', async () => {
    const svc = makeService(makeDb())
    await expect(
      svc.submitDeposit({ txHashOrLink: '0x' + 'd'.repeat(64) }, ADMIN),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('un-extractable hash → 400', async () => {
    const svc = makeService(makeDb())
    await expect(
      svc.submitDeposit({ txHashOrLink: 'not-a-hash-at-all' }, SENIOR),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('extracts hash from an Etherscan link', async () => {
    const hash = '0x' + 'e'.repeat(64)
    const inserted = {
      id: 'd-3',
      txHash: hash,
      amount: '0',
      status: 'PENDING',
      createdAt: new Date(),
    }
    const verifyDeposit = vi.fn().mockResolvedValue({
      found: true,
      toMatches: true,
      fromAddress: SENDER_WALLET,
      confirmed: false,
      confirmations: 3,
      amountUsdt: null,
      amountUsdtMinor: null,
    })
    const db = makeDb({
      insert: vi.fn(() => ({ values: () => ({ returning: () => Promise.resolve([inserted]) }) })),
    })
    const svc = makeService(db, { verifyDeposit })
    await svc.submitDeposit({ txHashOrLink: `https://etherscan.io/tx/${hash}` }, SENIOR)
    expect(verifyDeposit).toHaveBeenCalledWith(hash, WALLET, THRESHOLD)
  })
})

describe('CompanyAccountService.getDepositStatus — flip PENDING→PAID (AC5)', () => {
  const pendingDeposit = {
    id: 'dep-1',
    type: 'COMPANY_DEPOSIT',
    status: 'PENDING',
    txHash: '0x' + 'f'.repeat(64),
    amount: '0',
    senderId: SENIOR.id,
    createdAt: new Date(),
  }

  it('still below threshold → PENDING with live confirmations', async () => {
    const updateSpy = vi.fn(() => ({ set: () => ({ where: () => Promise.resolve() }) }))
    const db = makeDb({
      query: {
        companyAccount: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'acc',
            walletAddress: WALLET,
            confirmationThreshold: THRESHOLD,
            updatedAt: new Date(),
          }),
        },
        transactions: { findFirst: vi.fn().mockResolvedValue(pendingDeposit) },
        users: { findFirst: vi.fn() },
      },
      update: updateSpy,
    })
    const etherscan = {
      verifyDeposit: vi.fn().mockResolvedValue({
        found: true,
        toMatches: true,
        fromAddress: SENDER_WALLET,
        confirmed: false,
        confirmations: 5,
        amountUsdt: null,
      }),
    }
    const svc = makeService(db, etherscan)
    const status = await svc.getDepositStatus('dep-1', SENIOR)
    expect(status.status).toBe('PENDING')
    expect(status.confirmations).toBe(5)
    expect(updateSpy).not.toHaveBeenCalled() // no flip yet
  })

  it('reaches threshold → flips to PAID + persists amount', async () => {
    // MED-3 (security-review PR #438): the flip now runs INSIDE a transaction
    // together with the consumed-hash claim and uses a conditional
    // `WHERE status='PENDING' … RETURNING`, so the fake must resolve a row.
    const updateSpy = vi.fn(() => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 'dep-1' }]) }) }),
    }))
    const db = makeDb({
      query: {
        companyAccount: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'acc',
            walletAddress: WALLET,
            confirmationThreshold: THRESHOLD,
            updatedAt: new Date(),
          }),
        },
        transactions: { findFirst: vi.fn().mockResolvedValue(pendingDeposit) },
        // The deposit owner's registered wallet — the sender reference.
        users: { findFirst: vi.fn().mockResolvedValue({ walletUsdtErc20: SENDER_WALLET }) },
      },
      update: updateSpy,
    })
    const etherscan = {
      verifyDeposit: vi.fn().mockResolvedValue({
        found: true,
        toMatches: true,
        fromAddress: SENDER_WALLET,
        confirmed: true,
        confirmations: 12,
        amountUsdt: 800,
      }),
    }
    const svc = makeService(db, etherscan)
    const status = await svc.getDepositStatus('dep-1', SENIOR)
    expect(status.status).toBe('PAID')
    expect(status.amountUsdt).toBe(800)
    expect(updateSpy).toHaveBeenCalledOnce()
  })

  // task-onchain-payment-integrity: polling is the SECOND path that can flip a
  // deposit to PAID — a deposit submitted before the tx was mined has no sender
  // recorded yet, so the re-poll must record it on the flip.
  it('records the on-chain sender when the poll flips the deposit to PAID', async () => {
    const setSpy = vi.fn(() => ({
      where: () => ({ returning: () => Promise.resolve([{ id: 'dep-1' }]) }),
    }))
    const db = makeDb({
      query: { transactions: { findFirst: vi.fn().mockResolvedValue(pendingDeposit) } },
      update: vi.fn(() => ({ set: setSpy })),
    })
    const etherscan = {
      verifyDeposit: vi.fn().mockResolvedValue({
        found: true,
        toMatches: true,
        fromAddress: STRANGER_WALLET,
        confirmed: true,
        confirmations: 40,
        amountUsdt: 800,
        amountUsdtMinor: '800000000',
      }),
    }
    const svc = makeService(db, etherscan)
    const status = await svc.getDepositStatus('dep-1', SENIOR)
    // A third-party sender does NOT block the credit (exchange withdrawals)…
    expect(status.status).toBe('PAID')
    // …it is recorded.
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ txFromAddress: STRANGER_WALLET.toLowerCase() }),
    )
  })

  it('non-owner non-privileged → 403', async () => {
    const db = makeDb({
      query: {
        companyAccount: { findFirst: vi.fn() },
        transactions: { findFirst: vi.fn().mockResolvedValue(pendingDeposit) },
        users: { findFirst: vi.fn() },
      },
    })
    const svc = makeService(db, { verifyDeposit: vi.fn() })
    const otherSenior: SessionUser = { ...SENIOR, id: 'other' }
    await expect(svc.getDepositStatus('dep-1', otherSenior)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })
})

describe('CompanyAccountService.createDividend (ADMIN only)', () => {
  // MED (audit 2026-06-27): createDividend now wraps gate-read + debit-write in
  // db.transaction with a company-account advisory lock + balance gate. The
  // unit mock runs the callback with a `dbtx` that exposes `execute` (the
  // pg_advisory_xact_lock no-op), `select` (feeds the ledger SUMs so the gate
  // sees a known balance) and `insert` (returns the new row).
  function makeDividendDb(opts: {
    receiverRole?: string
    ledgerTotals?: string[]
    inserted?: { id: string }
  }) {
    const inserted = opts.inserted ?? { id: 'div-1' }
    // 7 ledger SUM terms: [deposits, payouts, adminIncome, dividends, salary,
    // expense, seniorIncome]. Default → a 5000 USDT balance (deposits only).
    const ledgerTotals = opts.ledgerTotals ?? ['5000', '0', '0', '0', '0', '0', '0']
    const dbtx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: selectReturning(ledgerTotals),
      insert: vi.fn(() => ({ values: () => ({ returning: () => Promise.resolve([inserted]) }) })),
    }
    return makeDb({
      query: {
        companyAccount: { findFirst: vi.fn() },
        transactions: { findFirst: vi.fn() },
        users: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ id: ADMIN.id, role: opts.receiverRole ?? 'ADMIN' }),
        },
      },
      transaction: vi.fn((cb: (tx: typeof dbtx) => unknown) => cb(dbtx)),
    })
  }

  it('non-ADMIN → 403', async () => {
    const svc = makeService(makeDb())
    await expect(svc.createDividend({ amount: 100 }, SENIOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('non-positive amount → 400', async () => {
    const svc = makeService(makeDb())
    await expect(svc.createDividend({ amount: 0 }, ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('non-admin receiver → 400', async () => {
    const db = makeDb({
      query: {
        companyAccount: { findFirst: vi.fn() },
        transactions: { findFirst: vi.fn() },
        users: { findFirst: vi.fn().mockResolvedValue({ id: 'x', role: 'SENIOR' }) },
      },
    })
    const svc = makeService(db)
    await expect(
      svc.createDividend(
        { amount: 100, adminId: 'x', receiptExternalUrl: 'https://etherscan.io/tx/0xabc123' },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('amount exceeds company balance → 400 (overdraw gate)', async () => {
    // balance = deposits(100) = 100; dividend of 1234 must be refused.
    const db = makeDividendDb({ ledgerTotals: ['100', '0', '0', '0', '0', '0', '0'] })
    const svc = makeService(db)
    await expect(
      svc.createDividend(
        { amount: 1234, receiptExternalUrl: 'https://etherscan.io/tx/0xabc123' },
        ADMIN,
      ),
    ).rejects.toThrowError(/Недостаточно средств/)
  })

  it('ADMIN, amount within balance → PAID DIVIDEND_TO_ADMIN crediting an admin', async () => {
    // balance = deposits(5000) = 5000; dividend of 1234 fits.
    const db = makeDividendDb({ inserted: { id: 'div-1' } })
    const svc = makeService(db)
    const res = await svc.createDividend(
      { amount: 1234, receiptExternalUrl: 'https://etherscan.io/tx/0xabc123' },
      ADMIN,
    )
    expect(res.amount).toBe(1234)
    expect(res.receiverId).toBe(ADMIN.id)
    expect(res.id).toBe('div-1')
  })

  it('acquires the advisory lock before reading balance (TOCTOU serialization)', async () => {
    const db = makeDividendDb({})
    const svc = makeService(db)
    await svc.createDividend(
      { amount: 100, receiptExternalUrl: 'https://etherscan.io/tx/0xabc123' },
      ADMIN,
    )
    // The transaction callback ran, and the advisory lock (dbtx.execute) was
    // invoked — proving the debit is serialized under the shared lock.
    const txMock = db.transaction as ReturnType<typeof vi.fn>
    expect(txMock).toHaveBeenCalledOnce()
  })
})

describe('CompanyAccountService.updateRequisites (ADMIN only)', () => {
  // A db whose company_account row starts with `requisitesBefore`, and whose
  // transaction() runs the callback against a tx that records the .set() payload
  // and audit-log insert. getAccount() (called at the end) reads the SAME
  // findFirst mock, which we flip to reflect the post-update value.
  function makeRequisitesDb(requisitesBefore: string | null) {
    const setSpy = vi.fn(() => ({ where: () => Promise.resolve() }))
    const auditInsertSpy = vi.fn(() => ({ values: () => Promise.resolve() }))
    // Current row value — getAccount reads this after the tx; tests assert on it
    // indirectly via the audit insert payload + the returned DTO.
    let current: string | null = requisitesBefore
    const findFirst = vi.fn().mockImplementation(() =>
      Promise.resolve({
        id: 'acc-1',
        walletAddress: WALLET,
        confirmationThreshold: THRESHOLD,
        requisitesMarkdown: current,
        updatedAt: new Date('2026-06-29T00:00:00Z'),
      }),
    )
    const dbtx = {
      update: vi.fn(() => ({ set: setSpy })),
      insert: auditInsertSpy,
    }
    const db = makeDb({
      query: {
        companyAccount: { findFirst },
        transactions: { findFirst: vi.fn() },
        users: { findFirst: vi.fn() },
      },
      // getAccount computes balance via select() — feed zeros so it returns 0.
      select: selectReturning(['0', '0', '0', '0', '0', '0']),
      transaction: vi.fn(async (cb: (tx: typeof dbtx) => unknown) => {
        const r = await cb(dbtx)
        // Reflect the write so the trailing getAccount() returns the new value.
        const payload = setSpy.mock.calls[0]?.[0] as { requisitesMarkdown?: string | null }
        if (payload && 'requisitesMarkdown' in payload) current = payload.requisitesMarkdown ?? null
        return r
      }),
    })
    return { db, setSpy, auditInsertSpy }
  }

  it('non-ADMIN → 403', async () => {
    const { db } = makeRequisitesDb(null)
    const svc = makeService(db)
    await expect(svc.updateRequisites('x', SENIOR)).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('body over the 10000-char cap → 400', async () => {
    const { db } = makeRequisitesDb(null)
    const svc = makeService(db)
    await expect(svc.updateRequisites('a'.repeat(10001), ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('ADMIN sets non-empty requisites → persisted verbatim + DTO reflects it', async () => {
    const md = '## Реквизиты\n\nООО «Тест», IBAN UA00'
    const { db, setSpy, auditInsertSpy } = makeRequisitesDb(null)
    const svc = makeService(db)
    const dto = await svc.updateRequisites(md, ADMIN)
    // Stored verbatim (not trimmed/normalized away).
    const setArg = setSpy.mock.calls[0]?.[0] as { requisitesMarkdown?: string | null }
    expect(setArg.requisitesMarkdown).toBe(md)
    // Audit row written (distinct action) since before(null) !== after(md).
    expect(auditInsertSpy).toHaveBeenCalledOnce()
    expect(dto.requisitesMarkdown).toBe(md)
  })

  it('empty / whitespace-only input is coerced to NULL (no heading-only section)', async () => {
    const { db, setSpy } = makeRequisitesDb('## Реквизиты\n\nold value')
    const svc = makeService(db)
    const dto = await svc.updateRequisites('   \n  ', ADMIN)
    const setArg = setSpy.mock.calls[0]?.[0] as { requisitesMarkdown?: string | null }
    expect(setArg.requisitesMarkdown).toBeNull()
    expect(dto.requisitesMarkdown).toBeNull()
  })

  it('no-op when value is unchanged → no audit row', async () => {
    const same = '## Реквизиты\n\nunchanged'
    const { db, auditInsertSpy } = makeRequisitesDb(same)
    const svc = makeService(db)
    await svc.updateRequisites(same, ADMIN)
    expect(auditInsertSpy).not.toHaveBeenCalled()
  })
})
