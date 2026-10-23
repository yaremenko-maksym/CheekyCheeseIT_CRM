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
 * be personal data. This is where the swallowing handlers' logging reads the chain and
 * decides what may be written down. It is NOT the only place a drizzle error's message and
 * stack are persisted: `TelemetryExceptionFilter` stores `exception.message` and
 * `exception.stack` of any 5xx, and for a drizzle error both carry the bound parameters.
 * That path does not use this module yet (tracked separately).
 *
 * THE ALERT'S CONTRACT IS NOT THIS FRAGMENT. For a privilege error (42501) the contract is
 * the canonical `db_privilege_denied …` line emitted once at the pool by
 * `privilege-denied-reporter.ts`; the alert matches that and only that. This fragment is
 * DIAGNOSTIC detail the swallowing handlers append to their own message (every SQLSTATE,
 * with table/constraint/column and the statement shape) so a human reading one failed run
 * sees what failed. It is DELIBERATELY OUTSIDE everything that pages, so that one swallowed
 * failure is one hit and not two:
 *   - for 42501 it drops the driver's message — "permission denied for table x" and
 *     "must be owner of table x" are matched by the alert as text (case-insensitively).
 *     The table is on the canonical line; and
 *   - its state field is `db_state`, not `sqlstate` / `code`. The alert's current pattern
 *     no longer has a branch for those words, but an earlier one did and matched the old
 *     `db_sqlstate=42501`, so the name stays away from them.
 * Both are pinned by `pg-errors-log.spec.ts` against the shared copy of the alert's patterns
 * in `__test-helpers__/alert-patterns.ts`, which names the script that owns them. Do not
 * start logging that message.
 *
 * ===========================  THE HANDLER-FRAGMENT FORMAT  =========================
 * An error that has a database error in its `.cause` chain adds ONE fragment to the
 * log message (callers append it after their own static text, preceded by a space):
 *
 *   db_error db_state=<S> db_table=<T> db_constraint=<C> db_column=<K> db_message="<M>" db_statement="<Q>"
 *
 * - The fragment always starts with the bare word `db_error`, and every field is
 *   always present, in this order. An absent value is the single character `-`.
 * - `db_state=<S>` — the five-character SQLSTATE (`42501`, `28P01`, `23505`…), or
 *   `none` for a database-call failure that has no SQLSTATE (connection refused…).
 * - `db_table` / `db_constraint` / `db_column` — identifiers the driver reported,
 *   restricted to `[A-Za-z0-9_$.]` (anything else becomes `?`). No whitespace.
 * - `db_message="<M>"` — the DRIVER's message, only for SQLSTATE classes whose text
 *   never embeds a value (08 23 28 40 42 53 54 55 57 58), and never for 42501 (see
 *   above). `-` for the rest: class 22 messages are
 *   `invalid input syntax for type integer: "<the value>"`. For a no-SQLSTATE failure
 *   it is the cause's code (`ECONNREFUSED`) or `-`.
 * - `db_statement="<Q>"` — drizzle's SQL text with `$1…` placeholders, whitespace
 *   collapsed, at most 200 characters. `-` when the error did not come through drizzle.
 * - Inside the two quoted fields `"` is replaced by `'` and control characters by a
 *   space, so a quote never needs escaping and the fragment is one line.
 *
 * NEVER in the fragment, by construction: query PARAMETER VALUES, the driver's
 * `detail` (`Key (email)=(a@b.c) already exists`), `where`, `hint`, or drizzle's own
 * message. Why: parameter values can be personal data, and a log line is routinely
 * pasted into issues of this PUBLIC repository, where it is world-readable.
 *
 * NOT A MATCH TARGET: nothing should alert on this fragment. If you need a stable token
 * for an alert, it belongs on the pool-level line, which has an owner and a test.
 * Changing a field name or the allow-list below changes what people reading logs see;
 * the alert is unaffected, but keep the two pinned tests green.
 */

/** Postgres SQLSTATE for insufficient_privilege ("permission denied …", "must be owner of …"). */
export const PG_INSUFFICIENT_PRIVILEGE = '42501'

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
    `db_error db_state=${sqlstate} db_table=${dbIdentifier(fields['table'])} ` +
    `db_constraint=${dbIdentifier(fields['constraint'])} db_column=${dbIdentifier(fields['column'])} ` +
    `db_message=${quoted(message)} db_statement=${quoted(statement)}`
  )
}

/**
 * The diagnostic fragment for `err`, or `null` when no database error is in its
 * `.cause` chain. See "THE HANDLER-FRAGMENT FORMAT" above — it is NOT the alert's contract.
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
  // 42501's message is what the alert matches as text; the canonical line carries the table.
  const messageIsLoggable =
    sqlstate !== PG_INSUFFICIENT_PRIVILEGE && VALUE_FREE_CLASSES.has(sqlstate.slice(0, 2))
  const message = messageIsLoggable ? ((pg['message'] as string | undefined) ?? null) : null
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
 *
 * The message is removed as a WHOLE, by its exact `name: message` header, before any line
 * is examined. Filtering lines for `^\s+at ` alone is not safe: a bound value that itself
 * contains a newline and an indented `at …` sits inside the message and passes that filter
 * (CR-H-1, reproduced on a real driver). If the stack does not begin with that header —
 * something rewrote it — or what follows it is not empty / a frame, nothing after the name
 * is trusted: fail closed.
 *
 * RESIDUAL — A DECISION, NOT AN OVERSIGHT (PR #1042, decided by the orchestrator): code that
 * read `.stack`, then assigned a `.message` cut EXACTLY at a newline inside a bound value,
 * leaves a remainder that starts like a frame, and that value would be logged. It is known
 * and it is ACCEPTED. Only an assignment to `.message` after the stack is read can produce
 * it, and there is none anywhere in apps/api/src; the frames, by contrast, are what make a
 * database error diagnosable at all. Returning only the name would close the hypothetical
 * at the price of that real capability, and was rejected. If you ever add such an
 * assignment, revisit this — that is the moment the trade changes.
 */
export function safeErrorStack(err: unknown): string | undefined {
  if (!(err instanceof Error)) return String(err)
  if (!isPgNode(err as unknown as Dict) && !isDrizzleNode(err as unknown as Dict)) return err.stack
  if (err.stack === undefined) return undefined
  return nameAndFrames(err)
}

/**
 * The message-dropping half of `safeErrorStack`, extracted so there is ONE
 * implementation of it (`strictErrorStack` below needs the same logic for a
 * wider set of inputs). Behaviour is unchanged for `safeErrorStack`'s callers:
 * it is reached only on the same branch as before, with `.stack` defined.
 */
function nameAndFrames(err: Error): string {
  // Only `strictErrorStack` can arrive without a stack: `safeErrorStack` returns before calling here.
  if (err.stack === undefined) return err.name
  const header = `${err.name}: ${err.message}`
  const rest = err.stack.slice(header.length)
  // V8 builds the header lazily: if `.stack` was read and `.message` shortened afterwards,
  // the shortened header is a PREFIX of the frozen stack and `startsWith` alone passes while
  // the parameters sit in the remainder (SR-M-1). So the remainder must be empty or begin
  // with a frame. Nothing in apps/api assigns `.message`, so this is unreachable today.
  // (An empty remainder fails this test too and yields the same bare name: no frames.)
  if (!err.stack.startsWith(header) || !rest.startsWith('\n    at ')) return err.name
  const frames = rest.split('\n').filter((line) => /^\s+at /.test(line))
  return [err.name, ...frames].join('\n')
}

/**
 * SR-M-2 (PR #868 delta review). `safeErrorStack` drops the message only when the
 * TOP-LEVEL error is itself a pg or drizzle node; every other shape — a plain
 * `Error`, an `HttpException` — keeps its message, which is the right trade for the
 * swallow-and-log handlers it was written for (see its doc comment: the frames and
 * the message are what make those diagnosable, and the values they log are their
 * own static text).
 *
 * It is the WRONG trade on a path whose request body is candidate transcript. There
 * the message of an arbitrary error is untrusted by default: the moment any wrapper
 * rethrows with `e.message` interpolated — the shape the webhook controller's own
 * sibling tests already exercise with transcript canaries — the message carries
 * whatever the first error carried. Latent rather than live today, and cheap to
 * close now rather than after someone adds that wrapper.
 *
 * So: name plus frames, for EVERY shape, never the message. A non-`Error` throw is
 * reported by its type alone — `String(err)` on a thrown string IS the value, which
 * is exactly what must not be logged.
 */
export function strictErrorStack(err: unknown): string {
  if (!(err instanceof Error)) return `NonError(${typeof err})`
  return nameAndFrames(err)
}
