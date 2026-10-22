import { MAX_TRANSACTION_AMOUNT } from '../finance'
import { AMOUNT_DECIMAL_PLACES, MIN_TRANSACTION_AMOUNT } from '../money'
import type { CurrencyEnum } from '../payment-requisites'
import { roundShareAmount } from '../../utils/money'
import type {
  CascadeDerivativePlan,
  CascadeLedgerFactReason,
  CascadePlan,
  CascadeWarning,
} from './schemas'
import type {
  CascadeDerivativeSnapshot,
  CascadeEditPatch,
  CascadeSnapshot,
  CascadeSourceSnapshot,
  SalaryPaymentFactEdit,
} from './types'

// ---------------------------------------------------------------------------
// The resolver.
// ---------------------------------------------------------------------------

/**
 * The SAME float-safe equality `adminUpdateTransaction`'s BIZ-18 guard uses
 * (`apps/api/src/finance/transactions.service.ts:2970-2971`) and
 * `settleByCompany`'s post-claim TOCTOU re-check
 * (`apps/api/src/finance/pending-settlement.service.ts:870`) — DB
 * `numeric(15,6)` round-trips through a string, so two values that print
 * identically at 6 decimals ARE the same money value even when the raw
 * floats differ by an epsilon. AC4 requires this comparison be REUSED, not
 * re-described a third time — this is the shared description; the two
 * `apps/api` call sites above are untouched by this task (out of scope —
 * see the task file) but express the identical rule.
 */
export function amountsDiffer(a: number, b: number): boolean {
  return Number(a).toFixed(6) !== Number(b).toFixed(6)
}

/**
 * Are «сколько уже выплачено» and «сколько должно быть» the same unit?
 *
 * HIGH-2 / HIGH-2-residual, stated once. `settledAmount` is accumulated in the
 * currency the payment was actually made in (`settleByCompany` stamps
 * `settled_currency`), while the figure it is compared against is always in the
 * ROW's own currency. A drop obligation closed in UAH puts ~2000 into the
 * accumulator and would call almost any USDT edit an overpayment.
 *
 * A zero accumulator is never a mismatch: there is nothing to compare, so a
 * stale currency column says nothing. A NON-zero accumulator whose currency was
 * never recorded IS a mismatch — "unknown" is not "assume it matches", the same
 * refusal-to-guess `NO_SHARE_SNAPSHOT` applies one field over.
 *
 * Extracted for task 5: `resolveDerivative` below asks it about a RECOMPUTED
 * share, and three UI surfaces ask it about a row's own stored amount. Same
 * question, and therefore deliberately not two spellings of it.
 */
export function settledCurrencyMismatch(
  settledAmount: number,
  settledCurrency: CurrencyEnum | null,
  rowCurrency: CurrencyEnum,
): boolean {
  return settledAmount > 0 && settledCurrency !== rowCurrency
}

/**
 * What is still owed: `max(0, amount - settledAmount)`, or `null` when the two
 * are not the same unit (`settledCurrencyMismatch` above).
 *
 * Both refusals are load-bearing, not defensive padding:
 *   - the floor at zero, because an overpaid row owes nothing and «осталось
 *     −100» is a figure no operator can act on;
 *   - the `null`, because a manufactured cross-currency difference would be
 *     shown as «к доплате» and paid.
 *
 * `.toFixed(6)` before `Math.max` is the same MONEY_SCALE-safe rounding
 * `roundShareAmount` uses — without it a stray float tail
 * (`199.99999999999997`) reaches the screen.
 */
export function remainingAgainstAccumulator(
  amount: number,
  settledAmount: number,
  currencyMismatch: boolean,
): number | null {
  if (currencyMismatch) return null
  return Math.max(0, Number((amount - settledAmount).toFixed(6)))
}

function resolveDerivative(
  derivative: CascadeDerivativeSnapshot,
  newSourceAmount: number,
  sourceCurrency: CurrencyEnum,
): CascadeDerivativePlan {
  const isSettled = derivative.obligation?.status === 'PAID'
  const sharePercent = isSettled ? derivative.settledSharePercent : derivative.sharePercent
  const oldAmount = derivative.obligation?.amount ?? derivative.amount
  // HIGH-1 (security-review round 1): `settled_amount` is the MONOTONIC
  // accumulator (task 1, PR #599) — read it UNCONDITIONALLY, never gated by
  // the obligation's CURRENT status. AC3 of the ADR: a cascade revert
  // (task 3, "Механика возврата производной в PENDING") flips
  // `pending_obligations.status` back to `PENDING` while leaving
  // `settled_amount` untouched (point 3: "накопитель не перезаписывается").
  // Gating on `isSettled` here made the plan report `0` for a row that was
  // already partially paid — presenting the FULL obligation for repayment
  // instead of the real difference, and silently erasing task 1's whole
  // point. Obligation status is used ONLY where the question genuinely IS
  // about status (`sharePercent` above — settle nulls the LIVE column;
  // `needsReconfirm` below) — never to decide whether money that was
  // actually paid still counts.
  const settledAmount = derivative.settledAmount ?? 0
  const settledCurrency = derivative.settledCurrency

  // task-cascade-apply (backlog 95, addendum §3.5). `oldAmount` above comes
  // from `pending_obligations.amount` when an obligation exists, and task 3
  // WRITES `newAmount` back into that very column. `newAmount` is a share of
  // `newSourceAmount`, i.e. denominated in `sourceCurrency`; the obligation's
  // own column is denominated in `obligation.currency`. Until task 3 those two
  // always coincided, held there by BIZ-18 — which is exactly the guard task 3
  // lifts, so the coincidence stops being one. Computed BEFORE the
  // `sharePercent === null` early return on purpose: this is a fact about the
  // snapshot (which column is denominated in what), not about whether a share
  // could be recomputed, and a row can legitimately carry BOTH refusals.
  const obligationCurrencyMismatch =
    derivative.obligation !== null && derivative.obligation.currency !== sourceCurrency
  const obligationCurrencyWarning: CascadeWarning[] = obligationCurrencyMismatch
    ? [
        {
          code: 'OBLIGATION_CURRENCY_MISMATCH',
          params: {
            obligationCurrency: derivative.obligation!.currency,
            sourceCurrency,
          },
        },
      ]
    : []

  if (sharePercent === null) {
    return {
      id: derivative.id,
      type: derivative.type as CascadeDerivativePlan['type'],
      receiverName: derivative.receiverName,
      oldAmount,
      newAmount: null,
      recomputedShare: null,
      sharePercent: null,
      currency: sourceCurrency,
      settledAmount,
      settledCurrency,
      remainingToPay: null,
      needsReconfirm: false,
      warnings: [
        {
          code: 'NO_SHARE_SNAPSHOT',
          params: {},
        },
        ...obligationCurrencyWarning,
      ],
    }
  }

  // QA-H-1 (manual QA, HIGH) — TWO figures, because they are two different
  // facts and conflating them is what let the preview describe a number the
  // system had already decided never to store.
  //
  //   `recomputedShare` — what the share COMES OUT TO from the new source
  //                       amount. The subject of the overpayment warning.
  //   `newAmount`       — what this row's `amount` WILL BE after saving.
  //
  // They differ exactly when the recomputed share falls below what has already
  // been paid. `applyEditCascade` has always floored the write at the
  // accumulator (a row whose `amount` sits under `settled_amount` leaves a
  // negative remainder and an obligation nobody can close), but the floor —
  // extracted into `floorAmountAtAccumulator` by #608 and applied there to the
  // SOURCE amount — never reached the derivative side of the resolver. So the
  // panel showed «100 → 50» and the row came out at 100, measured by QA with a
  // SQL dump either side.
  //
  // That is precisely the risk AC4 of the ADR names, and the reason it insists
  // the description live in ONE place: the same defect shape as #607 and #608,
  // a third time.
  const recomputedShare = roundShareAmount(newSourceAmount, sharePercent)

  // HIGH-2 (security-review round 1) + HIGH-2-residual (round 2): `newAmount`
  // is always a share of `newSourceAmount`, expressed in the SOURCE's OWN
  // currency (`sourceCurrency`), but on a DROP-branch row `settledAmount`
  // can be denominated in the PAYMENT currency — `settleByCompany` converts
  // and stamps `settled_currency` (pending-settlement.service.ts).
  // Subtracting one from the other when they are not the same unit is not
  // an approximation, it is a wrong number — a drop obligation closed in
  // UAH puts ~2000 into the accumulator and would call almost any edit an
  // overpayment. The resolver is pure and has no exchange rate, and must
  // not invent one: when currencies disagree it refuses to manufacture
  // `remainingToPay` or an overpayment verdict from that subtraction, and
  // leaves `needsReconfirm` to the one thing that IS a genuine status
  // question (is this row currently settled at all) rather than the broken
  // comparison. The plan still hands back BOTH figures with their own
  // currencies (`settledAmount`/`settledCurrency` here, `newAmount`/
  // `oldAmount` tagged with `currency` above) plus the `NON_USDT_CURRENCY`
  // warning below, so a human in task 5 sees "выплачено 2000 UAH, новая
  // доля 50 USDT" instead of a fabricated difference.
  //
  // Round 2 fixed TWO things in this single condition, not one:
  //  1. Comparison target is `sourceCurrency` (read off the snapshot,
  //     `CascadeSourceSnapshot.currency` via `resolveEditCascade`), never a
  //     hardcoded `'USDT'` literal — today they always coincide
  //     (`declareUsdtProjectIncome` always books `currency: 'USDT'`), but
  //     that coincidence is an invariant task 3 is explicitly allowed to
  //     lift (BIZ-18), not a fact this pure function may assume.
  //  2. The `settledCurrency !== null` guard round 1 had is GONE (LOW,
  //     round 2): `null !== sourceCurrency` is `true` for every real
  //     currency, so a `settledAmount > 0` row whose currency was never
  //     recorded is now treated the same as an outright mismatch — "unknown"
  //     is not "assume it matches", the same refusal-to-guess principle
  //     `NO_SHARE_SNAPSHOT` above already applies. Unreachable today (a
  //     settle always stamps `settled_amount`/`settled_currency` together),
  //     kept correct anyway so a future write path cannot silently violate it.
  const currencyMismatch = settledCurrencyMismatch(settledAmount, settledCurrency, sourceCurrency)

  // The floor is skipped when the two figures are not the same unit, for the
  // same refusal-to-guess reason `remainingToPay` and `overpaid` are: `max()`
  // over 2000 UAH and 50 USDT is not a bigger number, it is a meaningless one,
  // and putting it on screen as «Стало» would be worse than the raw share.
  // (`applyEditCascade`'s own floor is left exactly as it was — this changes
  // what is SHOWN, never what is written.)
  //
  // `null` rather than a second conditional: `floorAmountAtAccumulator` already
  // documents "no accumulator ⇒ NO floor" and implements it on exactly that
  // input, so passing `null` reuses the law instead of restating it. It also
  // matters — `settledAmount` is a NUMBER here (0 when the row never settled),
  // and `Math.max(requested, 0)` would clamp a negative probe to zero, which is
  // the very second rule that helper's comment refuses to state. The
  // mutation-gate boundary case in this module's spec probes with a negative
  // amount precisely to keep that distinction observable.
  const comparableAccumulator = !currencyMismatch && settledAmount > 0 ? settledAmount : null
  const newAmount = floorAmountAtAccumulator(comparableAccumulator, recomputedShare)

  // Same MONEY_SCALE-safe rounding as roundShareAmount itself — avoids a
  // stray float tail like 199.99999999999997 in remainingToPay.
  const remainingToPay = remainingAgainstAccumulator(newAmount, settledAmount, currencyMismatch)
  // MED-A (security-review round 2): AC3 defines "переплата" purely through
  // the MONOTONIC `settledAmount` accumulator — the exact same principle
  // HIGH-1 (round 1) already established for reading that accumulator at
  // all. Gating this on `isSettled` (the obligation's CURRENT status) meant
  // a cascade revert (task 3, "Механика возврата производной в PENDING")
  // could leave a PENDING row holding a nonzero accumulator, and a further
  // edit dropping the recomputed share below it produced NO overpayment
  // warning — silently losing exactly the money HIGH-1 made visible in
  // `settledAmount` one field over. Money already paid out does not stop
  // being paid out because the row's status flipped back.
  // Both read the RECOMPUTED share, never the floored figure: after the floor
  // `newAmount >= settledAmount` always holds, so asking `newAmount <
  // settledAmount` would silence the overpayment warning on exactly the
  // population it exists for. (`needsReconfirm` is provably unchanged either
  // way — `max(raw, settled) > settled` and `raw > settled` agree on every
  // input — but it says what it means when written against the share.)
  const overpaid = !currencyMismatch && settledAmount > 0 && recomputedShare < settledAmount
  const needsReconfirm = currencyMismatch ? isSettled : isSettled && recomputedShare > settledAmount

  const warnings: CascadeWarning[] = []
  if (overpaid) {
    warnings.push({
      code: 'OVERPAYMENT',
      // COPY-M-4 (copy-review): every neighbour in this family names a remedy;
      // this one — the only message about money that was ACTUALLY overpaid —
      // named none, so the operator learned that an overpayment exists and not
      // whether it comes back. The remedy itself stays unprescribed on purpose
      // (write-off vs claw-back is a human decision, ADR AC3); what the text
      // now closes is the dangerous half of the silence.
      // COPY-L-7: «сумма», not «сумма строки» — the longest line in the panel
      // (6 rows at 320px) brought to parity with the PAID branch. Deliberately
      // NOT «сумма останется прежней», which the copy reviewer flagged: in this
      // branch the amount DOES change — it is raised to the accumulator.
      //
      // QA-H-1, second layer: ONE text was describing TWO outcomes, and was
      // false for the second. «Строка остаётся оплаченной» is right for a PAID
      // obligation that stays PAID (the write-nothing branch of
      // `applyEditCascade`). It is simply untrue for a row that was reverted to
      // PENDING_PAYMENT earlier and is still open now: that row is PENDING when
      // this is shown and PENDING after saving — what happens to it is that its
      // amount is held at the accumulator and nothing more is owed.
      // `overpaid` implies `!currencyMismatch`, so the paid sum and the share are
      // in the SOURCE's own currency — the one `currency` the client formats both with.
      params: {
        paid: isSettled ? 'yes' : 'no',
        settledAmount,
        recomputedShare,
        currency: sourceCurrency,
      },
    })
  }
  if (derivative.hasSignedInvoice) {
    warnings.push({ code: 'SIGNED_INVOICE', params: {} })
  }
  if (currencyMismatch) {
    warnings.push({
      code: 'NON_USDT_CURRENCY',
      // `settledCurrency` is always a string on the wire; when it was never
      // recorded the flag says so and the text does not read the value.
      params: {
        settledCurrencyKnown: settledCurrency === null ? 'no' : 'yes',
        settledAmount,
        settledCurrency: settledCurrency ?? '',
        sourceCurrency,
      },
    })
  }
  // `newAmount` above is computed as usual even on a mismatch: the NUMBER is
  // correct (it is a share of the source amount, in the source's currency) —
  // what is wrong is only writing it into a column that means another
  // currency. The preview therefore still shows a truthful figure; task 3's
  // APPLY path is what refuses (AC4).
  warnings.push(...obligationCurrencyWarning)

  return {
    id: derivative.id,
    type: derivative.type as CascadeDerivativePlan['type'],
    receiverName: derivative.receiverName,
    oldAmount,
    newAmount,
    recomputedShare,
    sharePercent,
    currency: sourceCurrency,
    settledAmount,
    settledCurrency,
    remainingToPay,
    needsReconfirm,
    warnings,
  }
}

/**
 * MED-1 (security-review round 1) — warnings about the SOURCE row itself
 * (the row `GET /edit-preview` was called ON), independent of the proposed
 * new amount. AC5 §5/§6 of the ADR: a `PAID` row that is NOT an
 * `ADMIN_INCOME` (a `SALARY` payment, notably) can itself already carry
 * `originalAmount` or a counterparty-signed invoice — the same two "snapshot
 * by design" concerns (C2/C3) the derivative-level warnings already cover,
 * just on the row being edited rather than on what it produced.
 */
function resolveSourceWarnings(source: CascadeSourceSnapshot): CascadeWarning[] {
  const warnings: CascadeWarning[] = []
  // task-paid-salary-amount-edit (COPY-L-2) — `SOURCE_ORIGINAL_AMOUNT_SET` is
  // no longer emitted. A salary's triplet follows the edit (the plan's
  // `sourcePaymentFact` describes it); every other row carrying the triplet is
  // refused before a plan is shown, with the catalogued
  // `FINANCE_PAYMENT_FACT_AMOUNT_LOCKED`. The warning had no reachable reader
  // and sent the operator to a «документ об оплате» that does not exist. The
  // code stays in `cascadeWarningCodeSchema` for wire compatibility only.
  if (source.hasSignedInvoice) {
    warnings.push({ code: 'SOURCE_SIGNED_INVOICE', params: {} })
  }
  return warnings
}

/**
 * `resolveEditCascade(snapshot, patch) -> CascadePlan` — the resolver itself.
 * See the module doc for why it must stay pure and why both `GET
 * /edit-preview` and the future `PATCH` are required to call THIS function
 * on a snapshot shaped by `loadCascadeSnapshot`, never re-derive the
 * arithmetic locally.
 *
 * `sourceAmountChanged === false` (patch equals the stored amount, AC4/AC3
 * idempotency point 1) always yields an EMPTY `derivatives` list — "дельта
 * == 0 трактуется как отсутствие каскада, а не нулевое обязательство".
 * `sourceWarnings` is populated in BOTH branches — it describes the row as
 * it stands today, not the proposed edit.
 */
export function resolveEditCascade(
  snapshot: CascadeSnapshot,
  patch: CascadeEditPatch,
): CascadePlan {
  const { source, derivatives } = snapshot
  // SR-M-2 (review round 4) — the figure the WRITE will store, not the raw
  // request. Before this, the preview answered `newSourceAmount: 100` for an
  // edit the service then stored as 260, which is risk 1 of the ADR's AC6
  // ("предпросмотр и факт разъезжаются") arriving on the source amount after
  // CR-M-1 had closed it on the refusals.
  //
  // It also has to be the basis for the SHARES: a derivative is a share of the
  // source amount, and taking shares of a number that will not be stored would
  // be a worse defect than showing the wrong total.
  const effectiveAmount = floorAmountAtAccumulator(source.settledAmount, patch.amount)
  const sourceAmountChanged = amountsDiffer(effectiveAmount, source.amount)
  const sourceWarnings = resolveSourceWarnings(source)

  if (!sourceAmountChanged) {
    return {
      sourceId: source.id,
      sourceAmountChanged: false,
      oldSourceAmount: source.amount,
      newSourceAmount: source.amount,
      sourceCurrency: source.currency,
      derivatives: [],
      sourceWarnings,
      sourcePaymentFact: null,
    }
  }

  return {
    sourceId: source.id,
    sourceAmountChanged: true,
    oldSourceAmount: source.amount,
    newSourceAmount: effectiveAmount,
    sourceCurrency: source.currency,
    derivatives: derivatives.map((d) => resolveDerivative(d, effectiveAmount, source.currency)),
    sourceWarnings,
    sourcePaymentFact: resolveSourcePaymentFact(source, effectiveAmount),
  }
}

/**
 * The plan's account of the edited salary's payment fact — see
 * `cascadePlanSchema.sourcePaymentFact`. `UNREPRESENTABLE` yields `null`: that
 * edit is refused (`classifyEditedRowLedgerFact`) before any plan is shown or
 * applied, so there is no figure to describe.
 */
function resolveSourcePaymentFact(
  source: CascadeSourceSnapshot,
  amount: number,
): NonNullable<CascadePlan['sourcePaymentFact']> | null {
  const edit = resolveSalaryPaymentFactEdit(source, amount)
  if (edit === null || edit.kind === 'UNREPRESENTABLE') return null
  // `originalAmount` is non-null here: `resolveSalaryPaymentFactEdit` answers
  // null otherwise. Narrowed through it rather than re-checked.
  const oldOriginalAmount = source.originalAmount as number
  return {
    originalCurrency: source.originalCurrency,
    exchangeRate: source.exchangeRate,
    oldOriginalAmount,
    newOriginalAmount: edit.kind === 'RECOMPUTED' ? edit.newOriginalAmount : oldOriginalAmount,
    recomputed: edit.kind === 'RECOMPUTED',
  }
}

/**
 * Deterministic, comparable "version" of a cascade snapshot — the
 * optimistic-locking token `GET /edit-preview` hands back (AC5 of the task
 * file). The future `PATCH` (task 3) re-derives this SAME string from a
 * freshly `SELECT … FOR UPDATE`-locked read and refuses to apply the plan on
 * a mismatch ("отказ с просьбой обновить предпросмотр, а не молчаливый
 * пересчёт" — ADR AC4). Built purely from ids + `updatedAt` timestamps
 * already on the snapshot: no hashing needed, string equality is enough, and
 * it works identically in Node and the browser (`@crm/shared` runs in both).
 */
export function computeCascadeVersion(snapshot: CascadeSnapshot): string {
  const derivativeParts = snapshot.derivatives
    .map(
      (d) =>
        `${d.id}:${d.updatedAt}:${d.obligation ? `${d.obligation.id}:${d.obligation.updatedAt}` : '-'}`,
    )
    .sort()
  return [`src:${snapshot.source.id}:${snapshot.source.updatedAt}`, ...derivativeParts].join('|')
}

/**
 * task-paid-salary-amount-edit — the obligation a corrected paid figure stands
 * for, at the rate that transfer was RECORDED with (owner decision 2026-09-25:
 * «обе суммы по тому же курсу»). `exchange_rate` is «units of the paid
 * currency per 1 unit of the obligation's» (`paySalary`), so the obligation is
 * `amount / rate`, stored at the six decimals `original_amount` has.
 *
 * `null` — the rate cannot be divided by (non-positive, non-numeric) or the
 * result is not a storable transaction amount. Never a clamped figure: a wrong
 * number in a fact-of-payment column is worse than a refused edit.
 *
 * The pair then agrees to the precision `paySalary` itself keeps (rate at 8
 * decimals, obligation at 6): `|obligation × rate − amount| ≤ rate×5e-7 +
 * obligation×5e-9` — pinned by the spec over a spread of figures rather than
 * re-checked here, where it holds by construction of the rounding.
 */
export function recomputeObligationAtRecordedRate(amount: number, rate: string): number | null {
  const obligation = Number((amount / Number(rate)).toFixed(AMOUNT_DECIMAL_PLACES))
  // ONE range check covers every bad rate, so there is no second rule to keep
  // in step with it: a non-numeric rate gives NaN (fails both comparisons), a
  // zero rate gives Infinity, a negative one a negative figure, an infinite
  // one 0 — all outside [MIN, MAX].
  const storable = obligation >= MIN_TRANSACTION_AMOUNT && obligation <= MAX_TRANSACTION_AMOUNT
  return storable ? obligation : null
}

/**
 * Which of the owner-decided branches an amount edit on this row falls into —
 * or `null` when the rule does not apply (not a `SALARY`, or no payment fact
 * recorded on it). ONE description, read by the classifier (may it be edited),
 * the resolver (what the plan shows) and, through the plan, the write.
 */
export function resolveSalaryPaymentFactEdit(
  source: Pick<CascadeSourceSnapshot, 'type' | 'originalAmount' | 'exchangeRate'>,
  amount: number,
): SalaryPaymentFactEdit | null {
  if (source.type !== 'SALARY' || source.originalAmount === null) return null
  if (source.exchangeRate === null) return { kind: 'RATE_NOT_RECORDED' }
  const newOriginalAmount = recomputeObligationAtRecordedRate(amount, source.exchangeRate)
  return newOriginalAmount === null
    ? { kind: 'UNREPRESENTABLE' }
    : { kind: 'RECOMPUTED', newOriginalAmount }
}

/**
 * ONE description of AC13's four predicates, so `GET :id/edit-preview` and
 * `PATCH :id/admin-edit` cannot disagree about what is editable (CR-M-1,
 * code-review round 3; risk 1 of the main ADR's AC6).
 *
 * Returns the FIRST reason that applies, most specific first — a row can carry
 * several carriers at once and the operator should hear about the one that is
 * hardest to argue with.
 *
 * `ADMIN_INCOME`, `EXPENSE` and `DIVIDEND_TO_ADMIN` return `null` ON PURPOSE:
 * they have no second carrier (checked column by column across all eight
 * ledger terms — the table in addendum §1.12), so an edit there means "we wrote
 * down the wrong number" and the ledger is obliged to follow it. That is the
 * work the whole cascade exists to do; do not "finish the job" by adding them.
 *
 * ONLY EVER ASKED ABOUT THE ROW BEING EDITED. The cascade writes `amount` on
 * derivatives whose `settledAmount` is non-null all the time — that is AC5/AC6,
 * its ordinary work. Calling this from `applyEditCascade` would make the
 * cascade refuse itself.
 */
export function classifyEditedRowLedgerFact(
  // Only the columns the four predicates read — so the edit dialog can ask the
  // SAME question from a `TransactionDto` before the operator types (task-paid-
  // salary-amount-edit: «disabled сразу», not a refusal after input).
  source: Pick<
    CascadeSourceSnapshot,
    'type' | 'originalAmount' | 'exchangeRate' | 'settledAmount' | 'hasClosedObligation'
  >,
  requestedAmount: number,
): CascadeLedgerFactReason | null {
  if (source.originalAmount !== null) {
    // task-paid-salary-amount-edit — the one row type whose triplet MOVES with
    // the edit instead of pinning it: a salary's obligation is recomputed at
    // the recorded rate (or, with no rate, deliberately left). Everything else
    // carrying the triplet (a converted drop settle) is still refused, and so
    // is a salary whose recomputed obligation could not be stored.
    const salaryEdit = resolveSalaryPaymentFactEdit(source, requestedAmount)
    if (salaryEdit === null) return 'PAYMENT_FACT_RECORDED'
    if (salaryEdit.kind === 'UNREPRESENTABLE') return 'SALARY_OBLIGATION_OUT_OF_RANGE'
  }
  if (source.settledAmount !== null) return 'SETTLED_AMOUNT_RECORDED'
  if (source.hasClosedObligation) return 'CLOSES_OBLIGATION'
  if (source.type === 'COMPANY_DEPOSIT') return 'ONCHAIN_DEPOSIT'
  return null
}

/**
 * THE FLOOR, stated once (SR-M-6 / SR-M-2, review rounds 3-4):
 *
 * > a row's `amount` is never written, or shown, below its `settled_amount`.
 *
 * `settled_amount` is what actually left the account. Writing `amount` below
 * it makes ledger terms 7/8 under-debit by the difference — an error in the
 * "+" direction, the one no gate catches — and leaves an obligation asserting
 * a smaller debt than has already been paid, which nothing but a data repair
 * can undo.
 *
 * It lives HERE, in the pure module, because three places need the same
 * number: the resolver (so the preview shows what will be stored, and so the
 * shares are shares of that figure), and `adminUpdateTransaction`'s two
 * writers. A law with three implementations is three laws.
 *
 * `?? 0` covers `undefined` as well as `null`: `Number(undefined)` is `NaN`,
 * `Math.max` propagates it, and the money write becomes the string 'NaN'.
 */
export function floorAmountAtAccumulator(
  // Accepts the RAW column value (`numeric` arrives from drizzle as a string)
  // as well as a parsed number, so callers never have to write their own
  // null-preserving conversion. They did, briefly, and it was a redundant
  // branch no test could reach: the only caller that could tell `null` from
  // `0` apart needs a non-positive request, and both entrances validate
  // `.positive()`. One conversion, in the place whose own spec exercises both
  // branches directly.
  settledAmount: number | string | null | undefined,
  requested: number,
): number {
  // No accumulator ⇒ NO floor. `Math.max(requested, settledAmount ?? 0)` reads
  // the same for every figure the API can actually receive (amounts are
  // `.positive()` on both entrances), but it quietly states a SECOND rule —
  // "never below zero" — that nobody asked for, and it clamps a negative
  // probe to 0. The law is about the accumulator; where there is none, there
  // is nothing to say.
  if (settledAmount === null || settledAmount === undefined) return requested
  return Math.max(requested, Number(settledAmount))
}

/**
 * Is this edit the one that runs the cascade? (CR-M-2, review round 4.)
 *
 * Asked by BOTH entrances — `GET :id/edit-preview` and
 * `PATCH :id/admin-edit` — and previously written out in both, the second time
 * under a comment saying it "mirrors" the first. That phrasing is the marker
 * for a third copy of a rule (backlog 85); copies that agree today are still
 * two descriptions, and on #600 two of them had already drifted.
 *
 * Compared against the RAW request, NOT the floored figure — the two are
 * different questions and conflating them silently removes AC13:
 *
 *   - "does the STORED figure move?" (floored) decides what gets WRITTEN;
 *   - "did the operator ASK for a change?" (raw) decides whether this is a
 *     cascade edit, and therefore whether AC13 and the preview token apply.
 *
 * On a settled row `amount === settled_amount`, so EVERY downward request
 * floors back to the current value. Asking the floored question there would
 * make it "no change", skip AC13 and answer the operator with a silent
 * success — for exactly the population AC13 exists to refuse. Measured: the
 * `risk 18` and `risk 25` specs both went red on that, which is what the
 * accumulator fixture in them is for.
 *
 * The two questions only diverge when an accumulator exists, and on a `PAID`
 * row that is precisely where AC13 refuses anyway — so the raw comparison
 * costs nothing and keeps the refusal reachable.
 */
export function isCascadeAmountEdit(args: {
  status: string
  storedAmount: number
  requestedAmount: number
}): boolean {
  return args.status === 'PAID' && amountsDiffer(args.requestedAmount, args.storedAmount)
}
