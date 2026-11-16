const MS_PER_MINUTE = 60_000
/** A source with no fetch profile (never scheduled) counts as fresh for a day. */
const NULL_PROFILE_FRESH_MS = 24 * 60 * MS_PER_MINUTE

/**
 * Is the source's last ATTEMPT recent enough that enabling it needs no immediate fetch?
 * `job_sources.last_attempt_at` is stamped on every claim (a later cancel or failure included), so
 * an enable -> disable -> enable loop inside the window starts one fetch, not one per enable (SR-H-1).
 * Window = max(profile `intervalMinutes`, host `floorHours`); null profile: 24 h. Never attempted =
 * stale. An unreadable clock counts as fresh: the slot `setEnabled` armed fetches on the next tick.
 */
export function isFreshForEnable(input: {
  readonly lastAttemptAtMs: number | null
  readonly nowMs: number | null
  readonly intervalMinutes: number | null
  readonly floorHours: number
}): boolean {
  if (input.nowMs === null) return true
  if (input.lastAttemptAtMs === null) return false
  const windowMs =
    input.intervalMinutes === null
      ? NULL_PROFILE_FRESH_MS
      : Math.max(input.intervalMinutes, input.floorHours * 60) * MS_PER_MINUTE
  return input.nowMs - input.lastAttemptAtMs <= windowMs
}

/** A DB epoch-ms value (`float8` may arrive as a number or a numeric string) or null. */
export function msOrNull(value: unknown): number | null {
  // `Number(null)` and `Number('')` are 0, not "absent"; `undefined` already gives NaN.
  if (value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
