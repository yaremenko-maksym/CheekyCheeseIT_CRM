/**
 * task-sender-receiver-invariant, mutation gate round 2 (backlog A-2). Two
 * mutants in `schema.ts`'s `ck_transactions_sender_ne_receiver` CHECK
 * declaration survived the CI mutation gate with zero test coverage:
 *   1. The constraint NAME string mutated to `''` — no test noticed (the
 *      real Postgres constraint would then be named something Drizzle
 *      never intended, and the manual-migration idempotency lookup by name
 *      in `2026-08-18_sender_receiver_invariant.sql` would silently stop
 *      matching it).
 *   2. The CHECK expression `sql\`${t.senderId} <> ${t.receiverId}\`` mutated
 *      to an empty `sql\`\`` — no test noticed the constraint would then
 *      compile to a syntactically-empty (effectively always-true / DDL-
 *      rejected) predicate instead of `sender_id <> receiver_id`.
 *
 * Both exist for the SAME structural reason as
 * `company-name-snapshot-schema.spec.ts` / `source-income-drop-link-schema
 * .spec.ts`: this constraint's own real-Postgres integration spec
 * (`sender-receiver-invariant.integration.spec.ts`) proves the LIVE
 * database behaviour, but is excluded from the unit/mutation run entirely
 * (`describe.skipIf(!hasDatabaseUrl())` — Stryker's default run carries no
 * DATABASE_URL). No unit spec ever reads the constraint's NAME or SQL text
 * off the compiled Drizzle object; the application code that calls
 * `selfPayError` never touches `schema.ts`'s CHECK declaration either. This
 * spec closes that gap the same way its two precedents do: compile
 * schema.ts's ACTUAL Drizzle object (never a hand-typed restatement) and
 * compare it against the prod migration file's literal DDL. Pure unit spec
 * — no live DB needed; `PgDialect#sqlToQuery` / `getTableConfig` are pure
 * compile-time introspection, the `Pool` below is never `.connect()`-ed.
 */
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import * as schema from './schema'
import { transactions } from './schema'

const MIGRATION_FILE = join(
  import.meta.dirname,
  '../../drizzle/manual/2026-08-18_sender_receiver_invariant.sql',
)

/** Mirrors source-income-drop-link-schema.spec.ts's `normalize` — strips
 * table-qualification/quoting/whitespace/case differences between the
 * compiled Drizzle SQL and the hand-written migration DDL. */
function normalize(sqlFragment: string): string {
  return sqlFragment
    .replace(/"/g, '')
    .replace(/\btransactions\./gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

describe('ck_transactions_sender_ne_receiver — schema.ts matches the prod migration file (mutation-gate closure)', () => {
  it("the constraint NAME is the real string, not empty (kills the StringLiteral→'' mutant)", () => {
    const { checks } = getTableConfig(transactions)
    const check = checks.find((c) => c.name === 'ck_transactions_sender_ne_receiver')
    expect(
      check,
      `expected a check constraint literally named 'ck_transactions_sender_ne_receiver' — ` +
        `got names: ${checks.map((c) => c.name).join(', ')}`,
    ).not.toBeUndefined()
  })

  it("the CHECK expression (compiled from the REAL schema.ts object) matches the prod migration file's literal predicate, and is not empty (kills the StringLiteral→empty-template mutant)", () => {
    const { checks } = getTableConfig(transactions)
    const check = checks.find((c) => c.name === 'ck_transactions_sender_ne_receiver')!

    // Side 1 — compile schema.ts's ACTUAL check expression SQL object.
    const compiled = new PgDialect().sqlToQuery(check.value)
    const tsCheckSql = normalize(compiled.sql)
    expect(tsCheckSql.length).toBeGreaterThan(0)

    // Side 2 — the prod migration file's literal CHECK predicate.
    const migrationSql = readFileSync(MIGRATION_FILE, 'utf-8')
    const ddlMatch =
      /add\s+constraint\s+ck_transactions_sender_ne_receiver\s+check\s*\(([^)]+)\)\s*;/is.exec(
        migrationSql,
      )
    expect(
      ddlMatch,
      'expected to find "ADD CONSTRAINT ck_transactions_sender_ne_receiver CHECK (...)" in ' +
        "the migration file — if this fails, the file's DDL shape changed and this spec's " +
        'extraction regex needs updating too.',
    ).not.toBeNull()
    const migrationCheckSql = normalize(ddlMatch![1]!)

    // Both sides, independently derived, must express the SAME predicate —
    // kills the empty-expression mutant (an empty tsCheckSql can never equal
    // the non-empty migration text) without hand-retyping either side.
    expect(tsCheckSql).toBe(migrationCheckSql)
    // Pin the expected shape too — catches BOTH sides drifting together to
    // something else (e.g. someone "fixing" this to IS DISTINCT FROM, which
    // the task's own AC2 proved is the WRONG semantics — see the doc comment
    // on this constraint in schema.ts for the full three-valued-logic proof).
    expect(tsCheckSql).toBe('sender_id <> receiver_id')
  })

  it('sanity: the compiled table + Pool never actually connect (pure introspection, no live DB required)', () => {
    const pool = new Pool({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused' })
    const db = drizzle(pool, { schema })
    expect(db).toBeDefined()
  })
})
