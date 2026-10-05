# Phase 8 — "Company account" (product term: «Счёт компании») (USDT ERC-20) — BA brief / feature spec

**Status:** Draft for implementation (b0-deliverable of the 2026-06-17 planning cycle).
**Prerequisite:** b0b Legal pre-check (see §8) — MANDATORY before implementation starts (real USDT + dividends).
**Roadmap:** ADR `docs/architecture/2026-06-17-planning-audit-roadmap.md` Part 3(b), safety-gates Part 5.
**Replaces:** the cancelled smart contracts (Solidity PaymentSplitter / mainnet).

---

## 1. Essence

A single **company account** (a USDT ERC-20 wallet). SENIORs and DROPs transfer money to it and
send a **transaction link**; the system verifies the tx through Etherscan and credits the incoming amount to
the account balance. ADMINs spend from this account on salaries/expenses and withdraw **dividends**.
The ADMINs' 50/50 shares are preserved; a **shared company account** appears as a pool for expenses.

## 2. Owner decisions (2026-06-17) — fixed

| #   | Question             | Decision                                                                                                                                                                            |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Confirming incoming  | **Fully automatic.** tx confirmed (≥ block threshold) to the company address → credited immediately. No manual ACCOUNTANT step.                                                     |
| 2   | Wallet address       | **One shared address, in settings.** ADMIN edits it in the finance settings; changing the address requires confirmation (security).                                                 |
| 3   | Dividend calculation | **Free withdrawal, accounting after the fact.** ADMIN withdraws an arbitrary amount; the system records the movement + shares after the fact, with no "available to withdraw" gate. |

## 3. Incoming flow (automatic)

1. SENIOR/DROP sends USDT to the company address (outside the system, from their own wallet).
2. In the CRM: a "Confirm transfer" form — they paste the **transaction link** (or tx-hash).
3. The backend extracts the tx-hash and calls `etherscan.service.ts`:
   - tx found, recipient == company address, token == USDT ERC-20, **confirmed** (≥ block threshold) →
     **auto-credit** to the company account balance in the amount of the tx's actual on-chain value.
   - tx **pending** (found, but < block threshold) → the UI shows a **block-resolution progress bar**
     (current confirmations / threshold), the record is in the "processing" status, periodic re-poll.
   - tx not found / wrong recipient / not USDT → an error with a clear message, NO credit happens.
4. **Idempotency:** one tx-hash is counted EXACTLY once (UNIQUE + a check before writing) —
   resubmitting the same link does not duplicate the incoming amount.

## 4. Expenses / dividends flow

- **Expenses (shared account):** ADMIN spends from the company account on salaries (the existing SALARY flow) and
  other expenses. A debit reduces the account balance.
- **Dividends:** ADMIN initiates a withdrawal of an arbitrary amount as dividends; the system records the movement,
  reduces the balance, and keeps the 50/50 share accounting after the fact. No auto-reserve/gate (decision #3).

## 5. Data model (sketch — finalized in b1)

- `company_account` — balance (or computed from the ledger), wallet address (a setting), currency.
- Inbound deposits — `txHash` (UNIQUE), sender (SENIOR/DROP), amount, status
  (`PENDING_CONFIRMATION | CONFIRMED | FAILED`), confirmations, verified-via-Etherscan timestamp.
- Outbound — withdrawals/dividends/expenses (type, initiator ADMIN, amount, link to shares).
- **Legacy revision:** what to do with `payout_requests` / `pending_obligations` /
  `seniorSharePercent` / `dropSharePercent` / USDT wallets in `project_finance_settings` — to be decided
  in b1 (reuse / migrate / deprecate). Do NOT break the existing finance model blindly.

## 6. RBAC (separation-of-duties)

- **Accepting incoming (submit tx):** SENIOR, DROP (their own transfers). The auto-credit is done by the system.
- **Withdrawing dividends / expenses from the account:** **ADMIN** only. ACCOUNTANT sees/controls, but **does not withdraw**
  (cf. security MED #222 SALARY self-pay — do not let the withdrawal initiator be uncontrolled).
- **Wallet address (setting):** changing it — ADMIN only, with step-up confirmation.
- All new endpoints (submit-tx, withdraw, settings) → **a real backend 403 guard test** (FM-5 gate d1).

## 7. Acceptance criteria (draft — detailed in the task files)

1. Auto-credit fires ONLY on a confirmed tx to the company address; pending → progress bar, not balance.
2. Idempotency: resubmitting the same tx-hash does not duplicate the incoming amount (integration test).
3. Dividends/expenses: ADMIN only (backend 403 for non-ADMIN — integration test).
4. Changing the wallet address: ADMIN only + confirmation; audit record.
5. Etherscan unavailable/timeout → graceful (the progress bar does not hang; a "retry" status).
6. Design of the block-resolution progress bar + the account page — Mode A (ui-ux-designer) before layout.
7. The ADMINs' 50/50 shares are preserved in accounting; the shared account is correctly reduced by expenses/dividends.

## 8. Prerequisite — Legal pre-check (b0b, MANDATORY before implementation)

A company that is a USDT custodian (accepting from contractors) + ADMIN dividends → UA crypto/VASP/AML + tax
qualification of dividends. Skills: `ua-crypto-compliance` + `ua-tax-compliance`. Law 2074-IX is not in force,
the DPS (tax service) prohibition of crypto on the single-tax payer regime (original: ЄП). Money-movement = **human + legal** (rule). Implementation of the money-flow starts
only after the Legal verdict.

## 9. Open questions for b1 (clarify during design)

- Confirmation threshold (default candidate: 12 ETH blocks) — to be confirmed.
- Network: USDT ERC-20 = Ethereum mainnet (we read others' transfers; we do NOT deploy a contract). Etherscan API mainnet.
- Balance: a stored aggregate or computed from the ledger (ledger preferred — auditability).
- What to show SENIOR/DROP about their past transfers (history + statuses).

## 10. Out of scope

- Any on-chain smart contract / autonomous split (cancelled).
- Automatic sending of USDT from the system (withdrawal is a manual ADMIN action outside the network; the system records the fact).
- Mainnet deploy / audit / multisig (not applicable — no contract of our own).
