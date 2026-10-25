import { COLLECTION_ERROR_CODES, type CollectionErrorCode } from '../providers/reporting-provider'
import { activationOf } from '../registry/activation'
import type { RegisteredAdapter } from '../registry/registered-adapter'
import {
  MAX_CONSECUTIVE_FAILURES,
  MAX_CONSECUTIVE_FAILURES_CEILING,
} from '../scheduling/due-policy'
import type { LedgerCatalogEntry } from './ledger-catalog'

/**
 * The pure decisions of the run ledger (r5 Task 2.5 T3; ADR 2026-10-24-job-source-run-ownership.md,
 * "Claiming", "Failure accounting"). `job-run-ledger.ts` applies them in SQL under the row locks;
 * keeping them here is what lets the unit suite, and so the mutation gate, see every branch.
 */

/**
 * The claim's refusal reasons, a closed list written to `job_sources.last_error_code` (ADR T3,
 * "New codes"). `HOST_KEY_MISSING` is T8's own refusal for a NULL or policy-less host key; the ADR's
 * list predates it and it fails closed the same way, so it is carried here rather than dropped.
 */
export const CLAIM_REFUSALS = [
  'MANIFEST_ENTRY_MISSING',
  'NOT_ACTIVATABLE',
  'READINESS_BLOCKED',
  'TRANSPORT_NOT_WIRED',
  'METER_MISSING',
  'HOST_KEY_MISSING',
  'HOST_PAUSED',
  'HOST_BUSY',
  'HOST_RATE_GAP',
  'HOST_DAILY_CAP',
] as const
export type ClaimRefusal = (typeof CLAIM_REFUSALS)[number]

export interface GateInput {
  /** The registry's adapter for the row's `type`. */
  readonly adapter: RegisteredAdapter | undefined
  /** The catalog entry the row's `manifest_id` resolves to. */
  readonly entry: LedgerCatalogEntry | undefined
  /** The DATABASE clock, read in the claim transaction (SR-L-21). */
  readonly dbNow: Date
  /** The meter's account key through `account_meter_id`, or null when there is no meter row. */
  readonly meterKey: string | null
}

/**
 * Step 2 of a claim, on the locked row (SR-H-5). The KIND comes first: the ledger claims only
 * `REPORTING` adapters, so DOU (`LEGACY`) is refused `NOT_ACTIVATABLE` before its missing manifest
 * entry or NULL host key is even read (AC 18, SR-M-23).
 *
 * T2's activation check (`activationOf`) decides the rest: `NOT_VERIFIED` (an owner decision with no
 * captured evidence, an unverified payload) is `NOT_ACTIVATABLE` -- evidence is not permission; a
 * `BLOCKED` type (a permission, key, deadline or status blocker) or a blocked entry is
 * `READINESS_BLOCKED`.
 */
export function claimGate(input: GateInput): ClaimRefusal | null {
  const { adapter, entry, dbNow } = input
  if (adapter?.contract !== 'REPORTING') return 'NOT_ACTIVATABLE'
  if (entry === undefined || entry.type !== adapter.type) return 'MANIFEST_ENTRY_MISSING'
  const status = activationOf(adapter, entry.activationFacts(dbNow))
  const entryReady = entry.entryReadiness(dbNow) === 'CANDIDATE'
  if (status === 'NOT_VERIFIED') return 'NOT_ACTIVATABLE'
  if (status !== 'ACTIVATABLE' || !entryReady) return 'READINESS_BLOCKED'
  if (adapter.allowedHosts.length === 0 || adapter.adapterVersion === null) {
    return 'TRANSPORT_NOT_WIRED'
  }
  if (entry.quotaDeclared && input.meterKey === null) return 'METER_MISSING'
  return null
}

export type RefusalWrite =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'RECHECK' }
  | { readonly kind: 'UNTIL'; readonly at: Date }

const HOST_TIMED: ReadonlySet<ClaimRefusal> = new Set([
  'HOST_PAUSED',
  'HOST_RATE_GAP',
  'HOST_DAILY_CAP',
])

/**
 * What a SCHEDULED refusal commits to `job_sources.next_attempt_at` (ADR "A refusal never stays at
 * the head of the queue"). `HOST_BUSY` sets nothing: the source waits for the host's run to end. A
 * host refusal moves the source to when its slot opens (a database-computed instant, only written
 * back); without one it falls back to the recheck interval, as every persistent refusal does.
 */
export function refusalWrite(reason: ClaimRefusal, opensAt: Date | null): RefusalWrite {
  if (reason === 'HOST_BUSY') return { kind: 'NONE' }
  if (HOST_TIMED.has(reason) && opensAt !== null) return { kind: 'UNTIL', at: opensAt }
  return { kind: 'RECHECK' }
}

// ---------------------------------------------------------------------------
// How a run ends
// ---------------------------------------------------------------------------

export type RunEndOutcome = 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'CANCELLED'

const PARTIAL_CODES: ReadonlySet<string> = new Set(['PAGE_CAP', 'COST_STOP', 'DEADLINE'])
const KNOWN_CODES: ReadonlySet<string> = new Set(COLLECTION_ERROR_CODES)

/**
 * The closed table "Every way a run ends", for `finish`. `LEASE_EXPIRED` is refused here: only
 * recovery writes it, so a live worker cannot dress its own failure up as a crash.
 */
export function validateEnding(outcome: RunEndOutcome, code: CollectionErrorCode | null): void {
  const ok =
    outcome === 'SUCCEEDED'
      ? code === null
      : outcome === 'PARTIAL'
        ? code !== null && PARTIAL_CODES.has(code)
        : outcome === 'CANCELLED'
          ? code === 'CANCELLED'
          : outcome === 'FAILED' &&
            code !== null &&
            KNOWN_CODES.has(code) &&
            code !== 'LEASE_EXPIRED'
  if (!ok) throw new RangeError(`a run cannot end ${outcome} / ${String(code)}`)
}

export type EndingEffect = 'SUCCESS' | 'NEUTRAL' | 'COST_STOP' | 'FAILURE'

/**
 * The row of "Failure accounting" a run's ending selects. A `PARTIAL` run that stopped on its page
 * cap or deadline having persisted ZERO pages is a failure (SR-M-22): otherwise a source that never
 * gets a page through would be re-run forever without reaching the cap. Every `FAILED` code counts,
 * `LEASE_EXPIRED` included (SR-L-18), whatever the run persisted before it (SR-H-4).
 */
export function endingEffect(
  outcome: RunEndOutcome,
  code: CollectionErrorCode | null,
  pagesPersisted: boolean,
): EndingEffect {
  if (outcome === 'SUCCEEDED') return 'SUCCESS'
  if (outcome === 'CANCELLED') return 'NEUTRAL'
  if (outcome === 'PARTIAL' && code === 'COST_STOP') return 'COST_STOP'
  if (outcome === 'PARTIAL' && pagesPersisted) return 'NEUTRAL'
  return 'FAILURE'
}

/** The failure backoff after the `failures`-th consecutive failure: base, doubling, capped. */
export function backoffMs(failures: number, baseMs: number, maxMs: number): number {
  if (!Number.isInteger(failures) || failures < 1) {
    throw new RangeError(`backoff: invalid failure count ${failures}`)
  }
  // The exponent is clamped so the product stays finite; the cap is reached long before.
  return Math.min(baseMs * 2 ** Math.min(failures - 1, 30), maxMs)
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface LedgerOptions {
  /** `L`: a claim's and a heartbeat's lease. */
  readonly leaseMs: number
  /** `RUN_MAX_AGE` (SR-M-18): no heartbeat extends a lease past `started_at` + this. */
  readonly runMaxAgeMs: number
  /** `REFUSAL_RECHECK`: how far a persistent refusal pushes `next_attempt_at`. */
  readonly refusalRecheckMs: number
  /** `MAX_CLAIM_SCAN`: candidate transactions one `claimDue` call may run. */
  readonly maxClaimScan: number
  /** `claimSource`'s `lock_timeout` (SR-L-16). */
  readonly claimLockTimeoutMs: number
  readonly backoffBaseMs: number
  readonly backoffMaxMs: number
  readonly maxConsecutiveFailures: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const DEFAULT_LEDGER_OPTIONS: LedgerOptions = Object.freeze({
  leaseMs: 5 * MINUTE,
  runMaxAgeMs: 2 * HOUR,
  refusalRecheckMs: 6 * HOUR,
  maxClaimScan: 50,
  claimLockTimeoutMs: 2_000,
  backoffBaseMs: HOUR,
  backoffMaxMs: DAY,
  maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
})

/** Ceilings: each option is a config value with a ceiling (ADR "What this ADR does not decide"). */
const CEILINGS: Readonly<Record<keyof LedgerOptions, number>> = {
  leaseMs: HOUR,
  runMaxAgeMs: DAY,
  refusalRecheckMs: 7 * DAY,
  maxClaimScan: 500,
  claimLockTimeoutMs: 30_000,
  backoffBaseMs: 7 * DAY,
  backoffMaxMs: 7 * DAY,
  maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES_CEILING,
}

export function resolveLedgerOptions(over: Partial<LedgerOptions> = {}): LedgerOptions {
  const o: LedgerOptions = { ...DEFAULT_LEDGER_OPTIONS, ...over }
  for (const key of Object.keys(CEILINGS) as (keyof LedgerOptions)[]) {
    const v = o[key]
    if (!Number.isSafeInteger(v) || v < 1 || v > CEILINGS[key]) {
      throw new RangeError(`ledger option ${key} = ${v} is outside 1..${CEILINGS[key]}`)
    }
  }
  if (o.leaseMs > o.runMaxAgeMs) throw new RangeError('the lease must not outlive RUN_MAX_AGE')
  if (o.backoffBaseMs > o.backoffMaxMs) throw new RangeError('the backoff base exceeds its cap')
  return o
}

// ---------------------------------------------------------------------------
// The manual claim's due terms
// ---------------------------------------------------------------------------

/** Why `claimSource` refused, beyond the gates: the due predicate's own terms, a lock, a race. */
export type ManualRefusal =
  | ClaimRefusal
  | 'NOT_FOUND'
  | 'DISABLED'
  | 'NOT_ACTIVE'
  | 'NO_MANIFEST_ENTRY'
  | 'TRIGGER_MODE'
  | 'FAILURE_CAP'
  | 'COOLING_DOWN'
  | 'ALREADY_RUNNING'
  | 'LOCK_TIMEOUT'
  | 'CONFLICT'

/**
 * The first failing term of the MANUAL due predicate, in `isDue`'s order, or null when all pass.
 * Each `t_*` is a boolean the claim's SQL computed on the locked row against the database clock;
 * anything but a literal `true` refuses (a NULL included).
 */
export function manualTermRefusal(row: Readonly<Record<string, unknown>>): ManualRefusal | null {
  if (row['t_enabled'] !== true) return 'DISABLED'
  if (row['t_active'] !== true) return 'NOT_ACTIVE'
  if (row['t_manifest'] !== true) return 'NO_MANIFEST_ENTRY'
  if (row['t_trigger'] !== true) return 'TRIGGER_MODE'
  if (row['t_cap'] !== true) return 'FAILURE_CAP'
  if (row['t_cool'] !== true) return 'COOLING_DOWN'
  if (row['t_idle'] !== true) return 'ALREADY_RUNNING'
  // The host term of the predicate: a NULL key, or a paused host.
  if (row['t_due'] !== true) return row['host_key'] === null ? 'HOST_KEY_MISSING' : 'HOST_PAUSED'
  return null
}
