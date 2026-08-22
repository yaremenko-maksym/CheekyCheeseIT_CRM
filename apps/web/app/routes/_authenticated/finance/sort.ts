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
 * Tie-breaking: two rows whose EFFECTIVE date is equal fall back to
 * `createdAt` directly (unique, monotonic, always present). This covers
 * same-day legacy income rows (parsed `txDate` collides at midnight-UTC)
 * and, degenerately, two undated rows — whose effective date already IS
 * `createdAt`, so the tie-break re-derives the same order the primary
 * comparison already produced. Harmless, not incorrect.
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
  const aEffective = toTime(a.txDate ?? a.createdAt)
  const bEffective = toTime(b.txDate ?? b.createdAt)
  const byDate = aEffective - bEffective
  // Stryker disable next-line ArithmeticOperator: `mul` is always ±1, and
  // for any nonzero `byDate`, `mul * byDate` and `mul / byDate` have the
  // identical sign (dividing/multiplying by ±1 both just mirror or preserve
  // the sign of the other operand) — Array.sort only reads the sign of a
  // comparator's return value, so no sort-order assertion can ever
  // distinguish `*` from `/` here. A magnitude assertion would pin an
  // implementation detail the contract doesn't make, not a behaviour.
  if (byDate !== 0) return mul * byDate
  // Tie (equal effective date) — fall back to createdAt.
  return mul * (toTime(a.createdAt) - toTime(b.createdAt))
}

export function compareTxByAmount(a: TxSortable, b: TxSortable, dir: SortDir): number {
  const mul = dir === 'asc' ? 1 : -1
  return mul * (parseFloat(a.amount) - parseFloat(b.amount))
}
