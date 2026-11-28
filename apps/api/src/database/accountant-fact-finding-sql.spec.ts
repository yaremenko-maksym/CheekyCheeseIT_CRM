import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Manager-role plan PR 1a AC 1: the owner-run ACCOUNTANT fact-finding file is read-only. It is run
 * on prod by hand, so a write keyword in it is a write to the live database.
 */
const FILE = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual-private',
  '2026-11-27_accountant_fact_finding.sql',
)
const WRITE_KEYWORD =
  /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|COMMIT|COPY|MERGE|CALL|DO)\b/i

/** The SQL text without `--` line comments and block comments. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

describe('manual-private/2026-11-27_accountant_fact_finding.sql', () => {
  const code = stripComments(readFileSync(FILE, 'utf8'))

  it('opens a read-only transaction before any other statement', () => {
    expect(code.trimStart()).toMatch(/^BEGIN TRANSACTION READ ONLY;/)
  })

  it('contains no write keyword outside comments', () => {
    expect(code.match(new RegExp(WRITE_KEYWORD.source, 'gi'))).toBeNull()
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

  it('the matcher flags a write keyword outside a comment and ignores one inside', () => {
    expect(WRITE_KEYWORD.test(stripComments('SELECT 1; DELETE FROM users;'))).toBe(true)
    expect(
      WRITE_KEYWORD.test(stripComments('-- DELETE FROM users\n/* UPDATE x */ SELECT 1;')),
    ).toBe(false)
  })
})
