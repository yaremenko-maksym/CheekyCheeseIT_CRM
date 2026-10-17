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

    it('recognises a tag that starts the input (offset 0)', () => {
      // The other half of the `at > 0` guard in `followsIdentifier`.
      expect(splitSqlStatements('$$a;b$$;')).toEqual(['$$a;b$$'])
    })

    it('does not read a `$` inside an identifier as a tag (SR-L-4)', () => {
      // `tab$le$x` is a legal unquoted Postgres identifier. Treating its `$le$` as an
      // opener mis-slices the statement around it.
      expect(splitSqlStatements('SELECT c FROM tab$le$x;')).toEqual(['SELECT c FROM tab$le$x'])
    })

    it('counts `$` itself as an identifier character (CR-L-3)', () => {
      // The run of dollars is what pins it: with `$` missing from IDENTIFIER_CHAR, the
      // second and third `$` here are preceded by a `$` that no longer counts as part of
      // an identifier, so `$$` is read as a dollar-quote opener and the scan runs off the
      // end looking for a closing `$$`. Nothing else in this suite has a `$` run.
      expect(splitSqlStatements('SELECT x$$$ FROM t;')).toEqual(['SELECT x$$$ FROM t'])
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

    it("refuses an E'…' escape string by name rather than mis-splitting it (CR-L-1)", () => {
      // Inside an E-string a backslash escapes the next character, so this is ONE
      // literal. Scanned the ordinary way it would end at the escaped quote and the `;`
      // after it would split the statement into two valid-looking fragments — silently.
      // The WHOLE message, not just its opening clause: an error that names the
      // construct but not the reason sends the next author to read this module instead
      // of the header.
      expect(() => splitSqlStatements(`SELECT E'a\\';b' FROM t;`)).toThrow(
        "escape string (E'\u2026') at offset 7 is not supported by this splitter: a " +
          'backslash inside one escapes the next character, so splitting it the ordinary ' +
          'way would silently cut the statement at an escaped quote',
      )
    })

    it('refuses a lowercase e-string prefix too', () => {
      expect(() => splitSqlStatements(`SELECT e'x';`)).toThrow(/escape string/)
    })

    it('refuses an E-string that starts the input (offset 0)', () => {
      // Pins the `at > 0` guard in `followsIdentifier`: read as "index 0 follows an
      // identifier character", every construct at the very start of a file stops being
      // recognised — and a manual file may legally begin with one.
      expect(() => splitSqlStatements(`E'x' FROM t;`)).toThrow(/escape string .* offset 0/)
    })

    it('leaves a bare `e` token alone when no quote follows it', () => {
      // A table alias is the common case, and `e` is the common alias. Pins that the
      // branch checks for the QUOTE as well as the letter: without that check every
      // `e`/`E` not preceded by an identifier character would be refused.
      expect(splitSqlStatements('SELECT e.x FROM t e;')).toEqual(['SELECT e.x FROM t e'])
      expect(splitSqlStatements('SELECT E FROM t;')).toEqual(['SELECT E FROM t'])
    })

    it('does not read a trailing `e` of an identifier as an E-string prefix', () => {
      // `some_name` followed by a literal is ordinary SQL, and the `e` ending the
      // identifier must not swallow it.
      expect(splitSqlStatements(`SELECT name'x' FROM t;`)).toEqual([`SELECT name'x' FROM t`])
    })

    it('treats a quote after a non-identifier character as an ordinary literal', () => {
      // Pins that the E-string branch fires on `E'` and nothing else. A branch that
      // triggered on ANY character before a quote would refuse this perfectly ordinary
      // statement, because `(` is not an identifier character either.
      expect(splitSqlStatements(`SELECT ('a;b');`)).toEqual([`SELECT ('a;b')`])
    })

    it('keeps standard-conforming semantics for a backslash in a PLAIN literal', () => {
      // With `standard_conforming_strings` on (the default since PG 9.1), `'a\\'` is a
      // COMPLETE literal whose content is `a\\` — the quote is NOT escaped. So the `;`
      // after it is a real terminator, the `'` later in the line opens a literal that
      // never closes, and refusing is correct. Asserted because the obvious intuition
      // ("a backslash escapes the quote") is the wrong one, and an E-string is the only
      // place where that intuition holds.
      expect(() => splitSqlStatements(`SELECT ('a\\';b');`)).toThrow(/unterminated string/)
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
        /psql meta-command is not supported by this splitter: \\pset format unaligned — it is/,
      )
      // The command is reported TRIMMED and cut at the newline: the surrounding
      // whitespace and the rest of the file are not part of the message.
      expect(() => splitSqlStatements('SELECT 1;\n   \\copy t FROM x   \nSELECT 2;')).toThrow(
        /: \\copy t FROM x — it is interpreted by the psql client and never reaches the server/,
      )
    })

    it('refuses one reached MID-STATEMENT, not only where a statement starts (CR-M-5)', () => {
      // The gap this closes: with the old `&& !current.trim()` operand, a backslash was
      // only checked where a statement began, and the one test on the subject put its
      // backslash inside a quoted literal — so nothing ever reached the check with a
      // non-empty `current` and removing the operand left all 39 tests green. Stryker
      // does not mutate individual operands of `&&`, so the gate could not see it.
      // psql 16 really does run these mid-line: `SELECT 1 \\g` executes the query.
      expect(() => splitSqlStatements('SELECT 1 \\g\n')).toThrow(
        /psql meta-command is not supported by this splitter: \\g — it is/,
      )
      expect(() => splitSqlStatements('SELECT 2 \\echo hi\n')).toThrow(/: \\echo hi — it is/)
    })

    it('leaves a backslash inside a literal or a dollar-quoted body alone', () => {
      // Those branches consume their whole span, so the scanner never lands on the
      // backslash — which is why refusing EVERY backslash it does reach is safe.
      expect(splitSqlStatements(`SELECT 'a\\\\b';`)).toEqual([`SELECT 'a\\\\b'`])
      expect(splitSqlStatements("DO $$ SELECT 'a\\\\b'; $$;")).toEqual([
        "DO $$ SELECT 'a\\\\b'; $$",
      ])
    })
  })
})
