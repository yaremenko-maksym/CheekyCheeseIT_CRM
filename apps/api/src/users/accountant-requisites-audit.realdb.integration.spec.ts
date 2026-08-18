/**
 * Real-DB integration test — ACCOUNTANT requisites read-audit + ADMIN wallet
 * exclusion (pre-deploy MEDIUM #1).
 *
 * WHY this exists:
 *   ACCOUNTANT can read payout requisites (RNOKPP / IBAN / wallet) company-wide
 *   for payroll, but (a) the read had no audit trail and (b) it also leaked other
 *   ADMINs' payout wallets (admins are paid via 50/50 split, not payroll).
 *
 *   AC1a: ACCOUNTANT reading a SENIOR's requisites writes ONE requisites_read
 *         audit row (actor = accountant, target = senior, values redacted).
 *   AC1b: ACCOUNTANT viewing an ADMIN gets paymentMethod but NULL wallet/IBAN/
 *         recipient/RNOKPP/bank (payout destination excluded).
 *   AC1c: ACCOUNTANT viewing SELF writes NO read-audit.
 *
 * Uses real UsersService + real UsersAccessService + real AuditLogService on
 * PostgreSQL. SEED isolated rows; IDs namespaced acra-.
 * DB-SKIP-GUARD: describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is
 * unset (reports SKIPPED). A DATABASE_URL that IS set but unreachable
 * throws in beforeAll (reports FAILED) — neither case can look like
 * "passed" with zero assertions.
 */

import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { User } from '../database/schema'

import { DatabaseService } from '../database/database.service'
import { UsersService } from './users.service'
import { UsersAccessService } from './users-access.service'
import { AuditLogService } from './audit-log.service'
import { userAuditLog, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

// ── Test IDs — namespace acra- ─────────────────────────────────────────────
const ACCOUNTANT_ID = '5b100003-0000-4000-aa00-000000000001'
const SENIOR_ID = '5b100003-0000-4000-aa00-000000000002'
const ADMIN_ID = '5b100003-0000-4000-aa00-000000000003'
const TEST_USER_IDS = [ACCOUNTANT_ID, SENIOR_ID, ADMIN_ID]

let pool: Pool | null = null
let service: UsersService

// Build a SessionUser-ish viewer from a seeded user row.
const viewerOf = (id: string, role: User['role']) =>
  ({
    id,
    role,
    displayName: role,
    email: `${role}@acra.spec`,
    avatar: null,
    seniorSharePercent: 26,
  }) as never

describe.skipIf(!hasDatabaseUrl())(
  'UsersService.buildProfileView — ACCOUNTANT requisites audit + wallet exclusion (real DB)',
  () => {
    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        await probe.end()
      } catch {
        throw new Error('[accountant-requisites-audit] FAILED — no DB at DATABASE_URL')
      }

      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      const db = drizzle(pool, { schema })
      const dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
      Object.assign(dbSvc, { pool, db })

      const accessService = new UsersAccessService(dbSvc)
      const auditLog = new AuditLogService(dbSvc)
      const tosService = { getLatestAcceptanceForUser: async () => null } as never

      // Constructor order: (db, accessService, auditLogService, tosService,
      // teamAuditLogService, projectAuditLogService, teamsService). Only the first
      // four are exercised by buildProfileView on the accountant path.
      service = new UsersService(
        dbSvc,
        accessService,
        auditLog,
        tosService,
        {} as never,
        {} as never,
        {} as never,
      )

      await db
        .insert(users)
        .values([
          {
            id: ACCOUNTANT_ID,
            email: 'acra-accountant@test.spec',
            displayName: 'ACRA Accountant',
            role: 'ACCOUNTANT',
            googleId: `g-${ACCOUNTANT_ID}`,
            paymentMethod: 'BANK_UAH_FOP',
            bankUahIban: 'UA000000000000000000000000010',
            bankUahRnokpp: '1111111111',
          },
          {
            id: SENIOR_ID,
            email: 'acra-senior@test.spec',
            displayName: 'ACRA Senior',
            role: 'SENIOR',
            googleId: `g-${SENIOR_ID}`,
            paymentMethod: 'USDT_ERC20',
            walletUsdtErc20: '0xSENIORWALLET',
            walletUsdtLabel: 'senior wallet',
            bankUahIban: 'UA000000000000000000000000020',
            bankUahRnokpp: '2222222222',
          },
          {
            id: ADMIN_ID,
            email: 'acra-admin@test.spec',
            displayName: 'ACRA Admin',
            role: 'ADMIN',
            googleId: `g-${ADMIN_ID}`,
            paymentMethod: 'USDT_ERC20',
            walletUsdtErc20: '0xADMINWALLET',
            walletUsdtLabel: 'admin wallet',
            bankUahRecipient: 'Admin FOP',
            bankUahIban: 'UA000000000000000000000000030',
            bankUahRnokpp: '3333333333',
            bankUahBankName: 'PrivatBank',
          },
        ])
        .onConflictDoNothing()
    }, 30_000)

    beforeEach(async () => {
      if (!pool)
        throw new Error(
          '[require-real-db] pool not initialized — beforeAll should have thrown already',
        )
      const db = drizzle(pool, { schema })
      // Clean any read-audit rows from prior tests targeting our seeded users.
      for (const id of TEST_USER_IDS) {
        await db.delete(userAuditLog).where(eq(userAuditLog.targetId, id))
      }
    })

    afterAll(async () => {
      if (!pool)
        throw new Error(
          '[require-real-db] pool not initialized — beforeAll should have thrown already',
        )
      try {
        const db = drizzle(pool, { schema })
        for (const id of TEST_USER_IDS) {
          await db.delete(userAuditLog).where(eq(userAuditLog.targetId, id))
          await db.delete(userAuditLog).where(eq(userAuditLog.actorId, id))
        }
        for (const id of TEST_USER_IDS) await db.delete(users).where(eq(users.id, id))
      } finally {
        await pool.end()
      }
    }, 30_000)

    it('AC1a: ACCOUNTANT reading a SENIOR writes ONE requisites_read audit (redacted)', async () => {
      if (!pool)
        throw new Error(
          '[require-real-db] pool not initialized — beforeAll should have thrown already',
        )
      const db = drizzle(pool, { schema })

      const result = await service.buildProfileView(
        viewerOf(ACCOUNTANT_ID, 'ACCOUNTANT'),
        SENIOR_ID,
      )
      // The accountant DOES receive a non-admin senior's payout requisites…
      const u = result.user as Record<string, unknown>
      expect(u.walletUsdtErc20).toBe('0xSENIORWALLET')
      expect(u.bankUahIban).toBe('UA000000000000000000000000020')

      // …and the read is audited.
      const audit = await db.select().from(userAuditLog).where(eq(userAuditLog.targetId, SENIOR_ID))
      const reads = audit.filter((a) => a.action === 'requisites_read')
      expect(reads).toHaveLength(1)
      expect(reads[0]!.actorId).toBe(ACCOUNTANT_ID)
      const changes = reads[0]!.changes as Record<string, { before: unknown; after: unknown }>
      expect(Object.keys(changes)).toContain('bankUahIban')
      // Values are never persisted — only the redaction marker.
      expect(changes.bankUahIban!.before).toBe('[redacted]')
      expect(changes.bankUahIban!.after).toBe('[redacted]')
    })

    it('AC1b: ACCOUNTANT viewing an ADMIN — paymentMethod kept, wallet/IBAN/RNOKPP excluded', async () => {
      const result = await service.buildProfileView(viewerOf(ACCOUNTANT_ID, 'ACCOUNTANT'), ADMIN_ID)
      const u = result.user as Record<string, unknown>
      // Payout destination of another admin is masked…
      expect(u.walletUsdtErc20).toBeNull()
      expect(u.walletUsdtLabel).toBeNull()
      expect(u.bankUahRecipient).toBeNull()
      expect(u.bankUahIban).toBeNull()
      expect(u.bankUahRnokpp).toBeNull()
      expect(u.bankUahBankName).toBeNull()
      // …but the method type (no destination) is still surfaced.
      expect(u.paymentMethod).toBe('USDT_ERC20')
    })

    it('AC1b: read-audit on an ADMIN target only records the still-exposed fields (paymentMethod)', async () => {
      if (!pool)
        throw new Error(
          '[require-real-db] pool not initialized — beforeAll should have thrown already',
        )
      const db = drizzle(pool, { schema })
      await service.buildProfileView(viewerOf(ACCOUNTANT_ID, 'ACCOUNTANT'), ADMIN_ID)
      const audit = await db.select().from(userAuditLog).where(eq(userAuditLog.targetId, ADMIN_ID))
      const reads = audit.filter((a) => a.action === 'requisites_read')
      // A read still happened (paymentMethod was exposed) but the excluded payout
      // fields must NOT appear in the audit (they were never read/returned).
      expect(reads).toHaveLength(1)
      const changes = reads[0]!.changes as Record<string, unknown>
      expect(Object.keys(changes)).toContain('paymentMethod')
      expect(Object.keys(changes)).not.toContain('bankUahIban')
      expect(Object.keys(changes)).not.toContain('walletUsdtErc20')
    })

    it('AC1c: ACCOUNTANT viewing SELF writes NO requisites_read audit', async () => {
      if (!pool)
        throw new Error(
          '[require-real-db] pool not initialized — beforeAll should have thrown already',
        )
      const db = drizzle(pool, { schema })
      await service.buildProfileView(viewerOf(ACCOUNTANT_ID, 'ACCOUNTANT'), ACCOUNTANT_ID)
      const audit = await db
        .select()
        .from(userAuditLog)
        .where(eq(userAuditLog.targetId, ACCOUNTANT_ID))
      const reads = audit.filter((a) => a.action === 'requisites_read')
      expect(reads).toHaveLength(0)
    })
  },
)
