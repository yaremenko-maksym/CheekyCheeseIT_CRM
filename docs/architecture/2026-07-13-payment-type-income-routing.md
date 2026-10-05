# ADR — Project payment type + routing of admin-declared USDT income

## Status

**Proposed** — the planning stage of a critical financial feature. Owner: "implementation only
after all the details are discussed". Requires user approval on the open questions (§Open
questions) before dispatching coders.

Branch: `feature/drop-share-override-and-receiver`. Model: opus. Confidence set on the
key Decision items.

---

## Context

The owner's contract (FIXED):

1. **Project payment type** → enum FOP / gig-contract / USDT (currently `projects.paymentType` —
   a free `varchar(100)`, `schema.ts:299`). Changed by ADMIN + ACCOUNTANT (field-scoped RBAC like
   `seniorSharePercentOverride`). Data migration: all existing → FOP, GamingTec → USDT (dev + prod).
2. **Declaration gate by payment type:** FOP/gig — SENIOR/DROP declare their incomes as
   now, without a receiver selector. USDT — ONLY ADMINs declare; a mandatory receiver:
   any ADMIN (dynamically by role) OR the "company account". History we do NOT touch.
3. **Auto-obligations after an admin USDT-income declaration:** (a) the senior's share = amount × eff.
   share — only if the senior is not an ADMIN; (b) the drop's share = amount × eff. share — only if the drop
   is attached. Settled by the existing payout mechanisms.
4. **Per-project drop share** (prior cycle, remains): `projects.dropSharePercentOverride`,
   RBAC ADMIN+ACCOUNTANT, the resolver override → `users.dropSharePercent` → 5, WITHOUT a team level;
   snapshot `transactions.drop_share_percent` + `drop_share_percent_source`.

The feature splits into **Part A** (per-project drop override — standalone, feeds Part B) and
**Part B** (paymentType enum + admin-USDT income routing + obligations).

### The existing money model (verified by the code — the foundation of the decisions)

- **Company-account ledger** (`company-account-balance.ts:21-45`, the single SSOT of the balance):
  `+ COMPANY_DEPOSIT(PAID,USDT)  + PAYOUT(PAID, funding=COMPANY_ACCOUNT)  + ADMIN_INCOME(PAID,
funding=COMPANY_ACCOUNT)  − DIVIDEND_TO_ADMIN  − SALARY(COMPANY_ACCOUNT)  − EXPENSE(COMPANY_ACCOUNT)
− SENIOR_INCOME(COMPANY_ACCOUNT)`. All USDT. **`PAYOUT_DROP` is absent from the ledger** (the drop-slice
  was never a debt of the company).
- **`ADMIN_INCOME`** (`transactions.service.ts:961-1053`): created immediately `PAID` (without validation),
  `fundingSource` routes: `COMPANY_ACCOUNT` → credit of the pool (USDT-forced, excluded from the admin's personal
  balance in `getSummary:3056`); `null` → credit of the receiverId admin personally. `totalIncome`
  (`getSummary:2996`) counts ALL `ADMIN_INCOME` as gross.
- **The IOU "the company owes X"** — is born in the `applyPayoutPaidCascade` drop-branch
  (`transactions.service.ts:2760-2804`): `SENIOR_PENDING_PAYOUT` (PENDING_PAYMENT, a visible-row) +
  `pending_obligations` (creditor=senior, `debtorType='COMPANY'`, `sourceTransactionId`=the IOU-row).
  `pending_obligations` does **NOT** store the creditor's role — the IOU type is resolved via the source transaction.
- **Settle** (`pending-settlement.service.ts:151-345`, `settleByCompany`): an atomic
  conditional-UPDATE PENDING→PAID (anti-double-settle, TOCTOU-safe), **hardcodes the insert of
  `SENIOR_INCOME`(PAID)** + the trigger `autoCreateForSeniorPayout` (gate `type==='SENIOR_INCOME'`,
  `invoices.service.ts:147`). Funding at pay-time: `COMPANY_ACCOUNT` (debit of the pool, balance gate) |
  `ADMIN_PERSONAL` (sender=admin, the pool is not touched; only USD/USDT — BIZ-03).
- **Drop balance** = `Σ PAYOUT_DROP received − sent` (`computeDropAggregate:593-598`). The only
  type crediting the drop's balance.
- **The senior-share resolver** (`senior-share-resolver.ts`): project override → single-team → user
  (26). The drop has NO team level (`projects.dropId` — a direct link, not via a team).

---

## Decision

### D0. The end-to-end money-flow of an admin USDT income (the core) — **Confidence: HIGH on the form, MED on 2 nodes**

Example: ADMIN declares **$1000 USDT** on a USDT project (senior=S non-admin 26%, drop=D 5%,
override-aware). The receiver — ADMIN X **or** the "company account".

```
1. Income-row (gross $1000)         → type ADMIN_INCOME, status PAID (see D3)
   ├ receiver = "company account"   → fundingSource=COMPANY_ACCOUNT → +$1000 into the pool
   └ receiver = ADMIN X             → fundingSource=null, receiverId=X → +$1000 to X's personal balance
2. Atomically (the same db.transaction) — the company's obligations (see D4):
   ├ if S is not an ADMIN: SENIOR_PENDING_PAYOUT $260 + obligation(creditor=S, debtor=COMPANY)
   └ if D is attached:     DROP_PENDING_PAYOUT   $50  + obligation(creditor=D, debtor=COMPANY)
3. Settlement (existing settle, see D5), ACCOUNTANT/ADMIN chooses the funding:
   ├ senior → SENIOR_INCOME PAID (existing branch, invoice)
   └ drop   → PAYOUT_DROP  PAID (NEW branch, credit of the drop's balance, no senior invoice)
   The residual $690 remains where the gross arrived (the pool / X's personal balance).
```

**Consistency invariant:** the funding choice at settle is tied to where the gross arrived.
receiver=pool → settle from `COMPANY_ACCOUNT`; receiver=ADMIN X → settle `ADMIN_PERSONAL`(payer=X).
This is **not** hard-enforced (mirroring the existing manual model), but it sets up the default and is
protected by the balance gate (`settleByCompany:276` throws "Insufficient funds"). MED — see Q3.

### D1. `paymentType` free-text → enum — **Confidence: HIGH**

- Shared Zod: `projectPaymentTypeSchema = z.enum(['FOP','GIG_CONTRACT','USDT'])`. Ukrainian labels on
  the front, in Ukrainian: `FOP→"FOP"`, `GIG_CONTRACT→"gig-contract"`, `USDT→"USDT"` (the live UI strings are the Ukrainian spellings of these).
- pgEnum `project_payment_type` in `schema.ts`; `projects.paymentType` → `project_payment_type
NOT NULL DEFAULT 'FOP'`.
- Field-scoped RBAC in `createProjectSchema`/`updateProjectSchema` + `projects.service.ts`
  create/update — the pattern 1:1 with `seniorSharePercentOverride` (`:610-618`, `:739-747`): only
  ADMIN/ACCOUNTANT can send the field, otherwise `ForbiddenException`; the ACCOUNTANT `hasOnlyOverride` branch
  is extended to `paymentType`.
- `mapProject` (`:196-209`) returns `paymentType` in the DTO (do not mask — not PII; but a JUNIOR masking
  at the owner's taste — see Q5).

### D2. The declaration gate by payment type (bidirectional) — **Confidence: HIGH**

- `createSeniorIncome` / `createDropIncome` (`:1069`, `:1151`): add a check — if
  `project.paymentType === 'USDT'` → `ForbiddenException('On a USDT project the income is declared by an
administrator')`. The FOP/GIG lifecycle does NOT change.
- The new admin-USDT method (D3): reject if `project.paymentType !== 'USDT'`.
- Frontend `CreateTransactionDialog`: SENIOR/DROP on choosing a USDT project → the type
  SENIOR_INCOME/DROP_INCOME is unavailable (hint). ADMIN gets a new type option only for
  USDT projects.
- **We do not touch history**: the gate is only on NEW declarations; old DROP_INCOME on GamingTec live.

### D3. Lifecycle of an admin USDT income: **reuse `ADMIN_INCOME`, a new service method** — **Confidence: MED→HIGH**

**The type of the income-row = `ADMIN_INCOME` (NOT a new enum).** Rationale (adopt-before-extend):

- The `fundingSource` routing of `ADMIN_INCOME` already precisely models "pool vs admin's personal balance",
  the ledger + `getSummary` + `totalIncome` are already integrated → **zero churn** across the exhaustive maps /
  summary / ledger for the income-row.
- A new enum-type for the income-row would give a huge blast-radius (every ledger term, every
  summary, `Record<TransactionType>` in `constants.ts:4,:67`, the dialog ICON/DESC maps, invoices) without
  a gain — the money semantics are identical to `ADMIN_INCOME`.

**A separate method**, NOT an edit of `createAdminIncome` (regression-safe): `declareUsdtProjectIncome`
(a working name) + the endpoint `POST /api/finance/usdt-income`. The differences from `createAdminIncome`:

- RBAC: **only ADMIN** (the contract "ONLY ADMINs declare"; ACCOUNTANT — see Q4).
- The project — ANY USDT project (not "one's own"), `paymentType==='USDT'`.
- `receiverId`: any active ADMIN → `receiverId=X, fundingSource=null`; "company account" →
  `fundingSource=COMPANY_ACCOUNT, receiverId=the caller` (excluded from the personal balance as in
  `createAdminIncome`), currency forced `USDT`.
- Validator: does not require an ACCOUNTANT cascade — `ADMIN_INCOME` is created immediately `PAID` (a trusted
  admin), as today. See Q2 (whether validation is needed).
- **Atomically** in a single `db.transaction`: income-row + both obligation blocks (D4). Never
  income-without-obligations.

### D4. Obligations + the drop-share resolver (Part A feeds Part B) — **Confidence: MED**

- **A new resolver `resolveDropShare`** (modeled on `senior-share-resolver.ts`, WITHOUT a team level):
  `project.dropSharePercentOverride ?? user.dropSharePercent ?? 5`, source `'PROJECT'|'USER_DEFAULT'`.
  Used BOTH in the admin-USDT obligation math AND in the DROP_INCOME snapshot (Part A).
- **Extract a shared helper** `bookCompanyObligations(dbtx, {project, income, senior, drop})` from
  `applyPayoutPaidCascade:2760-2804` (the senior IOU) + add a drop branch. Reuse in both
  call-sites (drop-payout cascade AND admin-USDT) → no ledger drift.
- The senior-share on GROSS via `resolveSeniorShareSnapshot` (project/team-aware), only if
  `senior.role !== 'ADMIN'`. The drop-share on GROSS via `resolveDropShare`, only if
  `project.dropId != null`. Snapshot of the shares+source on the IOU-rows.
- **`DROP_PENDING_PAYOUT`** — a new enum-value (M1 already laid it into Zod). In `schema.ts`
  add `transactionTypeEnum` LAST (after `COMPANY_DEPOSIT`) — a clean `ALTER TYPE ADD
VALUE`. Mandatory follow-up: `constants.ts` `TYPE_LABELS`(`:4`)+`TYPE_COLORS`(`:67`) —
  the exhaustive `Record<TransactionType>` break without an entry (the reason M1 was not pushed).
- **Idempotency (anti-BIZ-02):** a double-submit of a declaration = 2 different income-rows, each with its own
  obligations (not a double-settle of one obligation) — the same landing as `createAdminIncome`
  today. The real double-settle risk is closed by the atomic guard of `settleByCompany` (we reuse it). Atomicity
  of creation (income+obligations in one tx) — mandatory.

### D5. Settle of a drop obligation (a new branch) — **Confidence: MED (the highest-risk node)**

`pending_obligations` does not distinguish the creditor's role → `settleByCompany` branches by the type of
the source transaction (`sourceTransactionId` → tx.type):

- `SENIOR_PENDING_PAYOUT` → the existing branch: `SENIOR_INCOME` PAID + `autoCreateForSeniorPayout`.
  **Do not break.**
- `DROP_PENDING_PAYOUT` → **a new branch**: insert `PAYOUT_DROP` PAID (`receiverId=drop`,
  `senderLabel='COMPANY'` when company-funded / `senderId=payerAdmin` when ADMIN_PERSONAL) — credits
  the drop's balance via `computeDropAggregate`. Do **NOT** trigger a senior invoice.
- **Ledger term:** add `− Σ(PAYOUT_DROP PAID, funding=COMPANY_ACCOUNT, USDT)` in
  `company-account-balance.ts`. Existing `PAYOUT_DROP` (drop-payout cascade) have
  `fundingSource=null` → not affected. ADMIN_PERSONAL-settle: `senderId=admin` → the debit is caught by
  `adminBalances.sent` in `getSummary`, the ledger term is not needed.
- Drop invoice: the contract does not require it; by default we do not create one (the senior invoice — a legal type). See Q6.

### D6. Part A — per-project drop override (unchanged from the prior cycle) — **Confidence: HIGH**

CRUD 1:1 with `seniorSharePercentOverride` in `projects.service.ts` create(`:604-725`)/update(`:732-804`):
field-scoped RBAC ADMIN/ACCOUNTANT, implicit-null-reset (value === eff. drop-default → `null`),
the `hasOnlyOverride` branch. **Differences:** default = `user.dropSharePercent ?? 5` (not 26); only for
drop projects (`dropId != null`); **no** `project_finance_settings` mirror (the senior has a legacy
mirror — the drop does not need one). DTO fields (M1): `dropSharePercentOverride`, `dropSharePercentDefault`,
`effectiveDropSharePercent`, `effectiveDropShareSource`. Snapshot on DROP_INCOME:
`transactions.drop_share_percent` + `drop_share_percent_source` (new columns).

### D7. The fate of WIP M1 (`119e3f60`) — **Confidence: HIGH**

Cherry-pick partially:

- **Take as is:** `dropSharePercentSourceSchema`, `transactionSchema += dropSharePercent /
dropSharePercentSource`, `projectSchema += 4 drop fields`, `create/updateProjectSchema +=
dropSharePercentOverride`, `DROP_PENDING_PAYOUT` in `transactionTypeSchema`.
- **REDO:** `createDropIncomeSchema += receiverId (REQUIRED)` — **WRONG** under the new
  contract. A DROP on FOP/GIG declares its income WITHOUT a receiver. `receiverId` — a field of the NEW
  admin-USDT DTO (`createUsdtIncomeSchema`), NOT `createDropIncomeSchema`. Also the comment about
  "an ADMIN caller on DROP_INCOME" from M1 — discard.
- **Add on (was not in M1):** `projectPaymentTypeSchema`, `createUsdtIncomeSchema`
  (`projectId, amount, currency='USDT', receiverId | 'COMPANY_ACCOUNT'`), update the `constants.ts`
  exhaustive maps + the dialog maps for `DROP_PENDING_PAYOUT` (M1 breaks them → that is why it was not pushed).

---

## Conflict matrix

Each item: conflict yes/no + resolution.

| #   | Surface                                                                             | Conflict?                | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **ACCOUNTANT validation** (`validateTransaction:1539`, `getAccountantSummary:3212`) | **No**                   | The admin-USDT income = `ADMIN_INCOME` PAID immediately, does NOT go through the validate cascade. `pendingValidation` filters only `SENIOR_INCOME/DROP_INCOME` → the admin-USDT does not get in. Correct.                                                                                                                                                                                                                                                                                                                                                 |
| C2  | **Payout bundling** (`createPayoutRequest:2061`)                                    | **No**                   | Only one's own `SENIOR_INCOME/DROP_INCOME` (receiverId=caller) is bundled. The admin-USDT does not create a bundle-able income for the senior/drop; their money goes through the obligation settle, not through a payout. Decoupled.                                                                                                                                                                                                                                                                                                                       |
| C3  | **salary-cron** (`createMonthlySalaries:3909`)                                      | **No**                   | Salaries do not depend on paymentType / admin-income. Does not intersect.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| C4  | **totalIncome double-count** (`getSummary:2991-3007`)                               | **YES (MED)**            | receiver=ADMIN X + settle senior `ADMIN_PERSONAL` → `SENIOR_INCOME(funding=null)` **is counted** in totalIncome (line `:3003`), although this slice is already part of the counted `ADMIN_INCOME` gross. **Pre-existing** (task-senior-settle-owner), but this feature MAKES IT MORE FREQUENT. Fix: extend the exclusion — a settlement `SENIOR_INCOME` (closing an obligation) is NOT counted in totalIncome regardless of funding. A discriminator is needed (e.g. a `closingTransactionId` join OR a marker field). **A regression test is mandatory.** |
| C5  | **adminBalances / 50-50** (`getSummary:3039-3073`)                                  | **No (verified)**        | receiver=X: `ADMIN_INCOME(null)` +X.received; settle `ADMIN_PERSONAL` → `PAYOUT_DROP/SENIOR_INCOME senderId=X` +X.sent. The HOLDING model reconciles (+gross −shares = +residual). receiver=pool: `funding=COMPANY_ACCOUNT` excluded from the personal. Consistent.                                                                                                                                                                                                                                                                                        |
| C6  | **drop-aggregate** (`computeDropAggregate:553`)                                     | **YES (low)**            | `pendingCount`/`debtToCompany` match `receiverId===drop.id` / `senderId===drop.id`. admin-USDT: income receiverId=admin (not the drop) → will NOT get into pendingCount (correct — the drop does not declare). Settle `PAYOUT_DROP` receiverId=drop → `balance.received` +=the drop-share (correct). A unit test is needed that the settle `PAYOUT_DROP` is not double-counted as `sent` (senderId≠drop).                                                                                                                                                  |
| C7  | **company-account ledger** (`company-account-balance.ts`)                           | **YES (needs an edit)**  | Add the `− PAYOUT_DROP(COMPANY_ACCOUNT)` term (D5). The `ADMIN_INCOME(COMPANY_ACCOUNT)` credit term already exists → receiver=pool works without edits. A ledger-balance integration test.                                                                                                                                                                                                                                                                                                                                                                 |
| C8  | **invoices/PDF** (`invoices.service.ts:147,197`)                                    | **No**                   | senior-settle → `SENIOR_INCOME` → `autoCreateForSeniorPayout` (the existing gate). drop-settle → `PAYOUT_DROP` → the gate does not fire, no invoice (see Q6). The admin `ADMIN_INCOME` does not generate an invoice (no trigger on ADMIN_INCOME). Consistent.                                                                                                                                                                                                                                                                                              |
| C9  | **RBAC visibility of transactions** (`assertReadAccess:4071`, `mapTx:279`)          | **YES (check)**          | A new `DROP_PENDING_PAYOUT` visible-row + `ADMIN_INCOME` on someone else's project. Check: the drop sees its own `DROP_PENDING_PAYOUT`/`PAYOUT_DROP`; the senior — its own `SENIOR_PENDING_PAYOUT`; a JUNIOR does not see finance. An RBAC integration test on the new rows is needed (not mocked — the mocked-guards lesson).                                                                                                                                                                                                                             |
| C10 | **seed / E2E fixtures** (`seed.ts`)                                                 | **YES**                  | The seed projects do not fill `paymentType` (→ the default 'FOP' migration). GamingTec is NOT in the dev seed. Add to the seed at least 1 USDT drop-project fixture (dev can run the admin-USDT flow + obligations). `notesPaymentType` on interviews — do not touch (a different field).                                                                                                                                                                                                                                                                  |
| C11 | **GamingTec history**                                                               | **No**                   | Old DROP_INCOME on GamingTec we do not touch (the gate is only on the new). The migration only sets `paymentType='USDT'` for the project.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| C12 | **interaction with the per-project drop override** (Part A↔B)                       | **Coupling (by design)** | The drop-obligation amount = income × `resolveDropShare` (project override → user → 5). The same resolver snapshots DROP_INCOME. A single `resolveDropShare` — SSOT.                                                                                                                                                                                                                                                                                                                                                                                       |
| C13 | **free-text `paymentType` UI fields** (existing prod values!)                       | **YES (data-migration)** | Prod `payment_type` — arbitrary free-text. Migration: normalize all → 'FOP', GamingTec → 'USDT', then `ALTER COLUMN TYPE enum USING`. A manual prod DDL (`apps/api/drizzle/manual/`). Verify the prod values BEFORE the conversion (no unexpected strings that should be USDT/GIG).                                                                                                                                                                                                                                                                        |
| C14 | **createDropIncome M1 `receiverId REQUIRED`**                                       | **YES (M1 bug)**         | Revert (D7): the FOP/GIG drop declares without a receiver. receiverId — in the admin-USDT DTO.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

---

## Open questions for the owner (only those changing money/UX)

**Q1 — "Company account" receiver: a direct credit vs on-chain tx-link verification?**
There are 2 paths of crediting into the pool: (a) `ADMIN_INCOME(COMPANY_ACCOUNT)` — a direct credit, without
verification (a trusted admin, as today); (b) `COMPANY_DEPOSIT` — Etherscan verification of
the tx-link (Phase 8, `submitDeposit`). Recommendation: **(a) a direct credit** (consistent with
`createAdminIncome`, the tx-link remains as receipt proof). Options: (a) direct /
(b) require a verified tx-link like for a deposit / (c) direct + an optional link.

**Q2 — Is ACCOUNTANT validation of the admin-USDT income needed before creating the obligations?**
Recommendation: **no** (immediately PAID + obligations, like `ADMIN_INCOME`; the admin is trusted). Options:
(a) immediately PAID / (b) PENDING → ACCOUNTANT validate → then obligations (a control gate, but
diverges from the ADMIN_INCOME model).

**Q3 — Should the settle-funding be tied to the gross receiver (hard)?**
receiver=pool is logical to settle from `COMPANY_ACCOUNT`, receiver=ADMIN X — `ADMIN_PERSONAL`(X). Currently
this is a manual ACCOUNTANT choice (mirror of the existing). Recommendation: **soft** (a default by the receiver,
the balance gate protects it). Option: hard-force the funding by the receiver (less freedom, fewer
errors).

**Q4 — Can ACCOUNTANT (not only ADMIN) declare a USDT income?**
The contract says "ONLY ADMINs", but ACCOUNTANT has create-parity for `ADMIN_INCOME` and manages
finance. Recommendation: **follow the contract — only ADMIN**. Option: allow ACCOUNTANT
(as a recorder, the receiver is still ADMIN/pool).

**Q5 — Should `paymentType` be masked from a JUNIOR?**
The payment type — not PII, but a financial configuration. Recommendation: show to all non-JUNIOR (like the
senior share). Option: hide from JUNIOR/HR.

**Q6 — An invoice to the drop on settle of the drop share?**
The senior gets a signable `SENIOR_INCOME` invoice. The contract does not stipulate an invoice for the drop.
Recommendation: **no invoice** (the drop-slice — an internal payout). Option: generate a drop invoice
(a new invoice trigger on `PAYOUT_DROP` is needed).

---

## Edits to task-files (PM zone — I propose, I do not edit)

**The task-files `task-drop-share-{design,backend,frontend,e2e}.md` do NOT exist** (neither on the feature, nor
in main — verified with `git ls-tree`). There is only the design spec + WIP schemas. PM must **create** 4
files with the following content (the expanded Part A+B scope):

- **`task-drop-share-design.md`** (ui-ux-designer, Tier 2) — **an addendum to
  `docs/design/drop-share-override-and-receiver.md`** (the spec was written BEFORE the contract, Surface B is outdated):
  1. Surface A (the drop-share slider) — **unchanged**, correct.
  2. Surface B (the receiver) — **MOVE** from the `DROP_INCOME` branch to the **new admin-USDT
     declaration flow**. DROP_INCOME (FOP/GIG) — WITHOUT a receiver selector.
  3. A new screen/section: an ADMIN on a USDT project selects the receiver = the "Admins" group (dynamic) +
     "Company account". The options of the 2 groups + a hint "the gross will go to the receiver; the company will create obligations
     to the senior/drop".
  4. A new "Payment type" field (FOP/gig-contract/USDT) in the project form — a Select, RBAC ADMIN/ACCOUNTANT.
  5. Responsive + fidelity on all classes (design-fidelity-review).

- **`task-drop-backend.md`** (Coder, model=opus — finance+migration; security-reviewer MANDATORY):
  AC on: the paymentType enum+migration (D1), the gate (D2), `resolveDropShare` (D4), the per-project drop
  override CRUD (D6), `declareUsdtProjectIncome` + endpoint (D3), the `bookCompanyObligations`
  shared helper + `DROP_PENDING_PAYOUT` (D4), the settle drop branch + ledger term (D5, C7), the totalIncome
  fix (C4), the DROP_INCOME snapshot columns (D6). Explicit AC: unit (resolveDropShare,
  computeDropDistribution with override, obligation-math), **integration against the real DB** (RBAC
  403 on the gate, settle-drop atomicity/idempotency, ledger balance — C6/C7/C9), regression
  (the senior branch settle is not broken, totalIncome).

- **`task-drop-frontend.md`** (Coder + design-gate) — per the design addendum: the paymentType Select,
  the drop-share slider (Surface A), the admin-USDT dialog (receiver), gate-hiding of
  SENIOR_INCOME/DROP_INCOME on USDT projects, the `constants.ts` exhaustive maps for
  `DROP_PENDING_PAYOUT`, the dialog maps. Do NOT insert receiverId into createDropIncome (C14).

- **`task-drop-e2e.md`** (AutoTest) — E2E: ADMIN declares a USDT income (receiver=admin /
  receiver=pool) → obligations appear → ACCOUNTANT settles → the drop's/senior's balance moves;
  the gate (SENIOR/DROP cannot declare on a USDT project); paymentType RBAC. testids from
  the design spec + new ones.

**Design tier** in each UI task-file: Tier 2. **The model** of the backend task: `opus` (Drizzle migration

- financial computation logic + company-account — per the `model-routing.md` trigger).

---

## Implementation order (incremental, a working state at each step)

1. **M1 add-on (shared)** — cherry-pick the good parts from `119e3f60` + `projectPaymentTypeSchema` +
   `createUsdtIncomeSchema`, revert `createDropIncome.receiverId`, update the `constants.ts`
   exhaustive maps (`DROP_PENDING_PAYOUT`). → typecheck green. **Rollback:** revert the shared commit.
2. **Schema migration** — pgEnum `project_payment_type` + the drop-share snapshot columns +
   the `DROP_PENDING_PAYOUT` enum-value. `db:push` dev. A manual prod DDL in `apps/api/drizzle/manual/
2026-07-13_payment_type_and_drop_pending_payout.sql` (ADD VALUE outside a transaction; the conversion
   varchar→enum with a USING mapping FOP/GamingTec-USDT). **Rollback:** the reverse DDL (enum→varchar; drop
   of the columns; an enum-value cannot be removed — leave it unused).
3. **Part A backend** — `resolveDropShare` + the override CRUD + the DROP_INCOME snapshot + DTO. Unit tests.
   → works in isolation (the drop override without Part B). **Rollback:** revert.
4. **Part B backend** — the gate (D2) + `declareUsdtProjectIncome` + `bookCompanyObligations` (extract
   from the cascade) + the settle drop branch + the ledger term + the totalIncome fix. Integration against the real DB.
   security-reviewer. **Rollback:** revert; removing the gate restores the old lifecycle.
5. **Frontend** (design-gate: designer BEFORE) — the paymentType Select, the Surface A slider, the admin-USDT
   dialog. fidelity-review all classes. **Rollback:** revert.
6. **E2E + a seed USDT fixture** (C10). A full run locally before push.
7. **User Testing** → "merge it" → `merge-approved`. The prod DDL is applied BEFORE the deploy (like the tail of
   the mega-audit) — GamingTec→USDT on prod.

---

## Rollback (feature level)

- **Single-file:** `git checkout <file>`.
- **Phase-subset:** `git revert <range>` by the steps of the order above (each step — a working state).
- **Full:** close the PR, return to the pre-change `feature/drop-share-override-and-receiver`.
- **Prod DDL:** the migration is reversible (enum→varchar preserves the values; drop of the snapshot columns; the new
  enum-value `DROP_PENDING_PAYOUT` cannot be removed in PG — it remains unused, harmless). The gate and
  the admin-USDT method — purely additive: removing them returns the FOP/GIG lifecycle without data loss.
- **Verification after rollback:** `pnpm typecheck && pnpm --filter @crm/api test` green;
  `postgres query` — the `payment_type` values are consistent; the company-account ledger balance is not shifted.

---

## Sources

- `apps/api/src/finance/transactions.service.ts`: `createAdminIncome:961`, `createSeniorIncome:1057`,
  `createDropIncome:1139`, `validateTransaction:1539`, `createPayoutRequest:2061`,
  `applyPayoutPaidCascade:2482` (SENIOR_PENDING_PAYOUT+obligation `:2760-2804`),
  `computeDropDistribution:480`, `computeDropAggregate:553`, `getSummary:2937` (totalIncome `:2991`,
  adminBalances `:3039`), `getAccountantSummary:3193`, `getSeniorSummary:3286`,
  `resolveSeniorShareSnapshot:351`.
- `apps/api/src/finance/pending-settlement.service.ts`: `settleByCompany:151`,
  `settleByCompanySourceTransaction:366`, `SettleFunding:75`.
- `apps/api/src/finance/senior-share-resolver.ts` (the resolver model for `resolveDropShare`).
- `apps/api/src/finance/company-account-balance.ts:21-45,130-186` (the ledger SSOT).
- `apps/api/src/invoices/invoices.service.ts:142-202` (`autoCreateForSeniorPayout` gate `:147`).
- `apps/api/src/database/schema.ts`: `transactionTypeEnum:57-107`, `pendingObligationDebtorTypeEnum:115`,
  `projects.paymentType:299`, `dropId:284`, `seniorSharePercentOverride:309`, `users.dropSharePercent:202`.
- `apps/api/src/projects/projects.service.ts`: the override CRUD create `:604-725` / update `:732-804`,
  `mapProject:120-209`.
- `apps/web/app/routes/_authenticated/finance/constants.ts:4,67` (the exhaustive `Record<TransactionType>`).
- `apps/web/app/routes/_authenticated/finance/components/dialogs/CreateTransactionDialog.tsx`
  (`availableTypes:127-134`, the receiver-Select SALARY `:572-634`, DROP_INCOME `:342`).
- `docs/design/drop-share-override-and-receiver.md` (spec — Surface B is outdated under the contract).
- WIP `119e3f60` (M1 shared schemas — a partial cherry-pick, D7).
- `apps/api/src/database/seed.ts:968+` (`notesPaymentType` — interviews, not projects; GamingTec is not in the seed).
- Rules: `.claude/rules/common/{version-pins,zone-of-write,git-policy,model-routing,design-gate,
design-fidelity-review}.md`. Memory: `project_phase8_redefined_company_account`,
  `project_accounting_migration`, `project_drop_attach_2026_07_12`, `feedback_mocked_e2e_guards`,
  `project_mega_audit_2026_07_03` (the BIZ-02 double-credit lesson).
