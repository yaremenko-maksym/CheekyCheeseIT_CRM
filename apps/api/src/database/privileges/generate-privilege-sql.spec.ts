/**
 * The committed privilege SQL is what the generator produces — and is applicable as
 * production applies it.
 *
 * The first half is a drift test: `2026-10-18_db_grants.sql` and
 * `2026-10-18_db_privileges_check.sql` are generated from `privilege-classes.ts`, and a
 * hand edit to either (or a manifest change without regenerating) is precisely the state
 * in which the check asserts a stale expectation and passes. One byte of difference fails
 * here, with the command that fixes it.
 *
 * The second half is about the file being APPLICABLE the way `deploy.yml` applies it:
 * statement-level autocommit, no psql meta-commands. `splitSqlStatements` throws on a
 * backslash command, so running it over both files proves they can be verified — and
 * applied — by sending statements to the server, which is what the integration spec then
 * does with the same bytes.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { splitSqlStatements } from '../manual-sql-statements'
import {
  CHECK_FILE,
  GRANTS_FILE,
  ROLES_FILE,
  buildCheckSql,
  buildGrantsSql,
} from './generate-privilege-sql'
import { PRIVILEGE_CLASSES, ROLES } from './privilege-classes'

const MANUAL_DIR = join(__dirname, '..', '..', '..', 'drizzle', 'manual')
const read = (file: string): string => readFileSync(join(MANUAL_DIR, file), 'utf8')

describe('generated privilege SQL', () => {
  it('matches the committed grants file', () => {
    expect(read(GRANTS_FILE)).toBe(buildGrantsSql())
  })

  it('matches the committed catalog-check file', () => {
    expect(read(CHECK_FILE)).toBe(buildCheckSql())
  })

  it('splits into statements the way psql does, with no meta-commands', () => {
    for (const file of [ROLES_FILE, GRANTS_FILE, CHECK_FILE]) {
      const statements = splitSqlStatements(read(file))
      expect({ file, statements: statements.length > 0 }).toEqual({ file, statements: true })
    }
  })

  it('wraps the grants in one explicit transaction', () => {
    // ADR §4: without the transaction every deploy re-grants UPDATE, DELETE on the
    // append-only log for the length of a few statements.
    // `splitSqlStatements` returns statements without their terminator, as psql sends them.
    const statements = splitSqlStatements(read(GRANTS_FILE)).map((s) => s.trim().toUpperCase())
    expect(statements.at(0)).toBe('BEGIN')
    expect(statements.at(-1)).toBe('COMMIT')
    expect(statements.filter((s) => s === 'BEGIN' || s === 'COMMIT')).toHaveLength(2)
  })

  it('revokes before it grants, so a hand-made grant on production does not survive', () => {
    const sql = read(GRANTS_FILE)
    const firstRevoke = sql.indexOf('REVOKE ALL PRIVILEGES ON ALL TABLES')
    const firstGrant = sql.indexOf('GRANT SELECT')
    expect(firstRevoke).toBeGreaterThan(-1)
    expect(firstGrant).toBeGreaterThan(firstRevoke)
  })

  it('never emits TRUNCATE, REFERENCES, TRIGGER or WITH GRANT OPTION in a GRANT', () => {
    const grants = splitSqlStatements(read(GRANTS_FILE)).filter((s) => /^\s*GRANT /.test(s))
    expect(grants.length).toBeGreaterThan(0)
    for (const statement of grants) {
      const subject = statement.slice(0, statement.indexOf(' ON '))
      expect({ statement: subject, bad: /TRUNCATE|REFERENCES|TRIGGER/.test(subject) }).toEqual({
        statement: subject,
        bad: false,
      })
      expect(/WITH GRANT OPTION/i.test(statement)).toBe(false)
    }
  })

  it('grants the append-only table SELECT and INSERT only', () => {
    const [appendOnly] = PRIVILEGE_CLASSES.B
    expect(appendOnly).toBeDefined()
    const grants = splitSqlStatements(read(GRANTS_FILE)).filter(
      (s) => /^\s*GRANT /.test(s) && s.includes(`public.${appendOnly}`),
    )
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatch(/^GRANT SELECT, INSERT ON TABLE/)
    expect(grants[0]).toMatch(new RegExp(`TO ${ROLES.app}$`))
  })

  it('grants a class E or collector-less class nothing at all', () => {
    const sql = read(GRANTS_FILE)
    // The collector has no login credential and no class C/D table yet, so no statement
    // may name it as a grantee. Fail-closed is the designed state, not an oversight.
    const grantsToCollector = splitSqlStatements(sql).filter(
      (s) => /^\s*GRANT /.test(s) && s.includes(`TO ${ROLES.collector}`),
    )
    expect(grantsToCollector).toEqual([])
    const grantsToRetentionOwner = splitSqlStatements(sql).filter(
      (s) => /^\s*GRANT /.test(s) && s.includes(`TO ${ROLES.retentionOwner}`),
    )
    expect(grantsToRetentionOwner).toEqual([])
  })

  it('refuses a manifest entry that is not a plain identifier', () => {
    // The generator validates rather than escapes: a name needing quotes is a manifest
    // bug, and rendering it safely would hide it.
    const classes = PRIVILEGE_CLASSES as unknown as Record<string, string[]>
    const original = classes.A
    try {
      classes.A = [...original, 'users; DROP TABLE users']
      expect(() => buildGrantsSql()).toThrow(/not a plain lower-case identifier/)
    } finally {
      classes.A = original
    }
  })
})
