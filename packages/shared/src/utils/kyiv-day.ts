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

/** Today's Kyiv calendar day, as `YYYY-MM-DD`. See the module comment above. */
export function kyivToday(): string {
  kyivDayFormatter ??= new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return kyivDayFormatter.format(Date.now())
}
