---
name: ua-tax-compliance
description: When the Legal agent answers UA tax / company structure questions for the CRM founder — FOP regimes, TOV-Diia City, CFC rules, hybrid offshore structures, banking caps, mandatory audit. UA-specific knowledge not covered by ECC. Use in Mode A (consultation) before any company-structure advice + in Mode B (PR-review) when a PR touches payment/tax-related fields in users/transactions.
when_to_use: "Use when Legal advises on UA tax or company structure for the founder, or reviews a PR touching payment/tax fields. Examples: 'which FOP regime to choose', 'Diia City vs FOP', 'CFC rules', 'banking limits on the Single Tax', 'mandatory TOV audit', 'PR touches transactions/users tax fields'."
allowed-tools:
  - Read
  - Grep
  - Glob
---

# UA Tax Compliance (Legal knowledge primitive)

UA-specific tax / company structure knowledge. Lifted from `.claude/agents/memory/legal/lessons.md` (2026-05-31 consultations). NOT covered by ECC — this is jurisdictional knowledge.

**Disclaimer:** This skill is reference material for the Legal agent when formulating consultations. Each recommendation on a consultation output must have a stronger disclaimer + IT-corporate lawyer engagement for final sign-off (see the `legal-escalation-patterns` skill).

## When to invoke

- Before a Mode A consultation about company structure (FOP vs TOV vs offshore)
- Before a Mode A consultation about tax optimization
- Before a Mode B PR-review when a PR touches the finance/transactions/wallets/payouts modules
- When the user iterates over evasion variants (refer to `legal-escalation-patterns`)
- Before advising on banking setup

## Patterns

### 1. Tax on Withdrawn Capital 9% (Diia City resident) vs Single Tax 5% — break-even analysis

**Rule:** Tax on Withdrawn Capital 9% (Diia City) beats the Single Tax 5% (Single Tax FOP-3) even at small turnover at IT margins of 25-35% — 5% of turnover > 9% of profit in typical outsource structures.

**Break-even Single Tax vs Tax on Withdrawn Capital** = only at a margin ≥40-50% (unrealistic for IT-outsource).

**Decision rule:**

- An outsource company with a 25-35% margin → TOV-Diia City Tax on Withdrawn Capital wins already at mini-scale.
- A product company with a margin >50% → FOP-3 may remain optimal (but the banking cap 14.08.2026 blocker — see §6).

### 2. Startup resident of Diia City (24-month bridge)

**Rule:** A startup resident of Diia City gets 24 months of a preferential period **without** the requirement of 9 specialists / **without** €1200/month salaries — a critical bridge for a tech founder's launch.

**Pitfall:** A TOV older than 24 months **cannot** apply as a startup, only as a full resident immediately. Apply BEFORE active operations.

**Decision rule:** A new TOV founder → startup resident of Diia City immediately at registration, not later.

### 3. CFC (Controlled Foreign Company) — Art. 39² of the Tax Code of Ukraine

**Rule:** CFC fundamentals — a game-changer for UA residents: an offshore structure **does NOT mean** "do not pay into Ukraine".

**A UA PIT 18%+1.5% exemption from CFC profit** is possible only if:

- **(a)** there is a treaty Ukraine↔jurisdiction
- **AND (b)** the effective rate ≥13% OR passive income ≤50%

**For IT-outsource** the active income test PASSes, but documentation is needed. Without the exemption — the controller pays 19.5% PIT on all undistributed CFC profit even if a distribution did not occur.

**Decision rule:** Tax avoidance through offshore = a myth for UA residents. The real goal of offshore = client preferences / brand / FX hedging, **not** tax arbitrage.

### 4. Cyprus / UAE — FAIL on the CFC effective rate test

**Rule:** Cyprus 12.5% corp tax FAILS the UA CFC 13% effective rate test → the controller will always pay PIT at the UA level even with a Cyprus entity. UAE 0%/9% also FAILs on the rate.

**The active income exemption** — the only path, requires >50% IT services revenue + documentation. Do not present Cyprus as "will provide tax savings" — this is not so for a UA-resident UBO.

### 5. FOP-3 banking caps (NBU Memorandum 14.05.2026)

**Rule:** The NBU + AUB Memorandum + 29 banks of 14.05.2026 — structural banking caps for FOP-3 **independent of the Tax Code limits and crypto regulation**:

| Date       | Cap       |
| ---------- | --------- |
| 14.08.2026 | ₴3M/month |
| 14.11.2026 | ₴1M/month |

This cap — the banks simply will not process it. For a scale > ₴10M/year the FOP vehicle breaks not only on the tax side but also on the banking side.

### 6. FOP-3 + USDT — structurally impossible

**Rule:** FOP-3 + USDT in the contract for an IT-outsource scale (₴20-30M/year, a team) = **structurally impossible** due to 3 independent blockers:

1. **State Tax Service ban on crypto under the Single Tax** (barter → exclusion + 15% penalty)
2. **Tax limit ₴10.09M for 2026** (1167 minimum wages)
3. **Banking caps ₴3M/₴1M/month per the Memorandum 14.05.2026** (§5)

**Decision rule (bridge FOP → TOV):** A bridge is considered only under ALL conditions: NULL USDT, < ₴3M/month, no commingling with the TOV, ≤ 6 months hard cutoff. If one is not met — the bridge breaks.

**Recommended alternative:** TOV-Diia City startup resident immediately at mini-scale (₴30-50k setup) instead of a bridge FOP-USDT detour.

### 7. Mandatory audit of the Diia City report

**Rule:** The mandatory audit of the Diia City report — a **hidden cost** often missed in planning:

- Cost: ₴30-80k/year
- Deadline: by June 1 of year+1
- Form: [blank.dtkt.ua form 743](https://blank.dtkt.ua/blank/743)
- Non-submission = exclusion from the Diia City registry + retroactive recalculation to the general system.

**Decision rule:** Include in monthly accruals (₴3-7k/month) from the very start, not as an edge cost.

### 8. TOV-Diia City + WhiteBIT/Wise — effective tax / banking realities

**Effective consolidated tax burden of TOV-Diia City + WhiteBIT + Wise:**

- ~12-16% at 30% dividend / 70% reinvest
- ~8-10% at aggressive reinvest
- ~28-30% at 100% distribution (near parity with TOV-general)

**The architecture wins** through the 0%-on-reinvest mechanic, **not** through nominally low rates. Diia City is effective for **scaling companies**, not for cash-out.

**WhiteBIT Business KYB:** Officially 5 business days, **realistically 3-5 weeks** (RFI rounds + institutional onboarding).

**Wise Business for a UA legal entity:** Success rate variable (30-40% rejection). **Strategy:**

- Phase A: personal Wise founder
- Phase B: Wise Business after 3-6 months of TOV operations history

**Not all-eggs on Wise** — a backup via a direct UA bank USD subaccount is mandatory.

### 9. Transfer Pricing for a hybrid Diia City + offshore

**Rule:** TP is mandatory for any hybrid UA Diia City + offshore structure. Diia City does **NOT** exempt from TP rules (confirmed by the State Tax Service 2025). The 75% revenue criterion from January 1, 2025 makes us prima facie related parties.

**Decision rule:** TP documentation from the start — budget ₴30-50k/year fees.

### 10. Banking 2025-2026 for UA citizens — a bottleneck

**Rule:** Opening banking is a critical bottleneck. Verify banking **BEFORE** registering the company, not after.

**Realistic options (2025-2026):**

| Jurisdiction    | Bank                            | Reality                                      |
| --------------- | ------------------------------- | -------------------------------------------- |
| Estonia LHV     | —                               | Requires a face-to-face visit                |
| Cyprus Eurobank | —                               | 6-10 weeks enhanced DD                       |
| Hong Kong       | —                               | Practically closed since 2020                |
| UAE             | Emirates NBD / Mashreq via IFZA | Realistically opens                          |
| Georgia         | TBC                             | Realistically opens                          |
| Delaware LLC    | Mercury / Wise                  | Realistically opens                          |
| —               | Revolut                         | Closed the entire UA market in December 2025 |

### 11. Substance requirements — stricter since 2025

**Rule:** Substance requirements since 2025 are stricter everywhere (UAE MD 229/230, Cyprus IP Box DD, Estonia substance audits). A sham office / no employees = loss of all benefits + sham accusation risk.

**Decision rule:** Each jurisdiction with tax advantages requires a real office, real employees, real decision-making locally. Remote offshore from UA in 2025-2026 — **not working** for the larger jurisdictions.

### 12. Recharacterization risk — gig contracts → employment relationship

**Rule:** The main legal risk of moving to TOV-Diia City — **recharacterization of gig contracts into an employment relationship**. An internet template = +18% PIT + penalties for 3 years.

**Decision rule:** A specialized IT lawyer (₴15-30k one-time) is mandatory before launching Diia City. Saving on legal review = a potential loss of ₴1.5M/year.

## Anti-patterns

| ❌ Don't                                                   | ✅ Do                                                                                     |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Advise Cyprus 12.5% / UAE 9% as "tax savings" for a UA UBO | Explain the CFC effective rate test → Cyprus/UAE FAIL without the active income exemption |
| Skip the Diia City audit in the monthly accruals plan      | Include ₴3-7k/month from day-1 (mandatory)                                                |
| Advise FOP-3 + USDT for a team scale > ₴10M/year           | Hard refuse → TOV-Diia City startup resident                                              |
| Advise a bridge FOP → TOV without the 4 conditions check   | Verify NULL USDT + < ₴3M/month + no commingling + ≤ 6 months hard cutoff                  |
| Advise offshore without a TP documentation budget          | Include ₴30-50k/year TP fees + lawyer engagement                                          |
| Advise opening a bank AFTER company registration           | Verify banking BEFORE registration (KYC bottleneck)                                       |
| Advise remote offshore (without substance)                 | Substance requirements 2025 — real office + real employees + local decision-making        |
| Take an internet template for Diia City gig contracts      | IT-corporate lawyer (Juscutum / EQUITY / Avellum) review mandatory                        |

## References

- Source lessons (lifted 2026-06-03):
  - `.claude/agents/memory/legal/lessons.md` (2026-05-31 — 12+ substantive items #ua-fop #tax)
- Citations within patterns:
  - Art. 39² of the Tax Code of Ukraine (CFC rules)
  - NBU + AUB Memorandum 14.05.2026 (banking caps)
  - Form 743 / blank.dtkt.ua (audit form)
  - UAE MD 229/230 (substance)
- Related agent docs:
  - `.claude/agents/legal.md` Mode A (consultation)
- Related skills:
  - `ua-crypto-compliance` (related crypto/AML restrictions)
  - `ua-it-contract` (gig contracts recharacterization)
  - `legal-escalation-patterns` (hard refuse for evasion variants)
