/**
 * task 3 of docs/superpowers/specs/2026-09-01-notifications-and-confirmations-design.md
 * — mutation-gate closure for the `approvals` table declaration in `schema.ts`.
 *
 * Same structural gap as `sender-receiver-check-schema.spec.ts` /
 * `source-income-drop-link-schema.spec.ts`: nothing in `approvals.service.ts`
 * (or its unit spec) ever READS the compiled Drizzle object's constraint
 * names, index predicates, or FK targets — the application code only
 * builds/runs queries against the table, it never introspects its own DDL.
 * `approvals.integration.spec.ts` proves the constraints work against a REAL
 * Postgres, but is excluded from the unit/mutation run entirely
 * (`describe.skipIf(!hasDatabaseUrl())`). Stryker's TypeScript-level mutants
 * on the DDL literals themselves (constraint names, index names, WHERE
 * predicates, enum values, FK targets) are invisible to both.
 *
 * UNLIKE the two precedents above, this spec does NOT compare against a
 * `drizzle/manual/*.sql` migration file — none exists yet. The table's prod
 * DDL is deliberately deferred (see the "Prod DDL intentionally deferred"
 * comment on `approvals` in `schema.ts`): nothing in prod depends on this
 * table until a later position in the plan wires a real subject against it.
 * When that migration file is written, this spec should be upgraded to a
 * two-sided comparison the same way the precedents do — until then, the
 * hardcoded expected strings below ARE the second, independent source (typed
 * directly here, never derived from `schema.ts`'s own text).
 *
 * Pure unit spec — no live DB needed; `getTableConfig` / `PgDialect#sqlToQuery`
 * are pure compile-time introspection, the `Pool` below is never `.connect()`-ed.
 */
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import * as schema from './schema'
import { approvals, approvalStatusEnum, users } from './schema'

/** Strips quoting/table-qualification/whitespace differences so formatting
 * doesn't fail the compare — mirrors sender-receiver-check-schema.spec.ts's
 * `normalize`. */
function normalize(sqlFragment: string): string {
  return sqlFragment
    .replace(/"/g, '')
    .replace(/\bapprovals\./gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

describe('approvals — schema.ts DDL (mutation-gate closure)', () => {
  it('approvalStatusEnum carries the real three values, not an empty/mutated array', () => {
    expect([...approvalStatusEnum.enumValues]).toEqual(['PENDING', 'APPROVED', 'REJECTED'])
  })

  it('subjectType compiles to the real column name subject_type', () => {
    const { columns } = getTableConfig(approvals)
    expect(columns.map((c) => c.name)).toContain('subject_type')
  })

  it('approverUserId FK references users.id (kills the ()=>undefined mutant)', () => {
    const { foreignKeys } = getTableConfig(approvals)
    const fk = foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === 'approver_user_id'),
    )
    expect(fk, 'expected a foreign key on approvals.approver_user_id').not.toBeUndefined()
    const ref = fk!.reference()
    expect(ref.foreignTable).toBe(users)
    expect(ref.foreignColumns.map((c) => c.name)).toEqual(['id'])
  })

  it('proposedByUserId FK references users.id (kills the ()=>undefined mutant)', () => {
    const { foreignKeys } = getTableConfig(approvals)
    const fk = foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === 'proposed_by_user_id'),
    )
    expect(fk, 'expected a foreign key on approvals.proposed_by_user_id').not.toBeUndefined()
    const ref = fk!.reference()
    expect(ref.foreignTable).toBe(users)
    expect(ref.foreignColumns.map((c) => c.name)).toEqual(['id'])
  })

  it('carries exactly the three declared indexes/constraints (kills the (t)=>[] mutant)', () => {
    const { indexes, checks } = getTableConfig(approvals)
    expect(indexes.map((i) => i.config.name).sort()).toEqual(
      [
        'idx_approvals_approver_pending',
        'idx_approvals_subject',
        'uq_approvals_live_subject_approver',
      ].sort(),
    )
    expect(checks.map((c) => c.name).sort()).toEqual(
      ['ck_approvals_decided_at_matches_status', 'ck_approvals_rejection_reason_required'].sort(),
    )
  })

  it("idx_approvals_approver_pending's WHERE clause is the real predicate, not empty", () => {
    const { indexes } = getTableConfig(approvals)
    const idx = indexes.find((i) => i.config.name === 'idx_approvals_approver_pending')!
    expect(idx.config.where, 'the partial index must carry a WHERE condition').toBeDefined()
    const compiled = new PgDialect().sqlToQuery(idx.config.where!, 'indexes')
    const sql = normalize(compiled.sql)
    expect(sql.length).toBeGreaterThan(0)
    expect(sql).toBe("status = 'pending' and superseded_at is null")
  })

  it('uq_approvals_live_subject_approver is UNIQUE with the real (non-empty) WHERE clause', () => {
    const { indexes } = getTableConfig(approvals)
    const idx = indexes.find((i) => i.config.name === 'uq_approvals_live_subject_approver')!
    expect(idx.config.unique).toBe(true)
    expect(idx.config.where, 'the partial unique index must carry a WHERE condition').toBeDefined()
    const compiled = new PgDialect().sqlToQuery(idx.config.where!, 'indexes')
    const sql = normalize(compiled.sql)
    expect(sql.length).toBeGreaterThan(0)
    expect(sql).toBe('superseded_at is null')
  })

  it('ck_approvals_rejection_reason_required compiles to the real (non-empty) predicate', () => {
    const { checks } = getTableConfig(approvals)
    const check = checks.find((c) => c.name === 'ck_approvals_rejection_reason_required')!
    const compiled = new PgDialect().sqlToQuery(check.value)
    const sql = normalize(compiled.sql)
    expect(sql.length).toBeGreaterThan(0)
    expect(sql).toBe(
      "status <> 'rejected' or (rejection_reason is not null and btrim(rejection_reason) <> '')",
    )
  })

  it('ck_approvals_decided_at_matches_status compiles to the real (non-empty) predicate', () => {
    const { checks } = getTableConfig(approvals)
    const check = checks.find((c) => c.name === 'ck_approvals_decided_at_matches_status')!
    const compiled = new PgDialect().sqlToQuery(check.value)
    const sql = normalize(compiled.sql)
    expect(sql.length).toBeGreaterThan(0)
    expect(sql).toBe("(status = 'pending') = (decided_at is null)")
  })

  it('sanity: the compiled table + Pool never actually connect (pure introspection, no live DB required)', () => {
    const pool = new Pool({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused' })
    const db = drizzle(pool, { schema })
    expect(db).toBeDefined()
  })
})
