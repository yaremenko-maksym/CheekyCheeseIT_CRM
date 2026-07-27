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
  let cur: unknown = err
  // Bounded walk — guards against a (pathological) self-referential cause chain.
  for (let depth = 0; cur != null && depth < 8; depth += 1) {
    if ((cur as { code?: unknown }).code === PG_UNIQUE_VIOLATION) return true
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}
