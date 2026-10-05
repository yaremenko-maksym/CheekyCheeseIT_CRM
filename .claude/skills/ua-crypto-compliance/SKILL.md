---
name: ua-crypto-compliance
description: When the Legal agent advises on USDT / crypto payouts in CRM Phase 8 (smart contracts) or when reviewing PRs touching wallets/transactions. UA-specific snapshot — Law 2074-IX status (NOT in force, awaiting 10225-d), AML thresholds (Law 361-IX), the State Tax Service ban on crypto under the Single Tax. Use in Mode A consultation about the crypto channel + Mode B PR-review.
when_to_use: "Use when Legal advises on USDT / crypto payouts (Phase 8 smart contracts) or reviews a PR touching wallets/transactions. Examples: 'can we pay in USDT', 'VASP license', 'AML thresholds', 'is crypto banned under the Single Tax?', 'status of law 2074-IX', 'PR touches walletAddress/smart-contract'."
allowed-tools:
  - Read
  - Grep
  - Glob
---

# UA Crypto Compliance (Legal knowledge primitive)

UA-specific crypto / virtual assets / AML knowledge for CRM Phase 8 (Smart Contracts USDT). NOT covered by ECC. Lifted from `.claude/agents/memory/legal/lessons.md` (#usdt #aml items).

**Disclaimer:** Legal vacuum status. Any production crypto channel = legal risk. This skill is reference material; final sign-off — IT-corporate lawyer.

## When to invoke

- Before a Mode A consultation about smart contracts / USDT payouts
- Before a Mode B PR-review on any changes in wallets / transactions / smart contracts / payouts
- When a user iterates over cash/USDT channel variants
- When discussing wallet field changes in the users profile (Phase 7)

## Patterns

### 1. Law 2074-IX "On Virtual Assets" — status

**Rule:** Law 2074-IX was adopted **17.02.2022** but **is NOT in force** — awaiting amendments to the Tax Code (bill 10225-d).

**Timeline of 10225-d:**

- First reading: **03.09.2025**
- Planned activation: **01.01.2026**

**Decision rule:** Any production crypto channel right now = legal vacuum + risk of a State Tax Service adjustment of the financial result. Crypto features = `feature_flag: false` until the actual activation of 10225-d.

**In CRM:** Phase 8 (smart contracts) is developed in test mode / on testnet, production rollout — after the activation of 10225-d OR explicit legal sign-off from an IT-corporate lawyer.

### 2. AML Thresholds (Law 361-IX)

**Rule:** Financial monitoring crypto thresholds — **UAH 30k (~$720) per transaction** triggers a screening obligation per Law 361-IX.

**Decision rule:** For typical IT outsource payouts this threshold is exceeded practically always → without KYC procedures = AML risk on every transaction.

**Mechanism for CRM:**

- Every crypto transaction > UAH 30k eq. → must capture KYC data (source of funds, beneficiary owner ID).
- A smart contract does not exempt from KYC — the banking layer (cash-out) still requires it.

### 3. State Tax Service ban on crypto under the Single Tax (FOP-3)

**Rule:** The State Tax Service officially banned crypto income under the Single Tax (FOP-3). Crypto = barter → exclusion + 15% penalty.

**Decision rule:** FOP-3 + USDT in the contract = an autopath to exclusion from the Single Tax. Do not propose as a solution even for short bridges.

**Real impact:** If a user receives USDT as FOP-3 — this is an auto-risk of reclassification + retroactive recalculation to the general system of 18% personal income tax + a 15% penalty.

### 4. Multi-issuer / cash-channel — hard refuse zone

**Rule:** A multi-issuer scheme (cash/crypto paid to an entity ≠ the main company) = a **pattern of tax evasion**, Art. 212 of the Criminal Code of Ukraine at the threshold of ₴4.99M (easily exceeded at our turnover).

**Hard refuse zone** — § 1 of escalation-zones.md. Never recommend; on a user assumption of such a format — refuse explicitly + escalate to a criminal defense lawyer.

**A cash channel in IT-outsource** is practically impossible legally:

- NBU limit ₴10k/day B2B (Resolution No. 148)
- Prohibition of FX-cash with non-residents (NBU Resolution No. 5 of 24.02.2022)

**Decision rule:** With users who want cash in the architecture — categorically rule it out at the project level, do not try to optimize.

### 5. Wallet field changes — minimal trigger for a crypto compliance review

**Rule:** Any PR touching a wallet field in the users profile (Phase 7) — required Legal Mode B review.

**Why:** A wallet = an identifier for the crypto channel. Changing the wallet + preserving history = an audit trail for Mode B. If the wallet is changed without consent re-confirm — GDPR Art.6 violation (lawful basis missing).

**Decision rule (Mode B):**

- PR touches `users.walletAddress` → Mode B with a crypto-specific checklist.
- PR adds a wallet update flow → requires consent re-confirmation UI + audit log entry.

## Anti-patterns

| ❌ Don't                                            | ✅ Do                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| Advise USDT payout as a production-ready solution   | Explain Law 2074-IX status + feature_flag false until 10225-d activation |
| Skip KYC for crypto transactions < UAH 30k          | Capture source of funds anyway (audit-ready)                            |
| Advise FOP-3 + USDT as a "legal bridge"             | Hard refuse — State Tax Service ban + 15% penalty                       |
| Consider multi-issuer cash/crypto schemes           | Hard refuse + escalate to a criminal defense lawyer                     |
| Advise a cash-channel in IT-outsource               | Hard refuse — NBU limit ₴10k/day + prohibition of FX-cash with non-residents |
| Change the wallet field without a consent re-confirmation flow | Require a consent re-confirm UI + audit log entry before production deploy |

## References

- Source lessons (lifted 2026-06-03):
  - `.claude/agents/memory/legal/lessons.md` (2026-05-31 — 4 substantive items #usdt #aml)
- Citations within patterns:
  - Law 2074-IX "On Virtual Assets" (17.02.2022, not in force)
  - Bill 10225-d (first reading 03.09.2025)
  - Law 361-IX (financial monitoring threshold UAH 30k)
  - Art. 212 of the Criminal Code of Ukraine (tax evasion threshold ₴4.99M)
  - NBU Resolution No. 148 (cash NBU limit)
  - NBU Resolution No. 5 (24.02.2022 prohibition of FX-cash with non-residents)
- Related skills:
  - `ua-tax-compliance` (FOP/TOV structure context)
  - `ua-it-contract` (wallet/payment requisites in contracts)
  - `legal-escalation-patterns` (hard refuse zone handling)
- Related agent docs:
  - `.claude/agents/legal.md` Mode A + Mode B
  - `.claude/agents/legal-escalation-zones.md` (if existing)
