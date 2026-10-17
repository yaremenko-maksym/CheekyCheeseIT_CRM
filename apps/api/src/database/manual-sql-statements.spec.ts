/**
 * The statement splitter that `job-opportunities-store-forward-ddl.integration.spec.ts`
 * feeds Postgres with. It is unit-tested apart from that spec because it runs without a
 * database and because every one of its failure modes is silent in the worst way: a `;`
 * mistaken for a terminator inside a `DO $$ … $$` body splits one guard into two
 * fragments, Postgres rejects the fragments, and the integration spec reports a broken
 * MIGRATION rather than a broken splitter.
 */
import { describe, expect, it } from 'vitest'
import { splitSqlStatements } from './manual-sql-statements'

describe('splitSqlStatements', () => {
  it('splits plain statements on the terminator', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('keeps a statement that has no trailing terminator', () => {
    expect(splitSqlStatements('SELECT 1')).toEqual(['SELECT 1'])
  })

  it('does not split inside a dollar-quoted body', () => {
    // The shape of every enum and constraint guard in the manual migrations.
    const sql = `DO $$ BEGIN CREATE TYPE t AS ENUM ('a'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;\nSELECT 1;`
    const statements = splitSqlStatements(sql)
    expect(statements).toHaveLength(2)
    expect(statements[0]).toContain('EXCEPTION WHEN duplicate_object')
    expect(statements[1]).toBe('SELECT 1')
  })

  it('does not split inside a tagged dollar-quoted body', () => {
    const statements = splitSqlStatements(`DO $body$ SELECT 1; SELECT 2; $body$;`)
    expect(statements).toHaveLength(1)
  })

  it('does not split inside a single-quoted literal', () => {
    // A real CHECK expression from the job_sources extension: `$` and `-` inside quotes.
    const sql = `ALTER TABLE t ADD CONSTRAINT c CHECK (x ~ '^[a-z0-9][a-z0-9._:-]{0,99}$');`
    expect(splitSqlStatements(sql)).toHaveLength(1)
  })

  it('treats a doubled quote as an escaped quote, not the end of the literal', () => {
    expect(splitSqlStatements(`SELECT 'it''s; fine';`)).toEqual([`SELECT 'it''s; fine'`])
  })

  it('does not split inside a quoted identifier', () => {
    expect(splitSqlStatements('SELECT "odd;name";')).toEqual(['SELECT "odd;name"'])
  })

  it('drops line comments, including one that contains a terminator', () => {
    // The manual files are mostly header prose, and that prose contains `;`.
    const statements = splitSqlStatements('-- a note; with a semicolon\nSELECT 1;')
    expect(statements).toEqual(['SELECT 1'])
  })

  it('drops nested block comments', () => {
    expect(splitSqlStatements('/* outer /* inner; */ still outer; */ SELECT 1;')).toEqual([
      'SELECT 1',
    ])
  })

  it('ignores whitespace-only fragments between terminators', () => {
    expect(splitSqlStatements(';;\n SELECT 1; \n;')).toEqual(['SELECT 1'])
  })

  it('refuses an unterminated dollar quote instead of returning a truncated statement', () => {
    expect(() => splitSqlStatements('DO $$ BEGIN NULL;')).toThrow(/unterminated dollar-quoted/)
  })

  it('refuses an unterminated string literal', () => {
    expect(() => splitSqlStatements("SELECT 'oops")).toThrow(/unterminated string/)
  })

  it('refuses an unterminated block comment', () => {
    expect(() => splitSqlStatements('/* oops SELECT 1;')).toThrow(/unterminated block comment/)
  })
})
