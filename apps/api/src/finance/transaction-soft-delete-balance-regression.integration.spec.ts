/**
 * Real-DB balance-regression spec for task-soft-delete-and-money-audit (AC4)
 * — the single most consequential AC in the task: "переход с жёсткого
 * удаления на мягкое [не должен] тихо изменит[ь] цифры."
 *
 * Methodology (mirrors the task's own instruction verbatim): for EVERY
 * money-aggregating read-path this task touched, (1) compute the figure —
 * the эталон/baseline, (2) insert a new row that WOULD move that figure,
 * (3) immediately soft-delete it via `adminDeleteTransaction` /
 * `restoreTransaction`'s sibling `svc.adminDeleteTransaction`, (4) recompute
 * and assert it is BYTE-IDENTICAL to the baseline. A soft-deleted row that
 * still counts anywhere would fail step 4 — proving the exclusion holds for
 * that exact code path, not just by inspection.
 *
 * WHY real-DB: several of these are raw SQL aggregates
 * (`company-account-balance.ts`'s `sumAmount`, `getAccountantSummary`'s
 * FILTER (WHERE …) clauses, `admin-summary.service.ts`'s NOT EXISTS
 * correlated subquery) — a mocked `.select()` cannot prove a WHERE clause is
 * actually wired into the generated SQL the way a real Postgres round-trip can.
 *
 * WHAT it covers (one row per function, chosen to be the type that function
 * ACTUALLY reads — see each `it` block's comment):
 *   - TransactionsService.getSummary            (totalIncome)
 *   - TransactionsService.getAccountantSummary  (pendingValidation)
 *   - TransactionsService.getSeniorSummary      (incomeTotal)
 *   - TransactionsService.getDropSelfSummary    (balance)
 *   - BalanceService.getAdminBalance            (dividends)
 *   - BalanceService.getSeniorBalance           (platformIncome)
 *   - BalanceService.getTotalEarned             (SENIOR income)
 *   - computeCompanyAccountBalanceFromLedger    (COMPANY_DEPOSIT term)
 *   - AdminSummaryService.getSummary            (activeTransactions feed +
 *                                                 projectsUnpaidThisMonth)
 *   - TransactionsService.getIncomeComplianceOverview (submittedProjects)
 *   - ProjectsService.findDropOwnProjects       (incomesCount)
 *   - getOwnSalaryStatus                        (helper — MED-5, security-review
 *                                                 PR #456: filtered in code since
 *                                                 the original PR, but had no
 *                                                 dedicated regression proof)
 *
 * DB-SKIP-GUARD:
 *   describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is unset (reports
 *   SKIPPED). A DATABASE_URL that IS set but unusable throws in beforeAll
 *   (reports FAILED). Neither case can look like "passed" with zero assertions.
 *
 * SEED strategy: UUID namespace bd5e0000-* — distinct from other specs.
 * Idempotent inserts; afterAll cleans up in reverse-FK order. Each `it`
 * inserts + deletes its OWN extra row (unique id per test) so tests do not
 * interfere with each other's baseline.
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { transactions, users, projects } from '../database/schema'
import * as schema from '../database/schema'
import type { TransactionsService } from './transactions.service'
import { BalanceService } from './balance.service'
import type { NbuCurrencyService } from './nbu-currency.service'
import { computeCompanyAccountBalanceFromLedger } from './company-account-balance'
import { AdminSummaryService } from '../admin/admin-summary.service'
import { getOwnSalaryStatus } from './salary-status.helper'
import { ProjectsService } from '../projects/projects.service'
import type { ProjectAuditLogService } from '../projects/project-audit-log.service'
import { HrAccessService } from '../common/hr-access.service'
import { hasDatabaseUrl } from '../test/require-real-db'

// ---------------------------------------------------------------------------
// Personas — namespace bd5e0000-*
// ---------------------------------------------------------------------------

const ADMIN_1: SessionUser = {
  id: 'bd5e0000-0000-4000-aa00-000000000001',
  email: 'br-admin@test.spec',
  displayName: 'BR Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const ACCOUNTANT_1: SessionUser = {
  id: 'bd5e0000-0000-4000-aa00-000000000002',
  email: 'br-accountant@test.spec',
  displayName: 'BR Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 26,
  legalFullName: null,
}
const SENIOR_1: SessionUser = {
  id: 'bd5e0000-0000-4000-aa00-000000000003',
  email: 'br-senior@test.spec',
  displayName: 'BR Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const DROP_1: SessionUser = {
  id: 'bd5e0000-0000-4000-aa00-000000000004',
  email: 'br-drop@test.spec',
  displayName: 'BR Drop',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 26,
  legalFullName: null,
}

const ALL_USER_IDS = [ADMIN_1, ACCOUNTANT_1, SENIOR_1, DROP_1].map((u) => u.id)

const PROJECT_1 = 'bd5e0001-0000-4000-b000-000000000001'
const ALL_PROJECT_IDS = [PROJECT_1]

/** Every extra tx id any `it` block inserts — swept in `afterAll`. */
const ALL_EXTRA_TX_IDS = [
  'bd5e0002-0000-4000-a000-000000000001', // getSummary
  'bd5e0002-0000-4000-a000-000000000002', // getAccountantSummary
  'bd5e0002-0000-4000-a000-000000000003', // getSeniorSummary
  'bd5e0002-0000-4000-a000-000000000004', // getDropSelfSummary
  'bd5e0002-0000-4000-a000-000000000005', // getAdminBalance
  'bd5e0002-0000-4000-a000-000000000006', // getSeniorBalance
  'bd5e0002-0000-4000-a000-000000000007', // getTotalEarned
  'bd5e0002-0000-4000-a000-000000000008', // computeCompanyAccountBalanceFromLedger
  'bd5e0002-0000-4000-a000-000000000009', // AdminSummaryService — projectsUnpaidThisMonth
  'bd5e0002-0000-4000-a000-00000000000a', // AdminSummaryService — activeTransactions feed
  'bd5e0002-0000-4000-a000-00000000000b', // getIncomeComplianceOverview
  'bd5e0002-0000-4000-a000-00000000000c', // ProjectsService.findDropOwnProjects.incomesCount
  'bd5e0002-0000-4000-a000-00000000000d', // getOwnSalaryStatus
]

const fakeNbu = {
  getRates: async () => ({
    usdUah: '41.50',
    usdtUah: '41.50',
    eurUah: '44.80',
    date: '2026-07-30',
  }),
} as unknown as NbuCurrencyService

// ---------------------------------------------------------------------------
// DB-skip-guard
// ---------------------------------------------------------------------------

let _pool: Pool | null = null
let svc: TransactionsService
let balanceSvc: BalanceService
let adminSummarySvc: AdminSummaryService
let projectsSvc: ProjectsService
let dbSvc: DatabaseService

describe.skipIf(!hasDatabaseUrl())(
  'task-soft-delete-and-money-audit — balance regression (real-DB, AC4)',
  () => {
    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        await probe.end()
      } catch {
        throw new Error(
          '[soft-delete-balance-regression] FAILED — no DB reachable at DATABASE_URL (expected in CI unit job)',
        )
      }

      _pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      const db = drizzle(_pool, { schema })

      dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
      Object.assign(dbSvc, { pool: _pool, db })
      svc = makeTransactionsService({ db: dbSvc, nbuCurrencyService: fakeNbu })
      balanceSvc = new BalanceService(dbSvc, fakeNbu)
      adminSummarySvc = new AdminSummaryService(dbSvc)
      projectsSvc = new ProjectsService(
        dbSvc,
        {} as ProjectAuditLogService,
        {} as never,
        new HrAccessService(dbSvc),
      )

      for (const u of [ADMIN_1, ACCOUNTANT_1, SENIOR_1, DROP_1]) {
        await db
          .insert(users)
          .values({
            id: u.id,
            email: u.email,
            displayName: u.displayName,
            role: u.role,
            seniorSharePercent: 26,
          })
          .onConflictDoNothing()
      }

      await db
        .insert(projects)
        .values({
          id: PROJECT_1,
          name: 'BR Project',
          companyName: 'BR Client Co',
          domain: 'AI',
          startDate: new Date('2026-01-01T00:00:00Z'),
          seniorId: SENIOR_1.id,
          // MED-5 (security-review PR #456): also drop-owned so
          // ProjectsService.findDropOwnProjects.incomesCount has a project to
          // count against.
          dropId: DROP_1.id,
          rate: 100,
          currency: 'USDT',
          paymentType: 'FOP',
        })
        .onConflictDoNothing()
    })

    afterAll(async () => {
      if (!_pool)
        throw new Error(
          '[require-real-db] _pool not initialized — beforeAll should have thrown already',
        )
      const db = drizzle(_pool, { schema })
      await db
        .delete(transactions)
        .where(inArray(transactions.id, ALL_EXTRA_TX_IDS))
        .catch(() => undefined)
      await db
        .delete(projects)
        .where(inArray(projects.id, ALL_PROJECT_IDS))
        .catch(() => undefined)
      await db
        .delete(users)
        .where(inArray(users.id, ALL_USER_IDS))
        .catch(() => undefined)
      await _pool.end()
    })

    it('getSummary.totalIncome — insert + soft-delete an ADMIN_INCOME nets to the baseline', async () => {
      const before = await svc.getSummary(ADMIN_1)

      const db = drizzle(_pool!, { schema })
      await db.insert(transactions).values({
        id: ALL_EXTRA_TX_IDS[0]!,
        type: 'ADMIN_INCOME',
        status: 'PAID',
        amount: '1234.56',
        currency: 'USDT',
        senderLabel: 'Client Co',
        receiverId: ADMIN_1.id,
        projectId: PROJECT_1,
        createdBy: ADMIN_1.id,
      })

      const afterInsert = await svc.getSummary(ADMIN_1)
      expect(afterInsert.totalIncome).toBeCloseTo(before.totalIncome + 1234.56, 6)

      await svc.adminDeleteTransaction(ALL_EXTRA_TX_IDS[0]!, 'regression test cleanup', ADMIN_1)

      const afterDelete = await svc.getSummary(ADMIN_1)
      expect(afterDelete.totalIncome).toBeCloseTo(before.totalIncome, 6)
    })

    it('getAccountantSummary.pendingValidation — insert + soft-delete a PENDING SENIOR_INCOME nets to baseline', async () => {
      const before = await svc.getAccountantSummary(ACCOUNTANT_1)

      const db = drizzle(_pool!, { schema })
      await db.insert(transactions).values({
        id: ALL_EXTRA_TX_IDS[1]!,
        type: 'SENIOR_INCOME',
        status: 'PENDING',
        amount: '500',
        currency: 'USDT',
        senderLabel: 'Client Co',
        receiverId: SENIOR_1.id,
        projectId: PROJECT_1,
        createdBy: SENIOR_1.id,
      })

      const afterInsert = await svc.getAccountantSummary(ACCOUNTANT_1)
      expect(afterInsert.pendingValidation.count).toBe(before.pendingValidation.count + 1)
      expect(afterInsert.pendingValidation.amount).toBeCloseTo(
        before.pendingValidation.amount + 500,
        6,
      )

      await svc.adminDeleteTransaction(ALL_EXTRA_TX_IDS[1]!, 'regression test cleanup', ADMIN_1)

      const afterDelete = await svc.getAccountantSummary(ACCOUNTANT_1)
      expect(afterDelete.pendingValidation.count).toBe(before.pendingValidation.count)
      expect(afterDelete.pendingValidation.amount).toBeCloseTo(before.pendingValidation.amount, 6)
    })

    it('getSeniorSummary.seniorShareIncome — insert + soft-delete a PAID SENIOR_INCOME nets to baseline', async () => {
      const before = await svc.getSeniorSummary(SENIOR_1)

      const db = drizzle(_pool!, { schema })
      await db.insert(transactions).values({
        id: ALL_EXTRA_TX_IDS[2]!,
        type: 'SENIOR_INCOME',
        status: 'PAID',
        amount: '1000',
        currency: 'USDT',
        senderLabel: 'Client Co',
        receiverId: SENIOR_1.id,
        projectId: PROJECT_1,
        seniorSharePercent: 26,
        createdBy: SENIOR_1.id,
      })

      // Gross 1000 × 26% = 260 senior share.
      const afterInsert = await svc.getSeniorSummary(SENIOR_1)
      expect(afterInsert.seniorShareIncome.total).toBeCloseTo(
        before.seniorShareIncome.total + 260,
        6,
      )

      await svc.adminDeleteTransaction(ALL_EXTRA_TX_IDS[2]!, 'regression test cleanup', ADMIN_1)

      const afterDelete = await svc.getSeniorSummary(SENIOR_1)
      expect(afterDelete.seniorShareIncome.total).toBeCloseTo(before.seniorShareIncome.total, 6)
    })

    it('getDropSelfSummary.balance — insert + soft-delete a PAID PAYOUT_DROP nets to baseline', async () => {
      const before = await svc.getDropSelfSummary(DROP_1)

      const db = drizzle(_pool!, { schema })
      await db.insert(transactions).values({
        id: ALL_EXTRA_TX_IDS[3]!,
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '150',
        currency: 'USDT',
        senderLabel: 'COMPANY',
        receiverId: DROP_1.id,
        recipientId: DROP_1.id,
        projectId: PROJECT_1,
        createdBy: ADMIN_1.id,
      })

      const afterInsert = await svc.getDropSelfSummary(DROP_1)
      expect(afterInsert.balance).toBeCloseTo(before.balance + 150, 6)

      await svc.adminDeleteTransaction(ALL_EXTRA_TX_IDS[3]!, 'regression test cleanup', ADMIN_1)

      const afterDelete = await svc.getDropSelfSummary(DROP_1)
      expect(afterDelete.balance).toBeCloseTo(before.balance, 6)
    })

    it('BalanceService.getAdminBalance — insert + soft-delete a PAID DIVIDEND_TO_ADMIN nets to baseline', async () => {
      const before = await balanceSvc.getAdminBalance(ADMIN_1.id, 'USDT')

      const db = drizzle(_pool!, { schema })
      await db.insert(transactions).values({
        id: ALL_EXTRA_TX_IDS[4]!,
        type: 'DIVIDEND_TO_ADMIN',
        status: 'PAID',
        amount: '80',
        currency: 'USDT',
        senderLabel: 'Счёт компании',
        receiverId: ADMIN_1.id,
        recipientId: ADMIN_1.id,
        createdBy: ADMIN_1.id,
      })

      const afterInsert = await balanceSvc.getAdminBalance(ADMIN_1.id, 'USDT')
      expect(afterInsert.balance).toBeCloseTo(before.balance + 80, 6)

      await svc.adminDeleteTransaction(ALL_EXTRA_TX_IDS[4]!, 'regression test cleanup', ADMIN_1)

      const afterDelete = await balanceSvc.getAdminBalance(ADMIN_1.id, 'USDT')
      expect(afterDelete.balance).toBeCloseTo(before.balance, 6)
    })

    it('BalanceService.getSeniorBalance — insert + soft-delete a PAID SENIOR_INCOME (net snapshot) nets to baseline', async () => {
      const before = await balanceSvc.getSeniorBalance(SENIOR_1.id, 'USDT')

      const db = drizzle(_pool!, { schema })
      // seniorSharePercent NULL ⇒ amount used AS-IS (settleByCompany-style NET row).
      await db.insert(transactions).values({
        id: ALL_EXTRA_TX_IDS[5]!,
        type: 'SENIOR_INCOME',
        status: 'PAID',
        amount: '90',
        currency: 'USDT',
        senderLabel: 'COMPANY',
        receiverId: SENIOR_1.id,
        projectId: PROJECT_1,
        createdBy: ADMIN_1.id,
      })

      const afterInsert = await balanceSvc.getSeniorBalance(SENIOR_1.id, 'USDT')
      expect(afterInsert.balance).toBeCloseTo(before.balance + 90, 6)

      await svc.adminDeleteTransaction(ALL_EXTRA_TX_IDS[5]!, 'regression test cleanup', ADMIN_1)

      const afterDelete = await balanceSvc.getSeniorBalance(SENIOR_1.id, 'USDT')
      expect(afterDelete.balance).toBeCloseTo(before.balance, 6)
    })

    it('BalanceService.getTotalEarned (SENIOR) — insert + soft-delete a PAID SENIOR_INCOME nets to baseline', async () => {
      const before = await balanceSvc.getTotalEarned(SENIOR_1.id, 'USDT')

      const db = drizzle(_pool!, { schema })
      await db.insert(transactions).values({
        id: ALL_EXTRA_TX_IDS[6]!,
        type: 'SENIOR_INCOME',
        status: 'PAID',
        amount: '65',
        currency: 'USDT',
        senderLabel: 'COMPANY',
        receiverId: SENIOR_1.id,
        projectId: PROJECT_1,
        createdBy: ADMIN_1.id,
      })

      const afterInsert = await balanceSvc.getTotalEarned(SENIOR_1.id, 'USDT')
      expect(afterInsert.totalEarned).toBeCloseTo(before.totalEarned + 65, 6)

      await svc.adminDeleteTransaction(ALL_EXTRA_TX_IDS[6]!, 'regression test cleanup', ADMIN_1)

      const afterDelete = await balanceSvc.getTotalEarned(SENIOR_1.id, 'USDT')
      expect(afterDelete.totalEarned).toBeCloseTo(before.totalEarned, 6)
    })

    it('computeCompanyAccountBalanceFromLedger — insert + soft-delete a PAID COMPANY_DEPOSIT nets to baseline', async () => {
      const before = await computeCompanyAccountBalanceFromLedger(dbSvc.db)

      const db = drizzle(_pool!, { schema })
      await db.insert(transactions).values({
        id: ALL_EXTRA_TX_IDS[7]!,
        type: 'COMPANY_DEPOSIT',
        status: 'PAID',
        amount: '333',
        currency: 'USDT',
        senderId: SENIOR_1.id,
        createdBy: SENIOR_1.id,
      })

      const afterInsert = await computeCompanyAccountBalanceFromLedger(dbSvc.db)
      expect(afterInsert).toBeCloseTo(before + 333, 6)

      await svc.adminDeleteTransaction(ALL_EXTRA_TX_IDS[7]!, 'regression test cleanup', ADMIN_1)

      const afterDelete = await computeCompanyAccountBalanceFromLedger(dbSvc.db)
      expect(afterDelete).toBeCloseTo(before, 6)
    })

    it('AdminSummaryService.getSummary.projectsUnpaidThisMonth — a deleted income does NOT count as "paid" (NOT EXISTS subquery)', async () => {
      const before = await adminSummarySvc.getSummary(ADMIN_1)
      const baselineUnpaid = before.kpis.projectsUnpaidThisMonth

      const db = drizzle(_pool!, { schema })
      const now = new Date()
      await db.insert(transactions).values({
        id: ALL_EXTRA_TX_IDS[8]!,
        type: 'ADMIN_INCOME',
        status: 'PAID',
        amount: '42',
        currency: 'USDT',
        senderLabel: 'Client Co',
        receiverId: ADMIN_1.id,
        projectId: PROJECT_1,
        txDate: now,
        createdBy: ADMIN_1.id,
      })

      // PROJECT_1 now HAS a this-month income row → one fewer unpaid project.
      const afterInsert = await adminSummarySvc.getSummary(ADMIN_1)
      expect(afterInsert.kpis.projectsUnpaidThisMonth).toBe(baselineUnpaid - 1)

      await svc.adminDeleteTransaction(ALL_EXTRA_TX_IDS[8]!, 'regression test cleanup', ADMIN_1)

      // Deleted → the NOT EXISTS subquery must stop seeing it → back to baseline
      // (the project is "unpaid" again, exactly as if the income never existed).
      const afterDelete = await adminSummarySvc.getSummary(ADMIN_1)
      expect(afterDelete.kpis.projectsUnpaidThisMonth).toBe(baselineUnpaid)
    })

    it('AdminSummaryService.getSummary.activeTransactions — a deleted PENDING row disappears from the feed', async () => {
      const db = drizzle(_pool!, { schema })
      await db.insert(transactions).values({
        id: ALL_EXTRA_TX_IDS[9]!,
        type: 'SENIOR_INCOME',
        status: 'PENDING',
        amount: '10',
        currency: 'USDT',
        senderLabel: 'Client Co',
        receiverId: SENIOR_1.id,
        projectId: PROJECT_1,
        createdBy: SENIOR_1.id,
      })

      const afterInsert = await adminSummarySvc.getSummary(ADMIN_1)
      expect(afterInsert.activeTransactions.find((t) => t.id === ALL_EXTRA_TX_IDS[9])).toBeDefined()

      await svc.adminDeleteTransaction(ALL_EXTRA_TX_IDS[9]!, 'regression test cleanup', ADMIN_1)

      const afterDelete = await adminSummarySvc.getSummary(ADMIN_1)
      expect(
        afterDelete.activeTransactions.find((t) => t.id === ALL_EXTRA_TX_IDS[9]),
      ).toBeUndefined()
    })

    // ── MED-5 (security-review PR #456): the three read-paths the review flagged
    // as filtered-in-code-but-untested — getIncomeComplianceOverview,
    // ProjectsService.findDropOwnProjects.incomesCount, getOwnSalaryStatus.
    // Same insert → assert → soft-delete → assert methodology as every test
    // above; these three simply never got a dedicated regression proof before.

    it('getIncomeComplianceOverview.totals.submittedProjects — insert + soft-delete a VALIDATED SENIOR_INCOME nets to baseline', async () => {
      const before = await svc.getIncomeComplianceOverview(ADMIN_1)
      const baselineSubmitted = before.totals.submittedProjects

      const db = drizzle(_pool!, { schema })
      await db.insert(transactions).values({
        id: ALL_EXTRA_TX_IDS[10]!,
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '77',
        currency: 'USDT',
        senderLabel: 'Client Co',
        receiverId: SENIOR_1.id,
        projectId: PROJECT_1,
        txDate: new Date(),
        createdBy: SENIOR_1.id,
      })

      // PROJECT_1 now has a counted (VALIDATED) SENIOR_INCOME row for the
      // current month → one more "submitted" project.
      const afterInsert = await svc.getIncomeComplianceOverview(ADMIN_1)
      expect(afterInsert.totals.submittedProjects).toBe(baselineSubmitted + 1)

      await svc.adminDeleteTransaction(ALL_EXTRA_TX_IDS[10]!, 'regression test cleanup', ADMIN_1)

      // Deleted → the isNull(deletedAt) filter must stop counting it → back to
      // baseline (PROJECT_1 reads as "not submitted" again).
      const afterDelete = await svc.getIncomeComplianceOverview(ADMIN_1)
      expect(afterDelete.totals.submittedProjects).toBe(baselineSubmitted)
    })

    it('ProjectsService.findDropOwnProjects.incomesCount — insert + soft-delete a DROP_INCOME nets to baseline', async () => {
      const before = await projectsSvc.findDropOwnProjects(DROP_1)
      const baselineCount = before.find((p) => p.id === PROJECT_1)?.incomesCount ?? 0

      const db = drizzle(_pool!, { schema })
      await db.insert(transactions).values({
        id: ALL_EXTRA_TX_IDS[11]!,
        type: 'DROP_INCOME',
        status: 'PENDING',
        amount: '55',
        currency: 'USDT',
        senderLabel: 'Client Co',
        receiverId: DROP_1.id,
        projectId: PROJECT_1,
        createdBy: DROP_1.id,
      })

      const afterInsert = await projectsSvc.findDropOwnProjects(DROP_1)
      expect(afterInsert.find((p) => p.id === PROJECT_1)?.incomesCount).toBe(baselineCount + 1)

      await svc.adminDeleteTransaction(ALL_EXTRA_TX_IDS[11]!, 'regression test cleanup', ADMIN_1)

      const afterDelete = await projectsSvc.findDropOwnProjects(DROP_1)
      expect(afterDelete.find((p) => p.id === PROJECT_1)?.incomesCount).toBe(baselineCount)
    })

    it('getOwnSalaryStatus — a soft-deleted SALARY reads back as "no salary yet"', async () => {
      const salaryMonth = '2099-01' // far-future month this spec namespace never otherwise touches
      // `{ hasMonthlySalary: true, isCronEligibleRole: true }` throughout —
      // this test is about the ROW's soft-delete visibility
      // (nonDeletedTransactions view), orthogonal to the E-6
      // configured/eligible/awaiting branching (covered separately in
      // salary-status.helper.spec.ts) — pinning both flags `true` collapses
      // that branching to the same AWAITING_CREATION/EXISTS pair it always had.
      const salaryConfig = { hasMonthlySalary: true, isCronEligibleRole: true }
      const before = await getOwnSalaryStatus(dbSvc.db, SENIOR_1.id, salaryMonth, salaryConfig)
      expect(before).toEqual({ state: 'AWAITING_CREATION' })

      const db = drizzle(_pool!, { schema })
      await db.insert(transactions).values({
        id: ALL_EXTRA_TX_IDS[12]!,
        type: 'SALARY',
        status: 'PENDING',
        amount: '444',
        currency: 'USDT',
        senderLabel: 'Счёт компании',
        receiverId: SENIOR_1.id,
        salaryMonth,
        createdBy: ADMIN_1.id,
      })

      const afterInsert = await getOwnSalaryStatus(dbSvc.db, SENIOR_1.id, salaryMonth, salaryConfig)
      expect(afterInsert.state).toBe('EXISTS')
      if (afterInsert.state !== 'EXISTS') throw new Error('unreachable')
      expect(afterInsert.amount).toBeCloseTo(444, 6)

      await svc.adminDeleteTransaction(ALL_EXTRA_TX_IDS[12]!, 'regression test cleanup', ADMIN_1)

      // Deleted → must read back exactly as "no salary yet" (AWAITING_CREATION,
      // since salaryConfig is configured+cron-eligible here), not resurface a
      // mistakenly-booked reminder.
      const afterDelete = await getOwnSalaryStatus(dbSvc.db, SENIOR_1.id, salaryMonth, salaryConfig)
      expect(afterDelete).toEqual({ state: 'AWAITING_CREATION' })
    })
  },
)
