import { ForbiddenException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import type {
  SessionUser,
  CascadeSnapshot,
  CascadeDerivativeSnapshot,
  CascadeSourceSnapshot,
  CascadeEditPreviewResponse,
  CascadePlan,
} from '@crm/shared'
import {
  resolveEditCascade,
  computeCascadeVersion,
  classifyEditedRowLedgerFact,
  CASCADE_LEDGER_FACT_ERROR_CODES,
  isCascadeAmountEdit,
  cascadeEditPreviewResponseSchema,
} from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import { invoiceSignatures, pendingObligations, transactions } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { lockCompanyAccount } from './company-account-balance'
import { applyEditCascade } from './edit-cascade-apply.util'
import { fetchWritableTransactionOrThrow } from './transaction-visibility.util'

/**
 * Edit-cascade core for money transactions: row locking in the one safe order,
 * the shared cascade snapshot read, the own-record amount assertion, the
 * cascade apply and the read-only edit preview. Depends on the database only
 * and never on TransactionsService.
 */
@Injectable()
export class EditCascadeService {
  private readonly logger = new Logger(EditCascadeService.name)

  constructor(private readonly db: DatabaseService) {}

  // ── Edit cascade preview (read-only) ────────────────────────────────────
  //
  // task-cascade-resolver-preview (task 2 of the paid-transaction-edit-cascade
  // decomposition — docs/architecture/2026-08-22-paid-transaction-edit-cascade.md,
  // AC4 "один резолвер, две обёртки"). `loadCascadeSnapshot` is the ONE query
  // shape both `getEditCascadePreview` below (this task) and the future
  // `PATCH` (task 3, re-reading the SAME rows under `SELECT … FOR UPDATE`)
  // are required to call — the arithmetic itself lives in `@crm/shared`
  // (`resolveEditCascade`) and is NEVER re-implemented here, the same
  // precedent `roundShareAmount` already set one layer down (see that
  // function's own comment, `:5127` region above).
  //
  // Accepts either the pool handle or an open `dbtx` so task 3 can reuse it
  // unchanged inside a `db.transaction(...)` callback.

  /**
   * task-cascade-apply (task 3, AC3 / addendum §1.9) — take every row lock the
   * cascade will need, in the ONE order that does not invert
   * `settleByCompany`'s:
   *
   *   1. `pending_obligations`  FOR UPDATE, ORDER BY id
   *   2. `lockCompanyAccount`   (the company-account advisory lock)
   *   3. `transactions`         FOR UPDATE, ORDER BY id
   *
   * `ORDER BY id` on both row-lock statements is against two CASCADES
   * deadlocking each other on overlapping row sets — a deterministic
   * acquisition order inside each statement makes that impossible.
   *
   * The advisory lock is taken UNCONDITIONALLY, not only when a derivative
   * turns out to be company-funded (addendum §1.6): the balance is a SUM over
   * many rows read by nine separate statements in READ COMMITTED, so a row
   * migrating between ledger terms while a gate is mid-read can be counted
   * twice or not at all. Not-at-all inflates the balance — the dangerous
   * direction. Holding the same lock every gate holds means no gate can read
   * the ledger while the cascade is moving a row between terms. It also has
   * to be taken BEFORE deciding whether anything is company-funded, because
   * that decision comes from the snapshot this lock is protecting.
   *
   * The id-discovery read below takes NO row locks (a plain `SELECT` in READ
   * COMMITTED), so it cannot join a deadlock cycle: only the three
   * acquisitions above order against anything. A derivative appearing between
   * the discovery read and the lock would be caught by the version check the
   * caller runs immediately after — the preview's version could not have
   * contained it.
   */
  async lockCascadeRows(db: DatabaseService['db'] | DrizzleTx, sourceId: string): Promise<void> {
    const derivativeIdRows = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(eq(transactions.sourceIncomeTransactionId, sourceId), isNull(transactions.deletedAt)),
      )
    // The SOURCE's own obligation is in the set on purpose: the #598 sync
    // UPDATE later in this same DB transaction writes it, and acquiring that
    // row lock AFTER the advisory lock would reintroduce the very inversion
    // this ordering exists to remove.
    const lockIds = [sourceId, ...derivativeIdRows.map((r) => r.id)]

    await db
      .select({ id: pendingObligations.id })
      .from(pendingObligations)
      .where(inArray(pendingObligations.sourceTransactionId, lockIds))
      .orderBy(pendingObligations.id)
      .for('update')

    // `lockCompanyAccount` takes a `DrizzleTx` deliberately: a
    // transaction-scoped advisory lock acquired outside a transaction is
    // released immediately and protects nothing, and the narrow parameter type
    // is what prevents that.
    //
    // SR-L-1 (security-review): this narrowing is no longer an assumption. The
    // ONLY route into this method is `loadCascadeSnapshot`'s `{ forUpdate:
    // true }` overload, whose declared handle type IS `DrizzleTx` — so every
    // caller has already been type-checked into passing a transaction. The
    // cast bridges the implementation signature (which still accepts the union,
    // because the plain-read overload shares this body), not a hope about
    // callers.
    await lockCompanyAccount(db as DrizzleTx)

    await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(inArray(transactions.id, lockIds))
      .orderBy(transactions.id)
      .for('update')
  }

  /** Plain read — either handle, no locks. */
  async loadCascadeSnapshot(
    db: DatabaseService['db'] | DrizzleTx,
    sourceId: string,
  ): Promise<CascadeSnapshot | null>
  /**
   * Locked read. SR-L-1 (security-review): `forUpdate` is only meaningful
   * inside an open transaction — row locks and the company-account advisory
   * lock both live for the transaction's lifetime, and a transaction-scoped
   * advisory lock taken outside one is released immediately and protects
   * nothing. This overload puts that requirement in the TYPES (the handle must
   * be a `DrizzleTx`) instead of a comment asking the caller to be careful.
   */
  async loadCascadeSnapshot(
    db: DrizzleTx,
    sourceId: string,
    opts: { forUpdate: true },
  ): Promise<CascadeSnapshot | null>
  async loadCascadeSnapshot(
    db: DatabaseService['db'] | DrizzleTx,
    sourceId: string,
    opts: { forUpdate?: boolean } = {},
  ): Promise<CascadeSnapshot | null> {
    // task-cascade-apply (task 3, AC3 / addendum §1.9) — the WRITE entry point
    // reads the same shape as the preview, but under locks. The read itself is
    // byte-identical below; only this preamble differs, so "предпросмотр ==
    // факт" cannot drift into two query shapes (ADR AC4).
    //
    // ORDER IS THE WHOLE POINT: `settleByCompany` takes
    // `pending_obligations` (its conditional claim) → `lockCompanyAccount` →
    // `transactions`. Any other order here is an ABBA inversion against it,
    // and Postgres resolves that by killing one side with 40P01 — a genuine
    // 500 on the money path the moment an edit and a settle race.
    if (opts.forUpdate) {
      await this.lockCascadeRows(db, sourceId)
    }

    const source = await db.query.transactions.findFirst({ where: eq(transactions.id, sourceId) })
    if (!source) return null

    // L18/C8 (ADR): `sourceIncomeTransactionId` is stamped ONCE at booking
    // time and, unlike `transactions.payoutRequestId`, survives
    // `settleByCompany`'s flip — it is what makes a derivative findable by
    // its source whether the derivative is still PENDING_PAYMENT or has
    // already flipped to PAID.
    const derivativeRows = await db.query.transactions.findMany({
      where: and(
        eq(transactions.sourceIncomeTransactionId, sourceId),
        isNull(transactions.deletedAt),
      ),
      // UX-1 (design fidelity, HIGH, reopened): the preview must be able to say
      // WHOSE share each row is, and that identity lives on the derivative —
      // not on the source. Inferring it from the source row printed the admin's
      // name against a senior's share on every `ADMIN_INCOME` cascade, which is
      // the main path of this feature.
      //
      // A plain relational read, no lock: `lockCascadeRows` has already taken
      // every row lock this snapshot needs, and `users` is not among them
      // (nothing here writes a user). So this join cannot participate in the
      // lock ordering the comment above guards, and cannot deadlock against
      // `settleByCompany`.
      //
      // `columns` is an explicit allow-list, deliberately: `with: { receiver: true }`
      // would pull the whole user row — email, legal name, admin note — into a
      // snapshot that gets serialised into an API response. One display name is
      // what the screen needs and all it gets (zone: projection rule 3).
      // Stryker disable next-line ObjectLiteral,BooleanLiteral: a Drizzle query SHAPE, unobservable from a unit double — this file's own `cascade-edit-preview.unit.spec.ts` stubs `transactions.findMany` with canned rows that already carry `receiver`, so it answers identically whether this clause is here, gutted to `{}`, or asks for `displayName: false`. The mutation gate cannot run integration specs at all (mutation-gate-integration-specs.md), and the proof lives in one: `cascade-edit-preview.integration.spec.ts` «UX-1: each derivative names ITS OWN receiver». VERIFIED, not assumed — deleting this line and re-running that spec against real Postgres fails with «expected null to be 'Cascade Preview Senior'». Same class and same reasoning as the `derivativeIds` / `signatureQueryIds` suppressions a few lines down
      with: { receiver: { columns: { displayName: true } } },
    })

    // Stryker disable next-line ArrowFunction: the VALUES this feeds into the
    // two `inArray(...)` filters below are a Postgres query shape — a unit
    // double (this file's own `cascade-edit-preview.unit.spec.ts`) proves the
    // `where` clause is PRESENT (not gutted) on every call, but a mock that
    // ignores its argument content cannot distinguish real ids from
    // `undefined`s without reaching into drizzle-orm's SQL builder internals.
    // The real-Postgres round-trip in `cascade-edit-preview.integration.spec.ts`
    // is what actually proves the correct rows come back (mutation-gate-integration-specs.md).
    const derivativeIds = derivativeRows.map((d) => d.id)
    // task-cascade-apply (task 3, AC13): the SOURCE's own id joins this filter.
    // The edited row can itself be a settled obligation (a flipped
    // `SENIOR_INCOME`), and AC13 needs to know that BEFORE allowing its amount
    // to move. Folding it into the query that already runs keeps
    // `loadCascadeSnapshot` a single read shape — the zero-length skip is gone
    // because this list now always holds at least `sourceId`.
    const obligationRows = await db.query.pendingObligations.findMany({
      where: or(
        inArray(pendingObligations.sourceTransactionId, [sourceId, ...derivativeIds]),
        // SR-H-3 (security-review round 3) — the SECOND key, for obligations
        // closed BEFORE the settle-in-place ADR of 2026-07-14.
        //
        // `source_transaction_id` alone is enough only in the epoch where a
        // settle flips the IOU on the spot (then source == closing == the row
        // itself). Before that, closing an obligation INSERTED a second
        // transaction: `closing_transaction_id` points at the row that paid,
        // `source_transaction_id` at the IOU still hanging behind it. Such an
        // obligation is invisible to the `inArray` above when the row being
        // edited is the CLOSING one — and that is exactly the row standing in
        // ledger term 7.
        //
        // The other three AC13 predicates are empty for that same population
        // by construction: `original_amount` (2026-08-05) and `settled_amount`
        // (2026-08-22) both landed "no backfill by design". So a legacy row
        // passed all four and stayed editable, with the vanishing debit AC13
        // exists to prevent.
        //
        // A one-time data-fix DID re-point some of these rows on production —
        // `2026-07-15_settle_phantom_cleanup_auto.sql`, auto-wired and applied
        // in PR #382, then de-wired (the reasoning is recorded in
        // `scripts/devops/check-prod-ddl-wiring.py`'s `KNOWN_NOT_WIRED`). It
        // does NOT make this disjunct redundant, because its repoint is scoped:
        //
        //   AND src.type IN ('SENIOR_PENDING_PAYOUT', 'DROP_PENDING_PAYOUT')
        //   AND src.status = 'PENDING_PAYMENT'
        //
        // It only re-pointed obligations whose OLD source row was still a
        // phantom IOU awaiting payment — that was its purpose (release the FK
        // so the phantom could be deleted). An obligation with
        // `closing <> source` whose old source row is anything else was left
        // exactly as it was, and is still out there in that shape.
        //
        // Which is the general point: a guard whose correctness depends on a
        // one-shot script having covered every row is a guard whose
        // correctness lives outside the code. This disjunct is correct in both
        // epochs and under either answer about the script.
        and(
          eq(pendingObligations.closingTransactionId, sourceId),
          eq(pendingObligations.status, 'PAID'),
        ),
      ),
    })
    // Keyed by `sourceTransactionId`, and the disjunct above cannot pollute
    // it: a row it adds is keyed by the hanging IOU's id, and this map is only
    // ever read at a DERIVATIVE's id. Where the two coincide the row was
    // already in the `inArray` result, so it is the same row either way.
    const obligationByDerivative = new Map(obligationRows.map((o) => [o.sourceTransactionId, o]))
    // AC13, the pre-#599 form: a row closed before `settled_amount` existed
    // carries no accumulator but still closes an obligation. `status === 'PAID'`
    // and not merely "an obligation exists": an OPEN obligation on the edited
    // row is the ordinary IOU case, which stays editable (that is L3's whole
    // point — #598 keeps the two copies in step). CANCELLED is not a closure
    // either — a written-off obligation has no money standing behind it.
    const sourceHasClosedObligation = obligationRows.some(
      (o) =>
        o.status === 'PAID' &&
        (o.sourceTransactionId === sourceId || o.closingTransactionId === sourceId),
    )

    // L13/C3 (ADR): a COUNTERPARTY-signed invoice on a derivative is exactly
    // the case AC5 §6 forbids the cascade from silently disagreeing with.
    //
    // MED-1 (security-review round 1): the SOURCE row itself needs the SAME
    // check — after guard 3 is lifted (task 3), a `SALARY` row can BE the
    // source, and it can carry its own signed invoice. `sourceId` is folded
    // into the SAME `inArray` filter as the derivatives (one query, not two)
    // — this is why the zero-length skip below can no longer bypass the
    // query entirely the way the obligations one still does.
    //
    // Stryker disable next-line ArrayDeclaration: same class as the
    // `derivativeIds` ArrowFunction suppression a few lines up — the VALUES
    // fed into `inArray(...)` are a Postgres query shape, and a unit double
    // whose `findManySignatures` stub ignores its call arguments (it returns
    // a canned row list regardless of which ids were actually queried)
    // cannot tell `[...derivativeIds, sourceId]` apart from `[]` without
    // reaching into drizzle-orm's SQL builder internals. Proven for real by
    // `cascade-edit-preview.integration.spec.ts`'s "a real COUNTERPARTY
    // invoice_signatures row on the SOURCE id surfaces SOURCE_SIGNED_INVOICE"
    // against actual Postgres: an empty/wrong id list there would return zero
    // rows and that test would fail (mutation-gate-integration-specs.md).
    const signatureQueryIds = [...derivativeIds, sourceId]
    const signatureRows = await db.query.invoiceSignatures.findMany({
      where: and(
        inArray(invoiceSignatures.transactionId, signatureQueryIds),
        // Stryker disable next-line StringLiteral: a Postgres query VALUE
        // (which signer_role to filter by), not a shape — see the
        // ArrowFunction suppression above `derivativeIds` for the same
        // reasoning; provable only against the real DB, which
        // `cascade-edit-preview.integration.spec.ts` exercises directly
        // (a signature row with signerRole !== 'COUNTERPARTY' asserted
        // absent from `hasSignedInvoice` there is not reachable here).
        eq(invoiceSignatures.signerRole, 'COUNTERPARTY'),
      ),
    })
    const signedIds = new Set(signatureRows.map((s) => s.transactionId))

    const derivatives: CascadeDerivativeSnapshot[] = derivativeRows.map((d) => {
      const obligation = obligationByDerivative.get(d.id)
      return {
        id: d.id,
        type: d.type,
        // UX-1 — see the `with:` allow-list on the query above.
        receiverName: d.receiver?.displayName ?? null,
        status: d.status,
        amount: Number(d.amount),
        currency: d.currency,
        updatedAt: d.updatedAt.toISOString(),
        // Non-null only while the row is still PENDING_PAYMENT — settle nulls
        // both and snapshots the ONE that mattered into settledSharePercent
        // below (schema.ts comment on settledSharePercent).
        sharePercent: d.seniorSharePercent ?? d.dropSharePercent ?? null,
        settledAmount: d.settledAmount !== null ? Number(d.settledAmount) : null,
        settledCurrency: d.settledCurrency,
        settledSharePercent: d.settledSharePercent,
        // task-cascade-apply (task 3, AC6): only a COMPANY_ACCOUNT-funded row
        // is in ledger terms 7/8/9, so only for such a row must the
        // `amount == settled_amount` invariant hold before a revert (addendum
        // §1.2). Unused by the pure resolver — see the field's own comment in
        // `@crm/shared` for why it still belongs on the snapshot.
        fundingSource: d.fundingSource,
        // task-drop-topup (task 3b): the payment-fact triplet and the proof of
        // the payment it describes. Read off the SAME row this map already
        // walks — `findMany` above selects `d.*`, so this is zero extra
        // round-trips (a second query would fork the one read shape AC4 fixes).
        // The pure resolver ignores all five; `applyEditCascade` nulls the
        // triplet on a revert and journals every one of them as the values
        // being retracted (see their comments in `@crm/shared`).
        originalAmount: d.originalAmount !== null ? Number(d.originalAmount) : null,
        originalCurrency: d.originalCurrency,
        exchangeRate: d.exchangeRate,
        receiptDocumentId: d.receiptDocumentId,
        receiptExternalUrl: d.receiptExternalUrl,
        // SR-M-1: ISO, like every other timestamp on this snapshot — the
        // journal is JSONB and a `Date` would serialise by accident rather
        // than by decision.
        txDate: d.txDate ? d.txDate.toISOString() : null,
        hasSignedInvoice: signedIds.has(d.id),
        obligation: obligation
          ? {
              id: obligation.id,
              status: obligation.status,
              amount: Number(obligation.amount),
              // task-cascade-apply (backlog 95, addendum §3.5): READ the
              // obligation's own currency instead of assuming it matches the
              // source's. `bookCompanyObligations` stamps 'USDT' as a
              // literal and BIZ-18 was the only thing keeping that literal
              // in step with the source — and BIZ-18 is what task 3 lifts.
              currency: obligation.currency,
              updatedAt: obligation.updatedAt.toISOString(),
            }
          : null,
      }
    })

    return {
      source: {
        id: source.id,
        type: source.type,
        status: source.status,
        amount: Number(source.amount),
        currency: source.currency,
        payoutRequestId: source.payoutRequestId,
        updatedAt: source.updatedAt.toISOString(),
        // MED-1 (security-review round 1) — see the comment on
        // `signatureQueryIds` above for why the source id shares the SAME
        // query as the derivatives instead of a second round-trip.
        hasSignedInvoice: signedIds.has(source.id),
        originalAmount:
          (source.originalAmount ?? null) === null ? null : Number(source.originalAmount),
        // task-paid-salary-amount-edit — the rest of the triplet: a paid
        // SALARY's obligation is recomputed at THIS rate. `?? null` for the
        // same partial-projection reason as the two below: `undefined` would
        // read as "a rate was recorded" in the resolver.
        originalCurrency: source.originalCurrency ?? null,
        exchangeRate: source.exchangeRate ?? null,
        // AC13 — the two "second carrier" facts about the edited row itself.
        //
        // `?? null` rather than a bare `!== null`: these two feed a REFUSAL,
        // and `Number(undefined)` is NaN, which is `!== null` and would read as
        // "this row carries an accumulator" — turning a money guard ON for a
        // row that has none. A partial projection (`columns: {...}` added to
        // the read for speed) is all it would take, and nothing about the
        // failure would point here.
        settledAmount:
          (source.settledAmount ?? null) === null ? null : Number(source.settledAmount),
        hasClosedObligation: sourceHasClosedObligation,
      },
      derivatives,
    }
  }

  /**
   * task-cascade-apply (task 3, AC13 / addendum §1.12, security-review SR-H-1)
   * — refuse an `amount` edit on a row whose amount is NOT purely our own
   * record of a figure.
   *
   * The rule, stated once:
   *
   * > Editing `amount` on a PAID row is allowed when `amount` is OUR OWN
   * > record of a value that could have been entered wrongly. It is forbidden
   * > when the number has a SECOND CARRIER that the edit does not move —
   * > because then the edit does not correct a record, it sets two of the
   * > system's records against each other.
   *
   * `ADMIN_INCOME`, `EXPENSE` and `DIVIDEND_TO_ADMIN` stay editable ON PURPOSE:
   * they have no second carrier (checked column by column across all eight
   * ledger terms — the table in addendum §1.12), so there an edit means "we
   * wrote down the wrong number" and the ledger is obliged to follow it. That
   * is the work this whole task exists to do; do not "finish the job" by
   * blocking them.
   *
   * ONLY EVER CALLED ON THE ROW THE REQUEST IS EDITING. This is not a general
   * helper and must not become one: the cascade writes `amount` on derivatives
   * whose `settledAmount` is non-null all the time — that is AC5/AC6, its
   * ordinary work. Calling this from `applyEditCascade` would make the cascade
   * refuse itself. Both directions are pinned by tests.
   */
  assertEditedRowAmountIsOwnRecord(source: CascadeSourceSnapshot, requestedAmount: number): void {
    // CR-M-1 (code-review round 3) — the predicates and their texts moved to
    // `@crm/shared` so `GET :id/edit-preview` answers from the SAME
    // description this refusal is built on. Two copies of "what is editable"
    // is precisely how a preview starts promising a save that cannot happen
    // (risk 1 of the main ADR's AC6).
    //
    // task-paid-salary-amount-edit — the requested amount is an input now: a
    // paid salary passes unless its obligation at the recorded rate could not
    // be stored, and only the figure can tell.
    const reason = classifyEditedRowLedgerFact(source, requestedAmount)
    // One code per reason (`CASCADE_LEDGER_FACT_ERROR_CODES`, shared with the
    // preview banner). CR-M-1: `SALARY_OBLIGATION_OUT_OF_RANGE` is not a pinned
    // row but a figure that gives an unstorable obligation — its code tells the
    // operator to check the amount, not to reverse.
    if (reason) throw apiError(CASCADE_LEDGER_FACT_ERROR_CODES[reason], HttpStatus.BAD_REQUEST)
  }

  /**
   * task-cascade-apply (task 3) — apply an already-resolved cascade plan to the
   * derivatives, inside the caller's DB transaction and under the locks
   * `lockCascadeRows` has already taken. Thin facade: the body lives in
   * `edit-cascade-apply.util.ts` (pure move; runs on the caller's `dbtx`).
   */
  applyEditCascade(
    dbtx: DrizzleTx,
    snapshot: CascadeSnapshot,
    plan: CascadePlan,
    actorId: string,
  ): Promise<{ changedDerivativeIds: string[] }> {
    return applyEditCascade(dbtx, snapshot, plan, actorId, this.logger)
  }

  /**
   * `GET /transactions/:id/edit-preview`. Read-only — loads a snapshot,
   * calls the shared resolver, returns the plan plus an optimistic-locking
   * version. Writes NOTHING: no row, no journal entry (AC9 of the task
   * file). Same RBAC as `adminUpdateTransaction` — ADMIN only, checked here
   * AND at the controller (`@Roles('ADMIN')`), the same defense-in-depth
   * pattern every other money endpoint in this file uses.
   *
   * Guards 1 and 2 of `adminUpdateTransaction` (`:2944-2949` above) are
   * mirrored here rather than imported from there — this task's scope
   * deliberately excludes touching `adminUpdateTransaction` at all (see the
   * task file), and both guards are a small, security-reviewed, "never
   * lifted" invariant (AC5 §1/§2 of the ADR). Guard 3 (BIZ-18, the PAID
   * `amount` lock) is intentionally ABSENT here: this endpoint exists to
   * preview what removing it would do (task 3), so it must never itself
   * refuse on it.
   */
  async getEditCascadePreview(
    id: string,
    amount: number,
    currentUser: SessionUser,
  ): Promise<CascadeEditPreviewResponse> {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    // Fetch+guard fusion (transaction-visibility.util.ts) — 404 for missing
    // or invisible, 400 for a soft-deleted row even though ADMIN can see it.
    const tx = await fetchWritableTransactionOrThrow(this.db.db, id, currentUser)

    if (tx.type === 'PAYOUT' || tx.type === 'PAYOUT_ADMIN' || tx.type === 'PAYOUT_CONFIRMED') {
      return cascadeEditPreviewResponseSchema.parse({
        editable: false,
        blockedReason: 'PAYOUT_FAMILY',
        plan: null,
        version: null,
      })
    }
    if (tx.payoutRequestId) {
      return cascadeEditPreviewResponseSchema.parse({
        editable: false,
        blockedReason: 'LINKED_TO_PAYOUT_REQUEST',
        plan: null,
        version: null,
      })
    }

    // LOW (security-review round 1): `fetchWritableTransactionOrThrow` above
    // already read this exact row, and `loadCascadeSnapshot` immediately
    // re-reads it as its OWN `source` query — a deliberate extra round-trip,
    // not an oversight. `fetchWritableTransactionOrThrow` carries visibility
    // RBAC + soft-delete semantics this endpoint needs for the 404/400 split
    // (`transaction-visibility.util.ts`); `loadCascadeSnapshot` is required
    // to stay a SINGLE, self-contained query shape re-usable VERBATIM by
    // task 3 under `SELECT … FOR UPDATE` (AC4 "один резолвер, две обёртки")
    // — threading a pre-fetched row into it would fork that shape into a
    // preview-only variant and reintroduce the exact "two descriptions of
    // one read" problem AC4 exists to prevent. One extra indexed
    // primary-key read is the accepted cost of keeping that guarantee.
    const snapshot = await this.loadCascadeSnapshot(this.db.db, id)
    if (!snapshot) {
      // `tx` above already proved the row exists and is visible — only a
      // genuine race (a concurrent hard-delete-equivalent between the two
      // reads) could land here. Real defense-in-depth, not a decorative
      // check: the two reads are NOT inside one transaction.
      throw apiError('FINANCE_TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND)
    }

    // CR-M-1 — AC13's refusals, reported BEFORE a plan is built, because a
    // plan for a row that cannot be saved is worse than no plan: task 5 would
    // render an edit form on it.
    //
    // CR-M-2 — the SAME symbol `adminUpdateTransaction` asks, not a second
    // spelling of it. The previous version of this comment said the condition
    // "mirrors `isCascadeEdit` exactly", which is the give-away phrasing for a
    // third copy of a rule (backlog 85): the copies agreed, but the rule was
    // written down twice, and on #600 that is precisely how two copies drifted.
    //
    // Parity is the whole point of asking at all: reporting "blocked" where
    // the write would NOT refuse is the same divergence pointing the other way.
    if (
      isCascadeAmountEdit({
        status: snapshot.source.status,
        storedAmount: snapshot.source.amount,
        requestedAmount: amount,
      })
    ) {
      const ledgerFact = classifyEditedRowLedgerFact(snapshot.source, amount)
      if (ledgerFact) {
        return cascadeEditPreviewResponseSchema.parse({
          editable: false,
          blockedReason: ledgerFact,
          plan: null,
          version: null,
        })
      }
    }

    const plan = resolveEditCascade(snapshot, { amount })
    const version = computeCascadeVersion(snapshot)
    // AC5 of the task file / project convention (all API responses cross the
    // wire through a Zod `.parse()`) — the SAME schema `GET /edit-preview`'s
    // consumer (task 5's UI, and task 3's own optimistic-lock check) will
    // parse on the way IN, parsed here on the way OUT so a shape drift in
    // `resolveEditCascade`/`computeCascadeVersion` fails loudly in THIS spec
    // rather than surfacing as a silent contract mismatch three tasks later.
    return cascadeEditPreviewResponseSchema.parse({
      editable: true,
      blockedReason: null,
      plan,
      version,
    })
  }
}
