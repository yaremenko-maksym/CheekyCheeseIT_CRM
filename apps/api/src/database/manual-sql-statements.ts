/**
 * Splits a `drizzle/manual/*.sql` file into individual statements, the way `psql` does.
 *
 * Why this exists rather than `client.query(wholeFile)`: a multi-statement simple query
 * is wrapped by Postgres in an IMPLICIT TRANSACTION, and two things our manual
 * migrations rely on are refused inside one — `CREATE INDEX CONCURRENTLY` outright, and
 * `ALTER TYPE … ADD VALUE` as soon as a later statement uses the new value. `deploy.yml`
 * applies these files as `psql -v ON_ERROR_STOP=1 < file`, which sends one statement per
 * message with autocommit between them. A spec that verifies such a file must send them
 * the same way, or it verifies a different thing than production runs.
 *
 * Deliberately NOT a SQL parser. It only needs to find the statement terminators, which
 * means knowing which `;` characters are not terminators:
 *   - inside a dollar-quoted body (`DO $$ … END $$`, `$tag$ … $tag$`) — our enum and
 *     constraint guards are all dollar-quoted, and they contain `;` by the handful;
 *   - inside a single-quoted literal, including an `E'…'` escape string — the CHECK
 *     regexes are full of `$`, `-` and `:`;
 *   - inside a quoted identifier;
 *   - inside a `--` or nested block comment, which is most of these files by volume.
 *
 * What it refuses rather than guesses (CR-L-1 / SR-L-4), in both cases because the
 * alternative is a SILENT wrong answer:
 *   - a psql meta-command ANYWHERE, not only where a statement starts: psql runs a
 *     mid-line `\g` or `\echo` as a meta-command too (measured). The psql CLIENT
 *     interprets them and never sends them to the server, so a file containing one
 *     cannot be verified by sending its statements to Postgres — the server would
 *     reject the line with a bare syntax error that says nothing about the cause. A
 *     backslash is not a legal operator character either, so one reaching this scanner
 *     outside a literal is never valid SQL;
 *   - an `E'…'` escape string, whose backslash escapes would make the ordinary scan cut
 *     the statement at an escaped quote.
 * Neither appears in the two files this verifies. Both throw, naming the construct, so
 * the first file that does carry one fails in CI with an instruction rather than on
 * production with a half-statement.
 *
 * It copies text verbatim and never unescapes it, and that is what makes a doubled quote
 * (`'it''s'`) need no special case: `''` is an EVEN number of quote characters, so
 * treating it as "close the literal, immediately reopen it" leaves the scanner on the
 * same side of the literal as treating it as an escape would, and copies the identical
 * characters either way. An earlier revision had an explicit escape branch; it was
 * removed after a brute-force comparison over 488,280 strings drawn from
 * `' " ; a <space>` found ZERO inputs on which the two versions disagree (the reviewer
 * of PR #1022 repeated it over 1,111,111 strings on a wider alphabet, also zero), and
 * the mutation gate was right to report its mutants as surviving. An `E'…'` string is
 * the one case where the parity argument does NOT hold — there a backslash really does
 * escape the next character — and that is exactly why one is REFUSED rather than
 * guessed at; see the throw below.
 * If this module is ever extended to return literal CONTENT rather than literal TEXT,
 * the parity reasoning stops holding and `''` needs real escape handling again.
 */

/** Characters that may appear in an unquoted SQL identifier (Postgres allows `$`). */
const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/

/**
 * True when the character before `at` could be part of an identifier. A `$…$` that
 * follows one is NOT a dollar-quote opener but a `$` inside a name (`tab$le$x`), and an
 * `e` that follows one is not the `E` of an escape string. Postgres resolves both the
 * same way, lexically.
 */
function followsIdentifier(sql: string, at: number): boolean {
  return at > 0 && IDENTIFIER_CHAR.test(sql[at - 1]!)
}

/**
 * Index just past the `*\/` that closes the block comment starting at `start`.
 * Separate from the main loop because Postgres NESTS block comments, so this is the one
 * place that needs a depth counter.
 *
 * Driven by the markers themselves rather than by a character-at-a-time scan with a
 * bounds check. Both shapes are correct; this one has no `i >= sql.length` in it, and
 * that comparison is the one place in this module where a mutation would be EQUIVALENT
 * rather than wrong — `i > sql.length` merely throws the same error one harmless
 * iteration later, so no assertion could separate the two and the gate would need a
 * suppression. Reaching for a formulation without the comparison beats suppressing the
 * comparison: the mutation gate stays a measurement rather than a negotiation.
 *
 * Scanning starts at `start + 2`, past the opening `/*`, which is why `/*\/` is an
 * UNTERMINATED comment: its `*\/` would have to reuse the opener's `*`. Postgres agrees.
 */
function endOfBlockComment(sql: string, start: number): number {
  const marker = /\/\*|\*\//g
  marker.lastIndex = start + 2
  let depth = 1

  for (let match = marker.exec(sql); match !== null; match = marker.exec(sql)) {
    depth += match[0] === '/*' ? 1 : -1
    if (depth === 0) return match.index + 2
  }

  throw new Error('unterminated block comment')
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let i = 0

  /** Ends the statement under construction. Whitespace alone is not a statement. */
  const flush = (): void => {
    if (current.trim()) statements.push(current.trim())
    current = ''
  }

  while (i < sql.length) {
    const rest = sql.slice(i)

    // A `--` comment runs to end of line. It is replaced by a SPACE rather than deleted
    // (CR-M-2): deleting it welds the text on either side together, so `SELECT 1--c\n
    // FROM t` would become `SELECT 1FROM t`. Both real files only carry whole-line
    // comments, where the difference is invisible after trimming — which is exactly why
    // this needed fixing before a future file carries a trailing one.
    if (rest.startsWith('--')) {
      const newline = sql.indexOf('\n', i)
      // No newline left: the comment runs to the end of the file.
      i = newline === -1 ? sql.length : newline + 1
      current += ' '
      continue
    }

    if (rest.startsWith('/*')) {
      i = endOfBlockComment(sql, i)
      current += ' '
      continue
    }

    // A psql meta-command. Refused, not guessed — see the header.
    //
    // Position-INsensitive, and that is a correction (CR-M-5). An earlier revision only
    // looked where a statement STARTS, with a comment claiming that is the only place a
    // meta-command can appear. Measured in psql 16: `SELECT 1 \g` executes the query as
    // a meta-command, and `SELECT 2 \echo X` prints X and then runs the query — so
    // mid-line is a real position. The condition was also the kind of gap a mutation
    // gate cannot see: Stryker does not mutate individual operands of `&&`, so removing
    // `&& !current.trim()` left all 39 tests green while the gate still reported zero
    // survivors.
    //
    // Refusing EVERY backslash the scanner reaches is safe, not merely conservative: a
    // backslash is not a legal Postgres operator character, so one outside a literal is
    // never valid SQL — `SELECT 1 \ 2` is `syntax error at or near "\"` on the server.
    // A backslash INSIDE a literal or a dollar-quoted body never reaches here, because
    // those branches consume their whole span.
    if (rest.startsWith('\\')) {
      const command = rest.split('\n')[0]!.trim()
      throw new Error(
        `psql meta-command is not supported by this splitter: ${command} — it is ` +
          'interpreted by the psql client and never reaches the server',
      )
    }

    // A dollar-quoted body: everything up to the matching tag is opaque. The pattern is
    // ANCHORED, and a tag that follows an identifier character is not a tag at all —
    // without either guard, the `$…$` inside an ordinary literal or inside a name like
    // `tab$le$x` would be read as an opener and mis-slice the statement around it.
    // The tag body, when present, must START with a letter or underscore: `$1$` is a
    // positional parameter, not a dollar-quote opener. Digits and underscores are legal
    // after the first character, so `$a_1$` is a tag.
    const dollarTag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(rest)
    if (dollarTag && !followsIdentifier(sql, i)) {
      const tag = dollarTag[0]
      const close = sql.indexOf(tag, i + tag.length)
      if (close === -1) throw new Error(`unterminated dollar-quoted string ${tag}`)
      current += sql.slice(i, close + tag.length)
      i = close + tag.length
      continue
    }

    const ch = sql[i]!

    // An `E'…'` escape string is REFUSED, not scanned (CR-L-1). Inside one a backslash
    // escapes the next character, so `E'a\\';b'` is a single literal — scanned the
    // ordinary way it would end at that quote and the `;` after it would split the
    // statement in half, SILENTLY producing two fragments that are each valid-looking
    // SQL. Neither manual file contains an E-string, and handling one properly is a
    // second escape dialect to carry and test for a case that does not occur. Refusing
    // turns the silent mis-split into a loud error that names the fix.
    if ((ch === 'E' || ch === 'e') && sql[i + 1] === "'" && !followsIdentifier(sql, i)) {
      throw new Error(
        `escape string (E'…') at offset ${i} is not supported by this splitter: a ` +
          'backslash inside one escapes the next character, so splitting it the ' +
          'ordinary way would silently cut the statement at an escaped quote',
      )
    }

    if (ch === "'" || ch === '"') {
      const close = sql.indexOf(ch, i + 1)
      if (close === -1) {
        throw new Error(`unterminated ${ch === "'" ? 'string' : 'identifier'}`)
      }
      current += sql.slice(i, close + 1)
      i = close + 1
      continue
    }

    if (ch === ';') {
      flush()
      i += 1
      continue
    }

    current += ch
    i += 1
  }

  // A trailing statement without its terminator is still a statement.
  flush()
  return statements
}
