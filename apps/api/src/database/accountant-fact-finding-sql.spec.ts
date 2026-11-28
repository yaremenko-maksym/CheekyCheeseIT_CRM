import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Manager-role plan PR 1a AC 1: the owner-run ACCOUNTANT fact-finding file is read-only. It is run
 * on prod by hand, so a write keyword in it is a write to the live database, and anything that ends
 * the read-only transaction early or acts outside it (sequences, settings, other backends, large
 * objects, dblink, COPY) defeats the guarantee.
 */
const FILE = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual-private',
  '2026-11-27_accountant_fact_finding.sql',
)

/** Each rule names what it refuses; a match anywhere in the comment-free SQL is a violation. */
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  [
    'write keyword',
    /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|COMMIT|COPY|MERGE|CALL|DO)\b/i,
  ],
  ['SET TRANSACTION', /\bSET\s+TRANSACTION\b/i],
  ['SET SESSION CHARACTERISTICS', /\bSET\s+SESSION\s+CHARACTERISTICS\b/i],
  ['read-only setting', /\b(default_)?transaction_read_only\b/i],
  ['set_config(', /\bset_config\s*\(/i],
  ['setval(', /\bsetval\s*\(/i],
  ['nextval(', /\bnextval\s*\(/i],
  ['pg_terminate_backend(', /\bpg_terminate_backend\s*\(/i],
  ['pg_cancel_backend(', /\bpg_cancel_backend\s*\(/i],
  ['dblink', /\bdblink/i],
  ['lo_', /\blo_\w*/i],
]

/** A statement that ends the transaction. END is matched at statement start only (CASE ... END). */
const TRANSACTION_END = /^(COMMIT|END|ABORT|ROLLBACK)\b|\b(COMMIT|ABORT|ROLLBACK)\b/i

/** The SQL text without `--` line comments and block comments. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

/** The names of every read-only rule the SQL breaks; `[]` when it is read-only. */
function readOnlyViolations(sql: string): string[] {
  const code = stripComments(sql)
  const violations = FORBIDDEN.filter(([, re]) => re.test(code)).map(([name]) => name)
  const statements = code
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (statements.slice(0, -1).some((s) => TRANSACTION_END.test(s))) {
    violations.push('transaction end before the final statement')
  }
  if (!/^ROLLBACK$/i.test(statements.at(-1) ?? '')) {
    violations.push('final statement is not ROLLBACK')
  }
  return violations
}

const wrap = (body: string): string => `BEGIN TRANSACTION READ ONLY;\n${body};\nROLLBACK;\n`

describe('manual-private/2026-11-27_accountant_fact_finding.sql', () => {
  const sql = readFileSync(FILE, 'utf8')
  const code = stripComments(sql)

  it('opens a read-only transaction before any other statement', () => {
    expect(code.trimStart()).toMatch(/^BEGIN TRANSACTION READ ONLY;/)
  })

  it('breaks no read-only rule and ends with its only ROLLBACK', () => {
    expect(readOnlyViolations(sql)).toEqual([])
  })

  it('derives FK columns and role-typed columns from the catalog at run time', () => {
    expect(code).toContain('pg_constraint')
    expect(code).toContain("confrelid = 'users'::regclass")
    expect(code).toContain('query_to_xml')
    expect(code).toContain("'role'::regtype")
  })

  it('selects no email and no name', () => {
    expect(code).not.toMatch(/\b(email|name|full_name|first_name|last_name)\b/i)
  })
})

describe('readOnlyViolations', () => {
  it('accepts a read-only frame, a CASE ... END and rules named only in comments', () => {
    expect(
      readOnlyViolations(
        wrap('-- DELETE FROM users\n/* nextval(x) */ SELECT CASE WHEN true THEN 1 END'),
      ),
    ).toEqual([])
  })

  it.each([
    ['write keyword', 'DELETE FROM users'],
    ['write keyword', 'COPY users TO STDOUT'],
    ['SET TRANSACTION', 'SET TRANSACTION READ WRITE'],
    ['SET SESSION CHARACTERISTICS', 'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE'],
    ['read-only setting', 'SET LOCAL transaction_read_only = off'],
    ['set_config(', "SELECT set_config('transaction_read_only', 'off', true)"],
    ['setval(', "SELECT setval('users_seq', 1)"],
    ['nextval(', "SELECT nextval('users_seq')"],
    ['pg_terminate_backend(', 'SELECT pg_terminate_backend(42)'],
    ['pg_cancel_backend(', 'SELECT pg_cancel_backend(42)'],
    ['dblink', "SELECT * FROM dblink('host=x', 'DELETE FROM users') AS t(x int)"],
    ['lo_', 'SELECT lo_unlink(42)'],
  ])('flags %s: %s', (rule, body) => {
    expect(readOnlyViolations(wrap(body))).toContain(rule)
  })

  it.each([
    ['COMMIT', 'COMMIT'],
    ['END', 'END'],
    ['ABORT', 'ABORT'],
    ['ROLLBACK', 'ROLLBACK'],
  ])('flags %s before the final statement', (_kw, body) => {
    expect(readOnlyViolations(wrap(`${body}; SELECT 1`))).toContain(
      'transaction end before the final statement',
    )
  })

  it('flags a file whose final statement is not ROLLBACK', () => {
    expect(readOnlyViolations('BEGIN TRANSACTION READ ONLY;\nSELECT 1;\nCOMMIT;\n')).toContain(
      'final statement is not ROLLBACK',
    )
    expect(readOnlyViolations('BEGIN TRANSACTION READ ONLY;\nSELECT 1;\n')).toContain(
      'final statement is not ROLLBACK',
    )
  })
})
