/**
 * Real-DB spec for `TransactionsService.getTransactionAuditLog` /
 * `GET /api/transactions/:id/audit-log` (security-review PR #456, MED-3).
 *
 * `transaction_audit_log` was write-only across the whole API before this —
 * DELETE/RESTORE/VALIDATE/etc entries were journaled but nothing ever read
 * them back. This proves the read side actually surfaces what
 * `adminDeleteTransaction` / `restoreTransaction` wrote, through the SAME
 * real Drizzle join (`leftJoin(users, ...)` for `actorName`) production uses
 * — a mocked `.select()` could not prove the join is wired correctly.
 *
 * WHAT it covers:
 *   - ADMIN sees BOTH journal entries (DELETE then RESTORE) for a row it
 *     just deleted+restored, newest first, with the real actor's displayName
 *     resolved and the metadata (reason / previousDeletionReason) intact.
 *   - ACCOUNTANT (privileged for VISIBILITY, not for this journal) gets 403.
 *   - A non-existent transaction id gets 404.
 *
 * DB-SKIP-GUARD:
 *   describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is unset (reports
 *   SKIPPED). A DATABASE_URL that IS set but unusable throws in beforeAll
 *   (reports FAILED). Neither case can look like "passed" with zero assertions.
 *
 * SEED strategy: UUID namespace ad100000-* — distinct from other specs.
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { inArray } from 'drizzle-orm'
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { transactions, users } from '../database/schema'
import * as schema from '../database/schema'
import type { TransactionsService } from './transactions.service'
import { hasDatabaseUrl } from '../test/require-real-db'

const ADMIN_1: SessionUser = {
  id: 'ad100000-0000-4000-aa00-000000000001',
  email: 'al-admin@test.spec',
  displayName: 'AL Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const ACCOUNTANT_1: SessionUser = {
  id: 'ad100000-0000-4000-aa00-000000000002',
  email: 'al-accountant@test.spec',
  displayName: 'AL Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 26,
  legalFullName: null,
}
const SENIOR_1: SessionUser = {
  id: 'ad100000-0000-4000-aa00-000000000003',
  email: 'al-senior@test.spec',
  displayName: 'AL Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

const ALL_USER_IDS = [ADMIN_1, ACCOUNTANT_1, SENIOR_1].map((u) => u.id)
const TX_ID = 'ad100001-0000-4000-b000-000000000001'
const NONEXISTENT_TX_ID = 'ad100001-0000-4000-b000-00000000dead'

let _pool: Pool | null = null
let svc: TransactionsService

describe.skipIf(!hasDatabaseUrl())(
  'security-review PR #456 (MED-3) — GET transactions/:id/audit-log (real-DB)',
  () => {
    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        await probe.end()
      } catch {
        throw new Error(
          '[transaction-audit-log-read] FAILED — no DB reachable at DATABASE_URL (expected in CI unit job)',
        )
      }

      _pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      const db = drizzle(_pool, { schema })

      const dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
      Object.assign(dbSvc, { pool: _pool, db })
      svc = makeTransactionsService({ db: dbSvc })

      for (const u of [ADMIN_1, ACCOUNTANT_1, SENIOR_1]) {
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
        .insert(transactions)
        .values({
          id: TX_ID,
          type: 'EXPENSE',
          status: 'PAID',
          amount: '250',
          currency: 'USDT',
          senderLabel: 'Client Co',
          createdBy: ADMIN_1.id,
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
        .where(inArray(transactions.id, [TX_ID]))
        .catch(() => undefined)
      await db
        .delete(users)
        .where(inArray(users.id, ALL_USER_IDS))
        .catch(() => undefined)
      await _pool.end()
    })

    it('ADMIN sees the real DELETE then RESTORE journal, newest first, with actorName + metadata resolved', async () => {
      await svc.adminDeleteTransaction(TX_ID, 'дубликат расхода', ADMIN_1)
      await svc.restoreTransaction(TX_ID, 'проверили — не дубликат', ADMIN_1)

      const log = await svc.getTransactionAuditLog(TX_ID, ADMIN_1)

      // Newest first: RESTORE, then DELETE.
      const restoreEntry = log.find((e) => e.action === 'RESTORE')
      const deleteEntry = log.find((e) => e.action === 'DELETE')
      expect(restoreEntry).toBeDefined()
      expect(deleteEntry).toBeDefined()
      expect(log.indexOf(restoreEntry!)).toBeLessThan(log.indexOf(deleteEntry!))

      expect(restoreEntry!.actorId).toBe(ADMIN_1.id)
      expect(restoreEntry!.actorName).toBe(ADMIN_1.displayName)
      expect(restoreEntry!.metadata['reason']).toBe('проверили — не дубликат')
      expect(restoreEntry!.metadata['previousDeletionReason']).toBe('дубликат расхода')

      expect(deleteEntry!.actorName).toBe(ADMIN_1.displayName)
      expect(deleteEntry!.metadata['reason']).toBe('дубликат расхода')
      expect(deleteEntry!.metadata['type']).toBe('EXPENSE')
    })

    it('ACCOUNTANT (visibility-privileged, not audit-log-privileged) — 403', async () => {
      await expect(svc.getTransactionAuditLog(TX_ID, ACCOUNTANT_1)).rejects.toThrow(
        ForbiddenException,
      )
    })

    it('SENIOR — 403', async () => {
      await expect(svc.getTransactionAuditLog(TX_ID, SENIOR_1)).rejects.toThrow(ForbiddenException)
    })

    it('a non-existent transaction id — 404', async () => {
      await expect(svc.getTransactionAuditLog(NONEXISTENT_TX_ID, ADMIN_1)).rejects.toThrow(
        NotFoundException,
      )
    })
  },
)
