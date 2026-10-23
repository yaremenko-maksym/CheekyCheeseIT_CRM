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

/** Day 0 of the following month is the last day of this one. */
const lastDayOfMonthUtc = (year: number, month: number) =>
  new Date(Date.UTC(year, month + 1, 0)).getUTCDate()

/** True when `d` is the final day of its own month — Jan 31, Feb 28 (29 in a leap year), Apr 30. */
const isMonthEndUtc = (d: Date) =>
  d.getUTCDate() === lastDayOfMonthUtc(d.getUTCFullYear(), d.getUTCMonth())

/**
 * `anchor` plus `months` calendar months in UTC, keeping the time of day. A day of month the
 * target month does not have is clamped to that month's last day (Jan 31 + 1 -> Feb 28/29).
 *
 * CR-M-1 — WHY A MONTH-END ANCHOR STICKS TO MONTH-END. The meter row stores no original anchor:
 * each reset overwrites `resets_at`, and the overwritten value is the base the NEXT reset computes
 * from. Plain clamping is information-lossy, so the base decays — Jan 31 -> Feb 28, and then
 * Feb 28 + 1 month is Mar 28, not Mar 31. The day the meter resets on then depended on how often
 * anyone read the meter: stepped through every window it landed on Mar 28, skipped from January it
 * landed on Mar 31. That is the direction that OVERSPENDS — an early local reset zeroes `used`
 * while the provider still counts the old window, so the store re-admits spend the provider has
 * not forgiven yet.
 *
 * Treating "last day of the month" as the anchor itself closes that: month-end is a fixed point,
 * so Jan 31 -> Feb 28 -> Mar 31 -> Apr 30 whatever the traffic, and both histories above now agree
 * on Mar 31. A day that is NOT its month's end (the 15th) never clamps and is unaffected.
 *
 * The residual, bounded and in the safe direction: a 29th/30th anchor is not month-end, so its
 * first February still clamps it ONTO month-end (Jan 30 -> Feb 28), after which it sticks there.
 * A stepped history then resets one day later than a skipped one for a single window (Mar 31 vs
 * Mar 30) before the two converge on Apr 30. Later, not earlier, so it under-admits rather than
 * overspends. Removing it needs the original anchor persisted — a new column, and so an
 * owner-visible migration decision rather than something this task may invent.
 */
export function addMonthsUtc(anchor: Date, months: number): Date {
  const year = anchor.getUTCFullYear()
  const month = anchor.getUTCMonth() + months
  const lastDay = lastDayOfMonthUtc(year, month)
  return new Date(
    Date.UTC(
      year,
      month,
      isMonthEndUtc(anchor) ? lastDay : Math.min(anchor.getUTCDate(), lastDay),
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
 *
 * CR-M-1: stepping one window at a time and skipping several reach the SAME bounds — the schedule
 * is a property of the anchor, not of how often the meter was read (see `addMonthsUtc`, which is
 * what makes the monthly case hold, and `meter-window.spec.ts`, which asserts both histories).
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
