/**
 * Pure comparator helpers for transactions table sorting.
 *
 * Extracted into a standalone module so `compareTxByDate` / `compareTxByAmount`
 * can be unit-tested without rendering the page (TanStack Router + Query stack
 * is heavy and irrelevant for sort logic).
 *
 * `compareTxByDate` sorts by `txDate` — the field actually rendered in the
 * «Дата» column — so the order the user sees matches the button they clicked.
 * `txDate` is coarse (legacy income rows carry a midnight-UTC value, from an
 * `<input type="date">`) and `null` for payouts, so `createdAt` (monotonic,
 * unique, always present) is used as a tie-breaker rather than as the
 * primary key. See the `compareTxByDate` docblock for the full rationale,
 * including where `txDate = null` rows land.
 */
export type TxSortable = {
  txDate: string | null
  createdAt: string
  amount: string
}

export type SortDir = 'asc' | 'desc'

const toTime = (iso: string | null | undefined): number => (iso ? new Date(iso).getTime() : 0)

/**
 * Compare two transactions by `txDate` (primary key), with `createdAt` as a
 * tie-breaker (secondary key).
 *
 * Why `txDate` and not `createdAt` (see task-finance-sort-date-and-jump.md):
 * the «Дата» column renders `txDate`, so sorting by anything else desyncs
 * the order the user sees from the button they clicked — they sort the
 * visible column and get the invisible field's order. A previous fix (see
 * task-fix-transactions-sort-by-createdat.md) switched the primary key to
 * `createdAt` instead, reasoning that `txDate` is too coarse to give a
 * stable order on its own (legacy income rows are midnight-UTC, payouts are
 * `null`). That observation is correct, but the conclusion was wrong:
 * coarseness is a tie-breaking problem, not a reason to sort by a field the
 * user never sees. This version keeps `txDate` primary and fixes the
 * coarseness with a tie-breaker instead.
 *
 * Tie-breaking:
 * - Same `txDate` (e.g. two legacy income rows both parsed to the same
 *   midnight-UTC value) → `createdAt` decides, since it is unique and
 *   monotonic and reflects insertion order.
 * - `txDate = null` (always a payout — see `TxSortable`) → placed AFTER
 *   every dated row, in BOTH directions (not flipped by `dir`). A payout has
 *   no known "when it happened", so it cannot honestly be called newest or
 *   oldest; parking it at a fixed end keeps the dated rows browsable in the
 *   requested order without an undated row misleadingly surfacing at the
 *   top of "newest first". Rows that are BOTH null still order among
 *   themselves by `createdAt` (with `dir` applied), so that group isn't left
 *   in arbitrary order either.
 */
export function compareTxByDate(a: TxSortable, b: TxSortable, dir: SortDir): number {
  const mul = dir === 'asc' ? 1 : -1
  const aHasDate = a.txDate !== null
  const bHasDate = b.txDate !== null
  if (aHasDate !== bHasDate) {
    // Exactly one side is undated — undated always sorts last, regardless
    // of direction.
    return aHasDate ? -1 : 1
  }
  // aHasDate === bHasDate is guaranteed past this point (either both dated
  // or both null). No extra guard is needed: `toTime(null)` is 0 on both
  // sides when both are undated, so `byTxDate` is 0 and falls straight
  // through to the createdAt tie-break below — same result a
  // `both-dated`-only branch would have produced, with one fewer branch.
  const byTxDate = toTime(a.txDate) - toTime(b.txDate)
  // Stryker disable next-line ArithmeticOperator: `mul` is always ±1, and
  // for any nonzero `byTxDate`, `mul * byTxDate` and `mul / byTxDate` have
  // the identical sign (dividing/multiplying by ±1 both just mirror or
  // preserve the sign of the other operand) — Array.sort only reads the
  // sign of a comparator's return value, so no sort-order assertion can
  // ever distinguish `*` from `/` here. A magnitude assertion would pin an
  // implementation detail the contract doesn't make, not a behaviour.
  if (byTxDate !== 0) return mul * byTxDate
  // Tie (same txDate, or both null) — fall back to createdAt.
  return mul * (toTime(a.createdAt) - toTime(b.createdAt))
}

export function compareTxByAmount(a: TxSortable, b: TxSortable, dir: SortDir): number {
  const mul = dir === 'asc' ? 1 : -1
  return mul * (parseFloat(a.amount) - parseFloat(b.amount))
}
