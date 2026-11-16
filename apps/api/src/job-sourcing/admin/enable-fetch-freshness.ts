const MS_PER_MINUTE = 60_000

/**
 * Is the source's last ATTEMPT recent enough that enabling it needs no immediate fetch?
 * `job_sources.last_attempt_at` is stamped on every claim (a later cancel or failure included), so
 * an enable -> disable -> enable loop inside the window starts one fetch, not one per enable (SR-H-1).
 * `windowMinutes` is `enableWindowMinutes(entry)` (ledger-policy), the rule the enable slot uses too.
 * Never attempted = stale. An unreadable clock counts as fresh: the armed slot fetches on a tick.
 */
export function isFreshForEnable(input: {
  readonly lastAttemptAtMs: number | null
  readonly nowMs: number | null
  readonly windowMinutes: number
}): boolean {
  if (input.nowMs === null) return true
  if (input.lastAttemptAtMs === null) return false
  return input.nowMs - input.lastAttemptAtMs <= input.windowMinutes * MS_PER_MINUTE
}

/** A DB epoch-ms value (`float8` may arrive as a number or a numeric string) or null. */
export function msOrNull(value: unknown): number | null {
  // `Number(null)` and `Number('')` are 0, not "absent"; `undefined` already gives NaN.
  if (value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
