/**
 * Real-DB RBAC visibility spec for task-soft-delete-and-money-audit (AC2, AC3).
 *
 * WHY real-DB (not mocked): `findAll`/`findOne` run through the SAME Drizzle
 * relational-query path as production (`with: { sender, receiver, project }`);
 * a mocked `findFirst`/`findMany` would let a regression in the actual
 * `WHERE deleted_at IS NULL` predicate or the `assertVisibleDespiteDeletion`
 * ordering pass silently. Class of incident: feedback_mocked_e2e_guards (real
 * gaps behind guards, recurred 3×).
 *
 * WHAT it covers:
 *   AC2  Every non-ADMIN/ACCOUNTANT role gets a 404 (NotFoundException) — not
 *        403 — on a deleted transaction, both via `findAll` (absent from the
 *        list) and via a direct `findOne` by id. Tested for BOTH the row's
 *        OWNER (SENIOR — would otherwise be a normal 200) and a NON-owner
 *        (JUNIOR — would otherwise be a normal 403), proving the "existence
 *        oracle" gate applies uniformly regardless of what the response would
 *        have been had the row not been deleted.
 *   AC3  ADMIN/ACCOUNTANT: the deleted row is absent from `findAll` by
 *        DEFAULT; appears only with the explicit `includeDeleted: true`
 *        filter. `findOne` by id works for ADMIN/ACCOUNTANT regardless of the
 *        list toggle (the toggle only governs the LIST).
 *   AC6  restoreTransaction: ACCOUNTANT gets 403 (visibility ≠ restore
 *        rights); ADMIN succeeds and the row reappears in the default list.
 *
 * DB-SKIP-GUARD:
 *   dbAvailable = false when DATABASE_URL is unreachable — each test
 *   early-returns, staying green in no-DB environments.
 *
 * SEED strategy:
 *   UUID namespace: add50000-* (users) / add50001-* (transactions) — distinct
 *   from other specs. Idempotent via onConflictDoNothing; afterAll cleans up.
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

// ---------------------------------------------------------------------------
// Personas — namespace add50000-*
// ---------------------------------------------------------------------------

const ADMIN_1: SessionUser = {
  id: 'add50000-0000-4000-aa00-000000000001',
  email: 'sd-admin@test.spec',
  displayName: 'SD Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const ACCOUNTANT_1: SessionUser = {
  id: 'add50000-0000-4000-aa00-000000000002',
  email: 'sd-accountant@test.spec',
  displayName: 'SD Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 26,
  legalFullName: null,
}
/** Owns the deleted row (receiverId) — would normally see it (200) via ownership. */
const SENIOR_OWNER: SessionUser = {
  id: 'add50000-0000-4000-aa00-000000000003',
  email: 'sd-senior-owner@test.spec',
  displayName: 'SD Senior Owner',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
/** No relation to the deleted row — would normally get 403 (not theirs). */
const JUNIOR_STRANGER: SessionUser = {
  id: 'add50000-0000-4000-aa00-000000000004',
  email: 'sd-junior@test.spec',
  displayName: 'SD Junior Stranger',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
/**
 * MED-5 (security-review PR #456): the original spec covered SENIOR (owner)
 * + JUNIOR (stranger) but not DROP or HR — both go through the SAME
 * `assertReadAccess` own-row-only branch as JUNIOR (see transactions.service
 * .ts), so a regression there would have gone unnoticed. No relation to the
 * deleted row — would normally get 403 (not theirs).
 */
const DROP_STRANGER: SessionUser = {
  id: 'add50000-0000-4000-aa00-000000000005',
  email: 'sd-drop@test.spec',
  displayName: 'SD Drop Stranger',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 26,
  legalFullName: null,
}
/** No relation to the deleted row — would normally get 403 (not theirs). */
const HR_STRANGER: SessionUser = {
  id: 'add50000-0000-4000-aa00-000000000006',
  email: 'sd-hr@test.spec',
  displayName: 'SD HR Stranger',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 26,
  legalFullName: null,
}

const ALL_USER_IDS = [
  ADMIN_1,
  ACCOUNTANT_1,
  SENIOR_OWNER,
  JUNIOR_STRANGER,
  DROP_STRANGER,
  HR_STRANGER,
].map((u) => u.id)

// ---------------------------------------------------------------------------
// Transaction ids — namespace add50001-*
// ---------------------------------------------------------------------------

const TX_ACTIVE_ID = 'add50001-0000-4000-b000-000000000001'
const TX_DELETED_ID = 'add50001-0000-4000-b000-000000000002'
const ALL_TX_IDS = [TX_ACTIVE_ID, TX_DELETED_ID]

// ---------------------------------------------------------------------------
// DB-skip-guard
// ---------------------------------------------------------------------------

let dbAvailable = true
let _pool: Pool | null = null
let svc: TransactionsService

describe('task-soft-delete-and-money-audit — visibility RBAC (real-DB)', () => {
  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      await probe.end()
    } catch {
      console.warn(
        '[soft-delete-visibility] SKIPPED — no DB reachable at DATABASE_URL (expected in CI unit job)',
      )
      dbAvailable = false
      return
    }

    _pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(_pool, { schema })

    const dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
    Object.assign(dbSvc, { pool: _pool, db })
    svc = makeTransactionsService({ db: dbSvc })

    for (const u of [
      ADMIN_1,
      ACCOUNTANT_1,
      SENIOR_OWNER,
      JUNIOR_STRANGER,
      DROP_STRANGER,
      HR_STRANGER,
    ]) {
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

    // Active SENIOR_INCOME owned by SENIOR_OWNER.
    await db
      .insert(transactions)
      .values({
        id: TX_ACTIVE_ID,
        type: 'SENIOR_INCOME',
        status: 'PAID',
        amount: '100',
        currency: 'USDT',
        senderId: null,
        senderLabel: 'Client Co',
        receiverId: SENIOR_OWNER.id,
        createdBy: ADMIN_1.id,
      })
      .onConflictDoNothing()

    // Deleted SENIOR_INCOME owned by SENIOR_OWNER — seeded pre-deleted.
    await db
      .insert(transactions)
      .values({
        id: TX_DELETED_ID,
        type: 'SENIOR_INCOME',
        status: 'PAID',
        amount: '200',
        currency: 'USDT',
        senderId: null,
        senderLabel: 'Client Co',
        receiverId: SENIOR_OWNER.id,
        createdBy: ADMIN_1.id,
        deletedAt: new Date('2026-07-30T10:00:00Z'),
        deletedBy: ADMIN_1.id,
        deletionReason: 'Ошибочно задвоенный приход',
      })
      .onConflictDoNothing()
  })

  afterAll(async () => {
    if (!dbAvailable || !_pool) return
    const db = drizzle(_pool, { schema })
    await db
      .delete(transactions)
      .where(inArray(transactions.id, ALL_TX_IDS))
      .catch(() => undefined)
    await db
      .delete(users)
      .where(inArray(users.id, ALL_USER_IDS))
      .catch(() => undefined)
    await _pool.end()
  })

  // ── AC2: non-privileged roles — 404, never 403, regardless of ownership ──

  it('AC2 — SENIOR (the OWNER): findAll excludes the deleted row', async () => {
    if (!dbAvailable) return
    const rows = await svc.findAll(SENIOR_OWNER)
    expect(rows.find((t) => t.id === TX_DELETED_ID)).toBeUndefined()
    // Sanity: the active row IS still visible to its owner.
    expect(rows.find((t) => t.id === TX_ACTIVE_ID)).toBeDefined()
  })

  it('AC2 — SENIOR (the OWNER): findOne on the deleted row throws 404, not 200', async () => {
    if (!dbAvailable) return
    await expect(svc.findOne(TX_DELETED_ID, SENIOR_OWNER)).rejects.toThrow(NotFoundException)
  })

  it('AC2 — JUNIOR (a stranger to the row): findAll excludes the deleted row', async () => {
    if (!dbAvailable) return
    const rows = await svc.findAll(JUNIOR_STRANGER)
    expect(rows.find((t) => t.id === TX_DELETED_ID)).toBeUndefined()
  })

  it('AC2 — JUNIOR (a stranger to the row): findOne on the deleted row throws 404, NOT 403 (existence oracle)', async () => {
    if (!dbAvailable) return
    // Without the deletion this would be ForbiddenException (not their row).
    // The 404 gate must fire FIRST so a prober cannot distinguish
    // "deleted" from "exists but isn't yours" from "never existed".
    await expect(svc.findOne(TX_DELETED_ID, JUNIOR_STRANGER)).rejects.toThrow(NotFoundException)
    await expect(svc.findOne(TX_DELETED_ID, JUNIOR_STRANGER)).rejects.not.toThrow(
      ForbiddenException,
    )
  })

  // MED-5 (security-review PR #456): DROP and HR were untested here — both
  // route through the SAME own-row-only `assertReadAccess` branch as JUNIOR,
  // so a regression scoped to just those two roles would have gone unnoticed.

  it('AC2 — DROP (a stranger to the row): findAll excludes the deleted row', async () => {
    if (!dbAvailable) return
    const rows = await svc.findAll(DROP_STRANGER)
    expect(rows.find((t) => t.id === TX_DELETED_ID)).toBeUndefined()
  })

  it('AC2 — DROP (a stranger to the row): findOne on the deleted row throws 404, NOT 403 (existence oracle)', async () => {
    if (!dbAvailable) return
    await expect(svc.findOne(TX_DELETED_ID, DROP_STRANGER)).rejects.toThrow(NotFoundException)
    await expect(svc.findOne(TX_DELETED_ID, DROP_STRANGER)).rejects.not.toThrow(ForbiddenException)
  })

  it('AC2 — HR (a stranger to the row): findAll excludes the deleted row', async () => {
    if (!dbAvailable) return
    const rows = await svc.findAll(HR_STRANGER)
    expect(rows.find((t) => t.id === TX_DELETED_ID)).toBeUndefined()
  })

  it('AC2 — HR (a stranger to the row): findOne on the deleted row throws 404, NOT 403 (existence oracle)', async () => {
    if (!dbAvailable) return
    await expect(svc.findOne(TX_DELETED_ID, HR_STRANGER)).rejects.toThrow(NotFoundException)
    await expect(svc.findOne(TX_DELETED_ID, HR_STRANGER)).rejects.not.toThrow(ForbiddenException)
  })

  // ── AC3: ADMIN/ACCOUNTANT — hidden by default, shown via explicit toggle ──

  it('AC3 — ADMIN: findAll excludes the deleted row by DEFAULT', async () => {
    if (!dbAvailable) return
    const rows = await svc.findAll(ADMIN_1)
    expect(rows.find((t) => t.id === TX_DELETED_ID)).toBeUndefined()
  })

  it('AC3 — ADMIN: findAll includes the deleted row when includeDeleted=true', async () => {
    if (!dbAvailable) return
    const rows = await svc.findAll(ADMIN_1, { includeDeleted: true })
    const row = rows.find((t) => t.id === TX_DELETED_ID)
    expect(row, 'ADMIN with includeDeleted=true must see the deleted row').toBeDefined()
    expect(row!.deletedAt).not.toBeNull()
    expect(row!.deletedBy).toBe(ADMIN_1.id)
    expect(row!.deletionReason).toBe('Ошибочно задвоенный приход')
    // Active row still present too — the toggle WIDENS, it does not replace.
    expect(rows.find((t) => t.id === TX_ACTIVE_ID)).toBeDefined()
  })

  it('AC3 — ACCOUNTANT: findAll excludes by default, includes with the toggle', async () => {
    if (!dbAvailable) return
    const defaultRows = await svc.findAll(ACCOUNTANT_1)
    expect(defaultRows.find((t) => t.id === TX_DELETED_ID)).toBeUndefined()

    const withDeleted = await svc.findAll(ACCOUNTANT_1, { includeDeleted: true })
    expect(withDeleted.find((t) => t.id === TX_DELETED_ID)).toBeDefined()
  })

  it('AC3 — a non-privileged caller passing includeDeleted=true is silently ignored', async () => {
    if (!dbAvailable) return
    // SENIOR/JUNIOR/HR/DROP can never widen the query even if they somehow
    // send the query param — the deleted row must stay excluded.
    const rows = await svc.findAll(SENIOR_OWNER, { includeDeleted: true })
    expect(rows.find((t) => t.id === TX_DELETED_ID)).toBeUndefined()
  })

  it('ADMIN/ACCOUNTANT: findOne by id works regardless of the list toggle', async () => {
    if (!dbAvailable) return
    const adminRow = await svc.findOne(TX_DELETED_ID, ADMIN_1)
    expect(adminRow.deletedAt).not.toBeNull()
    const acctRow = await svc.findOne(TX_DELETED_ID, ACCOUNTANT_1)
    expect(acctRow.deletedAt).not.toBeNull()
  })

  // ── AC6: restore — ADMIN only ─────────────────────────────────────────────

  it('AC6 — ACCOUNTANT cannot restore (403) — visibility ≠ restore rights', async () => {
    if (!dbAvailable) return
    await expect(
      svc.restoreTransaction(TX_DELETED_ID, 'accountant tries to restore', ACCOUNTANT_1),
    ).rejects.toThrow(ForbiddenException)
  })

  it('AC6 — ADMIN restores; the row reappears in the default list for every role', async () => {
    if (!dbAvailable) return
    await svc.restoreTransaction(TX_DELETED_ID, 'восстановлено после проверки', ADMIN_1)

    const adminRows = await svc.findAll(ADMIN_1)
    expect(adminRows.find((t) => t.id === TX_DELETED_ID)).toBeDefined()

    const seniorRows = await svc.findAll(SENIOR_OWNER)
    expect(seniorRows.find((t) => t.id === TX_DELETED_ID)).toBeDefined()

    const restored = await svc.findOne(TX_DELETED_ID, SENIOR_OWNER)
    expect(restored.deletedAt).toBeNull()
    expect(restored.deletedBy).toBeNull()
    expect(restored.deletionReason).toBeNull()
  })
})
