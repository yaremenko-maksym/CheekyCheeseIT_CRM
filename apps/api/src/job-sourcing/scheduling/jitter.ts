/**
 * Jitter helpers for job-sourcing scheduled work (load-spreading only).
 *
 * Spreads cron starts and per-host request bursts across time so target hosts
 * do not see identical spikes on the same second. Jittered delays are always
 * ADDED to the minimum; they never shorten any gap, deadline or budget.
 */

export const START_OFFSET_SHARE = 0.1
export const START_OFFSET_MAX_MS = 600_000
export const GAP_JITTER_SHARE = 0.5

export type Random = () => number

/**
 * Random start offset taken from the window budget:
 * U[0, min(10 % of windowMs, 10 min)].
 * When windowMs <= 0, returns 0.
 */
export function startOffsetMs(windowMs: number, random: Random = Math.random): number {
  // Stryker disable next-line EqualityOperator: when windowMs is 0, Math.floor(random() * 0) evaluates to 0 anyway
  if (windowMs <= 0) return 0
  const maxOffset = Math.min(windowMs * START_OFFSET_SHARE, START_OFFSET_MAX_MS)
  return Math.floor(random() * maxOffset)
}

/**
 * Jittered per-host gap: minGapMs * (1 + U[0, 0.5]).
 * Never less than minGapMs.
 * When minGapMs <= 0, returns 0.
 */
export function jitteredGapMs(minGapMs: number, random: Random = Math.random): number {
  // Stryker disable next-line EqualityOperator: when minGapMs is 0, Math.ceil(0 * factor) evaluates to 0 anyway
  if (minGapMs <= 0) return 0
  // ceil, not floor: a fractional minimum (a decimal Crawl-delay) is never undercut (SR-M-1).
  return Math.ceil(minGapMs * (1 + random() * GAP_JITTER_SHARE))
}
