import { addCalendarMonths, kyivToday } from '@crm/shared'

export type Period = 'all' | 'current' | 'prev' | '3m'

/**
 * `from`/`to` day keys (`YYYY-MM-DD`) for a finance period filter, on the KYIV
 * business-day clock (the same clock the server uses), derived from the calendar
 * parts of the day key. No `Date` object is built here, so neither the browser
 * timezone nor `setMonth` overflow can shift a key.
 */
export function periodToDates(
  period: Period,
  today: string = kyivToday(),
): { from?: string; to?: string } {
  if (period === 'all') return {}

  const monthStart = `${today.slice(0, 7)}-01`
  if (period === 'current') return { from: monthStart }
  if (period === 'prev') {
    const from = addCalendarMonths(monthStart, -1)
    // `-31` clamped into its own month (delta 0) is that month's last day.
    return { from, to: addCalendarMonths(`${from.slice(0, 7)}-31`, 0) }
  }
  // 3m
  return { from: addCalendarMonths(today, -3) }
}
