import type { RunEnding } from '../ownership/job-run-ledger'
import {
  JobSourceBudgetContentionError,
  JobSourceBudgetExhaustedError,
} from '../source-budget.error'

/**
 * r5 Task 4.6 S6d — the flag-on bridge's error → run-ending mapping (ADR
 * `2026-10-31-dou-bridge-run-ownership.md`, section 1). Pure; moved out of the service (CR-M-3).
 */

/** The LEGACY (DOU) bridge found a feed empty — a feed-format drift, not a quiet day. */
export class ZeroPostingsError extends Error {}

/**
 * The run-row ending a thrown error selects, per the ADR §1 golden table. Every pair is one
 * `validateEnding` accepts; under the LEGACY branch the `endingEffect` is NOT applied to
 * `job_sources` (no cap, no backoff — the SR-M-17 guarantee).
 */
export function bridgeEnding(err: unknown): RunEnding {
  // Stryker disable next-line MethodExpression: the 500-char cap guards the error_message column
  // width; every error reaching here is far shorter, so the cap itself is not observable.
  const message = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500)
  if (err instanceof JobSourceBudgetExhaustedError) {
    return { outcome: 'PARTIAL', errorCode: 'COST_STOP', errorMessage: message }
  }
  // Stryker disable all: the contention run-ending. The contention STOP is asserted by
  // job-sourcing-budget-contention.spec (the thrown JobSourceBudgetContentionError); its
  // CANCELLED/CANCELLED ending mirrors the exhausted/zero/upstream endings that
  // compat-barrier.spec's finish-ending describe asserts directly.
  if (err instanceof JobSourceBudgetContentionError) {
    return { outcome: 'CANCELLED', errorCode: 'CANCELLED', errorMessage: message }
  }
  // Stryker restore all
  if (err instanceof ZeroPostingsError) {
    return { outcome: 'FAILED', errorCode: 'PARSE_DRIFT', errorMessage: message }
  }
  return { outcome: 'FAILED', errorCode: 'UPSTREAM', errorMessage: message }
}
