import type { JobMeterWindow } from '@crm/shared'

/**
 * Window arithmetic for `job_account_meters` (r5 Task 3.5a). Pure, so the calendar is tested
 * without a database; the store applies the result under the meter's row lock.
 *
 * A meter row is ONE row per (account, unit, window kind), not one row per window instance, so
 * a reset happens IN PLACE: `used` returns to zero and the window bounds advance. Outstanding
 * holds (`reserved`, `uncertain`) are NOT touched by a reset — they still belong to the window
 * they were taken in, and are settled against it (see `account-meter.store.ts`).
 */

const DAY_MS = 24 * 60 * 60 * 1000

export interface MeterWindowBounds {
  windowStartedAt: Date
  resetsAt: Date
}

/**
 * `anchor` plus `months` calendar months in UTC, keeping the time of day. A day of month the
 * target month does not have is clamped to that month's last day (Jan 31 + 1 -> Feb 28/29).
 */
export function addMonthsUtc(anchor: Date, months: number): Date {
  const year = anchor.getUTCFullYear()
  const month = anchor.getUTCMonth() + months
  // Day 0 of the following month is the last day of the target month.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(anchor.getUTCDate(), lastDay),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  )
}

/**
 * The bounds of the window that contains `now`, or `null` when the meter must not roll: a
 * LIFETIME meter, a windowed meter whose reset instant is unknown (NULL — the provider did not
 * publish one, so we never invent one), or a window that has not reached its reset yet.
 *
 * A reset is due AT `resetsAt`, inclusive. Windows that elapsed with no traffic are skipped in
 * one step, so the result always contains `now`.
 */
export function rollWindow(
  kind: JobMeterWindow,
  resetsAt: Date | null,
  now: Date,
): MeterWindowBounds | null {
  if (kind === 'LIFETIME' || resetsAt === null || now.getTime() < resetsAt.getTime()) return null

  if (kind === 'DAY') {
    const elapsed = Math.floor((now.getTime() - resetsAt.getTime()) / DAY_MS)
    const start = resetsAt.getTime() + elapsed * DAY_MS
    return { windowStartedAt: new Date(start), resetsAt: new Date(start + DAY_MS) }
  }

  // MONTH: the number of whole months from the old reset to now, corrected down by one when the
  // day/time of month has not come round yet.
  let months =
    (now.getUTCFullYear() - resetsAt.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - resetsAt.getUTCMonth())
  if (addMonthsUtc(resetsAt, months).getTime() > now.getTime()) months -= 1
  return {
    windowStartedAt: addMonthsUtc(resetsAt, months),
    resetsAt: addMonthsUtc(resetsAt, months + 1),
  }
}
