/**
 * Postgres error helpers shared by the services that rely on a unique index as
 * their authoritative (TOCTOU-safe) guard.
 *
 * Extracted from `finance/transactions.service.ts` (task-onchain-payment-integrity)
 * so the finance write paths — `transactions.service` and `company-account.service`
 * — detect a constraint collision the SAME way. Previously company-account read
 * `(err as {code}).code` off the TOP-LEVEL error only, which silently misses the
 * violation whenever drizzle wraps it (see the cause-chain note below) and turned
 * a would-be clean 400 into a 500.
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
