/**
 * The transactions ledger table.
 */
import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  type AnyPgColumn,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { documents, invoiceSignatures } from './documents'
import { currencyEnum, transactionStatusEnum, transactionTypeEnum } from './enums'
import { payoutRequests } from './finance'
import { projects } from './projects'
import { users } from './users'

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    type: transactionTypeEnum().notNull(),
    status: transactionStatusEnum().notNull().default('PENDING'),
    amount: numeric('amount', { precision: 18, scale: 6 }).notNull(),
    // currency always stored; USDT for crypto flows, USD for salary/expenses
    currency: currencyEnum().notNull().default('USDT'),
    /**
     * task-salary-pay-amount — OBLIGATION snapshot, written by `paySalary` at
     * the PENDING→PAID flip. task-drop-payout-currency (2026-08) extends the
     * SAME triple to `PendingSettlementService.settleByCompany`'s DROP-only
     * branch (settling a DROP_PENDING_PAYOUT obligation in a non-obligation
     * currency) — byte-for-byte the same three columns, same
     * `isStorableExchangeRate` guard, only the amount is SERVER-computed via
     * `convertToBase` rather than client-supplied (the settle dialog's amount
     * field is fully disabled — there is no client fact to record, only a
     * conversion). A SENIOR settle does NOT write these — unaffected by this
     * task, unchanged pre-existing behaviour. All three are NULL on every
     * other row (including a SENIOR settle).
     *
     * WHY THIS EXISTS. A salary is created as a PENDING reminder denominated in
     * the obligation's own currency («800 USD»). It is settled later, possibly
     * in another currency, and the owner requires `amount`/`currency` above to
     * carry the FACT of that payment («30 000 UAH») so a bank statement
     * reconciles one-to-one. Overwriting them with the fact and nothing else
     * would DESTROY the obligation — and USD reporting, balances and the
     * «projects unpaid this month» metric are all built on it. So the fact goes
     * into `amount`/`currency`, and the obligation it settled is preserved
     * here. Nothing is lost; both readings of the row stay derivable forever.
     *
     *   original_amount   — `amount`   as it stood immediately BEFORE payment.
     *   original_currency — `currency` as it stood immediately BEFORE payment.
     *   exchange_rate     — the EFFECTIVE applied rate, `paid / original`
     *                       (units of the paid currency per 1 unit of the
     *                       original). Computed SERVER-SIDE from the two
     *                       amounts, never accepted from the client — for
     *                       paySalary the payer settles at their own bank's
     *                       rate, which is by definition whatever those two
     *                       amounts imply; for settleByCompany's DROP branch
     *                       there is no external fact at all (the amount
     *                       field is disabled), so the server derives BOTH
     *                       amounts via the NBU rate. Either way a
     *                       client-supplied rate would add nothing but a
     *                       spoofable field. A SNAPSHOT of what was applied at
     *                       pay time (like `senior_share_percent`) — a later
     *                       `adminEditTransaction` on `amount` does not rewrite
     *                       it; the audit log records that edit separately.
     *                       scale 8 (not the 6 used for money) so a
     *                       sub-unit rate — e.g. UAH→USD ≈ 0.02666667 — keeps
     *                       full precision; it is a ratio, not an amount.
     *
     * A ROW CLOSED BY MORE THAN ONE PAYMENT (task-drop-topup, task 3b). Since
     * the drop top-up exists, a drop row can be closed, reopened by an income
     * edit, and closed again. The three definitions above do not change — but
     * note WHEN they are evaluated: the triplet is re-stamped at EVERY closure
     * and cleared by the revert in between, so it always describes the CLOSURE
     * THE ROW CURRENTLY STANDS IN, never one of the payments that made it up:
     *
     *   original_amount   — the obligation as it FINALLY stood (the revert has
     *                       already written that figure into `amount`, so this
     *                       is still literally "`amount` immediately before
     *                       payment");
     *   amount            — the SUM of every payment on the row;
     *   exchange_rate     — their ratio, so `amount = original_amount ×
     *                       exchange_rate` keeps holding.
     *
     * That identity survives only because a top-up is allowed ONLY in the
     * obligation's own currency — `settleByCompany` refuses anything else the
     * moment the accumulator is non-zero (AC8), precisely so this column can
     * never become an average of two rates that no single transfer was made
     * at. What the row no longer tells you is that there WERE two payments;
     * that provenance lives in `transaction_audit_log` (`CASCADE_REOPEN`,
     * `metadata.before`), written inside the money transaction.
     *
     * Two invariants, both testable:
     *   T1  amount = original_amount × exchange_rate
     *   T2  original_amount IS NOT NULL  ⟺  the row stands in its CLOSED form
     *
     * NULLABLE, NO DEFAULT, NO BACKFILL — deliberately. NULL reads as «this row
     * was never paid through the amount-aware flow», which is the literal truth
     * for every legacy row: their `amount` still means exactly what it always
     * meant, so there is nothing to migrate and every existing balance/metric
     * keeps returning the same number it returned before this column existed.
     * Since task 3b, NULL has a SECOND reading on a derivative row, and T2 tells
     * them apart by status rather than by guesswork: a cascade revert clears the
     * triplet, so a `PENDING_PAYMENT` row with a non-null `settled_amount` is
     * one that HAS been paid and is awaiting the remainder.
     *
     * ADD COLUMN DDL (prod is applied via deploy.yml — there is no SSH; see
     * apps/api/drizzle/manual/2026-08-05_salary_paid_amount.sql):
     *   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS original_amount numeric(18,6);
     *   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS original_currency currency;
     *   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS exchange_rate numeric(18,8);
     */
    originalAmount: numeric('original_amount', { precision: 18, scale: 6 }),
    originalCurrency: currencyEnum('original_currency'),
    exchangeRate: numeric('exchange_rate', { precision: 18, scale: 8 }),
    // Sender: real user or null (use senderLabel for named non-user entities)
    senderId: uuid('sender_id').references(() => users.id, { onDelete: 'set null' }),
    // "CheekyCheeseIT", "Project: Acme Corp", expense category, etc.
    senderLabel: varchar('sender_label', { length: 255 }),
    // Receiver: real user or null
    receiverId: uuid('receiver_id').references(() => users.id, { onDelete: 'set null' }),
    receiverLabel: varchar('receiver_label', { length: 255 }),
    // Drop role - phase 2. Optional, nullable explicit recipient reference for
    // transactions whose intended payee is NOT the same as receiverId (e.g.
    // PAYOUT_DROP semantics — receiverId = DROP user, recipientId = DROP user;
    // future-friendly for transactions that need a 3rd-party FK).
    // For backward compatibility every existing row keeps NULL.
    // FK ON DELETE SET NULL: keeps audit trail intact if a referenced user is
    // hard-deleted (we soft-delete via archivedAt — this is defensive).
    recipientId: uuid('recipient_id').references(() => users.id, { onDelete: 'set null' }),
    // Project this income/payout is associated with
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    // For PAYOUT / PAYOUT_ADMIN: links to the payout_request that triggered them
    payoutRequestId: uuid('payout_request_id').references(() => payoutRequests.id, {
      onDelete: 'set null',
    }),
    /**
     * security-review PR #443 (MED-B): a POSITIVE, permanent origin marker for
     * a DROP_PENDING_PAYOUT / PAYOUT_DROP row — true ⟺ this row's drop-share
     * IOU was booked by the drop-payout CASCADE (applyPayoutPaidCascade), i.e.
     * its money NEVER touched the shared company account (only `payable =
     * income*(1-dropShare%)` did — the drop keeps their own cut before the
     * on-chain transfer). `false` for an admin-USDT-declaration-booked drop
     * IOU (declareUsdtProjectIncome).
     *
     * CORRECTION (round 5): `false` is a cascade-vs-declaration discriminator,
     * NOT a "the company account holds this money" guarantee.
     * declareUsdtProjectIncome can route a declared income to a SPECIFIC
     * admin's personal wallet instead of the shared pool
     * (`toCompanyPool=false`) — the obligations it books still get `false`
     * here even though the company pool never received that income either.
     * Which pot actually pays is decided at SETTLE time by the ADMIN/
     * ACCOUNTANT's funding-source choice (COMPANY_ACCOUNT vs ADMIN_PERSONAL —
     * see settleByCompany, pending-settlement.service.ts), same as the
     * analogous senior-obligation case. This column only rules out the ONE
     * scenario where the money is PROVABLY never in the pool (the drop-
     * payout self-service cascade); it does not prove the opposite.
     *
     * WHY a dedicated column instead of `payoutRequestId IS NOT NULL`: that FK
     * is `ON DELETE SET NULL` — a future cleanup of an unrelated
     * `payout_requests` row would silently null it, and the settleByCompany
     * HIGH-1 funding-source guard (pending-settlement.service.ts) would then
     * fail OPEN (a cascade-originated row would look indistinguishable from an
     * admin-declared one and wrongly allow a COMPANY_ACCOUNT-funded settle —
     * debiting money the company never received). This column is stamped ONCE
     * at INSERT time (bookCompanyObligations, transactions.service.ts) from
     * the CALLER's intent, not derived from `payoutRequestId` afterwards —
     * later FK activity on `payout_requests` can never touch it. The backfill
     * script (`2026-07-27_drop_share_pending_parity_backfill.sql`) stamps the
     * SAME marker on the historical rows it converts, for the identical reason.
     *
     * NULLABLE, NO DEFAULT (security-review PR #443 round 3, LOW): a
     * `NOT NULL DEFAULT false` column cannot distinguish "explicitly verified
     * non-cascade" from "nobody ever set this" — an unrelated FUTURE insert
     * path for a DROP_PENDING_PAYOUT row that forgets to stamp this field
     * would silently inherit the PERMISSIVE default (`false`, "safe to settle
     * from the company account") rather than failing loudly. Left nullable
     * instead: `NULL` = unknown/unset, and the settleByCompany guard below
     * treats `!== false` (i.e. `true` OR `null`) as BLOCK — only an EXPLICIT
     * `false` (stamped by bookCompanyObligations for the admin-declared path)
     * allows a COMPANY_ACCOUNT settle. A silently-forgotten stamp therefore
     * fails SAFE (blocks) instead of failing OPEN. Not made `NOT NULL` outright
     * (which would force every OTHER transaction type's insert call site —
     * SALARY, EXPENSE, ADMIN_INCOME, COMPANY_DEPOSIT, …, none of which this
     * column is meaningful for — to explicitly pass a value, and would need a
     * backfill migration for existing rows) — that cost is disproportionate to
     * a column only `DROP_PENDING_PAYOUT`/`PAYOUT_DROP` rows ever read.
     *
     * ADD COLUMN DDL (apply to dev/prod manually before deploy — same
     * additive-push pattern as `idempotencyKey` above):
     *   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS drop_cascade_origin boolean;
     */
    dropCascadeOrigin: boolean('drop_cascade_origin'),
    // Snapshot of senior share percent at time of SENIOR_INCOME creation
    seniorSharePercent: integer('senior_share_percent'),
    // task-team-senior-share-override. Snapshot of *where* the percent above
    // came from at creation time. One of 'PROJECT' | 'TEAM' | 'USER_DEFAULT'.
    // Nullable to keep legacy rows (pre-task) renderable as-is. The hierarchy
    // resolved here is: project override → team override → user default.
    seniorSharePercentSource: varchar('senior_share_percent_source', { length: 16 }),
    // task-drop-share-override-and-receiver (Part A). Snapshot of the DROP share
    // percent at DROP_INCOME / DROP_PENDING_PAYOUT creation time — makes the
    // distribution deterministic (changing users.dropSharePercent later does not
    // retroactively re-price existing rows). Nullable — only drop-flow rows
    // carry it; legacy DROP_INCOME rows (pre-task) fall back to the resolver.
    dropSharePercent: integer('drop_share_percent'),
    // Snapshot source for the percent above — 'PROJECT' | 'USER_DEFAULT' (no
    // team level for the drop). Nullable for legacy / non-drop rows.
    dropSharePercentSource: varchar('drop_share_percent_source', { length: 16 }),
    /**
     * task-settled-amount-snapshot (Task 1 of the paid-transaction-edit-cascade
     * decomposition — docs/architecture/2026-08-22-paid-transaction-edit-cascade.md,
     * AC3 "Где хранится «сколько уже выплачено»"). Three columns, written together
     * by `PendingSettlementService.settleByCompany` at the SAME PENDING_PAYMENT →
     * PAID flip that nulls `seniorSharePercent`/`dropSharePercent` above.
     *
     * WHY THIS EXISTS. Once an edit to the source income can return an already-
     * PAID derivative to PENDING for re-confirmation (a LATER task in this same
     * decomposition), the UI needs "how much of this obligation is already
     * paid" — and today there is nowhere to read that number from:
     *   - `seniorSharePercent`/`dropSharePercent` are DELIBERATELY nulled on
     *     every settle (see the CRITICAL comment above) — the one place that
     *     would need the percent to recompute a share has it erased.
     *   - `transaction_audit_log`'s `PAY` entry is best-effort, written AFTER
     *     the settle transaction commits, and its own failure is only logged
     *     (see `settleByCompany`'s fire-and-forget audit insert) — a log that
     *     can silently miss a real payment is not a source for money.
     *   - `pending_obligations` stores the OBLIGATION amount, never "how much
     *     of it has been closed" — closure is modelled wholesale via `status`
     *     + `closingTransactionId`; there is no partial-payment concept there.
     *
     *   settled_amount        — MONOTONIC accumulator: the sum of every actual
     *                            payout this ROW has ever settled. Increments on
     *                            every settle, NEVER decreases, NEVER gets
     *                            overwritten. "К доплате" (amount still owed) is
     *                            deliberately NOT stored — it is the derived
     *                            `amount − settled_amount`, computed by a reader.
     *                            Storing the difference instead would go stale
     *                            the instant `amount` is edited again, which is
     *                            exactly the problem this column exists to avoid
     *                            — the SAME "store the immutable member, derive
     *                            the mutable one" contract `originalAmount`/
     *                            `exchangeRate` above already use on this row.
     *   settled_currency       — the currency of the settle(s) accumulated into
     *                            `settled_amount`. A SEPARATE column, not an
     *                            assumption that it always matches the
     *                            obligation's own USDT currency: a DROP
     *                            obligation can be settled in a different
     *                            currency — `settleByCompany` writes `amount` =
     *                            the FACT in the payment currency (see the
     *                            DROP-only amount-conversion block below). One
     *                            number with no currency label would already be
     *                            a wrong answer.
     *   settled_share_percent  — a snapshot of whichever of
     *                            `seniorSharePercent`/`dropSharePercent` was on
     *                            this row immediately BEFORE this settle nulled
     *                            it — written to its OWN column instead of
     *                            being lost, so a future cascade can recompute
     *                            a share after the row returns to PENDING.
     *                            Overwritten fresh on every settle (unlike
     *                            `settled_amount`, this one is NOT accumulated
     *                            — only the most recent percent is meaningful).
     *
     * There is no READER of these three columns yet — the cascade that returns
     * a derivative to PENDING and needs "already paid" to show a diff is a
     * LATER task in the same decomposition (2-3). This task is pure
     * infrastructure: write only, and that is by design (see the task file).
     *
     * NULLABLE, NO DEFAULT, NO BACKFILL — same contract as `originalAmount`/
     * `sourceIncomeTransactionId` above: `NULL` reads as "this row never went
     * through the settle-snapshot mechanism", which is the literal truth for
     * every row created before this column existed AND every row that has
     * never been settled at all.
     *
     * ADD COLUMN DDL (prod is applied via deploy.yml — there is no SSH; see
     * apps/api/drizzle/manual/2026-08-22_settled_amount_snapshot.sql):
     *   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS settled_amount numeric(18,6);
     *   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS settled_currency currency;
     *   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS settled_share_percent integer;
     */
    settledAmount: numeric('settled_amount', { precision: 18, scale: 6 }),
    settledCurrency: currencyEnum('settled_currency'),
    settledSharePercent: integer('settled_share_percent'),
    /**
     * task-admin-income-drop-backfill (2026-08-12). Links a SENIOR_PENDING_PAYOUT
     * / DROP_PENDING_PAYOUT obligation row back to the ADMIN_INCOME (or other
     * admin-USDT declaration) transaction it was booked FROM, when known.
     *
     * WHY THIS EXISTS. Before this column, "does this income already have a
     * booked share?" could only be answered by matching project + amount +
     * time — good enough to browse, not good enough to move real money on.
     * `createAdminIncome` never called `bookCompanyObligations` (the historical
     * bug this task's data-fix backfills — see
     * apps/api/drizzle/manual/2026-08-12_admin_income_drop_backfill_*.sql), so a
     * project can carry ADMIN_INCOME rows with zero, one, or several
     * DROP_PENDING_PAYOUT rows and no reliable way to tell which income each one
     * covers. This column makes that link explicit and queryable.
     *
     * Stamped ONCE, by `bookCompanyObligations`, on BOTH the senior and the drop
     * IOU it books — set to the id of the income row that caused the booking,
     * when the caller knows it. `declareUsdtProjectIncome` always does (it is
     * the ADMIN_INCOME row it just inserted, in the SAME db transaction).
     * `applyPayoutPaidCascade` deliberately does NOT pass it: that call books
     * ONE obligation per payout REQUEST, which can aggregate several linked
     * SENIOR_INCOME/DROP_INCOME rows behind a single `payoutRequestId` — there
     * is no single source income to name, and `payoutRequestId` +
     * `dropCascadeOrigin` already discriminate that origin. NULL there is the
     * honest answer, not a gap.
     *
     * NULLABLE, NO DEFAULT, NO BACKFILL of the column itself (the DATA backfill
     * for historical rows is a separate, explicit two-deploy SQL pair — see the
     * files named above) — every row created before this column existed keeps
     * NULL forever. That is the literal truth: their origin was genuinely never
     * recorded, and inventing one after the fact is guessing, not data.
     *
     * Self-referencing FK, ON DELETE SET NULL — a (hypothetical, ADMIN-only)
     * hard-delete of the source income never blocks or cascades into the
     * obligation it produced; the obligation itself is truth about money owed
     * regardless of what later happens to its origin's audit trail.
     *
     * ADD COLUMN DDL (prod is applied via deploy.yml — there is no SSH; see
     * apps/api/drizzle/manual/2026-08-12_admin_income_drop_backfill_column.sql):
     *   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source_income_transaction_id uuid
     *     REFERENCES transactions(id) ON DELETE SET NULL;
     *
     * security-review round 2 (PR #517, MED-F): the backfill script's own
     * SELECT predicate ("not already linked") is a read-then-write guard —
     * correct for a single sequential run, but NOT a structural defence
     * against two overlapping `apply.sql` executions (a manual re-run
     * triggered while a prior one is still in flight). The partial unique
     * index below converts that guarantee from "predicate, hopefully
     * evaluated once" into "the database physically refuses a second
     * DROP_PENDING_PAYOUT/PAYOUT_DROP row for the same source income" — a
     * genuine concurrent race hits 23505 instead of silently double-booking.
     * Scoped to the drop-share row types (not senior) because those are the
     * ONLY types this backfill ever creates; a co-existing
     * SENIOR_PENDING_PAYOUT row for the SAME income (created by the SAME
     * `bookCompanyObligations` call, same `sourceIncomeTransactionId`) is a
     * different `type` value and therefore outside this partial index's row
     * set — no conflict with the normal declare flow, which always books
     * both in one call. See `uq_transactions_admin_income_idempotency_key`
     * above for the sibling pattern this mirrors.
     *
     * ADD INDEX DDL — same file as the column above:
     *   CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_source_income_drop_link
     *     ON transactions (source_income_transaction_id)
     *     WHERE type IN ('DROP_PENDING_PAYOUT', 'PAYOUT_DROP')
     *       AND source_income_transaction_id IS NOT NULL;
     */
    sourceIncomeTransactionId: uuid('source_income_transaction_id').references(
      (): AnyPgColumn => transactions.id,
      { onDelete: 'set null' },
    ),
    /**
     * task-drop-sees-own-obligations (security-review PR #523 round 1, MED-4).
     * Snapshot of `projects.companyName` at the moment `bookCompanyObligations`
     * books a SENIOR_PENDING_PAYOUT / DROP_PENDING_PAYOUT IOU row — the same
     * "snapshot at creation, never re-derived" contract `dropSharePercent` /
     * `seniorSharePercent` already use above, applied to the display name
     * instead of a money figure.
     *
     * WHY THIS EXISTS. `getDropSelfIncomes` (the drop's own incomes feed)
     * resolves an obligation row's `companyName` by joining the LIVE
     * `projects` row (`senderLabel` on these rows is always the literal
     * 'COMPANY' marker other code branches on — see transactions.service.ts
     * `findAll`'s `sideLabel === 'COMPANY'` check and TransactionRow.tsx's
     * matching branch — so it can never carry the real company name the way
     * `createDropIncome`'s `senderLabel` already does for the OLD
     * self-declared model). A live join means renaming the project later
     * silently rewrites what a drop reads as history for money already
     * booked under the OLD name — the one thing a money-history view must
     * never do. This column is the fix: read once, frozen forever, exactly
     * like every other snapshot column on this row.
     *
     * NULLABLE, NO BACKFILL — every DROP_PENDING_PAYOUT/PAYOUT_DROP row
     * created before this column existed keeps NULL; `getDropSelfIncomes`
     * falls back to the live `projects` join for those (§AC — same fallback
     * `companyName` behaviour it always had, only for rows genuinely
     * created before a snapshot was possible to take).
     *
     * ADD COLUMN DDL (prod is applied via deploy.yml — there is no SSH; see
     * apps/api/drizzle/manual/2026-08-12_drop_obligation_company_name_snapshot.sql):
     *   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS company_name_snapshot varchar(255);
     */
    companyNameSnapshot: varchar('company_name_snapshot', { length: 255 }),
    // Receipt — uploaded file (FK to documents.id, category=RECEIPT) OR an
    // external URL (etherscan link, screenshot). Mutually exclusive — enforced
    // by a row-level CHECK constraint, see migration 0013. Both NULL = no
    // receipt attached.
    receiptDocumentId: uuid('receipt_document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),
    receiptExternalUrl: text('receipt_external_url'),
    // FK to documents (category = INVOICE). Points at the currently-active
    // signed/pending invoice PDF for this transaction. ON DELETE SET NULL so
    // hard-deleting an invoice document leaves the transaction intact but
    // marks it as having no active invoice attached (a fresh one can be
    // regenerated by ADMIN). Populated only for SENIOR_INCOME (after payout
    // submission) and SALARY (after status → PAID). Other transaction types
    // never have invoices.
    invoiceDocumentId: uuid('invoice_document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),
    // Blockchain TX hash (for PAYOUT, PAYOUT_ADMIN, COMPANY_DEPOSIT)
    txHash: varchar('tx_hash', { length: 255 }),
    // task-onchain-payment-integrity. On-chain SENDER of that transfer
    // (ERC-20 `topics[1]`, tx-level `from` as fallback), lowercase. Same
    // OBSERVED-NOT-ENFORCED contract as `payout_requests.tx_from_address` —
    // recorded for ADMIN/ACCOUNTANT audit, never a credit gate (exchange
    // withdrawals legitimately show the exchange's wallet). NULL wherever no
    // on-chain sender was resolved.
    txFromAddress: varchar('tx_from_address', { length: 42 }),
    // task-company-account-backend. Funding source of a SALARY row:
    //   'COMPANY_ACCOUNT' — paid from the shared company USDT account (debits
    //                       its derived balance); always USDT.
    //   'ADMIN_PERSONAL'  — paid from an admin partner's personal account; does
    //                       NOT touch the company balance.
    // NULL on every non-SALARY row (and on legacy SALARY rows, treated as
    // admin-personal for balance purposes). varchar (not a pg enum) to keep the
    // additive migration push-friendly and the nullable semantics simple.
    fundingSource: varchar('funding_source', { length: 16 }),
    /**
     * Client-supplied idempotency key. SHARED across FIVE idempotent flows —
     * one nullable column, one key namespace, guarded by five DISJOINT partial
     * unique indexes (one per `type`):
     *   - BIZ-19 (MED-2): DIVIDEND_TO_ADMIN (createDividend).
     *   - PR #367 (MED-1): ADMIN_INCOME    (declareUsdtProjectIncome).
     *   - backlog 73/A-3: SENIOR_INCOME    (createSeniorIncome).
     *   - backlog 73/A-3: DROP_INCOME      (createDropIncome).
     *   - multipart salary: SALARY          (createSalary).
     * The caller generates a UUID and passes it on the first request; a
     * subsequent request with the same key returns the existing row (no-op).
     * NULL for all other rows and historical salary rows created before the
     * manual-salary idempotency contract became mandatory.
     *
     * ADD COLUMN + INDEX DDL (apply to dev/prod manually before deploy):
     *   ALTER TABLE transactions ADD COLUMN idempotency_key uuid;
     *   CREATE UNIQUE INDEX uq_transactions_dividend_idempotency_key
     *     ON transactions (idempotency_key)
     *     WHERE type = 'DIVIDEND_TO_ADMIN' AND idempotency_key IS NOT NULL;
     *   CREATE UNIQUE INDEX uq_transactions_admin_income_idempotency_key
     *     ON transactions (idempotency_key)
     *     WHERE type = 'ADMIN_INCOME' AND idempotency_key IS NOT NULL;
     *   CREATE UNIQUE INDEX uq_transactions_senior_income_idempotency_key
     *     ON transactions (idempotency_key)
     *     WHERE type = 'SENIOR_INCOME' AND idempotency_key IS NOT NULL;
     *   CREATE UNIQUE INDEX uq_transactions_drop_income_idempotency_key
     *     ON transactions (idempotency_key)
     *     WHERE type = 'DROP_INCOME' AND idempotency_key IS NOT NULL;
     */
    idempotencyKey: uuid('idempotency_key'),
    // Accountant/admin validation fields (for SENIOR_INCOME)
    validatedBy: uuid('validated_by').references(() => users.id, { onDelete: 'set null' }),
    validatedAt: timestamp('validated_at', { withTimezone: true }),
    rejectionReason: varchar('rejection_reason', { length: 500 }),
    notes: varchar('notes', { length: 1000 }),
    // Calendar month this transaction belongs to (for SALARY/LOCKED logic): YYYY-MM
    salaryMonth: varchar('salary_month', { length: 7 }),
    // A SALARY row is one concrete salary part. Manual and cron-created parts
    // may coexist for the same employee/month; NULL identifies legacy rows.
    salaryOrigin: varchar('salary_origin', { length: 8 }),
    // Immutable meaning of a manual salary idempotency key. Historical rows
    // remain NULL and are treated as unverifiable legacy retries.
    salaryCreationIntent: jsonb('salary_creation_intent').$type<{
      version: 1
      operation: 'MANUAL_SALARY_CREATE'
      receiverId: string
      amount: string
      currency: 'USDT' | 'USD' | 'EUR' | 'UAH'
      salaryMonth: string
      notes: string | null
      txDate: string | 'AUTO'
    }>(),
    // User-specified transaction date (defaults to creation time if not provided)
    txDate: timestamp('tx_date', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    /**
     * task-soft-delete-and-money-audit (security-audit finding 3, 27.07).
     * Soft-delete triple — `adminDeleteTransaction` now marks a row instead of
     * physically removing it (`DELETE FROM transactions` is gone). All three
     * are NULL on an active row and set together at delete time, cleared
     * together at restore time (`restoreTransaction`, ADMIN-only).
     *
     * Visibility (owner requirement, 27.07): a deleted row is visible ONLY to
     * ADMIN/ACCOUNTANT, and even then hidden from the default list — see the
     * `TransactionsService.findAll` `includeDeleted` toggle. Every other role
     * gets a 404 (never 403) both in the list and on a direct `GET
     * /transactions/:id` — a 403 would leak that the row exists.
     *
     * ON DELETE SET NULL on `deletedBy` (not RESTRICT/CASCADE): keeps the
     * deleted row's audit trail intact even if the deleting ADMIN's user row
     * is later removed — mirrors `validatedBy`/`createdBy` above.
     *
     * ADD COLUMN + INDEX DDL (apply to dev/prod manually before deploy — same
     * additive-push pattern as `idempotencyKey` above; migration file:
     * apps/api/drizzle/manual/2026-08-01_transaction_soft_delete.sql):
     *   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
     *   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS deleted_by uuid
     *     REFERENCES users(id) ON DELETE SET NULL;
     *   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS deletion_reason varchar(500);
     *   CREATE INDEX IF NOT EXISTS idx_transactions_active_created_at
     *     ON transactions (created_at) WHERE deleted_at IS NULL;
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    deletionReason: varchar('deletion_reason', { length: 500 }),
  },
  (t) => [
    // task-soft-delete-and-money-audit: supports the `WHERE deleted_at IS
    // NULL` predicate every hot read (findAll default list, every balance /
    // summary aggregate) now carries. Partial so the index stays small — it
    // never needs to cover the (presumably rare) deleted rows.
    index('idx_transactions_active_created_at')
      .on(t.createdAt)
      .where(sql`${t.deletedAt} IS NULL`),
    // PR-3: 1:1 receipt ↔ income invariant — one receipt document can be linked
    // to at most one transaction. Partial index (WHERE IS NOT NULL) so that
    // multiple transactions with no receipt (NULL) are still allowed.
    uniqueIndex('uq_transactions_receipt_document_id')
      .on(t.receiptDocumentId)
      .where(sql`${t.receiptDocumentId} IS NOT NULL`),
    // task-company-account-backend. Idempotency for company deposits: a given
    // on-chain txHash can be submitted at most once as a COMPANY_DEPOSIT. Partial
    // (WHERE type='COMPANY_DEPOSIT') so PAYOUT/PAYOUT_ADMIN rows that legitimately
    // reuse a hash (e.g. simulate stubs) are unaffected. A duplicate submit hits
    // this constraint OR is short-circuited by the service's lookup-first guard.
    uniqueIndex('uq_transactions_company_deposit_tx_hash')
      .on(t.txHash)
      .where(sql`${t.type} = 'COMPANY_DEPOSIT' AND ${t.txHash} IS NOT NULL`),
    // Several salary parts for one employee/month are legitimate. Cron
    // idempotency is owned by salary_month_initializations below.
    index('idx_transactions_salary_receiver_month')
      .on(t.receiverId, t.salaryMonth)
      .where(sql`${t.type} = 'SALARY' AND ${t.salaryMonth} IS NOT NULL`),
    // BIZ-19: idempotency key for DIVIDEND_TO_ADMIN. Client supplies a UUID;
    // the DB enforces that the same key cannot produce two dividend rows.
    // Partial (WHERE type='DIVIDEND_TO_ADMIN' AND idempotency_key IS NOT NULL)
    // so all other transaction types and keyless dividends are unaffected.
    uniqueIndex('uq_transactions_dividend_idempotency_key')
      .on(t.idempotencyKey)
      .where(sql`${t.type} = 'DIVIDEND_TO_ADMIN' AND ${t.idempotencyKey} IS NOT NULL`),
    // PR #367 (MED-1): idempotency key for ADMIN_INCOME (declareUsdtProjectIncome).
    // Last-line-of-defence backstop for a double-submitted admin-USDT income —
    // the service's early-SELECT short-circuits the common replay; two truly
    // concurrent submits that both miss it collide here (23505) instead of
    // creating two incomes + two obligation sets. Partial + type-scoped so it is
    // DISJOINT from the dividend index above (same column, different type) and
    // leaves every other transaction type and keyless row untouched.
    uniqueIndex('uq_transactions_admin_income_idempotency_key')
      .on(t.idempotencyKey)
      .where(sql`${t.type} = 'ADMIN_INCOME' AND ${t.idempotencyKey} IS NOT NULL`),
    // backlog 73/A-3: idempotency key for SENIOR_INCOME (createSeniorIncome).
    // Same 1:1 copy of the ADMIN_INCOME contract above — a double-click / retry
    // that slips past the service's early-SELECT collides here (23505) instead
    // of creating a second SENIOR_INCOME row, which would otherwise book a
    // second company obligation for the same piece of work once the payout
    // reaches validation. Partial + type-scoped so it stays DISJOINT from every
    // other index on this shared column.
    // mutation-gate closure: senior-drop-income-idempotency-schema.spec.ts
    // pins BOTH this index's name and its WHERE clause against the prod
    // migration file's literal DDL (same pattern as
    // source-income-drop-link-schema.spec.ts) — no Stryker suppression
    // needed here, unlike the DB-only-testable columns elsewhere in this file.
    uniqueIndex('uq_transactions_senior_income_idempotency_key')
      .on(t.idempotencyKey)
      .where(sql`${t.type} = 'SENIOR_INCOME' AND ${t.idempotencyKey} IS NOT NULL`),
    // backlog 73/A-3: idempotency key for DROP_INCOME (createDropIncome). Same
    // contract as the SENIOR_INCOME index directly above, mirrored onto the
    // DROP role's own income-declaration path. Same mutation-gate closure —
    // senior-drop-income-idempotency-schema.spec.ts.
    uniqueIndex('uq_transactions_drop_income_idempotency_key')
      .on(t.idempotencyKey)
      .where(sql`${t.type} = 'DROP_INCOME' AND ${t.idempotencyKey} IS NOT NULL`),
    // Multipart salary: an idempotency key names one manual salary-part intent.
    // Two equal-looking parts with DIFFERENT keys remain legal; retrying the
    // SAME intent (including a concurrent retry) cannot create a second row.
    // Historical keyless rows remain valid; new MANUAL rows are covered by
    // the CHECK below and must carry a key.
    uniqueIndex('uq_transactions_salary_idempotency_key')
      .on(t.idempotencyKey)
      .where(sql`${t.type} = 'SALARY' AND ${t.idempotencyKey} IS NOT NULL`),
    // New manual salary parts must always carry an idempotency key. Legacy
    // rows remain valid because they have salary_origin NULL; cron-owned rows
    // use CRON and intentionally do not need a client intent key.
    check(
      'ck_transactions_manual_salary_idempotency_key',
      sql`${t.type} <> 'SALARY' OR ${t.salaryOrigin} IS DISTINCT FROM 'MANUAL' OR ${t.idempotencyKey} IS NOT NULL`,
    ),
    // security-review round 2 (PR #517, MED-F) — structural race guard for the
    // admin-income-drop-backfill apply script. See the doc comment on
    // `sourceIncomeTransactionId` above for the full reasoning: at most one
    // DROP_PENDING_PAYOUT/PAYOUT_DROP row may ever carry a given
    // `source_income_transaction_id` — a concurrent second `apply.sql` run
    // hits 23505 instead of double-booking a drop's share.
    uniqueIndex('uq_transactions_source_income_drop_link')
      .on(t.sourceIncomeTransactionId)
      .where(
        sql`${t.type} IN ('DROP_PENDING_PAYOUT', 'PAYOUT_DROP') AND ${t.sourceIncomeTransactionId} IS NOT NULL`,
      ),
    // task-sender-receiver-invariant (backlog A-2). Nothing anywhere used to
    // forbid a row that pays a user to themselves — no DB CHECK, no Zod
    // `.refine`, no service-layer check. The system was intact only because
    // the one write path that could produce such a row (the pre-obligations
    // legacy cascade) was deleted; `bookCompanyObligations` simply never
    // fills `senderId` for the obligation rows it writes. A self-paying row
    // has already happened once in prod (a deleted-path artifact) and cost a
    // real investigation before an owner decision could say which of two
    // disagreeing readers was right.
    //
    // `<>` (NOT `IS DISTINCT FROM`) is deliberate and verified by hand on a
    // scratch DB (see the task file / PR body for the four-case proof), not
    // assumed: SQL's three-valued logic makes `x <> y` evaluate to NULL (not
    // FALSE) whenever either side is NULL, and CHECK only rejects an
    // explicit FALSE — so a row with one or both sides empty still passes.
    // `sender_id IS DISTINCT FROM receiver_id` looks like the "safe" NULL-aware
    // choice but is actually wrong here: `NULL IS DISTINCT FROM NULL` is FALSE,
    // so that variant would reject every legitimate both-NULL row (senderLabel-
    // only company rows, obligation rows with no senderId, etc — there are many).
    //
    // ADD CONSTRAINT DDL (prod is applied via deploy.yml — there is no SSH; see
    // apps/api/drizzle/manual/2026-08-18_sender_receiver_invariant.sql):
    //   ALTER TABLE transactions ADD CONSTRAINT ck_transactions_sender_ne_receiver
    //     CHECK (sender_id <> receiver_id);
    check('ck_transactions_sender_ne_receiver', sql`${t.senderId} <> ${t.receiverId}`),
  ],
)

export const transactionsRelations = relations(transactions, ({ one, many }) => ({
  sender: one(users, {
    fields: [transactions.senderId],
    references: [users.id],
    relationName: 'sentTransactions',
  }),
  receiver: one(users, {
    fields: [transactions.receiverId],
    references: [users.id],
    relationName: 'receivedTransactions',
  }),
  validator: one(users, {
    fields: [transactions.validatedBy],
    references: [users.id],
    relationName: 'validatedTransactions',
  }),
  creator: one(users, {
    fields: [transactions.createdBy],
    references: [users.id],
    relationName: 'createdTransactions',
  }),
  project: one(projects, { fields: [transactions.projectId], references: [projects.id] }),
  payoutRequest: one(payoutRequests, {
    fields: [transactions.payoutRequestId],
    references: [payoutRequests.id],
  }),
  receiptDocument: one(documents, {
    fields: [transactions.receiptDocumentId],
    references: [documents.id],
  }),
  invoiceDocument: one(documents, {
    fields: [transactions.invoiceDocumentId],
    references: [documents.id],
    relationName: 'invoiceDocument',
  }),
  signatures: many(invoiceSignatures),
}))

export type Transaction = typeof transactions.$inferSelect

export type NewTransaction = typeof transactions.$inferInsert
