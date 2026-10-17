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

    it('accepts underscores and digits in a tag (CR-M-3)', () => {
      // A tag is an identifier, so `$a_1$` is legal and must be matched WHOLE: a pattern
      // that stops at the first non-letter closes the tag early and splits the body.
      expect(splitSqlStatements('DO $a_1$ SELECT 1; $a_1$;')).toEqual(['DO $a_1$ SELECT 1; $a_1$'])
    })

    it('does not read `$1$` as a tag — it is a positional parameter (CR-M-3)', () => {
      // A tag body must start with a letter or underscore. Reading `$1$` as an opener
      // would swallow everything up to the next `$1$`, which may never come.
      expect(() => splitSqlStatements('SELECT $1$ FROM t;')).not.toThrow()
      expect(splitSqlStatements('SELECT $1 FROM t;')).toEqual(['SELECT $1 FROM t'])
    })

    it('does not read a `$` inside an identifier as a tag (SR-L-4)', () => {
      // `tab$le$x` is a legal unquoted Postgres identifier. Treating its `$le$` as an
      // opener mis-slices the statement around it.
      expect(splitSqlStatements('SELECT c FROM tab$le$x;')).toEqual(['SELECT c FROM tab$le$x'])
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

    it('treats a backslash inside an E-string as an escape (CR-L-1)', () => {
      // Standard-conforming strings make `\\` ordinary inside `'…'`, but NOT inside an
      // `E'…'`, where `\\'` is an escaped quote. Scanning an E-string the plain way ends
      // the literal at that quote and lets the `;` after it split the statement.
      expect(splitSqlStatements(`SELECT E'a\\';b' FROM t;`)).toEqual([`SELECT E'a\\';b' FROM t`])
    })

    it('accepts a lowercase e-string prefix', () => {
      expect(splitSqlStatements(`SELECT e'a\\';b';`)).toEqual([`SELECT e'a\\';b'`])
    })

    it('does not read a trailing `e` of an identifier as an E-string prefix', () => {
      // `table'x'` is not valid SQL, but `some_table` followed by a literal is, and the
      // `e` of the identifier must not swallow it.
      expect(splitSqlStatements(`SELECT name'x' FROM t;`)).toEqual([`SELECT name'x' FROM t`])
    })

    it('refuses an unterminated E-string', () => {
      expect(() => splitSqlStatements(`SELECT E'oops`)).toThrow(/unterminated escape string/)
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

    it('leaves a separator where a trailing line comment was (CR-M-2)', () => {
      // Deleting the comment outright welds the text on either side together:
      // `SELECT 1--c\nFROM t` becomes the nonsense `SELECT 1FROM t`. Both current files
      // carry only whole-line comments, where this is invisible after trimming — which
      // is why it had to be fixed before a file carries a trailing one.
      expect(splitSqlStatements('SELECT 1-- why\nFROM t;')).toEqual(['SELECT 1 FROM t'])
    })

    it('leaves a separator where an inline block comment was (CR-M-2)', () => {
      expect(splitSqlStatements('ALTER TABLE t/* note */ADD COLUMN c int;')).toEqual([
        'ALTER TABLE t ADD COLUMN c int',
      ])
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

    it('treats `/*/` as unterminated — the closer may not reuse the opener (CR-M-3)', () => {
      // Pins the `start + 2` scan offset. Scanning from `start` instead would find the
      // opener's own `*` and close the comment that never closed. Postgres agrees that
      // `/*/` is unterminated.
      expect(() => splitSqlStatements('/*/ SELECT 1;')).toThrow(/unterminated block comment/)
    })

    it('refuses a block comment whose nesting is closed too few times', () => {
      expect(() => splitSqlStatements('/* outer /* inner */ SELECT 1;')).toThrow(
        /unterminated block comment/,
      )
    })
  })

  describe('characters that only START a comment in pairs (CR-M-3)', () => {
    it('keeps a lone minus as arithmetic, not a comment', () => {
      expect(splitSqlStatements('SELECT 1-2;')).toEqual(['SELECT 1-2'])
    })

    it('keeps a lone slash as division, not a comment', () => {
      expect(splitSqlStatements('SELECT 4/2;')).toEqual(['SELECT 4/2'])
    })

    it('keeps a minus directly before a terminator', () => {
      expect(splitSqlStatements('SELECT a-b; SELECT c/d;')).toEqual(['SELECT a-b', 'SELECT c/d'])
    })
  })

  it('ignores whitespace-only fragments between terminators', () => {
    expect(splitSqlStatements(';;\n SELECT 1; \n;')).toEqual(['SELECT 1'])
  })

  describe('psql meta-commands (SR-L-4)', () => {
    it('refuses one by name rather than letting Postgres report a bare syntax error', () => {
      // These are interpreted by the psql CLIENT and never reach the server, so a file
      // containing one cannot be applied by sending its statements to Postgres. The
      // splitter says so; the server would only have said `syntax error at or near "\\"`.
      expect(() => splitSqlStatements('\\pset format unaligned\nSELECT 1;')).toThrow(
        /psql meta-command is not supported/,
      )
      expect(() => splitSqlStatements('SELECT 1;\n\\copy t FROM x\n')).toThrow(/\\copy t FROM x/)
    })

    it('leaves a backslash INSIDE a statement alone', () => {
      // Only a backslash that starts a statement is a meta-command.
      expect(splitSqlStatements(`SELECT E'a\\\\b';`)).toEqual([`SELECT E'a\\\\b'`])
    })
  })
})
