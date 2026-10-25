import { sql } from 'drizzle-orm'
import { findPgError } from '../../database/pg-errors'
import type { SqlExecutor } from '../scheduling/host-state'

/**
 * Lock order and bounded contention retries for the record store (r5 Task 4.5).
 *
 * THE ORDER (an extension of the ADR 2026-10-24 lock-acquisition table, never a reversal of it):
 *   observation path   `job_collection_runs` 1 row (`assertOwned`) -> `job_source_records` in
 *                      ascending (namespace, identity_key), as `savePage` already does, so two
 *                      runs whose pages overlap lock their records in the same order;
 *   canonical path     `job_source_records` by id ascending -> `job_opportunities` by id
 *                      ascending, all opportunities locked in one statement before any write.
 * The two paths order records by different keys. They run in different transactions (4.6 runs
 * canonical resolution from the dirty-work worker, not inside a page), and a deadlock between a
 * page and a canonical transaction that share two records in opposite orders is the residual
 * case the bounded retry below exists for: Postgres aborts one side with 40P01 and the retry
 * re-runs the WHOLE transaction.
 */

/** SQLSTATEs that mean "the same transaction may succeed if run again". */
const RETRYABLE = new Set(['40P01', '40001', '55P03'])

const MAX_ATTEMPTS = 3
const BASE_MS = 10

/**
 * A race the store detected itself and resolves by re-running the transaction: a claim lost to
 * a concurrent winner whose row was not yet visible to the statement that planned the write.
 */
export class RetryableRaceError extends Error {
  constructor(what: string) {
    super(`lost a concurrent ${what} race`)
    this.name = 'RetryableRaceError'
  }
}

/** Contention persisted through every attempt. The caller sees one typed error, not a 40P01. */
export class LockContentionError extends Error {
  readonly code = 'LOCK_CONTENTION' as const

  constructor(
    readonly sqlstate: string,
    readonly attempts: number,
    cause: unknown,
  ) {
    super(`lock contention persisted after ${attempts} attempts (${sqlstate})`, { cause })
    this.name = 'LockContentionError'
  }
}

/** The retryable code of `err` (its SQLSTATE, or 'RACE' for the store's own signal), or null. */
export function retryableCode(err: unknown): string | null {
  if (err instanceof RetryableRaceError) return 'RACE'
  const code = String(findPgError(err)?.['code'])
  return RETRYABLE.has(code) ? code : null
}

/** Exponential backoff with jitter: 10 ms, 20 ms, 40 ms … each scaled into [0.5, 1.5). */
export function backoffMs(attempt: number, random: () => number): number {
  return Math.floor(BASE_MS * 2 ** (attempt - 1) * (0.5 + random()))
}

export interface RetryOptions {
  maxAttempts?: number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Run `attempt` (one whole transaction) up to `maxAttempts` times while it fails with a
 * retryable code; anything else is rethrown at once, untouched.
 */
export async function withLockRetry<T>(
  attempt: () => Promise<T>,
  { maxAttempts = MAX_ATTEMPTS, sleep = realSleep, random = Math.random }: RetryOptions = {},
): Promise<T> {
  for (let n = 1; ; n += 1) {
    try {
      return await attempt()
    } catch (err) {
      const code = retryableCode(err)
      if (code === null) throw err
      if (n >= maxAttempts) throw new LockContentionError(code, n, err)
      await sleep(backoffMs(n, random))
    }
  }
}

interface Keyed {
  readonly identity: { readonly namespace: string; readonly identityKey: string }
  readonly contentHash: string
}

/**
 * Ascending (namespace, identity key) by code unit. Within one identity the arrival order is kept
 * and only EXACT repeats (same identity and content hash) are dropped (CR-M-3): two contents of
 * one posting in one page are both stored, the later one last. The sort key joins the two with
 * NUL, the smallest code unit, which no stored text can contain (Postgres text has no NUL), so the
 * default string sort IS the tuple order — no comparator to get wrong, and independent of any
 * database collation.
 */
export function byNaturalKey<T extends Keyed>(items: readonly T[]): T[] {
  const byKey = new Map<string, Map<string, T>>()
  for (const item of items) {
    const key = `${item.identity.namespace}\u0000${item.identity.identityKey}`
    const contents = byKey.get(key) ?? new Map<string, T>()
    if (!contents.has(item.contentHash)) contents.set(item.contentHash, item)
    byKey.set(key, contents)
  }
  return [...byKey.keys()].sort().flatMap((k) => [...(byKey.get(k) as Map<string, T>).values()])
}

/** Ids ascending (code unit), each once: the order every multi-row lock takes. */
export function sortedUniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort()
}

/**
 * `SET LOCAL lock_timeout` for the store's own transaction: a lock wait ends in 55P03, which
 * `withLockRetry` retries and then types, instead of an unbounded wait. SET takes no bind
 * parameter, so the value is validated and inlined.
 */
export async function setLockTimeout(tx: SqlExecutor, ms: number): Promise<void> {
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new RangeError(`setLockTimeout: invalid ${ms}`)
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${ms}ms'`))
}
