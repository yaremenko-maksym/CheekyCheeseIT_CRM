/**
 * Postgres error helpers — detect a specific SQLSTATE in `err`'s `.cause`
 * chain, the way `drizzle-orm` actually surfaces it (wrapped in a
 * `DrizzleQueryError` whose OWN `.code` is `undefined`).
 *
 * Extracted from `finance/transactions.service.ts` (task-onchain-payment-integrity)
 * so the finance write paths — `transactions.service` and `company-account.service`
 * — detect a constraint collision the SAME way. Previously company-account read
 * `(err as {code}).code` off the TOP-LEVEL error only, which silently misses the
 * violation whenever drizzle wraps it (see the cause-chain note below) and turned
 * a would-be clean 400 into a 500.
 *
 * `isDeadlock` (SR-M-14, security-review PR #623 round 6) is the SAME
 * top-level-vs-`.cause` mistake, found a second time in a test's assertion
 * rather than in a service's catch block — see that function's own doc.
 */

/** Postgres SQLSTATE for a unique-constraint violation. */
export const PG_UNIQUE_VIOLATION = '23505'

/**
 * True when `err` (or any error in its `.cause` chain) is a Postgres
 * unique-constraint violation (SQLSTATE 23505). drizzle-orm wraps query
 * failures in a `DrizzleQueryError`, so the original pg error — the one
 * carrying `.code` — lives on `.cause`; this walks the chain rather than only
 * inspecting the top-level error.
 */
export function isUniqueViolation(err: unknown): boolean {
  return uniqueViolationConstraint(err) !== null
}

/**
 * The CONSTRAINT name of a unique violation in `err`'s cause chain, or null.
 *
 * Security-review PR #438 (MED): a blanket `isUniqueViolation` catch inside a
 * multi-write transaction reports whichever message the author had in mind,
 * whatever actually collided — e.g. a payout cascade that trips the
 * receipt-uniqueness index would tell the user «этот хеш уже использован».
 * Callers that write to several constrained tables should switch on the
 * constraint and rethrow anything they did not anticipate, so an unexpected
 * collision surfaces as a real error instead of a plausible-sounding lie.
 *
 * Returns `''` when the driver reports a violation without a constraint name
 * (still a violation — just unattributable).
 */
export function uniqueViolationConstraint(err: unknown): string | null {
  let cur: unknown = err
  // Bounded walk — guards against a (pathological) self-referential cause chain.
  for (let depth = 0; cur != null && depth < 8; depth += 1) {
    const candidate = cur as { code?: unknown; constraint?: unknown }
    if (candidate.code === PG_UNIQUE_VIOLATION) {
      return typeof candidate.constraint === 'string' ? candidate.constraint : ''
    }
    cur = (cur as { cause?: unknown }).cause
  }
  return null
}

/** Postgres SQLSTATE for a deadlock detected by the database. */
export const PG_DEADLOCK_DETECTED = '40P01'

/**
 * True when `err` (or any error in its `.cause` chain) is a Postgres
 * deadlock (SQLSTATE 40P01).
 *
 * SR-M-14 (security-review PR #623 round 6): a regression spec
 * (`user-email-invites.integration.spec.ts`, "SR-H-5") counted deadlocks by
 * reading `(err as {code?: string}).code` off the TOP-LEVEL rejection
 * reason only — exactly the mistake `uniqueViolationConstraint`'s own doc
 * above already warns against for 23505. drizzle-orm wraps every query
 * failure in a `DrizzleQueryError`, whose OWN `.code` is `undefined`; the
 * raw pg error (the one that actually carries a SQLSTATE `.code`) is one
 * level down, on `.cause`. The shallow check could therefore never observe
 * a real `40P01` — `expect(deadlocks).toBe(0)` passed unconditionally,
 * including against code that measurably deadlocked 8-14 times per 40 (see
 * that spec's own SR-H-5 comment for the measured numbers, both pre- and
 * post-fix). Verified directly against a real deadlock: `ctor=
 * DrizzleQueryError topLevelCode=undefined causeCtor=DatabaseError
 * causeCode="40P01"`.
 */
export function isDeadlock(err: unknown): boolean {
  let cur: unknown = err
  // Bounded walk — guards against a (pathological) self-referential cause chain.
  for (let depth = 0; cur != null && depth < 8; depth += 1) {
    const candidate = cur as { code?: unknown }
    if (candidate.code === PG_DEADLOCK_DETECTED) return true
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}

/* -------------------------------------------------------------------------- */
/*  Logging a database error — the alert contract                              */
/* -------------------------------------------------------------------------- */

/*
 * WHY THIS EXISTS (measured on a real PostgreSQL 16, drizzle-orm 0.45):
 * a failed query rejects with a `DrizzleQueryError` whose
 *   - `message` is `Failed query: <sql>\nparams: <the VALUES>`,
 *   - `stack` begins with that same message,
 *   - `code` is `undefined`,
 * and ONLY `.cause` — the driver's `DatabaseError` — carries `code: '42501'` and
 * `message: 'permission denied for table …'`. A handler that logs `err.message` or
 * `err.stack` therefore (1) never writes the SQLSTATE, so an alert on `42501` is
 * silent exactly where it is needed, and (2) writes the parameter values, which can
 * be personal data. This module is the one place that reads the chain and decides
 * what may be written down.
 *
 * WHICH LINE IS THE ALERT'S CONTRACT: for a privilege error (42501) it is the canonical
 * `db_privilege_denied …` line emitted once at the pool by `privilege-denied-reporter.ts` —
 * an alert on 42501 should match THAT, not this fragment. The fragment below is the
 * DIAGNOSTIC detail the swallowing handlers add to their own message (every SQLSTATE, with
 * table/constraint/column and the statement shape) so a human reading one failed run sees
 * what failed. It is stable and greppable too, but nothing should depend on it for 42501.
 *
 * ===========================  THE HANDLER-FRAGMENT FORMAT  =========================
 * An error that has a database error in its `.cause` chain adds ONE fragment to the
 * log message (callers append it after their own static text, preceded by a space):
 *
 *   db_error db_sqlstate=<S> db_table=<T> db_constraint=<C> db_column=<K> db_message="<M>" db_statement="<Q>"
 *
 * - The fragment always starts with the bare word `db_error`, and every field is
 *   always present, in this order. An absent value is the single character `-`.
 * - `db_sqlstate=<S>` — the five-character SQLSTATE (`42501`, `28P01`, `23505`…), or
 *   `none` for a database-call failure that has no SQLSTATE (connection refused…).
 * - `db_table` / `db_constraint` / `db_column` — identifiers the driver reported,
 *   restricted to `[A-Za-z0-9_$.]` (anything else becomes `?`). No whitespace.
 * - `db_message="<M>"` — the DRIVER's message, only for SQLSTATE classes whose text
 *   never embeds a value (08 23 28 40 42 53 54 55 57 58). `-` for the rest: class 22
 *   messages are `invalid input syntax for type integer: "<the value>"`. For a
 *   no-SQLSTATE failure it is the cause's code (`ECONNREFUSED`) or `-`.
 * - `db_statement="<Q>"` — drizzle's SQL text with `$1…` placeholders, whitespace
 *   collapsed, at most 200 characters. `-` when the error did not come through drizzle.
 * - Inside the two quoted fields `"` is replaced by `'` and control characters by a
 *   space, so a quote never needs escaping and the fragment is one line.
 *
 * NEVER in the fragment, by construction: query PARAMETER VALUES, the driver's
 * `detail` (`Key (email)=(a@b.c) already exists`), `where`, `hint`, or drizzle's own
 * message. This repository is public; its logs end up in issues.
 *
 * HOW TO MATCH (what an alert may rely on, and what it must not):
 *   RELY ON  the tokens `db_sqlstate=42501` and `db_error`, or the substring
 *            `permission denied`. These are plain `[a-z0-9_=]` and survive any
 *            logger that quotes or JSON-escapes the line.
 *   DO NOT   anchor on the quote characters, on field order beyond `db_error`
 *            coming first, or on the text of `db_statement`.
 * Changing a token name or the allow-list below is a change to this contract: tell
 * whoever owns the alert.
 */

const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/
/** SQLSTATE classes whose driver message never embeds a data value (see contract). */
const VALUE_FREE_CLASSES = new Set(['08', '23', '28', '40', '42', '53', '54', '55', '57', '58'])
const FIELD_MAX_LENGTH = 200
const ELLIPSIS = '...'

type Dict = Record<string, unknown>

/** First error in the `.cause` chain (bounded) satisfying `match`, or null. */
function findInChain(err: unknown, match: (node: Dict) => boolean): Dict | null {
  let cur: unknown = err
  // Only null/undefined need guarding: reading a property off a primitive cause is
  // harmless (`'str'['code']` is undefined) and simply ends the walk.
  for (let depth = 0; cur != null && depth < 8; depth += 1) {
    if (match(cur as Dict)) return cur as Dict
    cur = (cur as Dict)['cause']
  }
  return null
}

/** pg's `DatabaseError`: a five-character SQLSTATE `code` AND a string `severity`.
 * `severity` is what tells it apart from Node's `EPERM`-style codes. */
function isPgNode(node: Dict): boolean {
  return (
    typeof node['code'] === 'string' &&
    SQLSTATE_PATTERN.test(node['code']) &&
    typeof node['severity'] === 'string'
  )
}

/**
 * The driver's `DatabaseError` in `err`'s cause chain — `err` itself included, which is
 * what a pool-level observer sees before drizzle wraps it — or null. Shared with
 * `privilege-denied-reporter.ts` so there is ONE definition of "a Postgres error".
 */
export function findPgError(err: unknown): Record<string, unknown> | null {
  return findInChain(err, isPgNode)
}

/** drizzle's `DrizzleQueryError`: the SQL text and the params array. */
function isDrizzleNode(node: Dict): boolean {
  return typeof node['query'] === 'string' && node['query'] !== '' && Array.isArray(node['params'])
}

/** One line, no quotes, no control characters, at most `FIELD_MAX_LENGTH` characters. */
function oneLine(text: string): string {
  const flat = text
    .replace(/[\x00-\x1F\x7F-\x9F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replaceAll('"', "'")
  return flat.length > FIELD_MAX_LENGTH
    ? `${flat.slice(0, FIELD_MAX_LENGTH - ELLIPSIS.length)}${ELLIPSIS}`
    : flat
}

export function dbIdentifier(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value.replace(/[^A-Za-z0-9_$.]/g, '?') : '-'
}

function quoted(text: string | null): string {
  return text === null ? '-' : `"${oneLine(text)}"`
}

function fragment(
  sqlstate: string,
  fields: Dict,
  message: string | null,
  statement: string | null,
): string {
  return (
    `db_error db_sqlstate=${sqlstate} db_table=${dbIdentifier(fields['table'])} ` +
    `db_constraint=${dbIdentifier(fields['constraint'])} db_column=${dbIdentifier(fields['column'])} ` +
    `db_message=${quoted(message)} db_statement=${quoted(statement)}`
  )
}

/**
 * The contract fragment for `err`, or `null` when no database error is in its
 * `.cause` chain. See "THE LOG-LINE CONTRACT" above.
 */
export function describeDbError(err: unknown): string | null {
  const pg = findInChain(err, isPgNode)
  const drizzle = findInChain(err, isDrizzleNode)
  if (pg === null && drizzle === null) return null

  const statement = drizzle === null ? null : (drizzle['query'] as string)
  if (pg === null) {
    const cause = (drizzle as Dict)['cause'] as Dict | null | undefined
    const code = cause?.['code']
    return fragment('none', {}, typeof code === 'string' ? code : null, statement)
  }
  const sqlstate = pg['code'] as string
  const message = VALUE_FREE_CLASSES.has(sqlstate.slice(0, 2))
    ? ((pg['message'] as string | undefined) ?? null)
    : null
  return fragment(sqlstate, pg, message, statement)
}

/** `describeDbError` as a suffix ready to append to a static log message ('' if none). */
export function dbErrorLogSuffix(err: unknown): string {
  const described = describeDbError(err)
  return described === null ? '' : ` ${described}`
}

/**
 * What to hand a logger as the stack. For an error that IS a pg or drizzle error the
 * message is dropped — drizzle's embeds the parameter values, and a bare pg message
 * can too — and the frames are kept. Every other error returns exactly what the
 * handlers always logged: `err.stack`, or `String(err)` for a non-Error.
 */
export function safeErrorStack(err: unknown): string | undefined {
  if (!(err instanceof Error)) return String(err)
  if (!isPgNode(err as unknown as Dict) && !isDrizzleNode(err as unknown as Dict)) return err.stack
  if (err.stack === undefined) return undefined
  const frames = err.stack.split('\n').filter((line) => /^\s+at /.test(line))
  return [err.name, ...frames].join('\n')
}
