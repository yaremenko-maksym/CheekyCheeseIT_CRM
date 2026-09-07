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
 * CR-H-3 (code-review, PR #624): an earlier revision of this file hardcoded
 * the "expected" WHERE/CHECK strings by hand, because
 * `drizzle/manual/2026-09-01_approvals.sql` didn't exist yet when it was
 * written — its own comment said to upgrade to a two-sided comparison once
 * that migration landed. It now ships in the SAME PR (see the header
 * comment on `approvals` in schema.ts), so this spec is upgraded the same
 * way its precedents (`sender-receiver-check-schema.spec.ts`,
 * `senior-drop-income-idempotency-schema.spec.ts`) already do: compile
 * schema.ts's ACTUAL Drizzle object (never a hand-typed restatement) and
 * compare it against the prod migration file's literal DDL.
 *
 * `ck_approvals_decided_at_matches_status`'s predicate nests its own parens
 * (`(status = 'PENDING') = (decided_at IS NULL)`), and
 * `ck_approvals_rejection_reason_required`'s nests a function call
 * (`btrim(rejection_reason)`) — the precedents' simple `\(([^)]+)\)` capture
 * stops at the FIRST `)`, which would truncate either one.
 * `checkPredicateFromMigration` below does a balanced-paren scan instead, so
 * it extracts the full predicate regardless of nesting.
 *
 * Pure unit spec — no live DB needed; `getTableConfig` / `PgDialect#sqlToQuery`
 * are pure compile-time introspection, the `Pool` below is never `.connect()`-ed.
 */
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import * as schema from './schema'
import { approvals, approvalStatusEnum, users } from './schema'

const MIGRATION_FILE = join(import.meta.dirname, '../../drizzle/manual/2026-09-01_approvals.sql')
/** task-648-fix-round-1 (SR-H-1) — adds CANCELLED via `ALTER TYPE … ADD
 * VALUE`, on top of the CREATE TYPE in MIGRATION_FILE above. Two files, one
 * enum: `enumValuesFromMigration` below reads both, in migration order. */
const CANCELLED_MIGRATION_FILE = join(
  import.meta.dirname,
  '../../drizzle/manual/2026-09-04_approval_status_cancelled.sql',
)

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

/**
 * Extracts the balanced-paren predicate immediately following
 * `ADD CONSTRAINT <constraintName> CHECK (`. A plain `[^)]+` capture (the
 * shortcut `sender-receiver-check-schema.spec.ts` uses) is correct only for
 * a FLAT predicate — `ck_approvals_decided_at_matches_status` and
 * `ck_approvals_rejection_reason_required` both nest their own parens (see
 * the file header), so this counts depth instead of stopping at the first
 * `)`.
 */
function checkPredicateFromMigration(constraintName: string): string {
  const migrationSql = readFileSync(MIGRATION_FILE, 'utf-8')
  const headMatch = new RegExp(`add\\s+constraint\\s+${constraintName}\\s+check\\s*\\(`, 'is').exec(
    migrationSql,
  )
  expect(
    headMatch,
    `expected to find "ADD CONSTRAINT ${constraintName} CHECK (" in the migration file — ` +
      "if this fails, the file's DDL shape changed and this spec's extraction needs updating too.",
  ).not.toBeNull()

  const openParenIndex = headMatch!.index + headMatch![0]!.length - 1
  let depth = 0
  for (let i = openParenIndex; i < migrationSql.length; i += 1) {
    if (migrationSql[i] === '(') depth += 1
    else if (migrationSql[i] === ')') {
      depth -= 1
      if (depth === 0) return normalize(migrationSql.slice(openParenIndex + 1, i))
    }
  }
  throw new Error(`unbalanced parens extracting ${constraintName} from the migration file`)
}

/** Mirrors senior-drop-income-idempotency-schema.spec.ts's WHERE-clause
 * extraction, adapted for the `approvals` table and an optional UNIQUE
 * index. approvals' index WHERE clauses (unlike the CHECK predicates above)
 * carry no nested parens, so a plain "up to `;`" capture is exact. */
function whereClauseFromMigration(indexName: string, unique: boolean): string {
  const migrationSql = readFileSync(MIGRATION_FILE, 'utf-8')
  const uniqueToken = unique ? 'unique\\s+' : ''
  const ddlMatch = new RegExp(
    `create\\s+${uniqueToken}index\\s+if\\s+not\\s+exists\\s+${indexName}\\s+on\\s+approvals\\s*\\([^)]*\\)\\s*where\\s+([^;]+);`,
    'is',
  ).exec(migrationSql)
  expect(
    ddlMatch,
    `expected to find "CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${indexName} ON ` +
      'approvals (...) WHERE ...;" in the migration file — if this fails, the file\'s DDL shape ' +
      "changed and this spec's extraction regex needs updating too.",
  ).not.toBeNull()
  return normalize(ddlMatch![1]!)
}

/** The migration file's literal `CREATE TYPE approval_status AS ENUM (...)` values. */
function enumValuesFromCreateType(): string[] {
  const migrationSql = readFileSync(MIGRATION_FILE, 'utf-8')
  const ddlMatch = /create\s+type\s+approval_status\s+as\s+enum\s*\(([^)]+)\)\s*;/is.exec(
    migrationSql,
  )
  expect(
    ddlMatch,
    'expected to find "CREATE TYPE approval_status AS ENUM (...)" in the migration file — ' +
      "if this fails, the file's DDL shape changed and this spec's extraction regex needs updating too.",
  ).not.toBeNull()
  return ddlMatch![1]!.split(',').map((v) => v.trim().replace(/^'|'$/g, ''))
}

/** `CANCELLED_MIGRATION_FILE`'s literal `ALTER TYPE approval_status ADD VALUE
 * [IF NOT EXISTS] '...'` value — task-648-fix-round-1 (SR-H-1). Postgres enum
 * values can only be ADDed, never dropped/reordered, so appending this one
 * value onto `enumValuesFromCreateType()`'s result is exactly what the live
 * type looks like after both migrations run, in order. */
function enumValueFromAlterType(): string {
  const migrationSql = readFileSync(CANCELLED_MIGRATION_FILE, 'utf-8')
  const ddlMatch =
    /alter\s+type\s+approval_status\s+add\s+value\s+(if\s+not\s+exists\s+)?'([^']+)'\s*;/is.exec(
      migrationSql,
    )
  expect(
    ddlMatch,
    'expected to find "ALTER TYPE approval_status ADD VALUE [IF NOT EXISTS] \'...\'" in ' +
      "the migration file — if this fails, the file's DDL shape changed and this spec's " +
      'extraction regex needs updating too.',
  ).not.toBeNull()
  return ddlMatch![2]!
}

/** The full, live `approval_status` enum: the original CREATE TYPE values
 * (MIGRATION_FILE) followed by every value since ADDed by a later ALTER TYPE
 * (CANCELLED_MIGRATION_FILE) — matches schema.ts's `approvalStatusEnum`
 * exactly, or this spec fails and says why. */
function enumValuesFromMigration(): string[] {
  return [...enumValuesFromCreateType(), enumValueFromAlterType()]
}

describe('approvals — schema.ts DDL (mutation-gate closure)', () => {
  it('approvalStatusEnum carries the real four values, matching the prod migration files CREATE TYPE + ALTER TYPE (not an empty/mutated array)', () => {
    expect([...approvalStatusEnum.enumValues]).toEqual([
      'PENDING',
      'APPROVED',
      'REJECTED',
      'CANCELLED',
    ])
    expect([...approvalStatusEnum.enumValues]).toEqual(enumValuesFromMigration())
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

  it("idx_approvals_approver_pending's WHERE clause (compiled from the REAL schema.ts object) matches the prod migration file's literal WHERE clause, and is not empty", () => {
    const { indexes } = getTableConfig(approvals)
    const idx = indexes.find((i) => i.config.name === 'idx_approvals_approver_pending')!
    expect(idx.config.where, 'the partial index must carry a WHERE condition').toBeDefined()

    // Side 1 — compile schema.ts's ACTUAL where-clause SQL object.
    const compiled = new PgDialect().sqlToQuery(idx.config.where!, 'indexes')
    const tsSql = normalize(compiled.sql)
    expect(tsSql.length).toBeGreaterThan(0)

    // Side 2 — the prod migration file's literal WHERE clause.
    const migrationSql = whereClauseFromMigration('idx_approvals_approver_pending', false)

    // Both sides, independently derived, must express the SAME predicate —
    // kills the empty-WHERE mutant without hand-retyping either side.
    expect(tsSql).toBe(migrationSql)
    expect(tsSql).toBe("status = 'pending' and superseded_at is null")
  })

  it('uq_approvals_live_subject_approver is UNIQUE, and its WHERE clause (compiled from the REAL schema.ts object) matches the prod migration file literal WHERE clause', () => {
    const { indexes } = getTableConfig(approvals)
    const idx = indexes.find((i) => i.config.name === 'uq_approvals_live_subject_approver')!
    expect(idx.config.unique).toBe(true)
    expect(idx.config.where, 'the partial unique index must carry a WHERE condition').toBeDefined()

    const compiled = new PgDialect().sqlToQuery(idx.config.where!, 'indexes')
    const tsSql = normalize(compiled.sql)
    expect(tsSql.length).toBeGreaterThan(0)

    const migrationSql = whereClauseFromMigration('uq_approvals_live_subject_approver', true)

    expect(tsSql).toBe(migrationSql)
    expect(tsSql).toBe('superseded_at is null')
  })

  it("ck_approvals_rejection_reason_required (compiled from the REAL schema.ts object) matches the prod migration file's literal predicate, and is not empty", () => {
    const { checks } = getTableConfig(approvals)
    const check = checks.find((c) => c.name === 'ck_approvals_rejection_reason_required')!

    const compiled = new PgDialect().sqlToQuery(check.value)
    const tsSql = normalize(compiled.sql)
    expect(tsSql.length).toBeGreaterThan(0)

    const migrationSql = checkPredicateFromMigration('ck_approvals_rejection_reason_required')

    expect(tsSql).toBe(migrationSql)
    expect(tsSql).toBe(
      "status <> 'rejected' or (rejection_reason is not null and btrim(rejection_reason) <> '')",
    )
  })

  it("ck_approvals_decided_at_matches_status (compiled from the REAL schema.ts object) matches the prod migration file's literal predicate, and is not empty", () => {
    const { checks } = getTableConfig(approvals)
    const check = checks.find((c) => c.name === 'ck_approvals_decided_at_matches_status')!

    const compiled = new PgDialect().sqlToQuery(check.value)
    const tsSql = normalize(compiled.sql)
    expect(tsSql.length).toBeGreaterThan(0)

    const migrationSql = checkPredicateFromMigration('ck_approvals_decided_at_matches_status')

    expect(tsSql).toBe(migrationSql)
    expect(tsSql).toBe("(status = 'pending') = (decided_at is null)")
  })

  it('sanity: the compiled table + Pool never actually connect (pure introspection, no live DB required)', () => {
    const pool = new Pool({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused' })
    const db = drizzle(pool, { schema })
    expect(db).toBeDefined()
  })
})
