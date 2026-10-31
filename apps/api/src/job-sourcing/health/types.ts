/**
 * Source-fetch-strategy U4 — health states, reasons and the detector input shape.
 *
 * Design: docs/architecture/2026-10-25-source-fetch-strategy.md section 10.
 *
 * A source's CURRENT state is not stored: it is the `to_state` of its latest `TRANSITION`
 * event (section 10). The detector pass derives a `{ state, reasonCode }` from a snapshot of
 * recent runs plus a few source/manifest facts, and writes a new event only when that pair
 * changes (`classifyHealth` + the pass).
 */

/** The health states, in precedence order — the first that applies wins (section 10). */
export const HEALTH_STATES = [
  'BLOCKED',
  'CAPPED',
  'PAUSED',
  'FAILING',
  'EMPTY',
  'DEGRADED',
  'SILENT',
  'HEALTHY',
] as const

export type HealthState = (typeof HEALTH_STATES)[number]

/**
 * The reason a transition carries (section 10's detector table). `SCHEMA_DRIFT` is a reason
 * that puts a source in `DEGRADED`, never a state of its own.
 */
export const HEALTH_REASONS = [
  'VOLUME_DROP',
  'NO_NEW_ITEMS',
  'EMPTY_RESPONSE',
  'SCHEMA_DRIFT',
  'ACCESS_CHANGED',
  'THROTTLED',
  'SLOW',
  'PAYLOAD_GROWTH',
  'STALE_FEED',
  'BOARD_GONE',
  'DEADLINE_NEAR',
] as const

export type HealthReason = (typeof HEALTH_REASONS)[number]

/** The event kinds the append-only log carries. */
export type HealthEventKind = 'TRANSITION' | 'NOTE'

/**
 * One run of a source, reduced to the fields the detectors read. Built by the pass from
 * `job_collection_runs` (the U2 metric columns included); the detectors never touch the DB.
 *
 * `durationMs` is derived (`ended_at − started_at`), never stored (ADR Assumptions).
 */
export interface RunFact {
  readonly runId: string
  readonly startedAt: Date
  readonly endedAt: Date | null
  readonly outcome: 'STARTED' | 'PARTIAL' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
  readonly received: number
  readonly created: number
  readonly invalid: number
  readonly bytesRead: number | null
  readonly lastHttpStatus: number | null
  readonly newestItemPublishedAt: Date | null
  readonly envelopeFingerprint: string | null
  readonly errorCode: string | null
  readonly adapterVersion: string
  readonly configVersion: number
}

/**
 * A source's recent history and its manifest facts, as the detectors see it. `runs` is the
 * 14-day window, newest first.
 */
export interface HealthSnapshot {
  readonly now: Date
  readonly runs: readonly RunFact[]
  /** Section 10 "Board gone": an employer board (Greenhouse/Lever/…) rather than a feed. */
  readonly isEmployerBoard: boolean
  /** The provider's own freshness allowance in ms (24 h Remotive, 3 h Jobicy); null = no claim. */
  readonly freshnessMaxAgeMs: number | null
  /** A policy deadline (Recruitee 2027-02-10); null = none. `DEADLINE_NEAR` fires under 30 days. */
  readonly policyDeadline: Date | null
}

/**
 * The source/ledger facts the STATE (not the reasons) is derived from. The pass computes the
 * booleans from `job_sources` / `job_source_hosts`; keeping them booleans keeps `classifyHealth`
 * pure and free of the failure-cap constant (which lives in the ledger policy, not here).
 */
export interface HealthStateFacts {
  readonly adminState: 'ACTIVE' | 'PAUSED' | 'RETIRED'
  /** A BLOCKED cause other than `admin_state`: policy, a passed deadline, missing evidence. */
  readonly blocked: boolean
  /** `consecutive_failures >= MAX_CONSECUTIVE_FAILURES` (the ledger policy decides the cap). */
  readonly atFailureCap: boolean
  /** The source's host is under a ban pause (`job_source_hosts.paused_until` in the future). */
  readonly hostPaused: boolean
  readonly consecutiveFailures: number
  /** The detector reasons that fired this pass. */
  readonly reasons: readonly HealthReason[]
}

/** The classifier's verdict for one source. */
export interface HealthVerdict {
  readonly state: HealthState
  readonly reasonCode: HealthReason | null
}
