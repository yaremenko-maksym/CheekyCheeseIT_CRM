/**
 * Pure comparator helpers for transactions table sorting.
 *
 * Extracted into a standalone module so `compareTxByDate` / `compareTxByAmount`
 * can be unit-tested without rendering the page (TanStack Router + Query stack
 * is heavy and irrelevant for sort logic).
 *
 * `compareTxByDate` sorts by `txDate` — the field actually rendered in the
 * «Дата» column — so the order the user sees matches the button they clicked.
 * `txDate` is always `null` for payouts, so a row with no `txDate` falls back
 * to its own `createdAt` (round 2 — see the `compareTxByDate` docblock for
 * why a fallback, not a fixed "undated first/last" edge, is the fix).
 * `createdAt` is also used as a tie-breaker for rows whose effective date
 * collides (legacy income rows share a midnight-UTC `txDate`).
 */
export type TxSortable = {
  txDate: string | null
  createdAt: string
  amount: string
}

export type SortDir = 'asc' | 'desc'

const toTime = (iso: string | null | undefined): number => (iso ? new Date(iso).getTime() : 0)

const DAY_MS = 24 * 60 * 60 * 1000

// Calendar-day index (UTC) of an ISO instant — see the "day-level, not
// millisecond-level" paragraph in `compareTxByDate`'s docblock for why the
// PRIMARY comparison truncates to this instead of comparing raw instants.
const dayOf = (iso: string | null | undefined): number => Math.floor(toTime(iso) / DAY_MS)

/**
 * Compare two transactions by `txDate ?? createdAt` (primary key — the row's
 * "effective date"), with `createdAt` as a tie-breaker (secondary key) for
 * rows whose effective date collides.
 *
 * Why `txDate` and not `createdAt` alone (see task-finance-sort-date-and-jump.md
 * round 1): the «Дата» column renders `txDate`, so sorting by anything else
 * desyncs the order the user sees from the button they clicked — they sort
 * the visible column and get the invisible field's order. A previous fix
 * (see task-fix-transactions-sort-by-createdat.md) switched the primary key
 * to `createdAt` instead, reasoning that `txDate` is too coarse to give a
 * stable order on its own (legacy income rows are midnight-UTC, payouts are
 * `null`). That observation is correct, but the conclusion was wrong:
 * coarseness is a tie-breaking problem, not a reason to sort by a field the
 * user never sees.
 *
 * Why a FALLBACK (`?? createdAt`) and not a fixed edge for `txDate = null`
 * rows (round 1 shipped "undated always sorts first"; round 2 reverted it —
 * see H-1 in the task file, caught by the `drop-finance` E2E shard's
 * required CI check): a fixed edge — "first" or "last" — clumps EVERY
 * undated row (every payout) into one contiguous block regardless of when it
 * actually happened. That block grows with the payout count, and once it
 * exceeds one page (`usePaginatedFilter`'s `DEFAULT_PAGE_SIZE = 50`), it
 * fully occupies page 1 and pushes every OTHER row off it:
 * - "undated last" (the pre-round-1 bug): a fresh payout's own row falls
 *   behind >50 dated rows and becomes invisible right after creation.
 * - "undated first" (round 1's fix): once >50 payouts pile up (exactly what
 *   16 real-API specs sharing one DB across the `drop-finance` shard do), a
 *   freshly-dated row — no matter how recent — falls behind them instead and
 *   becomes invisible. Same defect, block moved to the other edge.
 * A payout has no `txDate` because it has no independent "when it happened"
 * date distinct from when it was recorded — `createdAt` IS its most honest
 * date, not an arbitrary placeholder for one. Falling back to it means:
 * - a freshly-created payout's effective date is "now", so it still sorts to
 *   the top on DESC — the guarantee round 1 needed, preserved (see the
 *   "freshly-created payout" test below);
 * - an old payout's effective date is however long ago it was actually
 *   created, so a pile of old payouts no longer blocks a fresh dated row
 *   from page 1 — the guarantee round 2 needed, restored (see the "H-1
 *   regression" test below);
 * - no block forms at either edge, because undated rows are interleaved by
 *   time with dated ones instead of pulled out of the timeline altogether.
 *
 * Primary comparison is by CALENDAR DAY (UTC), not raw millisecond instant —
 * discovered live, not assumed: the `drop-finance` E2E shard's
 * `drop-share-usdt-income.spec.ts` "settle in place" test still failed after
 * the `?? createdAt` fallback above, because settling a DROP payout writes a
 * real `txDate` (`SettleSeniorPayoutDialog` defaults the picker to the
 * obligation's OWN `createdAt.slice(0, 10)` — see `pending-settlement.
 * service.ts`'s `txDateToWrite`), truncated to day-only (midnight UTC) like
 * every other `txDate` in this system (the «Дата» column itself only ever
 * renders a day — see `fmtDate`, no time-of-day). Comparing that coarse
 * midnight instant against ANOTHER row's still-undated, millisecond-precise
 * `createdAt` fallback compares two different granularities: a row settled
 * moments after midnight on a busy day could rank BELOW dozens of same-day
 * rows that merely happen to have a later time-of-day in their raw
 * `createdAt` — even though nothing about "which day this happened on"
 * changed, and the settled row's OWN `createdAt` didn't move either. Once a
 * shard accumulates enough same-day rows (exactly what a shared-DB, 16-spec
 * CI shard does), that was enough to push a just-settled row off page 1 mid
 * test — the identical "block/press a row off the current page" shape as
 * H-1, just triggered by a granularity mismatch instead of a fixed edge.
 * Truncating BOTH sides of the primary comparison to the same day-level
 * granularity — the level the visible column actually operates at — removes
 * the mismatch: a settle no longer moves a row's calendar day (it's the same
 * day it was already created on), so it can no longer move the row's
 * position on that axis at all.
 *
 * Tie-breaking: two rows whose day is equal fall back to raw `createdAt`
 * (unique, monotonic, always present, and — critically — UNCHANGED by a
 * settle, since only `txDate` is written then). This covers same-day legacy
 * income rows (parsed `txDate` collides at midnight-UTC), two undated rows
 * on the same day, and a row transitioning from undated to dated within the
 * same calendar day (the settle-in-place scenario above) identically.
 */
export function compareTxByDate(a: TxSortable, b: TxSortable, dir: SortDir): number {
  const mul = dir === 'asc' ? 1 : -1
  // `??` (nullish coalescing), not `||`: an empty-string `txDate` is never a
  // real value `financeApi` sends, but `??` documents the intent — "missing
  // the field", not "falsy" — and, as a side effect, treats `undefined` the
  // same as `null` with no extra branch. That matters because
  // `financeApi.getTransactions` types its response `TransactionDto[]` but
  // does not `.parse()` it (no schema round-trip on this endpoint), so a
  // hand-built/mocked payload that omits the key entirely reaches here as
  // `undefined`, not `null` (unit-tested below).
  const aDay = dayOf(a.txDate ?? a.createdAt)
  const bDay = dayOf(b.txDate ?? b.createdAt)
  const byDay = aDay - bDay
  // Stryker disable next-line ArithmeticOperator: `mul` is always ±1, and
  // for any nonzero `byDay`, `mul * byDay` and `mul / byDay` have the
  // identical sign (dividing/multiplying by ±1 both just mirror or preserve
  // the sign of the other operand) — Array.sort only reads the sign of a
  // comparator's return value, so no sort-order assertion can ever
  // distinguish `*` from `/` here. A magnitude assertion would pin an
  // implementation detail the contract doesn't make, not a behaviour.
  if (byDay !== 0) return mul * byDay
  // Tie (same calendar day) — fall back to raw createdAt.
  return mul * (toTime(a.createdAt) - toTime(b.createdAt))
}

export function compareTxByAmount(a: TxSortable, b: TxSortable, dir: SortDir): number {
  const mul = dir === 'asc' ? 1 : -1
  return mul * (parseFloat(a.amount) - parseFloat(b.amount))
}
