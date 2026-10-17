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
 * What it refuses rather than guesses (CR-L-1 / SR-L-4): a psql meta-command. Those are
 * interpreted by the psql CLIENT, never sent to the server, so a file containing one
 * cannot be verified by sending its statements to Postgres — the server would reject the
 * line with a bare syntax error that says nothing about the cause. It throws instead,
 * naming the command.
 *
 * It copies text verbatim and never unescapes it, and that is what makes a doubled quote
 * (`'it''s'`) need no special case: `''` is an EVEN number of quote characters, so
 * treating it as "close the literal, immediately reopen it" leaves the scanner on the
 * same side of the literal as treating it as an escape would, and copies the identical
 * characters either way. An earlier revision had an explicit escape branch; it was
 * removed after a brute-force comparison over 488,280 strings drawn from
 * `' " ; a <space>` found ZERO inputs on which the two versions disagree (the reviewer
 * of PR #1022 repeated it over 1,111,111 strings on a wider alphabet, also zero), and
 * the mutation gate was right to report its mutants as surviving. An `E'…'` string is a
 * different matter and IS handled below: there a backslash really does escape the next
 * character, so `E'a\'b'` is one literal and the parity argument does not hold.
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

/**
 * Index just past the closing quote of the `E'…'` escape string starting at `start`
 * (which points at the `E`). Inside one, a backslash escapes the next character, so
 * `E'a\'b'` is a single literal — the only place in this module where that is true.
 */
function endOfEscapeString(sql: string, start: number): number {
  let i = start + 2
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === "'") {
      // A doubled quote is legal inside an E-string too, and means the same thing.
      if (sql[i + 1] === "'") {
        i += 2
        continue
      }
      return i + 1
    }
    i += 1
  }
  throw new Error('unterminated escape string')
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
    if (rest.startsWith('\\') && !current.trim()) {
      const line = rest.slice(0, rest.indexOf('\n') === -1 ? rest.length : rest.indexOf('\n'))
      throw new Error(
        `psql meta-command is not supported by this splitter: ${line.trim()} — ` +
          'it is interpreted by the psql client and never reaches the server, so a file ' +
          'containing one cannot be applied by sending its statements to Postgres',
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

    // An `E'…'` / `e'…'` escape string, where a backslash escapes the next character.
    if ((ch === 'E' || ch === 'e') && sql[i + 1] === "'" && !followsIdentifier(sql, i)) {
      const end = endOfEscapeString(sql, i)
      current += sql.slice(i, end)
      i = end
      continue
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
