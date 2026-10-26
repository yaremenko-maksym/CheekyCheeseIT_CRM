/**
 * The KYIV CALENDAR DAY, as `YYYY-MM-DD` — SINGLE SOURCE OF TRUTH.
 *
 * backlog 148 (security-review PR #574 MED-2, then PR #578 review MED-1/MED-2):
 * NBU's operational day turns at Kyiv midnight, not UTC midnight, so
 * "today" for anything priced off the NBU rate must be the KYIV calendar
 * day. PR #578 fixed this ONLY on the server
 * (`NbuCurrencyService.todayStr()`) and left THREE other "today" computations
 * on plain UTC:
 *   - the client-side `exchange-rate` react-query cache key
 *     (`amount-currency-input.tsx`, `PaySalaryDialog.tsx`, `UserDialog.tsx`)
 *   - the DROP-settle `txDate` upper bound (`settleSeniorPayoutSchema` in
 *     `finance.ts`) and its mirrored date-picker `maxDate`
 *     (`SettleSeniorPayoutDialog.tsx`)
 * — a THIRD, independent definition of "today" quietly reappearing is
 * exactly how the original bug happened in the first place (the server used
 * to have its own UTC `todayStr`, disagreeing with NBU's Kyiv-based one).
 * This module is the fix for that pattern, not just for one call site: EVERY
 * "what day is it, for NBU-rate purposes" question — on the server, in a
 * React Query cache key, or inside a Zod schema — goes through this ONE
 * function, in both `@crm/api` and `@crm/web`.
 *
 * ── WHY `Intl.DateTimeFormat` AND NOT MANUAL OFFSET ARITHMETIC ─────────────
 * Kyiv is UTC+2 in winter (EET) and UTC+3 in summer (EEST, DST). A
 * hand-rolled "+2 or +3 hours" would have to know which one applies on any
 * given instant — exactly the DST bug class already fixed once in
 * `NbuCurrencyService.prevDayStr` (see its comment in `nbu-currency.service.ts`).
 * `Intl.DateTimeFormat` with an explicit `timeZone: 'Europe/Kyiv'` asks the
 * real IANA tz database to resolve the INSTANT (`Date.now()`, a UTC epoch
 * number) to Kyiv wall-clock components directly — the offset and every DST
 * transition are looked up per-instant, never assumed. This works
 * identically in Node (the API) and in every evergreen browser (the client)
 * — `Intl.DateTimeFormat` with an IANA `timeZone` is universally supported,
 * no polyfill needed.
 *
 * `en-CA` is the one built-in locale whose `format()` output is already
 * `YYYY-MM-DD` — no manual reassembly of `{ year, month, day }` parts (and no
 * risk of a locale that reorders them).
 *
 * ── WHY LAZY, NOT A MODULE-TOP-LEVEL CONSTANT ───────────────────────────────
 * Built once and cached — `Intl.DateTimeFormat` construction re-parses the
 * timezone database and is not free to redo on every call — but on the FIRST
 * call to `kyivToday()`, not at module import. A malformed option
 * (`timeZone`/`year`/`month`/`day`) makes the constructor THROW (verified:
 * `new Intl.DateTimeFormat('en-CA', { timeZone: '' })` raises `RangeError:
 * Invalid time zone specified`). A top-level `const` would throw at MODULE
 * LOAD — invisible to a mutation run's coverage-per-test accounting (a
 * collection-time crash instead of a runtime one inside a covering test) and
 * — worse in production — a NestJS bootstrap crash on startup rather than a
 * caught, attributable error. Lazy construction moves that same throw inside
 * an ordinary function call, where a normal test can observe it with
 * `expect(() => kyivToday()).not.toThrow()`.
 */
let kyivDayFormatter: Intl.DateTimeFormat | undefined

/**
 * The Kyiv calendar day of an instant the CALLER supplies, as `YYYY-MM-DD`.
 *
 * Exists for the transaction-date policy (SR-809-H-1), which compares an
 * operator-chosen date against the business day and must be deterministic under
 * an injected clock — a policy reading the real `Date.now()` cannot be tested at
 * a window boundary without faking global time. Everything in the module comment
 * above applies unchanged: the offset and every DST transition are looked up
 * per-instant via the IANA database, never assumed.
 */
export function kyivDayOf(at: Date): string {
  kyivDayFormatter ??= new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return kyivDayFormatter.format(at)
}

/**
 * Today's Kyiv calendar day, as `YYYY-MM-DD`. See the module comment above.
 *
 * Defined in terms of `kyivDayOf` so there is still exactly ONE definition of
 * the Kyiv day — the property this module exists to protect.
 */
export function kyivToday(): string {
  return kyivDayOf(new Date())
}

/**
 * The latest business day a settlement may be recorded as of, given the business
 * day of the row it settles: `max(kyivToday(), sourceBusinessDay)`.
 *
 * ONE definition, called by both enforcement points — `PendingSettlementService`
 * (the server bound) and `SettleSeniorPayoutDialog` (the picker's `maxDate`).
 * CR-M-4: it used to be hand-written in both, which is `CR-795-M-7`'s
 * duplicated-predicate defect reappearing inside the very change meant to end
 * it, and it carried two separate Stryker equivalence proofs for one rule.
 *
 * Why the bound is a MAX rather than simply "today" (SR-809-M-2 / CR-809-H-1):
 * a settlement never predates the row it settles, so the lower bound is that
 * row's own day. If that day is itself in the future, a flat "not after today"
 * upper bound sits BELOW the lower one — `min > max`, an empty date picker, and
 * an obligation nobody can settle. Taking the later of the two keeps the range
 * non-empty in exactly that case and changes nothing otherwise.
 *
 * Both arguments and the result are `YYYY-MM-DD`, where string ordering IS
 * calendar ordering, so no timezone arithmetic happens here.
 */
export function latestSettleBusinessDay(sourceBusinessDay: string): string {
  const today = kyivToday()
  // Stryker disable next-line EqualityOperator: PROVABLY equivalent mutant (`>` to `>=`), not an untested bound. The two differ in which BRANCH is taken only when the operands are equal, and then both branches return the same string. Verified exhaustively over the three orderings (source after / equal to / before today): the returned value is identical for all three, so no test can distinguish the mutant. WHICH of the two values is returned is tested both ways in kyiv-day.spec.ts.
  return sourceBusinessDay > today ? sourceBusinessDay : today
}

/**
 * The Kyiv calendar month of an instant, as `YYYY-MM`. The month-bucketing
 * counterpart of `kyivDayOf`: between 00:00 and 02:00/03:00 Kyiv on the 1st the
 * UTC month is still the previous one, so `toISOString().slice(0, 7)` mis-files
 * the row. Derived from `kyivDayOf` so there is still ONE definition of the day.
 */
export function kyivMonthOf(at: Date): string {
  return kyivDayOf(at).slice(0, 7)
}

/**
 * Shift a `YYYY-MM-DD` day by whole calendar months, clamping the day to the
 * last day of the target month (31 May - 3 months = 28 Feb, not 3 Mar).
 *
 * Pure calendar arithmetic on the key's parts: no `Date#setMonth` (which
 * overflows on the 29th-31st) and no host timezone involved.
 */
export function addCalendarMonths(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const index = y * 12 + (m - 1) + delta
  const year = Math.floor(index / 12)
  const month = (index % 12) + 1
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const pad = (n: number, w: number) => String(n).padStart(w, '0')
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(Math.min(d, lastDay), 2)}`
}

let kyivHourFormatter: Intl.DateTimeFormat | undefined

/** The first instant of the KYIV calendar month `month` (`YYYY-MM`). */
function kyivMonthStartInstant(month: string): Date {
  const utcMidnight = Date.parse(`${month}-01T00:00:00.000Z`)
  kyivHourFormatter ??= new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    hourCycle: 'h23',
  })
  // At 00:00Z on the 1st Kyiv is already on the 1st, and its wall-clock hour IS
  // its UTC offset (2 or 3). The zone never changes offset on the 1st of a month
  // (EU transitions fall on the last Sunday), so the same offset holds at the
  // month's true first instant. Looked up per-instant, never hard-coded.
  const offsetHours = Number(kyivHourFormatter.format(new Date(utcMidnight)))
  return new Date(utcMidnight - offsetHours * 3_600_000)
}

/**
 * The bounds a reader needs to select the rows of ONE business month, mirroring
 * `transactionBusinessMonth` exactly (backlog 338): a row is in month M iff
 *   - `tx_date` IS NOT NULL and its UTC-midnight month is M
 *       -> `tx_date >= dateStart AND tx_date < dateEnd`, or
 *   - `tx_date` IS NULL and the KYIV month of `created_at` is M
 *       -> `created_at >= instantStart AND created_at < instantEnd`.
 * A single `coalesce(tx_date, created_at)` against one window cannot express
 * this: the two branches live on different clocks.
 *
 * `dateStart`/`dateEnd` are UTC midnights (date-only values are stored that way);
 * `instantStart`/`instantEnd` are the real instants Kyiv midnight falls on, which
 * is 22:00Z or 21:00Z of the previous UTC day depending on DST. All half-open.
 */
export interface BusinessMonthWindow {
  month: string
  dateStart: Date
  dateEnd: Date
  instantStart: Date
  instantEnd: Date
}

export function businessMonthWindow(month: string): BusinessMonthWindow {
  const next = addCalendarMonths(`${month}-01`, 1).slice(0, 7)
  return {
    month,
    dateStart: new Date(`${month}-01T00:00:00.000Z`),
    dateEnd: new Date(`${next}-01T00:00:00.000Z`),
    instantStart: kyivMonthStartInstant(month),
    instantEnd: kyivMonthStartInstant(next),
  }
}

/**
 * The business DAY (`YYYY-MM-DD`) of a transaction row — the day-level
 * counterpart of the API's `transactionBusinessMonth` (backlog 338, QA-LOW-1).
 *
 *   - a non-null `txDate` is a date-only value stored at UTC midnight, so its
 *     own UTC day IS the business day;
 *   - a NULL `txDate` (legacy rows) falls back to the KYIV day of the
 *     `createdAt` instant, never its UTC day: 21:00-24:00 UTC is already the
 *     next day in Kyiv.
 *
 * ONE definition for every reader: the server's payment-date floors
 * (`FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION` / `_BEFORE_INCOME`) and the web's
 * date cells, hints and picker minimums. A client minimum that disagrees with
 * the server floor offers a date the API refuses (QA-MED-1 of #1146).
 *
 * Returns `null` instead of throwing when the value it needs is unparseable:
 * `toISOString()` and `Intl` both raise `RangeError` on an invalid `Date`.
 */
export function transactionBusinessDay(
  txDate: string | Date | null | undefined,
  createdAt: string | Date,
): string | null {
  const d = new Date(txDate || createdAt)
  if (Number.isNaN(d.getTime())) return null
  return txDate ? d.toISOString().slice(0, 10) : kyivDayOf(d)
}
