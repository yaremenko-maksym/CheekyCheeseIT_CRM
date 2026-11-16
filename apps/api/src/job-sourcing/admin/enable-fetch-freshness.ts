const MS_PER_MINUTE = 60_000
/** A source with no fetch profile (never scheduled) counts as fresh for a day. */
const NULL_PROFILE_FRESH_MS = 24 * 60 * MS_PER_MINUTE

/**
 * Is the source's last SUCCEEDED run recent enough that enabling it needs no immediate fetch?
 * Fresh = it ended within the catalog profile's `intervalMinutes` (null profile: 24 h). Never ran = stale.
 */
export function isFreshForEnable(input: {
  readonly lastSuccessEndedAtMs: number | null
  readonly nowMs: number
  readonly intervalMinutes: number | null
}): boolean {
  if (input.lastSuccessEndedAtMs === null) return false
  const windowMs =
    input.intervalMinutes === null ? NULL_PROFILE_FRESH_MS : input.intervalMinutes * MS_PER_MINUTE
  return input.nowMs - input.lastSuccessEndedAtMs <= windowMs
}
