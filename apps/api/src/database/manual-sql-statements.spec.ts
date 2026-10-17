/**
 * The statement splitter that `job-opportunities-store-forward-ddl.integration.spec.ts`
 * feeds Postgres with. It is unit-tested apart from that spec because it runs without a
 * database and because every one of its failure modes is silent in the worst way: a `;`
 * mistaken for a terminator inside a `DO $$ … $$` body splits one guard into two
 * fragments, Postgres rejects the fragments, and the integration spec reports a broken
 * MIGRATION rather than a broken splitter.
 *
 * Several assertions below are on the EXACT text of a returned statement rather than on
 * the count or on a substring. That is deliberate and was driven by the mutation gate:
 * a `toHaveLength(2)` plus a `toContain(…)` accepts a splitter that returns the whole
 * file as statement one, so off-by-`tag.length` slicing survived until the assertions
 * compared the statement itself.
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

  it('trims a trailing statement that has no terminator', () => {
    // The pushed text, not just the decision to push: a splitter that pushes `current`
    // unchanged returns the surrounding whitespace with it.
    expect(splitSqlStatements('   SELECT 1   ')).toEqual(['SELECT 1'])
  })

  it('does not emit a statement for whitespace after the last terminator', () => {
    // Every manual file ends with a newline, so this is the shape of every real input.
    expect(splitSqlStatements('SELECT 1;   \n  ')).toEqual(['SELECT 1'])
  })

  describe('dollar-quoted bodies', () => {
    it('returns a guard whole, body and terminators included', () => {
      // The shape of every enum and constraint guard in the manual migrations, asserted
      // verbatim: this is what pins the slice boundaries at both ends of the tag.
      const guard = `DO $$ BEGIN CREATE TYPE t AS ENUM ('a'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`
      expect(splitSqlStatements(`${guard};\nSELECT 1;`)).toEqual([guard, 'SELECT 1'])
    })

    it('does not split inside a tagged body', () => {
      expect(splitSqlStatements('DO $body$ SELECT 1; SELECT 2; $body$;')).toEqual([
        'DO $body$ SELECT 1; SELECT 2; $body$',
      ])
    })

    it('treats a $tag$ pair inside a literal as ordinary text', () => {
      // The tag pattern must be ANCHORED. Unanchored, it matches the `$tag$` sitting
      // inside this literal, slices the statement around the wrong offsets, and ends up
      // reporting an unterminated string for input that is perfectly well-formed.
      expect(splitSqlStatements(`SELECT '$tag$';`)).toEqual([`SELECT '$tag$'`])
    })

    it('refuses an unterminated body instead of returning a truncated statement', () => {
      expect(() => splitSqlStatements('DO $$ BEGIN NULL;')).toThrow(/unterminated dollar-quoted/)
    })
  })

  describe('literals and identifiers', () => {
    it('does not split inside a single-quoted literal', () => {
      // A real CHECK expression from the job_sources extension: `$`, `-` and `:` inside
      // quotes, asserted verbatim so the closing offset is pinned.
      const statement = `ALTER TABLE t ADD CONSTRAINT c CHECK (x ~ '^[a-z0-9][a-z0-9._:-]{0,99}$')`
      expect(splitSqlStatements(`${statement};`)).toEqual([statement])
    })

    it('does not split inside a quoted identifier', () => {
      expect(splitSqlStatements('SELECT "odd;name";')).toEqual(['SELECT "odd;name"'])
    })

    it('copies a doubled quote through unchanged', () => {
      // No escape branch is needed to get this right, and the module header explains why
      // (`''` is an even number of quotes, so parity is preserved either way). This test
      // pins the OUTCOME so that reasoning stays verified rather than remembered.
      expect(splitSqlStatements(`SELECT 'it''s; fine';`)).toEqual([`SELECT 'it''s; fine'`])
      expect(splitSqlStatements(`SELECT 'a''';`)).toEqual([`SELECT 'a'''`])
    })

    it('refuses an unterminated string literal', () => {
      expect(() => splitSqlStatements("SELECT 'oops")).toThrow(/unterminated string/)
    })

    it('refuses an unterminated quoted identifier, naming it as an identifier', () => {
      // A separate message from the one above: the two share a line, and a test for only
      // one of them accepts a splitter that reports every unterminated quote as a string.
      expect(() => splitSqlStatements('SELECT "oops')).toThrow(/unterminated identifier/)
    })
  })

  describe('comments', () => {
    it('drops a line comment, including one that contains a terminator', () => {
      // The manual files are mostly header prose, and that prose contains `;`.
      expect(splitSqlStatements('-- a note; with a semicolon\nSELECT 1;')).toEqual(['SELECT 1'])
    })

    it('drops a line comment that runs to the end of the file without a newline', () => {
      // Nothing guarantees a trailing newline after the last comment line, and a
      // splitter that assumes one restarts at index 0 and never terminates.
      expect(splitSqlStatements('SELECT 1; -- trailing note, no newline')).toEqual(['SELECT 1'])
    })

    it('drops a block comment and keeps what follows it', () => {
      expect(splitSqlStatements('/* note */ SELECT 1;')).toEqual(['SELECT 1'])
    })

    it('drops nested block comments', () => {
      expect(splitSqlStatements('/* outer /* inner; */ still outer; */ SELECT 1;')).toEqual([
        'SELECT 1',
      ])
    })

    it('refuses an unterminated block comment', () => {
      expect(() => splitSqlStatements('/* oops SELECT 1;')).toThrow(/unterminated block comment/)
    })

    it('refuses a block comment whose nesting is closed too few times', () => {
      expect(() => splitSqlStatements('/* outer /* inner */ SELECT 1;')).toThrow(
        /unterminated block comment/,
      )
    })
  })

  it('ignores whitespace-only fragments between terminators', () => {
    expect(splitSqlStatements(';;\n SELECT 1; \n;')).toEqual(['SELECT 1'])
  })
})
