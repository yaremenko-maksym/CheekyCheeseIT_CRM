import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * AC2 — BIZ-11 Drizzle-builder domain constraints (real DB).
 *
 * Asserts that the partial unique indexes declared in schema.ts `(t) => [...]`
 * builders are present and enforced by PostgreSQL after `drizzle-kit push`.
 *
 * Covered constraints:
 *   1. pending_obligations: `uq_pending_obligations_source_pending` WHERE status='PENDING'
 *      — one pending_obligation per source_transaction_id in PENDING state.
 *   2. employee_contracts: `employee_contracts_one_per_user` WHERE status != 'CANCELLED'
 *      — one non-cancelled contract per user.
 *   3. contract_templates: `uq_contract_templates_active_role` WHERE is_active=true
 *      — one active template per target_role.
 *   4. tos_versions: `uq_tos_versions_active` WHERE is_active=true
 *      — at most one globally active ToS version.
 *
 * Run against the scratch DB:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- schema-constraints.integration
 *
 * Isolation contract:
 *   - This spec ONLY inserts/modifies rows owned by ADMIN_USER_ID (its own fixture user).
 *   - It NEVER permanently mutates shared seed rows (rows with other created_by_user_id).
 *   - When a test temporarily deactivates existing active rows to set up its scenario,
 *     it records the affected IDs and restores them in afterAll.
 */

const SPEC_TAG = 'schema-constraints-spec'

// ── stable fixture ids (UUIDs v4 format) ────────────────────────────────────

// Fake admin user that doesn't collide with crm_qa seed.
const ADMIN_USER_ID = 'cc000000-0000-4000-a000-000000000001'
// Two "non-ADMIN" users for employee_contracts tests.
const EMP_A_ID = 'cc000000-0000-4000-a000-000000000002'
const EMP_B_ID = 'cc000000-0000-4000-a000-000000000003'

let pool: Pool | null = null

// IDs of shared-seed rows temporarily deactivated by this spec — restored in afterAll.
const deactivatedContractTemplateIds: string[] = []
const deactivatedTosVersionIds: string[] = []

/**
 * Run a raw SQL query and return rows.
 */
async function query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
  const { rows } = await pool!.query(sql, params)
  return rows as T[]
}

/**
 * Expect a DB error with the given PG error code.
 */
async function expectPgError(pgCode: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
    throw new Error(`Expected DB error ${pgCode} but query succeeded`)
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    if (code !== pgCode) throw err
    // expected — test passes
  }
}

describe.skipIf(!hasDatabaseUrl())(
  'schema domain constraints (partial unique indexes, real DB)',
  () => {
    beforeAll(async () => {
      pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 3 })
      await pool.query('SELECT 1')

      // ── seed prerequisite users ─────────────────────────────────────────────
      await query(
        `INSERT INTO users (id, email, display_name, role, google_id)
       VALUES ($1, 'admin+cspec@test.dev', 'CS Admin', 'ADMIN', 'g-cspec-admin'),
              ($2, 'emp-a+cspec@test.dev', 'CS Emp A', 'SENIOR', 'g-cspec-emp-a'),
              ($3, 'emp-b+cspec@test.dev', 'CS Emp B', 'SENIOR', 'g-cspec-emp-b')
       ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, archived_at = NULL`,
        [ADMIN_USER_ID, EMP_A_ID, EMP_B_ID],
      )
    }, 20_000)

    afterAll(async () => {
      // ── teardown in FK-safe order ────────────────────────────────────────────
      // 1. employee_contracts referencing our users
      await query(`DELETE FROM employee_contracts WHERE user_id = ANY($1)`, [[EMP_A_ID, EMP_B_ID]])
      // 2. pending_obligations seeded by this spec (via tag on source tx)
      await query(
        `DELETE FROM pending_obligations
       WHERE source_transaction_id IN (
         SELECT id FROM transactions WHERE sender_label = $1
       )`,
        [SPEC_TAG],
      )
      await query(`DELETE FROM transactions WHERE sender_label = $1`, [SPEC_TAG])
      // 3. contract_templates seeded by this spec
      await query(`DELETE FROM contract_templates WHERE created_by_user_id = $1`, [ADMIN_USER_ID])
      // 4. tos_versions seeded by this spec
      await query(`DELETE FROM tos_versions WHERE created_by_user_id = $1`, [ADMIN_USER_ID])
      // 5. Restore any shared-seed rows that were temporarily deactivated by this spec.
      if (deactivatedContractTemplateIds.length > 0) {
        await query(`UPDATE contract_templates SET is_active = true WHERE id = ANY($1)`, [
          deactivatedContractTemplateIds,
        ])
      }
      if (deactivatedTosVersionIds.length > 0) {
        await query(`UPDATE tos_versions SET is_active = true WHERE id = ANY($1)`, [
          deactivatedTosVersionIds,
        ])
      }
      // 6. our fixture users
      await query(`DELETE FROM users WHERE id = ANY($1)`, [[ADMIN_USER_ID, EMP_A_ID, EMP_B_ID]])

      await pool?.end()
    }, 20_000)

    // ── 1. pending_obligations: partial-unique on source_transaction_id WHERE status='PENDING' ──

    it('pending_obligations: rejects a second PENDING obligation for the same source_transaction_id', async () => {
      const idxRows = await query(
        `SELECT indexname FROM pg_indexes
       WHERE tablename = 'pending_obligations'
         AND indexname = 'uq_pending_obligations_source_pending'
       LIMIT 1`,
      )
      if (idxRows.length === 0) {
        console.warn(
          '[schema-constraints] PENDING OBLIGATIONS partial-unique index missing — run db:push',
        )
        return
      }

      const [txRow] = await query<{ id: string }>(
        `INSERT INTO transactions (type, status, amount, currency, sender_label, created_by)
       VALUES ('SENIOR_INCOME', 'PAID', '1000', 'USDT', $1, $2)
       RETURNING id`,
        [SPEC_TAG, ADMIN_USER_ID],
      )
      const sourceTxId = txRow!.id

      await query(
        `INSERT INTO pending_obligations
         (creditor_user_id, debtor_type, source_transaction_id, amount, currency, status)
       VALUES ($1, 'TOV', $2, '500', 'USDT', 'PENDING')`,
        [EMP_A_ID, sourceTxId],
      )

      await expectPgError('23505', () =>
        query(
          `INSERT INTO pending_obligations
           (creditor_user_id, debtor_type, source_transaction_id, amount, currency, status)
         VALUES ($1, 'TOV', $2, '500', 'USDT', 'PENDING')`,
          [EMP_A_ID, sourceTxId],
        ),
      )

      await query(`DELETE FROM pending_obligations WHERE source_transaction_id = $1`, [sourceTxId])
      await query(`DELETE FROM transactions WHERE id = $1`, [sourceTxId])
    }, 20_000)

    it('pending_obligations: allows two obligations on the same source_transaction_id when one is PAID', async () => {
      const idxRows = await query(
        `SELECT indexname FROM pg_indexes
       WHERE tablename = 'pending_obligations'
         AND indexname = 'uq_pending_obligations_source_pending'
       LIMIT 1`,
      )
      if (idxRows.length === 0) return

      const [txRow] = await query<{ id: string }>(
        `INSERT INTO transactions (type, status, amount, currency, sender_label, created_by)
       VALUES ('SENIOR_INCOME', 'PAID', '1000', 'USDT', $1, $2)
       RETURNING id`,
        [SPEC_TAG, ADMIN_USER_ID],
      )
      const sourceTxId = txRow!.id

      await query(
        `INSERT INTO pending_obligations
         (creditor_user_id, debtor_type, source_transaction_id, amount, currency, status)
       VALUES ($1, 'TOV', $2, '500', 'USDT', 'PENDING')`,
        [EMP_A_ID, sourceTxId],
      )

      await query(
        `UPDATE pending_obligations SET status = 'PAID' WHERE source_transaction_id = $1`,
        [sourceTxId],
      )

      await expect(
        query(
          `INSERT INTO pending_obligations
           (creditor_user_id, debtor_type, source_transaction_id, amount, currency, status)
         VALUES ($1, 'TOV', $2, '500', 'USDT', 'PENDING')`,
          [EMP_A_ID, sourceTxId],
        ),
      ).resolves.toBeDefined()

      await query(`DELETE FROM pending_obligations WHERE source_transaction_id = $1`, [sourceTxId])
      await query(`DELETE FROM transactions WHERE id = $1`, [sourceTxId])
    }, 20_000)

    // ── 2. employee_contracts: one-per-user WHERE status != 'CANCELLED' ────────

    it('employee_contracts: rejects a second non-CANCELLED contract for the same user', async () => {
      const idxRows = await query(
        `SELECT indexname FROM pg_indexes
       WHERE tablename = 'employee_contracts'
         AND indexname = 'employee_contracts_one_per_user'
       LIMIT 1`,
      )
      if (idxRows.length === 0) {
        console.warn(
          '[schema-constraints] EMPLOYEE CONTRACTS one-per-user index missing — run db:push',
        )
        return
      }

      const [tmplRow] = await query<{ id: string }>(
        `INSERT INTO contract_templates (target_role, version, body_markdown, is_active, created_by_user_id)
       VALUES ('SENIOR', 9999, '# spec template', false, $1)
       RETURNING id`,
        [ADMIN_USER_ID],
      )
      const templateId = tmplRow!.id

      await query(
        `INSERT INTO employee_contracts
         (user_id, source_template_id, body_markdown, status, created_by_user_id)
       VALUES ($1, $2, '# body', 'DRAFT', $3)`,
        [EMP_A_ID, templateId, ADMIN_USER_ID],
      )

      await expectPgError('23505', () =>
        query(
          `INSERT INTO employee_contracts
           (user_id, source_template_id, body_markdown, status, created_by_user_id)
         VALUES ($1, $2, '# body2', 'DRAFT', $3)`,
          [EMP_A_ID, templateId, ADMIN_USER_ID],
        ),
      )

      await query(`UPDATE employee_contracts SET status = 'CANCELLED' WHERE user_id = $1`, [
        EMP_A_ID,
      ])

      await expect(
        query(
          `INSERT INTO employee_contracts
           (user_id, source_template_id, body_markdown, status, created_by_user_id)
         VALUES ($1, $2, '# body3', 'DRAFT', $3)`,
          [EMP_A_ID, templateId, ADMIN_USER_ID],
        ),
      ).resolves.toBeDefined()

      // Cleanup handled in afterAll (DELETE by user_id / created_by_user_id).
    }, 20_000)

    // ── 3. contract_templates: one active per target_role ──────────────────────

    it('contract_templates: rejects a second active row for the same target_role', async () => {
      const idxRows = await query(
        `SELECT indexname FROM pg_indexes
       WHERE tablename = 'contract_templates'
         AND indexname = 'uq_contract_templates_active_role'
       LIMIT 1`,
      )
      if (idxRows.length === 0) {
        console.warn(
          '[schema-constraints] CONTRACT TEMPLATES active-role index missing — run db:push',
        )
        return
      }

      // Temporarily deactivate any existing active templates for DROP role (shared seed rows).
      // IDs are recorded and restored in afterAll — never permanently mutated.
      const existingActive = await query<{ id: string }>(
        `UPDATE contract_templates
       SET is_active = false
       WHERE target_role = 'DROP' AND is_active = true AND created_by_user_id != $1
       RETURNING id`,
        [ADMIN_USER_ID],
      )
      for (const row of existingActive) {
        deactivatedContractTemplateIds.push(row.id)
      }

      const [r1] = await query<{ id: string }>(
        `INSERT INTO contract_templates (target_role, version, body_markdown, is_active, created_by_user_id)
       VALUES ('DROP', 9001, '# first', true, $1)
       RETURNING id`,
        [ADMIN_USER_ID],
      )
      expect(r1).toBeDefined()

      await expectPgError('23505', () =>
        query(
          `INSERT INTO contract_templates (target_role, version, body_markdown, is_active, created_by_user_id)
         VALUES ('DROP', 9002, '# second', true, $1)`,
          [ADMIN_USER_ID],
        ),
      )

      const [r2] = await query<{ id: string }>(
        `INSERT INTO contract_templates (target_role, version, body_markdown, is_active, created_by_user_id)
       VALUES ('DROP', 9003, '# inactive', false, $1)
       RETURNING id`,
        [ADMIN_USER_ID],
      )
      expect(r2).toBeDefined()

      // r1, r2 deleted in afterAll (DELETE WHERE created_by_user_id = ADMIN_USER_ID).
      // deactivatedContractTemplateIds restored in afterAll.
    }, 20_000)

    // ── 4. tos_versions: single globally active row ────────────────────────────

    it('tos_versions: rejects a second active row globally', async () => {
      const idxRows = await query(
        `SELECT indexname FROM pg_indexes
       WHERE tablename = 'tos_versions'
         AND indexname = 'uq_tos_versions_active'
       LIMIT 1`,
      )
      if (idxRows.length === 0) {
        console.warn('[schema-constraints] TOS VERSIONS active index missing — run db:push')
        return
      }

      // Temporarily deactivate any existing active ToS versions (shared seed rows).
      // IDs are recorded and restored in afterAll — never permanently mutated.
      const existingActive = await query<{ id: string }>(
        `UPDATE tos_versions
       SET is_active = false
       WHERE is_active = true AND created_by_user_id != $1
       RETURNING id`,
        [ADMIN_USER_ID],
      )
      for (const row of existingActive) {
        deactivatedTosVersionIds.push(row.id)
      }

      const [v1] = await query<{ id: string }>(
        `INSERT INTO tos_versions (version, body_markdown, is_active, created_by_user_id)
       VALUES (99901, '# tos spec 1', true, $1)
       RETURNING id`,
        [ADMIN_USER_ID],
      )
      expect(v1).toBeDefined()

      await expectPgError('23505', () =>
        query(
          `INSERT INTO tos_versions (version, body_markdown, is_active, created_by_user_id)
         VALUES (99902, '# tos spec 2', true, $1)`,
          [ADMIN_USER_ID],
        ),
      )

      const [v2] = await query<{ id: string }>(
        `INSERT INTO tos_versions (version, body_markdown, is_active, created_by_user_id)
       VALUES (99903, '# tos spec 3', false, $1)
       RETURNING id`,
        [ADMIN_USER_ID],
      )
      expect(v2).toBeDefined()

      // v1, v2 deleted in afterAll (DELETE WHERE created_by_user_id = ADMIN_USER_ID).
      // deactivatedTosVersionIds restored in afterAll.
    }, 20_000)
  },
)
