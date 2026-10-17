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
 *   - inside a `--` comment, which is most of these files by volume.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let i = 0

  while (i < sql.length) {
    const rest = sql.slice(i)

    // A `--` comment runs to end of line and is dropped entirely.
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end + 1
      continue
    }

    // A `/* … */` comment. Postgres nests them; so does this.
    if (rest.startsWith('/*')) {
      let depth = 1
      let j = i + 2
      while (j < sql.length && depth > 0) {
        if (sql.startsWith('/*', j)) {
          depth += 1
          j += 2
        } else if (sql.startsWith('*/', j)) {
          depth -= 1
          j += 2
        } else {
          j += 1
        }
      }
      if (depth > 0) throw new Error('unterminated block comment')
      i = j
      continue
    }

    // A dollar-quoted body: everything up to the matching tag is opaque.
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
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === ch) {
          // A doubled quote is an escaped quote, not the end of the literal.
          if (sql[j + 1] === ch) {
            j += 2
            continue
          }
          break
        }
        j += 1
      }
      if (j >= sql.length) throw new Error(`unterminated ${ch === "'" ? 'string' : 'identifier'}`)
      current += sql.slice(i, j + 1)
      i = j + 1
      continue
    }

    if (ch === ';') {
      if (current.trim()) statements.push(current.trim())
      current = ''
      i += 1
      continue
    }

    current += ch
    i += 1
  }

  // A trailing statement without its terminator is still a statement.
  if (current.trim()) statements.push(current.trim())
  return statements
}
