import { HttpStatus, type Logger } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import type { CascadeSnapshot, CascadePlan } from '@crm/shared'
import { amountsDiffer, floorAmountAtAccumulator, settledCurrencyMismatch } from '@crm/shared'
import { apiError } from '../common/api-error'
import { pendingObligations, transactions, transactionAuditLog } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { COMPANY_ACCOUNT_FUNDING_SOURCE } from './company-account-balance'

/**
 * task-cascade-apply (task 3) — apply an already-resolved cascade plan to the
 * derivatives, inside the caller's DB transaction and under the locks
 * `lockCascadeRows` has already taken.
 *
 * A separate method (rather than inline in `adminUpdateTransaction`) so a
 * unit double can observe the ORDER and CONTENT of every write — the
 * mutation gate cannot execute the integration spec that proves the same
 * thing against real Postgres (`mutation-gate-integration-specs.md`).
 *
 * Returns the ids whose stored `amount` actually moved: exactly the rows
 * whose invoice must be voided and re-issued (AC11).
 *
 * NOTHING here recomputes a share. Every figure comes from `plan`, which is
 * `resolveEditCascade`'s output — ADR AC4 ("предпросмотр == факт" holds
 * because the description is ONE, not because two descriptions are kept in
 * step) and AC5 §4 (a share is never re-derived from a live resolver).
 */
export async function applyEditCascade(
  dbtx: DrizzleTx,
  snapshot: CascadeSnapshot,
  plan: CascadePlan,
  actorId: string,
  // The calling service's own logger, so log context stays `EditCascadeService`.
  logger: Logger,
): Promise<{ changedDerivativeIds: string[] }> {
  const snapshotById = new Map(snapshot.derivatives.map((d) => [d.id, d]))

  // ── Phase 1: refuse, for the WHOLE cascade, before a single write ───────
  // All-or-nothing is not stylistic: a half-applied cascade leaves the two
  // stored copies of one obligation disagreeing, which is the L3 defect this
  // whole decomposition exists to close.
  for (const derivativePlan of plan.derivatives) {
    // `!` rather than a defensive branch: `plan.derivatives` IS
    // `snapshot.derivatives.map(...)` — same array, same order, same ids
    // (`resolveEditCascade`). A "what if it is missing" branch here could
    // never be executed by any test, and unexecutable code is worse than
    // absent code: it still has to be read and reviewed forever.
    const snap = snapshotById.get(derivativePlan.id)!

    if (derivativePlan.newAmount === null) {
      // COPY-H-2 (PR #704 fix-round 1): the row id is a UUID the user
      // cannot act on — it stays server-side, for whoever reads the log
      // to find the row that failed.
      logger.warn(`Derivative row ${derivativePlan.id}: no share-percent snapshot`)
      throw apiError('FINANCE_DERIVATIVE_ROW_NO_SHARE_SNAPSHOT', HttpStatus.BAD_REQUEST)
    }

    if (derivativePlan.warnings.some((w) => w.code === 'OBLIGATION_CURRENCY_MISMATCH')) {
      logger.warn(`Derivative row ${derivativePlan.id}: obligation currency mismatch with source`)
      throw apiError('FINANCE_DERIVATIVE_ROW_OBLIGATION_CURRENCY_MISMATCH', HttpStatus.BAD_REQUEST)
    }

    // AC6 / addendum §1.2 — the invariant ledger term 9 stands on.
    //
    // `settleByCompany` on the SENIOR branch takes the accumulator from
    // `pending_obligations.amount` while term 7 debits `transactions.amount`,
    // and NOTHING inside settle compares the two: the equality is held from
    // outside, by `bookCompanyObligations` and by task 0 (#598). A row edited
    // BEFORE #598 can therefore carry two different numbers — and reverting
    // it would hand the balance back a debit that is not the one that left
    // it. An error in the "+" direction, which no gate catches.
    //
    // So the dependency is expressed as an executable CHECK at the point of
    // reliance, not as a comment near it (addendum §3.1): remove the
    // invariant upstream and this starts refusing on real data, loudly,
    // instead of quietly returning the wrong figure.
    //
    // `needsReconfirm` alone identifies "about to be reverted": the resolver
    // sets it only for an obligation whose status IS `PAID` (both branches of
    // its ternary are gated on that), so an additional `isSettled &&` here
    // would be a second, unfalsifiable description of the same condition.
    if (
      derivativePlan.needsReconfirm &&
      snap.fundingSource === COMPANY_ACCOUNT_FUNDING_SOURCE &&
      amountsDiffer(snap.amount, snap.settledAmount ?? 0)
    ) {
      // task-i18n-stage4-task2 Step 1 (COPY-H-api-4): the full divergence
      // detail (row id, both figures, the #598 pointer) stays server-side
      // — the user-facing refusal is generic on purpose (lesson "разбор —
      // в лог").
      logger.warn(
        `Row ${derivativePlan.id} needsReconfirm: amount=${snap.amount} ` +
          `settled=${snap.settledAmount ?? 0} — see PR #598`,
      )
      throw apiError('FINANCE_ROW_AMOUNT_MISMATCH', HttpStatus.BAD_REQUEST)
    }

    // AC9 / addendum 3b, "Отдельно: settled_amount IS NULL" — the same
    // shape as the check directly above, for the other way the accumulator
    // can fail to describe reality: it is not there at all.
    //
    // `resolveDerivative` reads a missing accumulator as `?? 0` — "nothing
    // has been paid on this row". Reverting on that belief reopens the
    // obligation at its FULL figure, and the next settle pays the whole
    // thing a SECOND time. That is the one error class this decomposition
    // exists to prevent, and it would be silent.
    //
    // The population is empty TODAY, by a four-link theorem: `settled_amount`
    // and `settled_share_percent` were added by one task (#599) and are
    // written by one `.set()`, in which `settledAmount` is a `sql` expression
    // that never yields NULL — so `settled_amount IS NULL` implies the settle
    // predates #599, which implies `settled_share_percent IS NULL`, which
    // makes the resolver return `newAmount: null`, which the first condition
    // of this phase already refuses. Four links across three files, holding up
    // a money path.
    //
    // Which is exactly why it is written down as an executable check rather
    // than trusted (addendum §3.1): break any link and the system says so out
    // loud, on real data, instead of paying twice.
    if (derivativePlan.needsReconfirm && snap.settledAmount === null) {
      logger.warn(`Derivative row ${derivativePlan.id}: settled amount unknown`)
      throw apiError('FINANCE_DERIVATIVE_ROW_SETTLED_AMOUNT_UNKNOWN', HttpStatus.BAD_REQUEST)
    }

    // AC15 / addendum §1.14 (security-review SR-M-3, SR-M-4) — the cascade
    // does not revert what it will not be able to close again.
    //
    // A reopened obligation is a CLAIM OF A DEBT to a person:
    // `pending_obligations.amount` feeds the settle money gate and every
    // aggregate. A row that cannot be settled claims a debt that cannot be
    // discharged, and that dead end is undoable only by editing data by
    // hand — strictly worse than refusing now, which is undoable by doing
    // nothing.
    if (derivativePlan.needsReconfirm) {
      // (a) — GONE, and that removal is the content of task 3b.
      //
      // It used to refuse every drop derivative carrying a payment
      // (`snap.type === 'PAYOUT_DROP' && (snap.settledAmount ?? 0) > 0`),
      // because closing the remainder would make `amount` cumulative while
      // the payment-fact triplet next to it described exactly ONE conversion.
      // `settleByCompany` now computes that triplet from the CLOSURE rather
      // than from one payment (addendum 3b, 1.4/2.3) and the revert nulls it
      // (AC2 below), so the identity holds again — and the law AC15 states
      // ("do not revert what you will not be able to close") is carried by
      // four NARROWER refusals instead of one blanket one:
      //   - currency:  (b) right below, plus `OBLIGATION_CURRENCY_MISMATCH`;
      //   - remainder: the `max(newAmount, settledAmount)` floor (AC5),
      //                for which `owedNow === 0` is a legal idempotent close;
      //   - who pays:  the funding-source / payer guard in `settleByCompany`
      //                (AC14, #607) — a refusal at top-up time, not a dead end;
      //   - unknown accumulator: the check in this same phase above (AC9).
      //
      // (b) The accumulator is denominated in another unit than the share
      // being written, so "what is left to pay" is not computable — the
      // subtraction is not an approximation, it is a different unit. The
      // resolver already says so (`NON_USDT_CURRENCY`, and it leaves
      // `remainingToPay` null); applying the plan anyway would reopen an
      // obligation whose remainder nobody can compute.
      //
      // NOTE this reverses a first-round assumption of this task, which
      // called the warning non-blocking. That reasoning rested on "the
      // top-up works"; for drop it does not, so the premise went and the
      // conclusion with it (addendum §1.14).
      if (derivativePlan.warnings.some((w) => w.code === 'NON_USDT_CURRENCY')) {
        logger.warn(
          `Derivative row ${derivativePlan.id}: currency pair unresolvable ` +
            `(settled=${derivativePlan.settledCurrency ?? 'UNKNOWN'}, new=${derivativePlan.currency})`,
        )
        throw apiError(
          'FINANCE_DERIVATIVE_ROW_CURRENCY_PAIR_UNRESOLVABLE',
          HttpStatus.BAD_REQUEST,
          {
            settledCurrency: derivativePlan.settledCurrency ?? 'UNKNOWN',
            currency: derivativePlan.currency,
          },
        )
      }
    }
  }

  // ── Phase 2: write ─────────────────────────────────────────────────────
  const changedDerivativeIds: string[] = []

  for (const derivativePlan of plan.derivatives) {
    const snap = snapshotById.get(derivativePlan.id)!
    const newAmount = derivativePlan.newAmount!
    // QA-H-1 — the plan carries BOTH figures because they are different
    // facts: `newAmount` is what this row's amount WILL BE (floored at the
    // accumulator by the resolver, so the preview cannot describe a number
    // that will not be stored), `recomputedShare` is what the share came out
    // to. Their gap IS the overpayment.
    //
    // SR-L-6 — the reason two figures are needed, corrected. An earlier
    // version of this comment claimed a one-figure fix would break the
    // overpayment journal SILENTLY. That was wrong, and wrong in an
    // instructive way: three separate code-traces (mine, code-review's,
    // spec-review's) agreed on it, and an EXPERIMENT disproved it. Imitating
    // the one-figure fix and running the suites turns FOUR pre-existing tests
    // red — one in `@crm/shared` (the OVERPAYMENT warning stops firing:
    // `expected [] to deeply equal [{ code: 'OVERPAYMENT' }]`) and three here
    // (the `CASCADE_OVERPAYMENT` journal assertions). It fails loudly.
    //
    // The real reason is simpler and stronger: the floor DESTROYS the raw
    // share, and three consumers need it — `newShare`/`overpaidBy` in the two
    // journals below, the `overpaid` predicate, and the warning text. A
    // single field cannot be both the figure that gets written and the figure
    // that was computed. The shape is forced by what the information is, not
    // by what a test would or would not have caught.
    const recomputedShare = derivativePlan.recomputedShare!
    const isSettled = snap.obligation?.status === 'PAID'
    const amountMoved = amountsDiffer(newAmount, snap.amount)

    // ---- AC7: the obligation is closed and the recomputed share is NOT
    // above what was already paid. Write NOTHING.
    //
    // Terms 7/8 debit `amount`; what physically left is `settled_amount`.
    // Lowering `amount` here would under-debit the ledger by exactly the
    // overpaid difference — the company balance would GROW by money that has
    // already gone (addendum §1.7). The row stays PAID and keeps counting
    // for the figure that really left.
    if (isSettled && !derivativePlan.needsReconfirm) {
      await dbtx.insert(transactionAuditLog).values({
        actorId,
        targetId: derivativePlan.id,
        action: 'CASCADE_OVERPAYMENT',
        metadata: {
          // `isSettled` is true here, which BY DEFINITION means the
          // obligation exists (`snap.obligation?.status === 'PAID'`).
          obligationId: snap.obligation!.id,
          causedBy: plan.sourceId,
          settledAmount: derivativePlan.settledAmount,
          newShare: recomputedShare,
          overpaidBy: Number((derivativePlan.settledAmount - recomputedShare).toFixed(6)),
        },
      })
      continue
    }

    // ---- AC6: the obligation is closed and the recomputed share EXCEEDS
    // what was paid — return the row to "awaiting payment" for the balance.
    if (isSettled) {
      const obligation = snap.obligation!
      // Conditional UPDATE + affected-row count, the same shape
      // `settleByCompany` / `adminDeleteTransaction` / `restoreTransaction`
      // already use. Zero rows ⇒ the revert already happened ⇒ stop here
      // rather than journal it a second time (AC12).
      const reverted = await dbtx
        .update(pendingObligations)
        .set({
          status: 'PENDING',
          closingTransactionId: null,
          amount: String(newAmount),
          updatedAt: new Date(),
        })
        .where(and(eq(pendingObligations.id, obligation.id), eq(pendingObligations.status, 'PAID')))
        .returning({ id: pendingObligations.id })
      if (reverted.length === 0) continue

      const revertedType =
        snap.type === 'SENIOR_INCOME'
          ? 'SENIOR_PENDING_PAYOUT'
          : snap.type === 'PAYOUT_DROP'
            ? 'DROP_PENDING_PAYOUT'
            : null
      if (revertedType === null) {
        logger.warn(
          `Derivative row ${derivativePlan.id}: closed by unusual type ${String(snap.type)}, can't reopen`,
        )
        throw apiError('FINANCE_DERIVATIVE_ROW_TYPE_MISMATCH_FOR_REOPEN', HttpStatus.BAD_REQUEST)
      }

      await dbtx
        .update(transactions)
        .set({
          type: revertedType,
          status: 'PENDING_PAYMENT',
          amount: String(newAmount),
          // AC6 / addendum §2 — the percent goes back into the LIVE column,
          // because the NEXT preview reads the live column for a PENDING
          // obligation (`resolveDerivative`'s `isSettled` branch). Leaving it
          // null would make the row we just reverted un-recomputable.
          // `settled_share_percent` is NOT touched: it records the last
          // CLOSURE, and a revert is not one. `*SharePercentSource` stays
          // NULL — task 1 never snapshotted the origin, and inventing one
          // would be worse than the visible gap (backlog 70).
          ...(revertedType === 'SENIOR_PENDING_PAYOUT'
            ? { seniorSharePercent: derivativePlan.sharePercent }
            : { dropSharePercent: derivativePlan.sharePercent }),
          // task-drop-topup (task 3b, AC2 / addendum 1.5) — the payment-fact
          // triplet goes with the `amount` it describes.
          //
          // ONE criterion decides what a revert clears and what it keeps:
          // this UPDATE rewrites `amount` to the DEBT, so every column whose
          // truth is stated RELATIVE to `amount` stops being true, and every
          // column that is a self-standing record of a payment that really
          // happened stays. The triplet is the first kind — it asserts
          // `amount = original_amount × exchange_rate`. The accumulator, the
          // receipt, the payer, the date and the currency are the second
          // kind, and are deliberately absent from this `.set()`.
          //
          // T2 (addendum 1.4): after this, `original_amount IS NOT NULL` reads
          // as "the row stands in its CLOSED form" and nothing else.
          //
          // SR-L-2 — the dependency this line rests on, named at the line
          // rather than three screens away. `amount` is rewritten here to a
          // share of the SOURCE, denominated in the SOURCE's currency, while
          // `currency` is deliberately NOT rewritten. Those two agree only
          // because AC15(b) (a few screens up, the `NON_USDT_CURRENCY`
          // refusal) has already refused every derivative whose accumulator
          // is in a different unit than the share being written — which, via
          // the settle-side accumulator-currency guard, is the same unit the
          // row itself carries. Weaken or delete AC15(b) and this line starts
          // writing a figure in one currency under the label of another,
          // silently: nothing here compares them. Same shape of dependency,
          // and the same remedy, as the `Math.max` note in the AC5 branch.
          //
          // UNCONDITIONAL, not branched on `revertedType`: on a senior row all
          // three are already NULL by construction — `bookCompanyObligations`
          // never writes them and `settleByCompany` builds that object only
          // under `isDropObligation` — so writing NULL there is a provable
          // no-op. A branch no test could tell from its own absence costs more
          // than it saves (same call the `settledAmountError` gate made).
          //
          // Retractable, not lost: the values go into `CASCADE_REOPEN` below.
          originalAmount: null,
          originalCurrency: null,
          exchangeRate: null,
          // SR-L-2 (security-review, task 3b): `settleByCompany` stamped this
          // «Выплата … IOU (obligation …)», and after a revert that sentence
          // is false — the row is an IOU awaiting the remainder again, and
          // `notes` is what an operator reads in the transaction list.
          //
          // Written as the CURRENT state rather than restored to the booking
          // text: the original note carries a caller-supplied prefix
          // (`bookCompanyObligations`'s `notePrefix` — «USDT income» /
          // «Company owes») that the row does not record, so reconstructing
          // it would mean inventing one. The obligation id stays nameable
          // from the row either way.
          //
          // `notes` IS read by a WHERE predicate, in exactly one place, and
          // this is why that does not matter here (SR-M-1, review round 2 —
          // an earlier version of this comment claimed "nothing branches on
          // it", which is false): `confirmPayout` finds the row it just
          // inserted by `eq(transactions.notes, confirmationNote)`, in both
          // arms of its conditional predicate. BOTH arms also carry
          // `eq(transactions.type, 'PAYOUT_CONFIRMED')`, and a reverted
          // derivative is `SENIOR_PENDING_PAYOUT` / `DROP_PENDING_PAYOUT` —
          // it can never enter that lookup's population. Grep to re-check
          // when touching this: `grep -n 'transactions.notes' ` over
          // apps/api/src returns those two lines and nothing else.
          //
          // Stated this way on purpose. "Verified, not assumed" about a
          // claim that is merely broad is worse than no comment at all: the
          // next reader trusts it INSTEAD of looking, and the thing they
          // skip is the thing that changed. The narrow claim above is the
          // one that is actually true, and it names where to go and see.
          notes: `Повернення в очікування виплати після зміни суми доходу (зобов'язання ${obligation.id})`,
          updatedAt: new Date(),
        })
        .where(eq(transactions.id, derivativePlan.id))

      await dbtx.insert(transactionAuditLog).values({
        actorId,
        targetId: derivativePlan.id,
        action: 'CASCADE_REOPEN',
        metadata: {
          obligationId: obligation.id,
          causedBy: plan.sourceId,
          settledAmount: derivativePlan.settledAmount,
          sharePercent: derivativePlan.sharePercent,
          // task-drop-topup (task 3b, AC11): what the revert RETRACTS, in
          // full. `amount`/`type`/`status` are being rewritten by the UPDATE
          // above; the triplet is being nulled by it; and `receipt_*`, though
          // this UPDATE leaves them alone, will be OVERWRITTEN by the next
          // settle — the row has one pair of receipt columns and the closure
          // now has two payments (addendum 3b, "Семья однозначных колонок").
          // `tx_date` is here for exactly the same reason (SR-M-1): the
          // revert leaves it alone because a date is a self-standing record,
          // but the row has ONE date column and the closure now has two
          // payments, so the next settle overwrites the day the first one
          // happened.
          //
          // Without these lines the first payment's proof would disappear the
          // moment the remainder is topped up, which is the "not on the
          // screen ≠ not handed over" defect class.
          //
          // This insert is inside the money transaction, unlike the
          // best-effort `PAY` entry — so it is a RELIABLE carrier. Money is
          // still never computed from the journal (ADR AC5 п.9); this is
          // provenance only.
          before: {
            amount: snap.amount,
            type: snap.type,
            status: snap.status,
            originalAmount: snap.originalAmount,
            originalCurrency: snap.originalCurrency,
            exchangeRate: snap.exchangeRate,
            receiptDocumentId: snap.receiptDocumentId,
            receiptExternalUrl: snap.receiptExternalUrl,
            txDate: snap.txDate,
          },
          after: { amount: newAmount, type: revertedType, status: 'PENDING_PAYMENT' },
        },
      })
      if (amountMoved) changedDerivativeIds.push(derivativePlan.id)
      continue
    }

    // ---- AC5: the obligation is still open — no money has moved, so both
    // stored copies of the figure simply follow the new share. Scoped to
    // `status = 'PENDING'` exactly like the #598 sync: a CLOSED obligation's
    // amount is the historical record of a settlement that happened, and the
    // WHERE makes that unreachable structurally rather than by intent.
    //
    // AC5 / addendum §1.7 (security-review SR-M-4) — the figure written is
    // `max(newAmount, settledAmount)`, never the bare new share. AC5 and AC7
    // are ONE law in two states: **a derivative's `amount` is never written
    // below its `settled_amount`.** On a closed obligation that reads "do not
    // write at all" (the amount already equals the accumulator); on an open
    // one — an ALREADY-REVERTED row still carrying an accumulator — it reads
    // `max`. Writing less would make the remainder negative and leave an
    // obligation nobody can close. For a row that never settled,
    // `settledAmount` is 0 and `max` is the identity, so the first-round
    // behaviour is preserved byte for byte.
    // SR-L-1 (review round 4) — the comparison that holds this line up.
    //
    // `newAmount` is a share of the SOURCE amount, denominated in
    // `source.currency`. `settledAmount` is what actually left, denominated
    // in `settled_currency`. `Math.max` over two figures in different units
    // would be nonsense, and nothing in THIS expression says they match.
    //
    // SR-M-3 corrected the answer this comment used to give. It said AC15(b)
    // guarantees the two units match by the time control reaches here. It does
    // not: AC15(b) is scoped to a REVERT (`needsReconfirm`), so an OPEN
    // obligation with a foreign accumulator arrives here unrefused — and used
    // to take a `max` across units.
    //
    // What makes the line safe now is not a guard elsewhere but the call
    // itself: the floor is handed `null` when `settledCurrencyMismatch` says
    // the two are not comparable, which is the SAME function, on the same
    // values, that the resolver uses to decide whether to floor. There is one
    // predicate, so `newAmount` and the figure written here cannot disagree —
    // the property, not a claim about a distant guard.
    //
    // (Today it is doubly unreachable: `assertNoOffCurrencyCompanyRows`
    // (AC9) refuses to produce a balance at all while such a row exists.)
    // SR-L-3 (review round 5) — the shared law, not a fourth hand-written
    // copy of it. `derivativePlan.settledAmount` is `z.number()` (0 when the
    // row never settled), so this is the identity swap it looks like.
    // SR-M-3 (security-review) — the floor asks the SAME question here as in
    // the resolver, by calling the SAME function on the same values.
    //
    // It used to floor UNCONDITIONALLY while the resolver skips the floor
    // when the accumulator is not comparable to the share being written
    // (`max()` over 2000 UAH and 50 USDT is not a bigger number, it is a
    // meaningless one). Two predicates that look alike and disagree on
    // exactly one population: an OPEN obligation with a foreign accumulator,
    // where the plan said 26 and the row would have taken 260 — the same
    // «shown ≠ stored» defect QA measured one corner over.
    //
    // Fixed HERE rather than by refusing that population in Phase 1: AC15's
    // dead-end refusal is deliberately scoped to a REVERT (nothing is being
    // reverted on an open obligation, so there is no dead end), and widening
    // it would also refuse an ordinary INCREASE on such a row, which is
    // writable and works today. A first attempt did exactly that and was
    // caught by the test that states the carve-out in words.
    const flooredAmount = floorAmountAtAccumulator(
      settledCurrencyMismatch(
        derivativePlan.settledAmount,
        derivativePlan.settledCurrency,
        derivativePlan.currency,
      )
        ? null
        : derivativePlan.settledAmount,
      newAmount,
    )
    // Kept as the defense-in-depth it always was — the write must not depend
    // on the plan having applied the law — but it is an identity now, so the
    // OVERPAYMENT question can no longer be asked of it: `flooredAmount ===
    // newAmount` holds even when there IS an overpayment, and reading the
    // flag off it would have silently stopped journaling `CASCADE_OVERPAYMENT`
    // on the money path. Ask the two figures that actually differ.
    const flooredByAccumulator = amountsDiffer(recomputedShare, flooredAmount)

    await dbtx
      .update(pendingObligations)
      .set({ amount: String(flooredAmount), updatedAt: new Date() })
      .where(
        and(
          eq(pendingObligations.sourceTransactionId, derivativePlan.id),
          eq(pendingObligations.status, 'PENDING'),
        ),
      )

    // SR-M-1 (security-review) — the same structural scoping the obligation
    // UPDATE above has. Unreachable today (the row was read under
    // `FOR UPDATE` two statements ago and nothing between can move it), but
    // "unreachable" is an argument, and the sibling statement does not rely
    // on one. Zero rows means the invariant broke: fail loudly rather than
    // leave the obligation updated and the transaction not — which is
    // exactly the L3 divergence this decomposition exists to close.
    const derivativeUpdated = await dbtx
      .update(transactions)
      .set({ amount: String(flooredAmount), updatedAt: new Date() })
      .where(
        and(eq(transactions.id, derivativePlan.id), eq(transactions.status, 'PENDING_PAYMENT')),
      )
      .returning({ id: transactions.id })
    if (derivativeUpdated.length === 0) {
      throw apiError('FINANCE_SHARE_LEFT_PENDING_DURING_SAVE', HttpStatus.BAD_REQUEST)
    }

    await dbtx.insert(transactionAuditLog).values({
      actorId,
      targetId: derivativePlan.id,
      action: 'CASCADE_AMOUNT_UPDATE',
      metadata: {
        obligationId: snap.obligation?.id ?? null,
        causedBy: plan.sourceId,
        settledAmount: derivativePlan.settledAmount,
        sharePercent: derivativePlan.sharePercent,
        amount: { before: snap.amount, after: flooredAmount },
      },
    })
    // The recomputed share came out BELOW what has already been paid on a
    // row that was reverted earlier. The accumulator floor kept the
    // obligation closable; the overpayment itself is still a fact a human
    // has to see, and it is the same fact AC7 journals one state over.
    if (flooredByAccumulator) {
      await dbtx.insert(transactionAuditLog).values({
        actorId,
        targetId: derivativePlan.id,
        action: 'CASCADE_OVERPAYMENT',
        metadata: {
          obligationId: snap.obligation?.id ?? null,
          causedBy: plan.sourceId,
          settledAmount: derivativePlan.settledAmount,
          newShare: recomputedShare,
          overpaidBy: Number((derivativePlan.settledAmount - recomputedShare).toFixed(6)),
        },
      })
    }
    if (amountsDiffer(flooredAmount, snap.amount)) changedDerivativeIds.push(derivativePlan.id)
  }

  return { changedDerivativeIds }
}
