# Task: Payout → company wallet + on-chain validation (Phase 8 v2, backend)

## Model: opus

(Money + on-chain validation + RBAC + Drizzle/financial logic → opus per model-routing.)

## Zone: Coder — `apps/api/**`, `packages/shared/**`, `.github/workflows/guard-test-gate.yml` (allowlist). Progress — `.claude/tasks/task-payout-company-wallet.progress.md`.

## Context (owner's direction 2026-06-20)

Income to the company account goes THROUGH the existing **payout flow** ("выплата"), NOT through a separate page (that one was removed in #251). The company account = **USDT only**. Seniors/drops settle with the company in crypto.

Study via codegraph BEFORE editing (verbatim source, do not Read the same files):

- `transactions.service.ts`: `createPayoutRequest` (~1818), `payPayoutRequest` (~1940), `computeDropAggregate`, `mapTx`.
- `company-account.service.ts` (computeBalance, getRow), `etherscan.service.ts` (`verifyDeposit(txHash, expectedTo, threshold)` — already checks recipient+confirmations+amount).
- `nbu-currency.service.ts` (USD/EUR/UAH rates).
- `packages/shared/src/schemas/finance.ts`: `payPayoutRequestSchema`, `createPayoutRequestSchema`, `payoutRequestSchema`.
- `company_account` table (walletAddress, confirmationThreshold).

## Current state (what we change)

- `createPayoutRequest`: recipient = a STUB `contractAddress = '0x'+randomBytes(20)`; **mixed-currency guard** (`currencies.size>1 → BadRequest`); payableAmount = company-share (100−seniorSharePercent%) in the income currency.
- `payPayoutRequest`: confirmation by `txHash`, but a **simulation** (`simulateResult: 'success'|'error'`), NOT a real blockchain check.

## Design (implement it this way)

### 1. createPayoutRequest — recipient = company wallet + USDT conversion

- `contractAddress` → **the company wallet address** (from `company_account.walletAddress`). If the wallet is not configured → BadRequest «Кошелёк компании не настроен». (We reuse the `contract_address` field as the recipient — do NOT break the schema.)
- **Remove the mixed-currency guard.** Instead: convert the company-share of EACH income to USDT (USDT/USD = 1:1; EUR/UAH via `nbu-currency.service`), sum → `payableAmount` in USDT. `incomeAmount` also in USDT (or keep per-source — but payable must be USDT). The payout currency = **USDT**.
- Fix the rate/calculation deterministically (integer arithmetic as now, SCALE=1e6).

### 2. payPayoutRequest — real Etherscan validation + crediting

- Remove the `simulateResult` simulation (or keep it ONLY under NODE_ENV!=='production' + an explicit dev flag — not in prod).
- Real check: `etherscan.verifyDeposit(txHash, companyWallet, threshold)` → invariant: `toMatches && confirmed && amount ≈ payableAmount` (tolerance ~1% for rate/rounding; document it). Not PAID if the recipient != the company wallet OR not confirmed OR the amount is outside the tolerance.
- On valid → payout PAID + linked income-tx → PAID + **crediting to the company account**. Avoid DOUBLE counting: extend `company-account computeBalance` to include Σ(payout_requests PAID payableAmount) OR insert a single service credit-row — choose one, document it, so the balance is not doubled.
- Idempotency: a repeated confirm of the same payout/txHash does not double (UNIQUE/check).

### 3. Manual-confirm endpoint (ADMIN/ACCOUNTANT)

- New endpoint: ADMIN/ACCOUNTANT manually confirms that the payout was paid some other way. DTO: `method: 'CASH' | 'ADMIN_USDT' | 'COMPANY_ACCOUNT'` (+ optional note/txHash).
- RBAC: only ADMIN/ACCOUNTANT (not SENIOR/DROP). A real backend 403 test (FM-5).
- Marks the payout PAID. Crediting: if `COMPANY_ACCOUNT` → credits the company account; if `ADMIN_USDT`/`CASH` → does NOT credit the company account (the money went around it). Record the method (audit).

### 4. Shared schemas

Update `payPayoutRequestSchema` (txHash required for the on-chain path), a new `manualConfirmPayoutSchema` (method enum), `payoutRequestSchema` (currency=USDT, recipient). All API via `.parse()`.

### 5. FM-5 guard-test gate

If a new controller/endpoint is in a sensitive dir — it falls under the allowlist (`finance`/`transactions` are already covered). Verify.

## Acceptance Criteria (each with a test, integration against the REAL scratch DB `crm_qa`, NOT `crm_db`)

1. createPayoutRequest: recipient = company wallet; wallet not configured → BadRequest. typecheck green.
2. **USDT conversion:** mixed currencies (USD+USDT, like the photo-1 bug) → one USDT payout, payableAmount = Σ(company-share in USDT). NOT BadRequest. (unit + integration).
3. **On-chain confirm (integration, mock Etherscan):** valid (to=wallet, confirmed, amount-match) → PAID + company account +payable. wrong-recipient / not-confirmed / amount-mismatch → NOT PAID, balance does not grow.
4. **Crediting without double counting:** the company balance grows by exactly the payableAmount of the confirmed payout (unit).
5. **Manual-confirm RBAC (integration 403):** SENIOR/DROP → 403; ADMIN/ACCOUNTANT → PAID. COMPANY_ACCOUNT credits, ADMIN_USDT/CASH — does not.
6. Idempotency: a repeated confirm does not double the balance.
7. eslint clean (mcp**eslint**lint-files); all unit+integration green on crm_qa; full api typecheck.

## Test discipline

Integration RBAC/on-chain against `crm_qa` (guard #233), asserts 403 + balance deltas. Mock Etherscan for the valid/invalid branches (do NOT hit the real blockchain). Real controller (via `@Inject`, NOT a sentinel mirror — lesson #227/#251). `DATABASE_URL= git push`.

## Worktree (FM-2)

Your worktree: `/Users/maksym/Desktop/programming/CheekyCheeseIT_CRM/.claude/worktrees/payout-rework`. ALL Edit/Write — INSIDE it (abs paths with `/.claude/worktrees/payout-rework/`). Do NOT write to main-repo paths. After the first edit `git -C <wt> status`. `pnpm -C <wt> install --frozen-lockfile` if there is no node_modules.

## Git

Branch `feature/payout-company-wallet` (created). Chunked `wip:`; final `ac_verified: 1,2,3,4,5,6,7`. `DATABASE_URL= git push`. PR to main. Do NOT merge.
IMPORTANT: the frontend of the payout dialogs (recipient wallet + on-chain status + manual-confirm button) is a SEPARATE task, do NOT touch apps/web (except an exhaustive stub if an enum forces it).
