/**
 * FK integrity regression test — catches orphaned user FK references.
 *
 * Background: Migration 0028 originally used DISABLE TRIGGER ALL which
 * bypassed FK enforcement during the nil-UUID admin DELETE, leaving silent
 * orphaned references in documents.owner_id (13 rows) and
 * projects.senior_id (4 rows) on the live crm_db (2026-06-04).
 *
 * This test connects to the configured DATABASE_URL and asserts that ZERO
 * rows in any FK column referencing users still point to the legacy nil-UUID
 * admin IDs ('00000000-...-000001', '00000000-...-000002').
 *
 * Additionally it verifies the structural invariant: no FK column in any
 * table contains a user UUID that does not exist in users.id. This catches
 * any future migration that might introduce orphans via DISABLE TRIGGER ALL,
 * pg_dump/restore without FK checks, or manual edits.
 *
 * Test is skipped automatically when DATABASE_URL is absent (CI without DB).
 * Run locally: pnpm --filter @crm/api test -- fk-integrity
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'

// All FK columns referencing users.id, derived from information_schema query
// executed on 2026-06-04. Must be updated when new FK columns are added.
const FK_COLUMNS: Array<{ table: string; column: string }> = [
  { table: 'contract_templates', column: 'created_by_user_id' },
  { table: 'documents', column: 'uploaded_by' },
  { table: 'documents', column: 'deleted_by' },
  { table: 'documents', column: 'owner_id' },
  { table: 'interviews', column: 'senior_id' },
  { table: 'interviews', column: 'hr_id' },
  { table: 'invoice_signatures', column: 'signer_id' },
  { table: 'notifications', column: 'user_id' },
  { table: 'payout_requests', column: 'senior_id' },
  { table: 'pending_obligations', column: 'creditor_user_id' },
  { table: 'pending_obligations', column: 'debtor_user_id' },
  { table: 'project_audit_log', column: 'actor_id' },
  { table: 'project_finance_settings', column: 'updated_by' },
  { table: 'project_members', column: 'user_id' },
  { table: 'projects', column: 'senior_id' },
  { table: 'projects', column: 'drop_id' },
  { table: 'signed_contracts', column: 'user_id' },
  { table: 'team_audit_log', column: 'actor_id' },
  { table: 'team_members', column: 'user_id' },
  { table: 'tos_acceptances', column: 'user_id' },
  { table: 'tos_versions', column: 'created_by_user_id' },
  { table: 'transactions', column: 'recipient_id' },
  { table: 'transactions', column: 'receiver_id' },
  { table: 'transactions', column: 'validated_by' },
  { table: 'transactions', column: 'created_by' },
  { table: 'transactions', column: 'sender_id' },
  { table: 'user_audit_log', column: 'actor_id' },
  { table: 'user_audit_log', column: 'target_id' },
]

// Legacy nil-UUID admin IDs that must NOT appear in any FK column after 0028.
const NIL_UUID_PREFIXES = [
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
]

const DATABASE_URL = process.env['DATABASE_URL']

describe.skipIf(!DATABASE_URL)(
  'FK integrity — user references (regression for 0028 orphan bug)',
  () => {
    let pool: Pool

    beforeAll(() => {
      pool = new Pool({ connectionString: DATABASE_URL })
    })

    afterAll(async () => {
      await pool.end()
    })

    it('no FK column contains legacy nil-UUID admin IDs (00000000-...-001/002)', async () => {
      const orphansByColumn: string[] = []

      for (const { table, column } of FK_COLUMNS) {
        for (const nilUuid of NIL_UUID_PREFIXES) {
          const result = await pool.query<{ cnt: string }>(
            `SELECT COUNT(*)::text AS cnt FROM ${table} WHERE ${column}::text = $1`,
            [nilUuid],
          )
          const count = parseInt(result.rows[0]?.cnt ?? '0', 10)
          if (count > 0) {
            orphansByColumn.push(`${table}.${column} has ${count} rows pointing to ${nilUuid}`)
          }
        }
      }

      expect(
        orphansByColumn,
        `Orphaned FK references found:\n${orphansByColumn.join('\n')}`,
      ).toEqual([])
    })

    it('no FK column contains any user UUID not present in users.id (full referential integrity scan)', async () => {
      const broken: string[] = []

      for (const { table, column } of FK_COLUMNS) {
        // Only check non-null values — SET NULL columns legitimately have NULLs
        const result = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt
         FROM ${table} t
         WHERE t.${column} IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM users u WHERE u.id = t.${column}
           )`,
        )
        const count = parseInt(result.rows[0]?.cnt ?? '0', 10)
        if (count > 0) {
          broken.push(`${table}.${column}: ${count} rows reference non-existent user IDs`)
        }
      }

      expect(broken, `Broken FK references (no matching users.id):\n${broken.join('\n')}`).toEqual(
        [],
      )
    })
  },
)
