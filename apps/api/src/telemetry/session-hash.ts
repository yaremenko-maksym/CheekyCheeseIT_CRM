import { createHash } from 'node:crypto'

/**
 * session-hash.ts — task-telemetry-api contract: `telemetry_events.session_hash
 * = sha256(userId + суточная соль из env-секрета)`.
 *
 * Privacy contract (spec §"Решения владельца"): UX events carry "только роль
 * + хэш сессии" — never the raw userId. The salt itself ROTATES DAILY (derived
 * from `TELEMETRY_SESSION_SALT` + the current UTC date, not stored anywhere),
 * so the same user's events group together WITHIN a day (useful for session-
 * shaped analysis) but CANNOT be correlated across days without the secret —
 * "patterns visible, identity not" (design spec §1).
 */

function utcDateString(now: Date): string {
  // ISO 8601 date component only, e.g. "2026-07-24" — always UTC (getters on
  // `Date` used here are UTC-based via `toISOString`, not local timezone).
  return now.toISOString().slice(0, 10)
}

/** sha256(secret :: today's UTC date), hex-encoded. Recomputed per-call — never persisted. */
export function computeDailySalt(secret: string, now: Date = new Date()): string {
  return createHash('sha256')
    .update(`${secret}::${utcDateString(now)}`)
    .digest('hex')
}

/** sha256(userId :: today's daily salt), hex-encoded. */
export function computeSessionHash(userId: string, secret: string, now: Date = new Date()): string {
  const dailySalt = computeDailySalt(secret, now)
  return createHash('sha256').update(`${userId}::${dailySalt}`).digest('hex')
}
