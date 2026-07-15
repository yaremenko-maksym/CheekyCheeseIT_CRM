import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { PendingSettlementService } from './pending-settlement.service'
import { computeCompanyAccountBalanceFromLedger } from './company-account-balance'
import {
  companyAccount,
  pendingObligations,
  projects,
  transactions,
  users,
} from '../database/schema'
import * as schema from '../database/schema'

/**
 * task-senior-settle-owner — REAL-DB integration proving the owner / funding
 * selection on a senior IOU settlement (the SAME pay-time choice as a SALARY):
 *
 *   - COMPANY_ACCOUNT → the closing SENIOR_INCOME carries
 *     fundingSource=COMPANY_ACCOUNT (USDT) → the ledger DEBITS the company
 *     account by the senior share. The obligation flips PENDING→PAID.
 *   - ADMIN_PERSONAL  → senderId = the chosen ADMIN partner, NO company-account
 *     marker → the company balance is UNCHANGED. Currency follows the choice.
 *
 * Plus the money invariants that must NOT regress versus the obligation-id path:
 *   - idempotency: a second settle of the SAME source tx → 404, no second payout.
 *   - RBAC: SENIOR / DROP → 403 (gate before any money / lookup).
 *
 * The DB, the obligation, the settle cascade and the balance derivation are ALL
 * real. Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- senior-settle-owner.integration
 */

const PREFIX = 'cb440000-0000-4000'

const SENIOR: SessionUser = {
  id: `${PREFIX}-bb00-000000000001`,
  email: 'sso-senior@test.spec',
  displayName: 'SSO Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const ADMIN: SessionUser = {
  ...SENIOR,
  id: `${PREFIX}-bb00-000000000002`,
  email: 'sso-admin@test.spec',
  displayName: 'SSO Admin',
  role: 'ADMIN',
}
const ACCOUNTANT: SessionUser = {
  ...SENIOR,
  id: `${PREFIX}-bb00-000000000003`,
  email: 'sso-accountant@test.spec',
  displayName: 'SSO Accountant',
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
}
const DROP: SessionUser = {
  ...SENIOR,
  id: `${PREFIX}-bb00-000000000004`,
  email: 'sso-drop@test.spec',
  displayName: 'SSO Drop',
  role: 'DROP',
}

const ALL_USERS = [SENIOR, ADMIN, ACCOUNTANT, DROP]
const ALL_USER_IDS = ALL_USERS.map((u) => u.id)
const PROJECT_ID = `${PREFIX}-dd00-000000000001`
const ACCOUNT_ID = `${PREFIX}-cc00-000000000001`
const SOURCE_TX_ID = `${PREFIX}-ee00-000000000001`
const OBLIGATION_ID = `${PREFIX}-ff00-000000000001`
const DEPOSIT_ID = `${PREFIX}-aa00-000000000001`
// code-review PR #381 (MED — omitted-currency defaulting tested for SENIOR
// only, not DROP): a second source IOU + obligation pair, this time a
// DROP_PENDING_PAYOUT owed to DROP (mirrors bookCompanyObligations' drop
// branch in transactions.service.ts).
const DROP_SOURCE_TX_ID = `${PREFIX}-ee00-000000000002`
const DROP_OBLIGATION_ID = `${PREFIX}-ff00-000000000002`
// task-receipts-backend (review round 1): settleByCompany now requires a
// mandatory receipt whenever `funding` is supplied — orthogonal to the
// owner/funding-selection behavior this spec exercises.
const EXPLORER_RECEIPT = { receiptExternalUrl: 'https://etherscan.io/tx/0xseniorsettleownerspec' }
const FILE_RECEIPT = { receiptExternalUrl: 'https://drive.google.com/file/seniorsettleownerspec' }

const SENIOR_SHARE = '260'
const DROP_SHARE = '140'

const stubInvoices = {
  autoCreateForSeniorPayout: () => Promise.resolve(),
} as never

let _pool: Pool | null = null
let dbAvailable = true

@Global()
@Module({
  providers: [
    {
      provide: DatabaseService,
      useFactory: (): DatabaseService => {
        _pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
        const db = drizzle(_pool, { schema })
        const instance = Object.create(DatabaseService.prototype) as DatabaseService
        Object.assign(instance, { pool: _pool, db })
        Object.defineProperty(instance, 'onModuleInit', {
          value: () => Promise.resolve(),
          writable: false,
          enumerable: false,
          configurable: true,
        })
        Object.defineProperty(instance, 'onModuleDestroy', {
          value: () => _pool?.end() ?? Promise.resolve(),
          writable: false,
          enumerable: false,
          configurable: true,
        })
        return instance
      },
    },
  ],
  exports: [DatabaseService],
})
class TestDatabaseModule {}

@Module({
  imports: [TestDatabaseModule],
  providers: [
    {
      provide: PendingSettlementService,
      useFactory: (db: DatabaseService) => new PendingSettlementService(db, stubInvoices),
      inject: [DatabaseService],
    },
  ],
})
class SsoTestModule {}

describe('senior IOU settle — owner / funding selection (real DB)', () => {
  let settleSvc: PendingSettlementService
  let dbSvc: DatabaseService

  async function gateBalance(): Promise<number> {
    return computeCompanyAccountBalanceFromLedger(dbSvc.db)
  }

  // Re-seed the source SENIOR_PENDING_PAYOUT tx + a PENDING COMPANY obligation
  // for it, so each test starts from a clean, payable IOU.
  async function seedPendingIou(): Promise<void> {
    await dbSvc.db
      .delete(pendingObligations)
      .where(eq(pendingObligations.creditorUserId, SENIOR.id))
    await dbSvc.db.delete(transactions).where(inArray(transactions.id, [SOURCE_TX_ID]))
    await dbSvc.db
      .delete(transactions)
      .where(and(eq(transactions.type, 'SENIOR_INCOME'), eq(transactions.receiverId, SENIOR.id)))

    await dbSvc.db.insert(transactions).values({
      id: SOURCE_TX_ID,
      type: 'SENIOR_PENDING_PAYOUT',
      status: 'PENDING_PAYMENT',
      amount: SENIOR_SHARE,
      currency: 'USDT',
      senderId: null,
      senderLabel: 'COMPANY',
      receiverId: SENIOR.id,
      recipientId: SENIOR.id,
      projectId: PROJECT_ID,
      createdBy: ADMIN.id,
    })
    await dbSvc.db.insert(pendingObligations).values({
      id: OBLIGATION_ID,
      creditorUserId: SENIOR.id,
      debtorType: 'COMPANY',
      debtorUserId: null,
      sourceTransactionId: SOURCE_TX_ID,
      amount: SENIOR_SHARE,
      currency: 'USDT',
      status: 'PENDING',
    })
  }

  // Mirror of seedPendingIou for the DROP side (code-review PR #381) — a
  // DROP_PENDING_PAYOUT source tx + PENDING COMPANY obligation owed to DROP,
  // shaped exactly like bookCompanyObligations' drop branch
  // (transactions.service.ts): receiverId/recipientId = drop,
  // dropSharePercent snapshot instead of seniorSharePercent.
  async function seedPendingDropIou(): Promise<void> {
    await dbSvc.db.delete(pendingObligations).where(eq(pendingObligations.creditorUserId, DROP.id))
    await dbSvc.db.delete(transactions).where(inArray(transactions.id, [DROP_SOURCE_TX_ID]))
    await dbSvc.db
      .delete(transactions)
      .where(and(eq(transactions.type, 'PAYOUT_DROP'), eq(transactions.receiverId, DROP.id)))

    await dbSvc.db.insert(transactions).values({
      id: DROP_SOURCE_TX_ID,
      type: 'DROP_PENDING_PAYOUT',
      status: 'PENDING_PAYMENT',
      amount: DROP_SHARE,
      currency: 'USDT',
      senderId: null,
      senderLabel: 'COMPANY',
      receiverId: DROP.id,
      recipientId: DROP.id,
      projectId: PROJECT_ID,
      dropSharePercent: 10,
      dropSharePercentSource: 'USER_DEFAULT',
      createdBy: ADMIN.id,
    })
    await dbSvc.db.insert(pendingObligations).values({
      id: DROP_OBLIGATION_ID,
      creditorUserId: DROP.id,
      debtorType: 'COMPANY',
      debtorUserId: null,
      sourceTransactionId: DROP_SOURCE_TX_ID,
      amount: DROP_SHARE,
      currency: 'USDT',
      status: 'PENDING',
    })
  }

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      const check = await probe.query(
        `SELECT table_name FROM information_schema.tables WHERE table_name='pending_obligations' LIMIT 1`,
      )
      await probe.end()
      if (check.rowCount === 0) {
        console.warn('[senior-settle-owner] SKIPPED — pending_obligations not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[senior-settle-owner] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({ imports: [SsoTestModule] }).compile()
    await moduleRef.init()
    settleSvc = moduleRef.get(PendingSettlementService)
    dbSvc = moduleRef.get(DatabaseService)

    const db = dbSvc.db
    await db
      .delete(pendingObligations)
      .where(inArray(pendingObligations.creditorUserId, [SENIOR.id, DROP.id]))
    await db.delete(transactions).where(inArray(transactions.createdBy, ALL_USER_IDS))
    await db.delete(transactions).where(inArray(transactions.receiverId, ALL_USER_IDS))
    await db
      .delete(transactions)
      .where(inArray(transactions.id, [SOURCE_TX_ID, DROP_SOURCE_TX_ID, DEPOSIT_ID]))
    await db.delete(projects).where(eq(projects.id, PROJECT_ID))
    await db.delete(users).where(inArray(users.id, ALL_USER_IDS))

    await db
      .insert(users)
      .values(
        ALL_USERS.map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          seniorSharePercent: u.seniorSharePercent,
          googleId: `test-google-${u.id}`,
        })),
      )
      .onConflictDoNothing()

    await db
      .insert(projects)
      .values({
        id: PROJECT_ID,
        name: 'SSO Project',
        companyName: 'SSO Corp',
        domain: 'fintech',
        startDate: new Date('2025-01-01'),
        seniorId: SENIOR.id,
        dropId: null,
        currency: 'USDT',
        rate: 1000,
      })
      .onConflictDoNothing()

    // Company account row + a large COMPANY_DEPOSIT so a COMPANY_ACCOUNT settle
    // passes the balance gate.
    const existing = await db.query.companyAccount.findFirst()
    if (!existing) {
      await db.insert(companyAccount).values({
        id: ACCOUNT_ID,
        walletAddress: '0xC0FFEE0000000000000000000000000000000abc',
        confirmationThreshold: 12,
        updatedBy: ADMIN.id,
      })
    }
    await db.delete(transactions).where(eq(transactions.id, DEPOSIT_ID))
    await db.insert(transactions).values({
      id: DEPOSIT_ID,
      type: 'COMPANY_DEPOSIT',
      status: 'PAID',
      amount: '100000',
      currency: 'USDT',
      createdBy: ADMIN.id,
    })
  }, 30_000)

  beforeEach(async () => {
    if (!dbAvailable) return
    await seedPendingIou()
  })

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      await dbSvc.db
        .delete(pendingObligations)
        .where(inArray(pendingObligations.creditorUserId, [SENIOR.id, DROP.id]))
      await dbSvc.db.delete(transactions).where(inArray(transactions.createdBy, ALL_USER_IDS))
      await dbSvc.db.delete(transactions).where(inArray(transactions.receiverId, ALL_USER_IDS))
      await dbSvc.db
        .delete(transactions)
        .where(inArray(transactions.id, [SOURCE_TX_ID, DROP_SOURCE_TX_ID, DEPOSIT_ID]))
      await dbSvc.db.delete(projects).where(eq(projects.id, PROJECT_ID))
      await dbSvc.db.delete(users).where(inArray(users.id, ALL_USER_IDS))
    } catch {
      // non-fatal
    }
    await _pool?.end()
  }, 15_000)

  async function seniorIncomeRow() {
    return dbSvc.db.query.transactions.findFirst({
      where: and(eq(transactions.type, 'SENIOR_INCOME'), eq(transactions.receiverId, SENIOR.id)),
    })
  }

  it('COMPANY_ACCOUNT → company debited by senior share; SENIOR_INCOME(COMPANY_ACCOUNT, USDT, no sender)', async () => {
    if (!dbAvailable) return
    const before = await gateBalance()

    const result = await settleSvc.settleByCompanySourceTransaction(SOURCE_TX_ID, ACCOUNTANT, {
      fundingSource: 'COMPANY_ACCOUNT',
      currency: 'USDT',
      ...EXPLORER_RECEIPT,
    })
    expect(result.obligation.status).toBe('PAID')

    const row = await seniorIncomeRow()
    expect(row).toBeTruthy()
    expect(row!.status).toBe('PAID')
    expect(row!.fundingSource).toBe('COMPANY_ACCOUNT')
    expect(row!.currency).toBe('USDT')
    expect(row!.senderId).toBeNull()
    expect(parseFloat(row!.amount)).toBeCloseTo(parseFloat(SENIOR_SHARE), 6)

    // The ledger SSOT debited the company by exactly the senior share.
    expect(await gateBalance()).toBeCloseTo(before - parseFloat(SENIOR_SHARE), 6)
  })

  it('ADMIN_PERSONAL → senderId=payer, NO company marker, company balance UNCHANGED', async () => {
    if (!dbAvailable) return
    const before = await gateBalance()

    const result = await settleSvc.settleByCompanySourceTransaction(SOURCE_TX_ID, ACCOUNTANT, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN.id,
      currency: 'USD',
      ...FILE_RECEIPT,
    })
    expect(result.obligation.status).toBe('PAID')

    const row = await seniorIncomeRow()
    expect(row).toBeTruthy()
    expect(row!.status).toBe('PAID')
    // No company-account debit marker.
    expect(row!.fundingSource).toBeNull()
    // Sender = the paying admin partner; currency follows the choice.
    expect(row!.senderId).toBe(ADMIN.id)
    expect(row!.currency).toBe('USD')

    // The company account was NOT touched.
    expect(await gateBalance()).toBeCloseTo(before, 6)
  })

  // task-remove-settle-currency (2026-07): the settle dialog no longer sends a
  // `currency` field at all — the backend must default it to the obligation's
  // own currency (always USDT for a senior/drop IOU). Proves the REAL default
  // path (as opposed to the tests above, which pass an explicit currency
  // through the still-supported BIZ-03 safety net) AND that the
  // task-settle-in-place (#379) single-row-flip invariant holds: exactly one
  // SENIOR_INCOME row exists after settle, no phantom second row.
  it('ADMIN_PERSONAL with NO currency in the payload → defaults to USDT; single-row flip preserved (#379)', async () => {
    if (!dbAvailable) return
    const before = await gateBalance()

    const result = await settleSvc.settleByCompanySourceTransaction(SOURCE_TX_ID, ACCOUNTANT, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN.id,
      // No `currency` field — defaults to obligation.currency (USDT), so the
      // mandatory-receipt rule requires an EXPLORER link (not a generic file
      // URL like FILE_RECEIPT, which is only valid for a non-USDT currency).
      ...EXPLORER_RECEIPT,
    })
    expect(result.obligation.status).toBe('PAID')

    const row = await seniorIncomeRow()
    expect(row).toBeTruthy()
    expect(row!.status).toBe('PAID')
    expect(row!.fundingSource).toBeNull()
    expect(row!.senderId).toBe(ADMIN.id)
    // task-remove-settle-currency default — no currency was sent, so it falls
    // back to obligation.currency (USDT), NOT the old ADMIN_PERSONAL "any
    // currency" behaviour.
    expect(row!.currency).toBe('USDT')

    // ADMIN_PERSONAL never touches the shared company account.
    expect(await gateBalance()).toBeCloseTo(before, 6)

    // #379 invariant: the source IOU was flipped IN PLACE — exactly one
    // SENIOR_INCOME row for this settlement, keyed on the SAME id as the
    // source transaction (no second/phantom row inserted).
    const rows = await dbSvc.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.type, 'SENIOR_INCOME'), eq(transactions.receiverId, SENIOR.id)))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(SOURCE_TX_ID)
  })

  // code-review PR #381 (MED — omitted-currency defaulting tested for SENIOR
  // only, not DROP): mirrors the senior test directly above, but settles a
  // DROP_PENDING_PAYOUT obligation instead. Proves the same default path
  // (obligation.currency → USDT), the drop-specific flip target (PAYOUT_DROP,
  // not SENIOR_INCOME — settleByCompany branches on the source IOU type), and
  // the #379 single-row-flip invariant on the DROP side too.
  it('DROP obligation, ADMIN_PERSONAL with NO currency in the payload → PAYOUT_DROP defaults to USDT; single-row flip preserved (#379)', async () => {
    if (!dbAvailable) return
    await seedPendingDropIou()
    const before = await gateBalance()

    const result = await settleSvc.settleByCompanySourceTransaction(DROP_SOURCE_TX_ID, ACCOUNTANT, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN.id,
      // No `currency` field — defaults to obligation.currency (USDT), so the
      // mandatory-receipt rule requires an EXPLORER link.
      ...EXPLORER_RECEIPT,
    })
    expect(result.obligation.status).toBe('PAID')

    const row = await dbSvc.db.query.transactions.findFirst({
      where: and(eq(transactions.type, 'PAYOUT_DROP'), eq(transactions.receiverId, DROP.id)),
    })
    expect(row).toBeTruthy()
    expect(row!.status).toBe('PAID')
    expect(row!.fundingSource).toBeNull()
    expect(row!.senderId).toBe(ADMIN.id)
    // Same default as the senior path — no currency was sent, so it falls
    // back to obligation.currency (USDT).
    expect(row!.currency).toBe('USDT')

    // ADMIN_PERSONAL never touches the shared company account.
    expect(await gateBalance()).toBeCloseTo(before, 6)

    // #379 invariant on the drop side: the source IOU was flipped IN PLACE —
    // exactly one PAYOUT_DROP row for this settlement, keyed on the SAME id
    // as the source transaction.
    const rows = await dbSvc.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.type, 'PAYOUT_DROP'), eq(transactions.receiverId, DROP.id)))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(DROP_SOURCE_TX_ID)
  })

  it('ADMIN_PERSONAL with a non-ADMIN payer → 400, nothing booked', async () => {
    if (!dbAvailable) return
    await expect(
      settleSvc.settleByCompanySourceTransaction(SOURCE_TX_ID, ACCOUNTANT, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: SENIOR.id, // SENIOR, not ADMIN
        currency: 'USD',
      }),
    ).rejects.toThrow()
    expect(await seniorIncomeRow()).toBeFalsy()
  })

  it('idempotent: a repeated settle of the same source tx → 404, exactly one SENIOR_INCOME', async () => {
    if (!dbAvailable) return
    await settleSvc.settleByCompanySourceTransaction(SOURCE_TX_ID, ACCOUNTANT, {
      fundingSource: 'COMPANY_ACCOUNT',
      currency: 'USDT',
      ...EXPLORER_RECEIPT,
    })
    await expect(
      settleSvc.settleByCompanySourceTransaction(SOURCE_TX_ID, ACCOUNTANT, {
        fundingSource: 'COMPANY_ACCOUNT',
        currency: 'USDT',
        ...EXPLORER_RECEIPT,
      }),
    ).rejects.toThrow()

    const rows = await dbSvc.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.type, 'SENIOR_INCOME'), eq(transactions.receiverId, SENIOR.id)))
    expect(rows).toHaveLength(1)
  })

  it('RBAC: SENIOR → 403, nothing booked', async () => {
    if (!dbAvailable) return
    await expect(
      settleSvc.settleByCompanySourceTransaction(SOURCE_TX_ID, SENIOR, {
        fundingSource: 'COMPANY_ACCOUNT',
        currency: 'USDT',
      }),
    ).rejects.toThrow()
    expect(await seniorIncomeRow()).toBeFalsy()
  })

  it('RBAC: DROP → 403, nothing booked', async () => {
    if (!dbAvailable) return
    await expect(
      settleSvc.settleByCompanySourceTransaction(SOURCE_TX_ID, DROP, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN.id,
        currency: 'USD',
      }),
    ).rejects.toThrow()
    expect(await seniorIncomeRow()).toBeFalsy()
  })
})
