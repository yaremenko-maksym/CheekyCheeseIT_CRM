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
 *   - inside a single-quoted literal — the CHECK regexes are full of `$`, `-` and `:`;
 *   - inside a quoted identifier;
 *   - inside a `--` or nested `/* … *\/` comment, which is most of these files by volume.
 *
 * It copies text verbatim and never unescapes it, and that is what makes a doubled quote
 * (`'it''s'`) need no special case: `''` is an EVEN number of quote characters, so
 * treating it as "close the literal, immediately reopen it" leaves the scanner on the
 * same side of the literal as treating it as an escape would, and copies the identical
 * characters either way. An earlier revision had an explicit escape branch; it was
 * removed after a brute-force comparison over 488,280 strings drawn from
 * `' " ; a <space>` found ZERO inputs on which the two versions disagree — the mutation
 * gate was right to report its mutants as surviving, because the branch could not
 * affect an output. `splitStatementsPreservingEscapes` does not exist for that reason.
 * If this module is ever extended to return literal CONTENT rather than literal TEXT,
 * that reasoning stops holding and the escape handling has to come back.
 */

/**
 * Index just past the `*\/` that closes the block comment starting at `start`.
 * Separate from the main loop because Postgres NESTS block comments, so this is the one
 * place that needs a depth counter.
 */
function endOfBlockComment(sql: string, start: number): number {
  // Driven by the markers themselves rather than by a character-at-a-time scan with a
  // bounds check. Both shapes are correct; this one has no `i >= sql.length` in it, and
  // that comparison is the one place in this module where a mutation is EQUIVALENT
  // rather than wrong — `i > sql.length` merely throws the same error one harmless
  // iteration later, so no assertion can separate the two and the gate would need a
  // suppression. Reaching for a formulation without the comparison beats suppressing
  // the comparison: the mutation gate stays a measurement rather than a negotiation.
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

    // A `--` comment runs to end of line and is dropped entirely.
    if (rest.startsWith('--')) {
      const newline = sql.indexOf('\n', i)
      // No newline left: the comment runs to the end of the file.
      i = newline === -1 ? sql.length : newline + 1
      continue
    }

    if (rest.startsWith('/*')) {
      i = endOfBlockComment(sql, i)
      continue
    }

    // A dollar-quoted body: everything up to the matching tag is opaque. Both branches
    // are anchored — an unanchored tag pattern would match a `$…$` pair sitting INSIDE
    // an ordinary literal and mis-slice the statement around it.
    const dollarTag = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/.exec(rest)
    if (dollarTag) {
      const tag = dollarTag[0]
      const close = sql.indexOf(tag, i + tag.length)
      if (close === -1) throw new Error(`unterminated dollar-quoted string ${tag}`)
      current += sql.slice(i, close + tag.length)
      i = close + tag.length
      continue
    }

    const ch = sql[i]!
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
