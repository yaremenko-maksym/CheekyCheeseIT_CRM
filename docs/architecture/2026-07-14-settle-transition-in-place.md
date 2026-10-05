# ADR 2026-07-14 — In-place transition of the "Expected payout to drop/senior" obligation PENDING_PAYMENT → PAID

## Status

**Proposed** (implementation — AFTER the merge of PR #374; see §Conflict window). Requires user approval before start.

---

## Context

### Symptom (owner's report from prod)

Closing the "Expected payout to the drop" / "Senior's share" obligation (the "Pay out" button on a
`SENIOR_PENDING_PAYOUT` / `DROP_PENDING_PAYOUT` row) **creates a second transaction** instead of changing the
status of the first. The original IOU-row meanwhile **hangs forever** in the status `PENDING_PAYMENT`
("Awaiting payout"), and a separate `SENIOR_INCOME` / `PAYOUT_DROP` (PAID) appears next to it.

The owner's requirement: the obligation **must not disappear** and **must not spawn a second
transaction** — it should change the status `PENDING_PAYMENT → PAID` **in place (in-place)**.

### How it works now (verified by the code)

**Booking of the obligation** — `TransactionsService.bookCompanyObligations`
(`apps/api/src/finance/transactions.service.ts:2702`). Called from TWO places:

1. `declareUsdtProjectIncome` (`:1199`) — ADMIN declares a USDT income → `ADMIN_INCOME`(PAID) +
   a senior IOU (`SENIOR_PENDING_PAYOUT`) + a drop IOU (`DROP_PENDING_PAYOUT`).
2. `applyPayoutPaidCascade`, the drop branch (`:3115`) — a drop-payout payment → a direct `PAYOUT_DROP`
   (the drop's share) + a senior IOU (`SENIOR_PENDING_PAYOUT`); a drop IOU is NOT created here (`drop:null`).

Each IOU: `type ∈ {SENIOR_PENDING_PAYOUT, DROP_PENDING_PAYOUT}`, `status=PENDING_PAYMENT`,
`currency=USDT`, `senderLabel='COMPANY'`, `receiverId=creditor`, `fundingSource=null`, plus a row
`pending_obligations` (`debtorType='COMPANY'`, `sourceTransactionId → the IOU tx`, `status='PENDING'`).

**Settle** — `PendingSettlementService.settleByCompany`
(`apps/api/src/finance/pending-settlement.service.ts:246`):

1. A **conditional UPDATE** `pending_obligations` `PENDING → PAID` `WHERE status='PENDING'` `.returning()`
   — an atomic TOCTOU guard against a double click (the single source of truth against the race; there is no
   reserve in the form of a unique index on this transition). **← an invariant, must not break.**
2. If company-funded + a COMPANY debt: `pg_advisory_xact_lock` + a re-read of the balance + a refusal to drive the account
   negative. **← an invariant.**
3. **An INSERT of a new transaction**: `type = isDropObligation ? 'PAYOUT_DROP' : 'SENIOR_INCOME'`,
   `status=PAID`, `fundingSource = COMPANY_ACCOUNT` marker (if company-funded), sender/currency by
   the funding choice. **← this is the "second row".**
4. Backfill `pending_obligations.closingTransactionId → <the id of the new row>`.
5. Post-commit (outside the transaction): `autoCreateForSeniorPayout(<SENIOR_INCOME id>)`.

The original `*_PENDING_PAYOUT` row is **not touched** → the "Awaiting payout" phantom.

### Silo consumers of the created row (what exactly must not be broken)

| #   | Consumer                          | File                                                                | What it depends on today                                                                                                                                                                                                                                        |
| --- | --------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The company-account ledger        | `company-account-balance.ts:117`                                    | debit terms `SENIOR_INCOME(PAID, fundingSource=COMPANY_ACCOUNT, USDT)` and `PAYOUT_DROP(PAID, COMPANY_ACCOUNT, USDT)`                                                                                                                                           |
| 2   | The drop's balance                | `computeDropAggregate` (`transactions.service.ts:561`)              | `received = Σ PAYOUT_DROP(PAID, receiverId=drop)`; `sent = Σ PAYOUT_DROP(PAID, senderId=drop)`. C6: senderId≠drop → no double-count                                                                                                                             |
| 3   | The invoice to the senior         | `autoCreateForSeniorPayout` (`invoices.service.ts:142`)             | the gate `tx.type === 'SENIOR_INCOME'`                                                                                                                                                                                                                          |
| 4   | C4 totalIncome                    | `getSummary` (`transactions.service.ts:3315-3342`, monthly `:3463`) | `settlementTxIds = Set(pending_obligations.closingTransactionId)`; `SENIOR_INCOME` is counted in income **only if** `!settlementTxIds.has(id)`                                                                                                                  |
| 5   | ADMIN_PERSONAL vs COMPANY_ACCOUNT | settle §3                                                           | COMPANY: `senderId=null`, `senderLabel='COMPANY'`, `currency=USDT`, marker=`COMPANY_ACCOUNT`. ADMIN_PERSONAL: `senderId=admin`, `senderLabel=admin.displayName`, `currency∈{USD,USDT}`, marker=`null` (the debit is caught by `adminBalances.sent` by senderId) |

**Key observation.** All five consumers key on the **final form** of the row —
`(type=SENIOR_INCOME/PAYOUT_DROP) AND (status=PAID) AND (funding markers)`. The IOU type
(`*_PENDING_PAYOUT`) does not participate in any money term: not in the ledger, not in the drop aggregate, not in the
income filter C4. Therefore if we **rename the IOU-row itself to the final type on the flip**, the entire
chain of consumers keeps working without a single edit.

### DB schema / invariants (verified)

- `pending_obligations.sourceTransactionId` → `transactions.id`, **`onDelete: 'restrict'`**
  (cannot delete the IOU-row while an obligation references it).
- `pending_obligations.closingTransactionId` → `transactions.id`, `onDelete: 'set null'`.
- `uq_pending_obligations_source_pending` — a partial-unique on `sourceTransactionId` `WHERE status='PENDING'`
  (one PENDING obligation per source transaction; PAID/CANCELLED are not affected).
- `transaction_type` — a pgEnum without CHECK constraints on transitions: `UPDATE ... SET type=...` is allowed.

---

## Decision

### Recommended model: **change `type` on the flip** (Option A), NOT "type ∈ pending-set AND status=PAID" (Option B)

`settleByCompany` instead of an `INSERT` of a new row does an **`UPDATE` of the same IOU transaction**
(`sourceTransactionId`):

- `SENIOR_PENDING_PAYOUT → type='SENIOR_INCOME'`, `DROP_PENDING_PAYOUT → type='PAYOUT_DROP'`;
- `status: PENDING_PAYMENT → PAID`;
- stamps the funding fields exactly as it stamps the "second row" today: `fundingSource` (marker or null),
  `senderId`, `senderLabel`, `currency`, for the senior — `validatedBy/validatedAt`;
- `closingTransactionId := sourceTransactionId` (self-reference — the same row is the "closing" one);
- **`payoutRequestId := null`** (reset — see below, critical);
- we preserve the existing order: `resolveSource(...)` (reading the `sourceType` discriminator) —
  BEFORE the transaction; the TOCTOU claim on `pending_obligations` — first in the transaction; the flip of the IOU-row — after
  winning the claim.

**Confidence: HIGH.** The flipped row becomes **byte-for-byte equivalent** to today's "second
row" (the same `type` + `status` + funding markers), differing only in that it reuses the id
of the original IOU rather than allocating a new one. Therefore consumers §1-§5 do not require edits.

#### Why NOT Option B (keep `*_PENDING_PAYOUT`, tie everything to `type ∈ pending-set AND status=PAID`)

| Criterion                                          | Option A (change the type)          | Option B (keep the type + a dual predicate)                              |
| -------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| Edits in the ledger (`company-account-balance.ts`) | **0** (the terms already match)     | +2 new terms `*_PENDING_PAYOUT(PAID,COMPANY_ACCOUNT)`                    |
| Edits in `computeDropAggregate`                    | **0**                               | +a credit term `DROP_PENDING_PAYOUT(PAID,receiverId=drop)`               |
| Edits in `autoCreateForSeniorPayout`               | **0**                               | extend the gate to `SENIOR_PENDING_PAYOUT AND PAID`                      |
| Blast-radius (finance money-surface)               | 1 method                            | 3+ files, a new invariant "the dual predicate is consistent everywhere"  |
| Render of the row in the UI                        | `Senior income / Paid` (= as today) | `Expected payout to senior / Paid` (a strange pair, a relabel is needed) |
| Risk of a ledger-drift from a forgotten consumer   | low                                 | high (easy to miss one silo → a money discrepancy)                       |

Option A wins on all axes: the minimal blast-radius on the financial surface, zero new
duplicating invariant, the flipped row visually and semantically matches today's
settle-row. The battle-tested invariants (ledger terms, C6, the invoice gate, the C4 discriminator)
remain untouched. **Recommendation: Option A.**

#### Critical: reset `payoutRequestId := null` on the flip (Confidence: HIGH)

The IOU from the cascade branch (`:3115`) carries `payoutRequestId = requestId`. If not reset, the flipped
`SENIOR_INCOME` will keep this `payoutRequestId` and:

- will get into the `autoCreateForPayout` selection (aggregation of `SENIOR_INCOME/DROP_INCOME` by `payoutRequestId`);
- will match the `findOne` enrichment (`transactions.service.ts:938` — `SENIOR_INCOME AND payoutRequestId=X`
  for passing `seniorSharePercent` into the PAYOUT card).

Today's settle `SENIOR_INCOME` has `payoutRequestId=null` (settleByCompany does not set it).
The reset preserves the byte-identity and excludes a bleed into the income aggregation/enrichment. The audit link is not
lost: `pending_obligations.sourceTransactionId`/`closingTransactionId` + `notes` ("Payout of the
senior IOU (obligation X)") + `projectId` remain.

#### A deliberate cosmetic delta (not money)

The flipped row **preserves** `seniorSharePercent`/`dropSharePercent`(+`...Source`) from the IOU (today's
settle-row does not carry them). There are no money consumers of these snapshots on the settle-row
(`computeDropDistribution` reads the share from `DROP_INCOME`, not from the settle-row; the enrichment is cut off by the reset of
`payoutRequestId`). The effect — only a "Share: X%" badge. Recommendation: **preserve** (the data is correct);
document it as an intentional delta. Zeroing it is also acceptable — the Coder's choice, justify in the PR.

### Answers per consumer (Option A)

| #   | Consumer                                | How it changes under Option A                                                                                                                                                                                                                                                                                                                                                        |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **The ledger**                          | **Unchanged.** The flipped row — `SENIOR_INCOME`/`PAYOUT_DROP` with `fundingSource=COMPANY_ACCOUNT`,`currency=USDT` → it is caught by the EXISTING terms `companySeniorPayouts`/`companyDropPayouts`. The credit side (income `ADMIN_INCOME`/`PAYOUT` COMPANY_ACCOUNT) is not touched → the netting is identical. A new term is NOT needed.                                          |
| 2   | **The drop's balance**                  | **Unchanged.** The flip `DROP_PENDING_PAYOUT → PAYOUT_DROP` (receiverId=drop) → `received` is credited. C6 is intact: COMPANY-funded `senderId=null`; ADMIN_PERSONAL `senderId=admin` — both ≠ drop → not counted as `sent`. Before the flip `DROP_PENDING_PAYOUT` is invisible to the aggregate (all terms require `PAYOUT_DROP`) → no double-count.                                |
| 3   | **The invoice to the senior**           | **Unchanged in the invoice service.** The flipped row has `type='SENIOR_INCOME'` → `autoCreateForSeniorPayout(<its id>)` passes the gate. We trigger by the id of the flipped row (= sourceTransactionId). The drop flip (`PAYOUT_DROP`) does not trigger an invoice (Q6, as today).                                                                                                 |
| 4   | **C4 totalIncome**                      | **Unchanged in getSummary.** `closingTransactionId := sourceTransactionId` → the id of the flipped `SENIOR_INCOME` ∈ `settlementTxIds` → excluded from `totalIncome` and the monthly series (its gross is already counted as `DROP_INCOME`/`ADMIN_INCOME`). `PAYOUT_DROP` is not in the income filter at all.                                                                        |
| 5   | **ADMIN_PERSONAL vs COMPANY_ACCOUNT**   | The flip stamps the same funding fields as the "second row" today. COMPANY_ACCOUNT → a debit via the ledger term. ADMIN_PERSONAL → `senderId=admin`, marker=null → the debit is caught by `adminBalances.sent` (senderId=admin) in getSummary — **as today, byte-for-byte**. The ADMIN_PERSONAL currency guard (only USD/USDT, BIZ-03) is preserved.                                 |
| 6   | **Type vs status**                      | Recommendation — **change `type`** (rationale above).                                                                                                                                                                                                                                                                                                                                |
| 7   | **closingTransactionId + both sources** | `closingTransactionId := sourceTransactionId` (self). The fix lives in `settleByCompany`, which is called by BOTH IOU sources (declareUsdtProjectIncome `:1199` and applyPayoutPaidCascade `:3115`) via the same `pending_obligations` row and the same `settleByCompanySourceTransaction` → **both are automatically covered**. `bookCompanyObligations` (booking) does not change. |
| 8   | **Prod-data migration**                 | Needed (UX-cleanup of the existing "hung" pairs), NOT money-critical (the ledger is already correct). See §Data-fix.                                                                                                                                                                                                                                                                 |

### TOCTOU / idempotency (we do not break)

- The only race gate — the conditional UPDATE `pending_obligations` `PENDING → PAID .returning()`.
  It remains first in the transaction; the loser gets 0 rows → `throw` → rollback (the IOU flip does not
  happen). A double click is safe.
- The flip of the IOU-row goes AFTER winning the claim → it executes exactly once. Defense-in-depth (opt.):
  `UPDATE transactions ... WHERE id=sourceTx AND status='PENDING_PAYMENT'`.
- The company advisory-lock (`lockCompanyAccount`) + the balance-gate — unchanged, only for
  `debitsCompanyAccount`.
- `settleByCompanySourceTransaction` does not change (it delegates to `settleByCompany`).

---

## Data-fix (prod) — §8

### Is it needed: YES (UX), but NOT money-critical

On prod there are already "hung" pairs: the phantom `*_PENDING_PAYOUT`(PENDING_PAYMENT) + the settle-row
`SENIOR_INCOME`/`PAYOUT_DROP`(PAID), `pending_obligations.status=PAID`,
`closingTransactionId` points at the settle-row.

**The prod ledger is already correct**: the phantom `*_PENDING_PAYOUT` does not participate in any money term,
and a repeat settle is blocked (the obligation is already PAID → `settleByCompanySourceTransaction` finds
`WHERE status=PENDING` = null → 404). That is, the data-fix is **cosmetic** (remove the phantom "Awaiting
payout" rows + the "Pay out" button), not money. It can be run **after** the deploy, without a freeze.

### Target rows (an idempotent predicate)

Pairs where `pending_obligations.status='PAID'` AND `closingTransactionId IS NOT NULL` AND
`closingTransactionId <> sourceTransactionId` AND the row `sourceTransactionId` has
`type ∈ {SENIOR_PENDING_PAYOUT, DROP_PENDING_PAYOUT}` AND `status='PENDING_PAYMENT'`.
(Pairs already collapsed by the new code have `sourceTransactionId = closingTransactionId` → skipped →
idempotency.)

### Recommended script: repoint + delete the phantom (Confidence: MED)

Brings the old pairs to the new single-row model (`sourceTransactionId = closingTransactionId = the single row`):

```sql
-- Run in ONE transaction. First run as a SELECT (dry-run), reconcile the count.
BEGIN;

-- 0) DRY-RUN: how many phantoms will collapse (reconcile with the expected number of hung pairs).
SELECT o.id AS obligation_id, o.source_transaction_id AS phantom_id,
       o.closing_transaction_id AS settlement_id, src.type AS phantom_type
FROM pending_obligations o
JOIN transactions src ON src.id = o.source_transaction_id
WHERE o.status = 'PAID'
  AND o.closing_transaction_id IS NOT NULL
  AND o.closing_transaction_id <> o.source_transaction_id
  AND src.type IN ('SENIOR_PENDING_PAYOUT','DROP_PENDING_PAYOUT')
  AND src.status = 'PENDING_PAYMENT';

-- 1) Repoint: sourceTransactionId → the settlement-row (removes the FK restrict from the phantom;
--    the obligation is already PAID, so uq_pending_obligations_source_pending (WHERE PENDING) is not affected).
UPDATE pending_obligations o
SET source_transaction_id = o.closing_transaction_id, updated_at = now()
FROM transactions src
WHERE src.id = o.source_transaction_id
  AND o.status = 'PAID'
  AND o.closing_transaction_id IS NOT NULL
  AND o.closing_transaction_id <> o.source_transaction_id
  AND src.type IN ('SENIOR_PENDING_PAYOUT','DROP_PENDING_PAYOUT')
  AND src.status = 'PENDING_PAYMENT';

-- 2) Delete the phantom (after the repoint there are no incoming FKs to it: sourceTransactionId re-pointed,
--    closingTransactionId never pointed at the phantom, a PENDING IOU has no invoice/signature).
DELETE FROM transactions t
WHERE t.type IN ('SENIOR_PENDING_PAYOUT','DROP_PENDING_PAYOUT')
  AND t.status = 'PENDING_PAYMENT'
  AND NOT EXISTS (SELECT 1 FROM pending_obligations o WHERE o.source_transaction_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM pending_obligations o WHERE o.closing_transaction_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM invoice_signatures s WHERE s.transaction_id = t.id);

-- 3) Verification BEFORE COMMIT: 0 phantom PENDING_PAYMENT IOUs for closed obligations.
SELECT count(*) AS remaining_phantoms
FROM pending_obligations o JOIN transactions src ON src.id = o.source_transaction_id
WHERE o.status='PAID' AND src.type IN ('SENIOR_PENDING_PAYOUT','DROP_PENDING_PAYOUT')
  AND src.status='PENDING_PAYMENT';  -- expect 0

COMMIT;  -- only if count = 0 and the dry-run matched; otherwise ROLLBACK.
```

### Fallback (zero-delete) — if the prod-DELETE is deemed risky

Simply neutralize the phantom's status (without a delete/repoint):

```sql
UPDATE transactions t SET status='PAID', updated_at=now()
FROM pending_obligations o
WHERE o.source_transaction_id = t.id AND o.status='PAID'
  AND t.type IN ('SENIOR_PENDING_PAYOUT','DROP_PENDING_PAYOUT') AND t.status='PENDING_PAYMENT';
```

Removes "Awaiting payout" + the "Pay out" button (the gate requires `status=PENDING_PAYMENT`). The compromise:
historically TWO PAID rows remain (the phantom "Expected payout.../Paid" + the settle-row).
Money-safe: `*_PENDING_PAYOUT(PAID)` is not in any money term. **Does NOT reach single-row**, but
removes the acute symptom at zero deletion risk.

**Recommendation:** primary = repoint+delete (gives the owner's true single-row model); fallback =
status-neutralize if a DELETE is vetoed. In both cases: dry-run → count reconciliation → security-review →
execution by Master with prod access (`docker exec psql`, like the accounting-migration), NOT an agent.

---

## Consequences

**Pros:** the obligation transitions to PAID in-place, the "Awaiting payout" phantom disappears, there is no second
row. Blast-radius — the single method `settleByCompany`; zero edits in the ledger / drop-aggregate /
invoice service / C4. All invariants (TOCTOU, advisory-lock, C6, invoice, C4) preserved.

**Cons / trade-offs:**

- `settleByCompany` changes the semantics from INSERT to UPDATE-in-place — ~26 specs build
  `new TransactionsService(...)`/mock settle; the settle tests need to be rewritten for the flip
  (check that the original row changed type+status and NO second one appeared).
- The `createdBy` of the flipped row remains the author of the booking (not the settler). For a senior settler
  it is recorded in `validatedBy`; for a drop settler it is not recorded in a field — a minor audit delta,
  write the settler into `notes` if desired.
- The data-fix (primary) deletes prod rows — requires a dry-run + security-review + manual execution.

**Non-goals:** we do not change the moment of crediting the drop's balance (owed-but-unpaid is still invisible until
settle); we do not touch the credit side of the ledger; we do not change `bookCompanyObligations`.

## Conflict window (coordination — Master)

PR **#374** (`feature/transaction-receipts`) is actively editing the same files: `pending-settlement.service.ts`
(+30) and `transactions.service.ts` (+245/−123), plus `SettleSeniorPayoutDialog`. **The implementation of this ADR
starts AFTER the merge of #374** (or by rebasing onto it) — otherwise a guaranteed conflict in `settleByCompany`.
The coordination of the order (merge #374 → start) is held by Master. `security-reviewer` on the implementation — MANDATORY
(finance / company-account / RBAC money-path).

## Rollback

The change is docs-only (this ADR). Rolling back the ADR:

```bash
git revert <commit>            # revert the ADR commit, OR
git checkout origin/main -- docs/architecture/2026-07-14-settle-transition-in-place.md
# close the PR docs/adr-settle-transition without a merge
```

Expected state: `docs/architecture/` without the file `2026-07-14-settle-transition-in-place.md`; the
`main` branch is not affected. Verification: `git status` clean, `ls docs/architecture | grep settle-transition`
empty.

Rolling back the IMPLEMENTATION (when the code is written, separate PRs):

- Backend flip: `git revert` the settle PR — returns the INSERT semantics (the phantom returns, but
  the money is correct).
- Data-fix primary (delete): irreversible row-by-row; therefore dry-run + a backup of the affected rows
  (`\copy (SELECT ...) TO ...`) BEFORE COMMIT — restore from the backup on a regression.

## Implementation decomposition (revision of task-files)

| Task                         | Agent        | Zone                                   | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Model                            |
| ---------------------------- | ------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `task-coder-settle-in-place` | Coder        | `apps/api/src/finance/**`              | Rewrite `settleByCompany`: UPDATE-in-place of the original IOU-row (type-flip + status + funding fields + `closingTransactionId=self` + `payoutRequestId=null`); preserve the TOCTOU claim, advisory-lock, gate, invoice trigger by the flipped id; the order resolve→claim→flip. Unit+integration tests: double-settle idempotency (404/rollback), ledger-neutrality (balance before/after = income − settle), drop-credit + C6 (senderId≠drop), C4-exclusion (settlementTxIds), the senior invoice is triggered, both fundings (COMPANY_ACCOUNT/ADMIN_PERSONAL + the BIZ-03 currency guard), both IOU sources (declare + cascade). | opus (finance computation logic) |
| `task-devops-settle-datafix` | DevOps/Coder | `apps/api/drizzle/manual/**` + runbook | An idempotent guarded SQL (repoint+delete primary; status-neutralize fallback) + a dry-run SELECT + a backup of the affected rows. Executed by Master on prod (`docker exec psql`) — NOT CI.                                                                                                                                                                                                                                                                                                                                                                                                                                         | —                                |
| `task-autotest-settle-e2e`   | AutoTest     | `apps/e2e/**`                          | E2E: ADMIN/ACCOUNTANT "Pay out" on a `*_PENDING_PAYOUT` → the row transitions to PAID (one row, "Paid"), "Pay out" disappears, there is no second row; the drop's balance / the company ledger are correct.                                                                                                                                                                                                                                                                                                                                                                                                                          | sonnet                           |

`security-reviewer` — MANDATORY on `task-coder-settle-in-place` and on the data-fix. The design-gate does not
apply (the UI does not change visually — the same row, a different status label; manual-qa checks in UT
that the render `Senior income/Drop share + Paid` is coherent and there is no phantom).

## Sources

- `apps/api/src/finance/pending-settlement.service.ts:246-365` — `settleByCompany` (INSERT-second-row + TOCTOU-claim + advisory-lock).
- `apps/api/src/finance/transactions.service.ts:2702-2795` — `bookCompanyObligations` (IOU booking); `:1199` (declare), `:3115` (the cascade drop branch) — two sources.
- `apps/api/src/finance/company-account-balance.ts:117-219` — the ledger terms `SENIOR_INCOME`/`PAYOUT_DROP`(COMPANY_ACCOUNT).
- `apps/api/src/finance/transactions.service.ts:561-634` — `computeDropAggregate` (C6: received/sent by PAYOUT_DROP).
- `apps/api/src/invoices/invoices.service.ts:142-149` — `autoCreateForSeniorPayout` (the gate `type==='SENIOR_INCOME'`); `:176` autoCreateForPayout (aggregation by payoutRequestId — why the reset).
- `apps/api/src/finance/transactions.service.ts:3315-3342,3463-3471` — the C4 `settlementTxIds` discriminator (totalIncome + monthly); `:938` the findOne enrichment.
- `apps/api/src/database/schema.ts:681-722` — `pending_obligations` FK (`sourceTransactionId` restrict, `closingTransactionId` set-null, `uq_..._source_pending`).
- `apps/web/.../finance/components/TransactionRow.tsx:330-333` — the "Pay out" gate (`type∈pending-set AND PENDING_PAYMENT`); `constants.ts:27,43,49,51` — the labels.
- PR #374 (`gh pr view 374`) — the conflict window: `pending-settlement.service.ts` +30, `transactions.service.ts` +245/−123.
