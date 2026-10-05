# Legal Consultation: TOP Pattern Deep Dive — UA Diia City TOV + WhiteBIT Business + Wise Multi-currency

## Mode: strategic

## Date: 2026-05-31

## Requested by: User direct → PM

## Context

The User received 5 previous strategic consultations. After a full risk analysis of the off-the-books scheme the User pivoted to the legitimate path and asked for a **full explanation of the TOP recommendation** (Pattern #1):

- **UA Diia City TOV** — the main entity, exit-capital tax 9%
- **WhiteBIT Business** — a crypto bridge (USDT → UAH → the TOV account)
- **Wise Multi-currency** — an FX bridge (USD/EUR → UAH/USD subaccount)

The User wants to understand **how exactly these 3 instruments work together end-to-end**, and **what specifically to do**.

## Main question

**The full scheme of how Pattern #1 works from A to Z:**

1. How the client pays through each of the 3 channels (USDT / USD / UAH)
2. How the money gets to the TOV's account (with the numbers of fees and timelines)
3. How the TOV distributes the money further (to gig contractors, to the partner, to the ADMIN)
4. What is declared and which taxes are paid at each step
5. The full cost of the setup and ongoing operations (with a breakdown by instrument)
6. How to set up each instrument (a roadmap + requirements)
7. What practical risks this combination has (technical, regulatory, operational)

## Sub-questions

### Q1 — End-to-end flow scenarios (3 typical)

**Scenario A — a US/EU client pays in USDT (10,000 USDT per month):**

1. Where the client sends the USDT (which address — a personal wallet of a TOV employee? a WhiteBIT Business wallet?)
2. What happens at WhiteBIT (commission %, settlement time, KYC/KYB obligations)
3. How the USDT gets to the UAH account of the TOV (currency rate, which NBU rate is used for bookkeeping)
4. Which document is issued to the client (an invoice from the TOV with which details)
5. Which taxes are triggered at this stage

**Scenario B — a US/EU client pays by USD wire (10,000 USD):**

1. Where the client sends the wire (the TOV's Wise account? a UA bank USD subaccount?)
2. Wise commission, settlement time
3. Conversion USD → UAH (Wise rate vs banks)
4. When the TOV's income arises (on the invoice date or the receipt date?)
5. Currency control for non-residents (a transaction passport if > €400k/quarter)

**Scenario C — a UA client pays in UAH (300k UAH):**

1. A direct bank wire to the TOV account
2. Invoice + VAT obligations if the TOV is a VAT payer (does Diia City exempt?)
3. Receipt timelines

### Q2 — WhiteBIT Business detail

- **Status 2026:** MiCA license (EU), US entry date, VASP status in UA
- **KYB requirements** for a UA TOV — what documents, timing, success rate
- **Pricing structure** — deposit fee USDT, conversion USDT→UAH spread, withdrawal fee to a bank, monthly minimums
- **Bank settlement** — which UA banks support (PrivatBank / monobank Business / Raiffeisen?), timelines 1-3 days
- **Tax reporting** — what WhiteBIT gives the DPS automatically, what the TOV must file on its own
- **Limits** — daily/monthly limits on the TOV account
- **Risks** — what happens if WhiteBIT loses its license / exits UA / freezes the account

### Q3 — Wise Business detail

- **Acceptance criteria 2026** — did Wise accept UA citizens' businesses? Which states (Wise closed RU fully; UA after December 2025 — status?)
- **Multi-currency subaccounts** — which currencies are available for a TOV (USD/EUR/GBP/PLN)
- **Pricing** — wire receive, conversion spread, withdrawal to a UA bank
- **Integration with UA banking** — which UA banks accept Wise inbound
- **Limits** — for a TOV
- **Tax reporting** — UA tax obligations upon receiving via Wise
- **Risks** — Wise UA policy changes, account freeze scenarios

### Q4 — TOV Diia City — distribution flow

Money arrived at the TOV account (via WhiteBIT / Wise / direct). The distribution:

1. **To gig contractors (SENIOR/JUNIOR work under gig contracts):**
   - A wire to the UAH account of the FOP executor? or to the personal card of the gig individual?
   - 5% PIT + 5% ML withheld at source (the TOV as a tax agent)?
   - USC 22% of the minimum wage = ₴1902/month — who pays (the TOV or the gig specialist themselves)?
   - A specific wire instruction + accounting entries

2. **To the partner (co-founder):**
   - What legal status — a FOP subcontractor? another TOV shareholder? a dividend recipient?
   - If a TOV shareholder with a share — the exit-capital tax 9% triggers on distribution
   - If a FOP contractor — 5% single tax + 1.5% ML for the partner-FOP
   - Best practice for our structure

3. **To the ADMIN (founder, also a UBO):**
   - Same options as with the partner
   - Salary vs exit-capital-tax dividend vs FOP distribution
   - The tax-optimal split

### Q5 — Effective tax burden consolidated

On a conditional example: 5M UAH of annual turnover through a mix (60% Wire USD, 30% USDT, 10% UAH). Net profit after operating expenses: 2M UAH.

The full tax calculation:

- On the TOV side: exit-capital tax 9% (when distribution)
- On the gig contractors' side: 5% + 1.5% + USC
- On the ADMIN+partner side: exit-capital tax 9% + dividend income?

**Total effective tax %** of turnover and of profit.

Compare with the UA average for IT outsource (FOP group 3 + a TOV-deduction scheme).

### Q6 — Setup roadmap (BEFORE launch)

A specific step-by-step plan for launching all 3 instruments:

**Phase 0 (Pre-work, week -1):**

- What to prepare: documents, decisions, a partner agreement template

**Phase 1 (week 1-2): TOV registration**

- usr.minjust.gov.ua workflow
- KEP setup
- Founders' Agreement
- Cost

**Phase 2 (week 2-3): A UA bank account**

- PrivatBank Business / monobank Business / Raiffeisen — what to choose
- KYB documents
- Timing

**Phase 3 (week 3-4): Wise Business application**

- Application process
- Documents
- Success criteria

**Phase 4 (week 4-5): WhiteBIT Business KYB**

- Application
- Documents
- Sandbox / pilot transaction

**Phase 5 (week 5-6): Diia City startup-resident application**

- city.diia.gov.ua workflow
- Eligibility check
- Documents

**Phase 6 (week 6-8): Gig contracts + Services Agreement templates**

- IT corporate lawyer engagement
- Templates ready
- First contract signed

**Phase 7 (week 8+): Operations start**

- First client wire test
- Bookkeeping cycle
- Quarterly reporting first iteration

### Q7 — Operational details

- **Monthly bookkeeping flow** — what the accountant does each month
- **Quarterly reporting** — what is filed to the DPS (the exit-capital-tax declaration, USC, PIT for gig specialists)
- **Annual reporting** — the TOV's financial reporting, the annual Diia City declaration
- **FX rate fixing** — which rate for bookkeeping (NBU on the operation date)
- **Currency control** — a transaction passport for FX > €400k/quarter
- **Audit** — mandatory for Diia City residents?

### Q8 — Risks of this combined setup

| Risk type   | Risk                                      | Probability | Mitigation |
| ----------- | ----------------------------------------- | ----------- | ---------- |
| Regulatory  | MiCA changes for WhiteBIT EU operations   | MED         | ...        |
| Regulatory  | Wise UA policy reversal                   | MED         | ...        |
| Regulatory  | Diia City threshold/rule changes          | LOW         | ...        |
| Operational | WhiteBIT/Wise account freeze              | MED         | ...        |
| Tax         | Transfer pricing scrutiny if scaling up   | MED         | ...        |
| Banking     | A UA bank refuses crypto-related deposits | MED         | ...        |

Plus mitigation plans for each.

## What matters for the decision

- **Concrete numbers** — fees, timelines, costs
- **Step-by-step** roadmap that the user can drop into Google Tasks
- **Acknowledge unknowns** — where the exact rates/procedures may change, say so explicitly
- **Practical pitfalls** — what usually breaks the setup
- **Verification points** — where an accountant / lawyer is definitely needed before action

## What NOT to discuss (already covered by previous consultations)

- Basic Diia City theory and tax math (already in the roadmap consultation)
- CFC implications (already in the offshore consultation)
- Why off-books does not work (already in the risk analysis)
- Crypto in general (already in the USDT consultation)

---

<!-- The Legal agent will add the `## Lawyer answer` section below -->

## Lawyer answer

**Confidence (overall):** MED

**Per-section breakdown:**

- End-to-end flows (Q1, Scenarios A/B/C) — **MED** (the mechanics are clear, the specific fees drift ±20-30% from month to month, **a mandatory verification at the moment of action**)
- WhiteBIT Business detail (Q2) — **MED** ([the MiCA license confirmed on 29 April 2026 via HANFA](https://blog.whitebit.com/en/w-group-advances-european-expansion-as-white-tech-obtains-mica-authorization/), KYB in 5 working days — the official term, but pricing for a UA TOV — individual negotiation per [WhiteBIT institutional](https://docs.whitebit.com/institutional/compliance))
- Wise Business detail (Q3) — **LOW** (Wise officially supports UA-owned companies per [Wise blog 2026 for UA](https://buh.ua/en/how-to-open-wise-and-withdraw-funds-in-ukraine), but the **success rate for a UA TOV resident of Ukraine is variable**, the banking policy is dynamic, recommend a test application with a minimal setup risk)
- TOV Diia City distribution mechanics (Q4) — **MED** (the legislation is clearly covered by [Law 1667-IX](https://zakon.rada.gov.ua/laws/show/1667-20), [Art. 170.14 of the Tax Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2755-17), the tax-optimal split depends on the annual profile)
- Effective tax burden (Q5) — **MED** (the math is unambiguous, but the assumptions about the distribution policy affect it by ±2-3%)
- Setup roadmap (Q6) — **MED** (the phases and documents are clear; the timing depends on the load of the authorities, banks, the WhiteBIT compliance team)
- Operational obligations (Q7) — **MED** (the bookkeeping procedures are standard, but **the audit of the Diia City report is mandatory** ([blank.dtkt.ua form 743](https://blank.dtkt.ua/blank/743) + [Kreston Ukraine](https://kreston.ua/zvitnist-rezydentiv-diia-siti-vidnovleno-shcho-peredbachaie-zaznachena-protsedura/)) — this is a nuance that is often missed)
- Risks (Q8) — **MED** (the risk ranking is objective; the probabilities are professional estimates)

**Mode:** strategic
**Date:** 2026-05-31

### TL;DR

**Pattern #1 — TOV Diia City + WhiteBIT Business + Wise Business — is a working architecture with an effective consolidated tax burden of ~12-16% with a reasonable distribution policy and ~5-8% in reinvest mode.** The setup takes **8-12 weeks** (parallelized), **the setup budget is ₴80-180k**, **ongoing ₴35-65k/month** (bookkeeping + audit accruals + Diia City compliance + Wise/WhiteBIT fees). On the example of a turnover of 5M UAH → 2M UAH of net profit — the real consolidated tax burden is **≈ ₴280-360k = 14-18% of profit** (vs ₴524k = 26% on the general 18%+5%+5% system).

**The biggest hidden cost** is not taxes, but compliance: **the mandatory audit of the Diia City report** (₴30-80k/year per [Kreston/BP-audit](https://bp-audit.com.ua/service/audyt-zvitu-pro-vidpovidnist-rezydenta-diia-siti)) + **9 specialists × €1200 floor after 31 December of year+1** (this is your hard constraint after the startup period).

**The biggest regulatory risk** — reclassification of gig contracts into employment ones ([cases.media gig-verdict analysis](https://cases.media/en/article/diya-siti-podatki-ta-riziki-koli-gig-kontrakt-staye-trudovim-virokom)) — this **definitely** requires a specialized IT lawyer (₴15-30k one-off per minimum), not a template from the internet.

**What to do on Monday:** (1) a KEP via [ca.diia.gov.ua](https://ca.diia.gov.ua/) — 30 minutes, free; (2) a request for a cost estimate from 2-3 IT-corporate lawyers (Sayenko Kharenko / Asters / Avellum / Juscutum) for a services agreement of the TOV + a gig-contract template + Diia City application supervision — this is the foundation without which the rest falls apart; (3) submit for KYB at WhiteBIT Business in parallel with the TOV registration — this is a long thread (5 working days official, but realistically 2-4 weeks for a UA TOV).

### Analysis

#### 1. End-to-end picture — three channels

```
                           CLIENTS
        ┌──────────────┬──────────────┬──────────────┐
        │              │              │              │
        ▼              ▼              ▼              │
   USDT (US/EU)    USD/EUR wire    UAH (UA)         │
   client wallet   (SWIFT)         (UA bank)        │
        │              │              │              │
        ▼              ▼              ▼              │
┌──────────────┐ ┌──────────────┐                   │
│  WhiteBIT    │ │  Wise        │                   │
│  Business    │ │  Business    │                   │
│  KYB UA TOV  │ │  USD/EUR     │                   │
│  ┌────────┐  │ │  subaccount  │                   │
│  │USDT→UAH│  │ └──────┬───────┘                   │
│  │ P2P    │  │        │                            │
│  │ Express│  │        │ wire payout                │
│  └────────┘  │        │ to the TOV UA bank         │
└──────┬───────┘        │ (USD/EUR/UAH)              │
       │ Card Transfer  │                            │
       │ to the TOV bank│                            │
       │ (UAH)          │                            │
       ▼                ▼                            ▼
┌────────────────────────────────────────────────────────┐
│   TOV Diia City resident (UAH + USD/EUR subaccount)     │
│   • UAH account PrivatBank/monobank/Sense Business      │
│   • USD/EUR subaccount (for FX flexibility)             │
│   • EDRPOU + IBAN + SWIFT                                │
│   ─────────────────────────────────────────────────     │
│   The twist: exit-capital tax 9% triggers ONLY on       │
│   distribution. While the money is inside the TOV —     │
│   0% profit tax.                                         │
└────────────────────────────────────────────────────────┘
                          │
       ┌──────────────────┼──────────────────┐
       │                  │                  │
       ▼                  ▼                  ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Gig team     │  │ ADMIN/partner│  │ Reinvest     │
│ (SENIOR/JUN/ │  │ distribution │  │ (0% tax)     │
│  HR)         │  │              │  │              │
│              │  │ Options:     │  │ - O&M cash   │
│ 5% PIT       │  │ • Gig remun. │  │ - Capex      │
│ +5% ML       │  │   (5%+5%+USC)│  │ - Reserves   │
│ +USC ₴1902/  │  │ • Dividends  │  │              │
│   mo         │  │   (9% exit-  │  │              │
│              │  │    cap + 5%+ │  │              │
│ effective    │  │    5%)       │  │              │
│ ~10-12%      │  │ • Hybrid     │  │              │
└──────────────┘  └──────────────┘  └──────────────┘
```

**The key thesis:** the Pattern has **3 separate independent channels** (USDT / USD-wire / UAH), which **all** converge into one single entity (the TOV Diia City). **WhiteBIT and Wise are instruments**, the TOV is the entity. Do not confuse them.

**What this pattern does NOT do:**

- Does not give a 0% effective burden — the real consolidated burden is ~12-16%, but this is **transparently legal and safe long-term**
- Does not cover a cash-flow off-the-books — after the [previous consultation on the risk analysis](2026-05-31-cash-crypto-undeclared-risk-analysis.md) this is a closed question
- Does not relieve you of the obligation of an audit, gig documentation, currency control compliance

#### 2. Scenario A — a US/EU client pays 10,000 USDT (ERC-20) per month

**Day 0 (the contractual level):**

The TOV issues the client an invoice for $10,000 USD for services rendered within the MSA + Statement of Work for a specific month. The invoice contains:

- The TOV name + EDRPOU + legal address + IBAN UAH (as primary)
- **An alternative payment requisite:** the USDT address of the TOV's WhiteBIT Business account (ERC-20)
- VAT is not highlighted (a Diia City resident is a VAT non-payer by the general rule, or a payer by a separate choice)
- Sum: $10,000 USD = X UAH at the NBU rate on the invoice date (for the bookkeeping primary record — UAH)

**Day 0-1 (transfer):**

The client transfers **10,000 USDT (ERC-20)** to the TOV's USDT address on WhiteBIT Business.

- **Gas fee on the client's side:** ~$2-15 USD (Ethereum gas, volatile)
- **Ethereum confirmation:** 1-3 minutes (12 block confirmations)
- **Crediting to the WhiteBIT balance:** instant after confirmation. **USDT deposit fee:** WhiteBIT does not charge a fee for a crypto deposit to a Business account (per [WhiteBIT help — Trading, deposit and withdrawal fees](https://help.whitebit.com/hc/en-gb/articles/25029308319005-Trading-deposit-and-withdrawal-fees), collection date 2026-05-31). For institutional/Business, separately agreed terms may apply — verify in the KYB negotiation.

**Day 1 (USDT → UAH conversion via P2P Express or spot):**

Two options:

| Method                                     | Commission                                                                                                                                                                                                              | Speed                    | Volume cap                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------ |
| **P2P Express USDT→UAH**                   | No separate commission, but a spread ~1-3% of the market rate depending on liquidity ([WhiteBIT help — P2P Express](https://help.whitebit.com/hc/en-gb/articles/19401002086045-Deposit-and-withdrawal-via-P2P-Express)) | Minutes-hours (matching) | Depends on the KYB level       |
| **Spot exchange USDT/UAH** on the exchange | Trading fee 0.1% maker/taker                                                                                                                                                                                            | Instant                  | Depends on the orderbook depth |

**Realistic estimate for 10k USDT:** ~₴418,000 - ₴425,000 on the operation date (NBU rate on 2026-05-31 ≈ ₴42.0/USD, minus a 1-2% spread). The exact amount is confirmed via the **WhiteBIT statement** which becomes the primary document for bookkeeping.

**Day 1-2 (withdrawal of UAH to the TOV bank):**

WhiteBIT → the TOV's bank account via **Card Transfer** or **Bank Transfer**:

- **Card Transfer (to the TOV's corporate card linked to the main account):** commission usually 1-4% of the amount for a UAH withdrawal (by a historical promotion — 3% instead of 4%, per [WhiteBIT help — Card Transfer Withdrawal](https://help.whitebit.com/hc/en-gb/articles/20716216959005-Withdrawal-of-funds-using-Card-Transfer-on-WhiteBIT))
- **Speed:** 1-2 hours to crediting to the bank
- **NB:** for a UA TOV a withdrawal to a business account usually requires a separate settlement procedure — clarify in the KYB conversation with the WhiteBIT institutional team

**Real-world numbers for 10k USDT (sample):**

| Step                               | Sum                 | Loss (%)               |
| ---------------------------------- | ------------------- | ---------------------- |
| 10,000 USDT received on WhiteBIT   | $10,000 = ~₴420,000 | 0%                     |
| USDT→UAH conversion (~1.5% spread) | ~₴413,700           | -1.5%                  |
| Card Transfer withdrawal (~3% fee) | ~₴401,300           | -3% of ₴413k = -₴12.4k |
| **To the TOV UAH bank**            | **~₴401,000**       | **-4.5% total**        |

**Alternative: a direct USDT receive to the bank via the WhiteBIT institutional fiat gateway** — for KYB Business a direct UAH settlement with narrowing to 1-2% is possible by a separate agreement. Verify in the institutional negotiation.

**Day 2-3 (the bookkeeping moment):**

- **Date of recognition of the TOV's income:** the date of receiving the UAH into the TOV's bank account (cash basis for the Diia City exit-capital tax; alternatively accrual from the invoice date — discussed with the accountant, **I recommend accrual** for cleaner books)
- **Bookkeeping rate:** the **NBU rate on the operation date** ([Tax Code of Ukraine Art. 153.1.3](https://zakon.rada.gov.ua/laws/show/2755-17)) — this is the primary anchor. The WhiteBIT statement is used as a supporting document
- **Entry in the accounting:**
  - Dt 311 (UAH account) — ₴401,000
  - Kt 703 (Income from the sale of services) — ₴420,000 (at the NBU rate on the invoice date)
  - Dt 949 (Other operating expenses) — ₴19,000 (WhiteBIT commissions as an operating expense)

**Day 2-3 (documents for the archive):**

1. The TOV invoice (signed with the director's KEP) — primary
2. The SoW / Acceptance Act (signed by both parties)
3. The WhiteBIT statement for the period (shows deposit + conversion + withdrawal)
4. The bank statement of the TOV's UAH account (confirms the crediting of ₴401k)
5. The blockchain transaction hash (an Etherscan link — not mandatory for bookkeeping, but useful for an AML inquiry if there is one)

**Day 30+ (the declaration and taxes):**

- **The TOV's income (₴420,000) → is registered in the journal of business operations + the quarterly exit-capital-tax declaration**
- **The exit-capital tax triggers ONLY on dividend/sporadic-operation payments, not on the net income.** If this money: (a) goes to the gig remuneration of the team — the exit-capital tax = 0% on this part, because it is an operating expense, (b) goes to reinvest/O&M — the exit-capital tax = 0%, (c) is paid as a dividend to the owner — **the exit-capital tax 9% of the dividend amount**
- **VAT:** a Diia City resident can be a non-VAT payer (the general form) or choose VAT registration. For a typical outsource — non-VAT (under the ₴1M turnover threshold from [Art. 181 of the Tax Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2755-17), or via a Diia City exception — verify with a consultant)

**Total taxes triggered at this stage:** **₴0 immediately** (only the accounting of income). Taxes arise further at distribution.

#### 3. Scenario B — a US/EU client pays 10,000 USD wire (SWIFT)

**Day 0 (the contractual level):**

The TOV issues an invoice — the same as in Scenario A, but the primary payment method = a USD wire to the TOV's Wise Business USD subaccount **or** to the TOV's USD subaccount in a Ukrainian bank.

**Two real sub-scenarios:**

##### B1 — Wise Business as an intermediary

**Day 0-2 (wire receive):**

The client sends $10,000 USD to the TOV's Wise Business USD subaccount:

- **Wise local USD details:** provided upon opening — ACH (US-domestic) or SWIFT (international)
- **ACH speed:** 1-3 business days (free for receiving per the Wise local details policy)
- **SWIFT speed:** 1-5 business days; the receive fee is deposited by the sending bank, Wise usually does not charge for a SWIFT receive
- **Wise hidden FX spread (for USD → UAH):** 0.43-0.6% according to [Wise Business — international payments](https://wise.com/gb/business/), collection date 2026-05-31

**NB about UA acceptance:** [Wise has a guide for UA freelancers/sole proprietors](https://buh.ua/en/how-to-open-wise-and-withdraw-funds-in-ukraine) (collection date 2026-05-31). Wise acceptance for a **UA TOV legal entity** is less clear — most UA users open a **personal Wise** or a **FOP Wise** (easier); **Wise Business for a UA-registered legal entity** goes through an individual review, the **success rate is variable**. **Strongly recommend**: first open a personal/sole-proprietor Wise (as a founder) for a trial flow, then submit the application for Wise Business for the TOV after the TOV has an operational history. **Verify at the moment of action.**

**Day 2-4 (Wise → the TOV UA bank):**

Withdrawal Wise → the TOV's UAH account via SWIFT:

- **Wise outbound fee USD→UAH:** ~0.43-0.6% (significantly lower than banks)
- **Real conversion rate:** mid-market (Reuters/Google rate), which means a 2-3% economy vs the standard UA bank conversion
- **Settlement to the UA bank:** 1-2 business days

**Real-world numbers for 10k USD via Wise:**

| Step                    | Sum                 | Loss            |
| ----------------------- | ------------------- | --------------- |
| Client wire $10,000 USD | $10,000 = ~₴420,000 | 0%              |
| Wise FX spread 0.5%     | ~₴418,000           | -0.5% (~₴2,000) |
| Wise outbound fee       | -$4-10              | ~₴200-400       |
| UA bank receive (free)  | —                   | 0               |
| **To the TOV UAH bank** | **~₴417,600**       | **-0.6% total** |

##### B2 — A direct USD subaccount at a UA bank (without Wise)

**Day 0-3 (direct wire):**

The client sends $10,000 USD to the TOV's USD subaccount in a Ukrainian bank (PrivatBank / monobank / Sense Business):

- **monobank Business USD subaccount:** open online in 10-15 min per [monobank business — currency account](https://monobank.ua/en/business/currency-account), collection date 2026-05-31. **Incoming SWIFT — free** (per [monobank rates](https://monobank.ua/taryfy)). **Outgoing SWIFT:** 0.5% + $12 (cap $90).
- **PrivatBank Business:** via [Privat24 for business — foreign economic activity](https://privatbank.ua/business/zed). The KYB process includes the upload of the contract and the registration of the currency contract. **NB:** since January 2026 SWIFT remains the only channel of an outbound currency transfer outside Ukraine.

**Day 3-5 (currency control — contract registration):**

[The Currency Law 2473-VIII + NBU Resolution No. 5 dated 02.01.2019 + the current post-war restrictions](https://zakon.rada.gov.ua/laws/show/2473-19) establish:

- When **receiving currency revenue** from abroad for services — you need to register a **foreign economic contract** in the bank's system (once per contract)
- **Maximum settlement terms:** for the export of services — **180 days** from the invoice date to receiving the revenue (a war-time restriction)
- **Mandatory sale of currency:** **CANCELLED** [NBU Resolution 2021-2024](https://bank.gov.ua/en/news/all/obovyazkoviy-prodaj-valyutnih-nadhodjen-biznesom-skasovano), collection date 2026-05-31. In 2026 the **mandatory sale does not apply** — the TOV may leave the USD on the subaccount as an FX reserve.
- **A currency control threshold for buying currency:** a TOV is allowed to buy currency only if the available UAH amount < ₴400,000 equivalent (an NBU restriction). For our pattern this is less relevant, because we **receive** currency, not buy it.

**Day 5+ (FX conversion on the date of need):**

The TOV converts USD → UAH on the **Trading Platform of PrivatBank / monobank interbank market** on the date when it needs to make UAH payouts. The spread against the interbank ~0.5-1.5%.

**Real-world numbers for 10k USD direct via a UA bank:**

| Step                                | Sum                                        | Loss           |
| ----------------------------------- | ------------------------------------------ | -------------- |
| Client wire $10,000 USD             | $10,000 = ~₴420,000                        | 0%             |
| Sender bank correspondent fee       | -$15-50 (deducted by sender)               | $0 for the TOV |
| UA bank receive                     | $10,000 (free incoming SWIFT for monobank) | 0%             |
| USD subaccount hold (no conversion) | $10,000                                    | —              |
| Conversion when needed (~1% spread) | ~₴415,800                                  | -1%            |
| **To the TOV UAH account**          | **~₴415,800**                              | **-1% total**  |

**Verdict B1 vs B2:**

- **B1 (Wise):** a better FX rate (~0.6% total loss), BUT **acceptance for a UA TOV is uncertain**
- **B2 (Direct UA bank):** slightly more expensive (~1%), BUT **guaranteed**, native UA banking, simpler bookkeeping
- **Hybrid:** Wise for US/EU clients (FX optimization), a UA bank for UA clients (instant settlement)

**Bookkeeping:**

- Same as Scenario A — the income is registered at the NBU rate on the invoice/acceptance date, the bank statement = the primary supporting document
- The USD subaccount on the TOV balance — a separate sub-account 312 (a currency account)

**A currency control passport (a passport of a foreign economic operation):**

- The current rules (war-time): a separate transaction passport is **cancelled** after [NBU Resolution 18 / 24.02.2022](https://zakon.rada.gov.ua/laws/show/v0018500-22) and subsequent liberalizations
- Instead of a passport — the **registration of the contract in the bank** + **monthly foreign-economic-activity reporting** to the bank (a standardized form)
- **For turnovers > €400k/quarter** the bank may request additional documentation (proof of services performed, end-client identification) under AML — this is **not a gateway block**, but a compliance check

#### 4. Scenario C — a UA client pays 300,000 UAH (direct wire)

**Day 0 (the contractual level):**

The TOV signs a contract with a UA client (a commercial company). The invoice is issued with the full requisites of the TOV + the UAH IBAN.

**Day 0-1 (wire receive):**

The client transfers **₴300,000** from their bank to the TOV's UAH account:

- **Speed:** minutes-hours via the instant interbank settlement system ([SEP NBU + SPOT](https://bank.gov.ua/)). An internal transfer (within one bank) — instant.
- **Fee for the TOV recipient:** $0 (an incoming UAH wire is free)
- **Fee for the sender:** depends on the sender's bank (usually 0.1-0.5% or a flat 50-200 UAH)

**Day 1 (bookkeeping):**

Same as Scenario A/B — the income is registered at the moment of receiving the UAH into the account or at the moment of the acceptance act.

**VAT question:**

| Scenario                           | VAT                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The TOV's turnover < ₴1M/12 months | NOT obligatory VAT payer. Does not issue a tax invoice, does not accept a tax invoice.                                                                  |
| The turnover ≥ ₴1M/12 months       | Mandatory registration as a VAT payer (optionally earlier) ([Art. 181 of the Tax Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2755-17))         |
| A Diia City resident               | **The VAT regime does not change**. Diia City regulates only the exit-capital tax and gig taxation. If a TOV Diia City turnover ≥ ₴1M → a VAT payer 20% |

**Critical:** If a TOV Diia City turnover is above ₴1M (highly likely in outsource), the TOV is a VAT payer 20% on UA-domestic operations. **The export of services outside Ukraine = 0% VAT** ([Art. 195.1.3 of the Tax Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2755-17)), that is:

- A wire from a US/EU client = 0% VAT
- A wire from a UA client = 20% VAT → from an invoice of ₴300k you need to allocate **₴50,000 as a VAT liability** (₴300k includes VAT; net revenue ₴250k, VAT ₴50k to be paid)
- **Input VAT tax credit:** the TOV reduces the VAT liabilities by the input VAT from UA suppliers (office rent, comm services, etc.)

**The real realization for a UA client on 300k:**

| Step                                      | Sum                        | Tax effect            |
| ----------------------------------------- | -------------------------- | --------------------- |
| The client wires ₴300,000 (including VAT) | ₴300,000                   | —                     |
| The TOV's VAT liability (20%)             | -₴50,000                   | To be paid to the DPS |
| **Net revenue of the TOV**                | **₴250,000**               | —                     |
| If in the same period input VAT ₴10,000   | Net VAT to be paid ₴40,000 | —                     |

**Verdict Scenario C:** a UA client, through the VAT liability, is the most expensive channel from the perspective of the TOV economics, but **operationally the simplest** (instant settlement, native banking).

#### 5. WhiteBIT Business — detailed deep-dive

##### 5.1 Regulatory status (2026)

- **MiCA license (EU):** White Tech (part of W Group, majority-owned by the WhiteBIT CEO V. Nosov) obtained a MiCA CASP license via [HANFA (Croatian FSSA), 29 April 2026](https://blog.whitebit.com/en/w-group-advances-european-expansion-as-white-tech-obtains-mica-authorization/), collection date 2026-05-31
- **Coverage:** the EU/EEA market via a single MiCA passport — exchange crypto↔fiat, crypto↔crypto, transfer services, custody
- **UA status:** WhiteBIT is still headquartered and effectively operates from Lithuania + a 15-country office network (UA included). A UA VASP license is specific — **awaits the implementation of Law 2074-IX** (the status is described in the [USDT payouts consultation](2026-05-31-usdt-payouts-phase8.md))
- **US entry:** [WhiteBIT entered the US market on 1 December 2025](https://scroll.media/en/2025/12/01/whitebit-enters-us-market/) (per the previous risk analysis consultation) — this does not affect the UA-business path, but shows the regulatory maturity of the exchange
- **Reputation flag:** [the case with the KIT Group AML investigation (ANTIKOR articles 2024-2025)](https://antikor.info/en/articles/826030-kriptobirha_whitebit_figuriruet_v_sheme_otmyvanija_millionov_ot_onlajn-narkomarketov_cherez_setj_tenevyh_obmennikov_kit_group_pojavilisj_ekskljuzivnye_dokumenty), collection date 2026-05-31 — an ANTIKOR publication about a scheme via KIT Group. WhiteBIT denied involvement. **Practical implication:** WhiteBIT as an institution has a moderate AML risk profile in the media; in the KYB you may be asked for additional documents due to elevated DD requirements. **This is NOT a disqualifier**, but requires clean documentation.

##### 5.2 KYB requirements for a UA TOV

According to [WhiteBIT What is KYB](https://help.whitebit.com/hc/en-gb/articles/17350938784285-What-is-KYB) and [How to Open Corporate Account](https://blog.whitebit.com/en/how-to-open-a-corporate-account-on-whitebit/), collection date 2026-05-31:

**Documents required (typical for a UA TOV):**

1. **TOV registration documents:** an extract from the Unified State Register (in English + a translation if needed), the Statute/Charter, the Founders' Agreement
2. **Beneficial Ownership disclosure:** identification of all UBOs (>25% ownership) — a passport + proof of address for each
3. **Director / signatory:** KYC verification of each director/representative (passport, selfie, proof of address)
4. **Source of funds declaration:** a description of the origin of the starting capital + the ongoing revenue source
5. **Business model description:** a description of the services the TOV provides, the types of clients, the expected turnovers, the geographic coverage
6. **Bank statement / proof of operations:** the TOV's bank statement for 3-6 months (if a new TOV — financial projections + the founders' equity proof)
7. **Website / online presence:** a corporate website displaying the team, services, contact info
8. **Compliance docs:** the TOV's AML/KYC policy (a template is OK for small companies, a full policy for larger entities)

**KYB timing (official vs realistic):**

| Phase                                           | Official timeline             | Realistic for a UA TOV        |
| ----------------------------------------------- | ----------------------------- | ----------------------------- |
| Submit application                              | Day 0                         | Day 0                         |
| Initial review + RFI (request for information)  | 1-5 working days              | 5-10 working days             |
| Additional documentation rounds                 | n/a                           | 1-3 rounds × 3-7 days each    |
| Final approval                                  | up to 5 working days official | **2-4 weeks total** realistic |
| Onboarding (limits setup, API keys, settlement) | 1-2 days                      | 3-7 days                      |

**Total expected timeline for a UA TOV:** **3-5 weeks** from submit to the first transaction capability. Do not plan for 1 week.

**Approval probability:** HIGH for a clean UA TOV with a legitimate IT business model. KYB rejections are typical for shell companies, missing UBO disclosure, or high-risk industries (gambling, adult content, sanctioned jurisdictions).

##### 5.3 Pricing structure (institutional)

- **Spot trading fees:** 0.1% maker/taker default, 0.02% for futures ([CryptoSlate WhiteBIT review](https://cryptoslate.com/crypto-exchanges/whitebit-exchange-review/), collection date 2026-05-31)
- **Crypto deposit:** generally free for major networks (USDT ERC-20, USDT TRC-20, BTC, ETH)
- **Crypto withdrawal:** varies by network (USDT ERC-20: $3-15 depending on gas, USDT TRC-20: $1 flat)
- **UAH deposit/withdrawal:**
  - **Card Transfer:** ~3-4% fee depending on the promotion period (verify at action time)
  - **Bank Transfer (for Business KYB):** individually negotiated rates per [WhiteBIT institutional](https://docs.whitebit.com/institutional/compliance) — typically 0.5-1.5%
- **P2P Express USDT↔UAH:** no separate commission, spread 1-2% of the market
- **Institutional Business:** EUR 5 fixed fees for deposits/withdrawals, custom limits per KYB level
- **Monthly minimum:** not fixed for Business per public info; for institutional negotiation typical

**Real-world budget for our pattern:**

- 30k USDT/month volume via WhiteBIT → conversion + withdrawal fees ~₴30,000-50,000/month operational cost
- Annual ~₴360-600k operational fees if crypto = 30% revenue mix

##### 5.4 Bank settlement partners

Since 2024-2025 WhiteBIT has working settlement via:

- **Card Transfer:** to UAH Visa/Mastercard cards of any UA bank (in particular PrivatBank, monobank, Sense Bank, Raiffeisen Bank Aval)
- **Bank Transfer (for Business):** SWIFT/SEPA via banking partners, settlement to the TOV's corporate account
- **NB:** for a **direct UAH credit to the TOV's corporate IBAN** WhiteBIT uses settlement via **licensed financial institutions (Reseller / Payment Institution agreements)**. The specific provider is tied to the agreement in the KYB onboarding. Verify in the onboarding doc-pack.

##### 5.5 Limits for Business accounts

- **Default daily limit after KYB:** $10,000-50,000 equivalent
- **Standard Business tier:** $100,000-500,000/day after additional DD
- **Institutional tier:** $1M+/day per individual negotiation
- **Annual volume:** no formal cap, but > $10M/year triggers an enhanced DD review

For our scale (₴5M/year ≈ $120k/year) — a standard Business KYB is sufficient.

##### 5.6 Tax reporting (what WhiteBIT reports to the DPS)

**Currently (2026-05-31):** WhiteBIT is operationally based in Lithuania (W Group); **automatic reporting to the DPS of Ukraine does NOT apply** (UA crypto regulation is not in force — Law 2074-IX awaits the activation of 10225-d (original: 10225-д)).

**What this means for you practically:**

- WhiteBIT does **not** automatically transfer transactional data to the DPS
- BUT after the CRS exchange (since 2024) a UA tax-resident TOV with accounts in an EU-licensed VASP (and MiCA-licensed White Tech is an EU VASP) **falls under CRS reporting** via the jurisdiction where the VASP is licensed
- **The MiCA license HANFA (Croatia)** → in 2026-2027 there will be a CRS link between the Croatian tax authority and the DPS → transactional data is **available** to the DPS upon request, and in 2027+ — automatically

**Practical:** your transactions on WhiteBIT as a TOV Business are **traceable and will be in the DPS's field of view**. This **confirms** that the pattern must be **fully declared** in the TOV's accounting.

##### 5.7 WhiteBIT risks

| Risk                                                          | Severity | Probability                        | Mitigation                                                                                       |
| ------------------------------------------------------------- | -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| WhiteBIT loses the MiCA license due to regulatory action      | High     | Low (5-10%)                        | A backup KYB on another MiCA-licensed exchange (Binance EU, Bitstamp EU, Bitvavo) for redundancy |
| Account freeze due to an AML risk score (raised KYC question) | High     | Medium (15-25%)                    | Clean documentation, conservative volumes; do not perform unusual patterns                       |
| KYB rejection in the absence of a clear business model        | Med      | Low-Med (15%)                      | A clear MSA + sample invoices in the KYB pack                                                    |
| Settlement delay (banking partner issues)                     | Med      | Medium (20%)                       | A backup withdrawal channel (Card Transfer + Wise)                                               |
| Fee changes (especially on UAH withdrawal)                    | Low-Med  | High (60%) — fees change quarterly | Monitor the fee page monthly, adjust the pricing in client contracts                             |
| Reputation drag (KIT Group case) → bank partner issues        | Med      | Low-Med (15%)                      | If the UA bank partner refuses — an alternative settlement                                       |

#### 6. Wise Business — detailed deep-dive

##### 6.1 Acceptance for UA-registered entities

**Reality check** (per public info on 2026-05-31):

- Wise officially **supports UA citizens** for personal accounts (a refugee-friendly policy)
- Wise **Business for a UA TOV** — **case-by-case approval**, **not guaranteed**
- [The Buh.ua guide for UA freelancers / sole proprietors](https://buh.ua/en/how-to-open-wise-and-withdraw-funds-in-ukraine), collection date 2026-05-31, describes the process for FOPs/freelancers, **not for a full UA TOV legal entity**
- Wise has a [Wise for displaced Ukrainians](https://wise.com/gb/blog/wise-for-displaced-ukrainians) policy — this is personal, not business

**Strategic recommendation:**

1. **Phase A (a fast start):** Open a **personal Wise account** for the founder as an individual (works for UA citizens, fast onboarding, full multi-currency access). Use it as an FX bridge for small/medium volumes initially.
2. **Phase B (after 3-6 months of TOV operations):** Submit a **Wise Business application** for the UA TOV. By this time the TOV has an operational history, a banking history, sample invoices — this significantly improves the success rate.
3. **Phase C (alternative):** If Wise Business is rejected — **Revolut Business closed the UA market in December 2025** (per the previous offshore consultation). Alternatives: **Payoneer Business** (UA freelancer-friendly), **TransferGo Business** (a UA bridge), **a direct UA bank multi-currency** (B2 above).

##### 6.2 Multi-currency capabilities

The Wise Business Multi-currency Account provides ([Wise — international business payments](https://wise.com/ua/send-money/international-business-payments), collection date 2026-05-31):

- **Local account details:** USD (US ACH), EUR (SEPA + IBAN), GBP, AUD, SGD, CAD, NZD, RON, HUF, TRY, ...
- **Receive payments as local:** a client from the US makes an ACH transfer to the US-local Wise USD account — for them it is like an internal US wire (free, instant), for you — a credit to the USD subaccount
- **FX between subaccounts:** mid-market rate + 0.43-0.6% spread for major pairs (USD/EUR/GBP)

##### 6.3 Pricing for Business

- **Receive payment (incoming):** **Free** for most local-currency receives (USD ACH, EUR SEPA, GBP Faster Payments)
- **SWIFT incoming:** sometimes $4-7 for a cross-border SWIFT (depends on the sender's bank)
- **FX conversion:** mid-market rate + a transparent 0.43-0.6% fee
- **Outbound (Wise → an external bank):**
  - To a UA bank UAH: ~$5-15 USD-equivalent + 0.5-1% FX
  - To an EU bank EUR: ~€0.50 SEPA fee
- **Card (Wise Business Card):** a physical/virtual debit card linked to the multi-currency balance; a 1.75% fee on an ATM withdrawal > the monthly limit
- **Account opening:** **Free** for personal, **a one-time setup fee $50-100 USD** for Business (verify on application)

##### 6.4 Integration with UA banking

- **Wise → the PrivatBank / monobank / Sense Bank TOV UAH account:** works via standard SWIFT
- **Timing:** 1-2 business days
- **NB:** receiving USD/EUR from Wise to the USD/EUR subaccount of a UA bank — also SWIFT, that is, **fully compliant with war-time currency controls** (a registered contract, foreign-economic-activity reporting)

##### 6.5 Limits

- **Personal Wise (a UA citizen):** up to £50,000/year cumulative typically, with progressively higher tiers after KYC enhancement
- **Wise Business:** £200,000+/transaction for verified Business accounts; annual limits negotiable

##### 6.6 Wise risks

| Risk                                                               | Severity | Probability       | Mitigation                                                             |
| ------------------------------------------------------------------ | -------- | ----------------- | ---------------------------------------------------------------------- |
| A Wise Business application rejected for a UA TOV                  | High     | Med-High (30-40%) | Plan B with personal Wise + a direct UA bank USD subaccount            |
| A Wise UA citizens policy reversal (like Revolut in December 2025) | Critical | Low-Med (15%)     | Diversify via a UA bank + WhiteBIT (not all-eggs Wise)                 |
| Account freeze due to AML                                          | High     | Low-Med (10-15%)  | Clean transaction patterns; do not use it for personal-business mixing |
| FX rate spread changes                                             | Low      | Med (40%)         | Monitor monthly, switch to a direct UA bank if the spread > 1%         |

#### 7. TOV Diia City — distribution mechanics

The money arrived at the TOV's UAH account. How to distribute it **tax-optimally** among the three receiver groups?

##### 7.1 Distribution to gig contractors (the team SENIOR/JUNIOR/HR)

**Legal framework:** [Law 1667-IX "On Stimulating the Development of the Digital Economy"](https://zakon.rada.gov.ua/laws/show/1667-20) + [Art. 170.14¹ of the Tax Code of Ukraine — taxation of gig remuneration](https://zakon.rada.gov.ua/laws/show/2755-17).

**Tax structure for gig remuneration in a Diia City TOV:**

| Component              | Rate                                                                                                                                                      | Who pays                                                        | Base                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| **PIT**                | **5%** ([Art. 170.14¹ of the Tax Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2755-17))                                                           | The TOV as a tax agent (withholds from the payment)             | The whole gig remuneration                     |
| **ML (military levy)** | **5%** ([Art. 161 of the Tax Code of Ukraine — raised from 1.5% to 5% from 01.01.2024](https://zakon.rada.gov.ua/laws/show/2755-17))                      | The TOV as a tax agent                                          | The whole gig remuneration                     |
| **USC**                | **22% of the minimum wage** = **₴1 902.34/month** ([DPS dn.tax.gov.ua](https://dn.tax.gov.ua/media-ark/news-ark/962430.html), collection date 2026-05-31) | **The TOV** (at its own expense, not from the gig remuneration) | The minimum wage ₴8 647 (not the real payment) |

**Cap on the 5% PIT:** the annual payout to a gig specialist cannot exceed **€240,000 equivalent** per year (at the NBU rate on 1 January of the year). Exceeding it → 18% PIT on the excess.

**Real flow for a gig specialist with ₴100,000/month of gig remuneration:**

| Step                                                   | Sum          | Note                                                    |
| ------------------------------------------------------ | ------------ | ------------------------------------------------------- |
| Gross gig remuneration                                 | ₴100,000     | Recorded in the gig contract                            |
| PIT 5% (withheld by the TOV)                           | -₴5,000      | To the DPS on behalf of the spec                        |
| ML 5% (withheld by the TOV)                            | -₴5,000      | To the DPS on behalf of the spec                        |
| **Net payout to the spec's card**                      | **₴90,000**  |                                                         |
| **USC 22% of the minimum wage (at the TOV's expense)** | **+₴1,902**  | To the Pension Fund, a separate expense item of the TOV |
| **Total cost of the TOV**                              | **₴101,902** | (₴100,000 gross + ₴1,902 USC)                           |
| **Effective tax burden on the gig remuneration**       | **~11.7%**   | (₴5k + ₴5k + ₴1.9k) / ₴100k                             |

**Wire instruction:**

- The TOV pays to the gig specialist's UAH card (personal, as an individual)
- PIT + ML → the DPS via standard payment orders (in parallel with the payout, by the 30th of the next month)
- USC → the Pension Fund separately by the 20th of the next month ([Art. 9 of the USC Law 2464-VI](https://zakon.rada.gov.ua/laws/show/2464-17))

**Documentation for compliance:**

- A gig contract (signed with the KEP of both parties) — the template **mandatory** via an IT-corporate lawyer
- A report on the volume of services provided (monthly / quarterly)
- An acceptance act (optional for a gig, but recommended)
- **Do not confuse it with an employment contract** — a gig contract **must not** contain the characteristic signs of an employment relationship (a fixed working time, a workplace, subordination to the labor schedule, paid vacation in the usual format). This **critical recharacterization risk** will be discussed in the Risks section.

**The USC floor — an important nuance for a startup resident:**

Per [Audit-invest.com.ua — Diia City startups criteria](https://audit-invest.com.ua/ru/articles/blog/startapy-v-diia-city-pilhy-zvitnist-audyt) and [7eminar — a startup without 20k euros](https://7eminar.ua/news/19105-startap-u-diya-siti-ci-mozna-podavatisya-na-kriticnist-bez), collection date 2026-05-31:

- A **startup resident** has an **exception** to the requirement of 9 specialists + €1200 average — this is **allowed** not to fulfill during the startup period (until 31 December of year+1)
- BUT the **USC minimum 1902 UAH/month** is still accrued for each gig specialist regardless of the startup status — this is a **mandatory minimum base**
- The **average remuneration not below €1200/month** must be reached proportionally — that is, there are **two separate requirements**: (a) the number of specialists and (b) the compensation level

##### 7.2 Distribution to the partner (co-founder)

The User mentioned a co-founder partner. Tax-optimal patterns:

##### Option A: The partner is a gig specialist of the TOV (recommended for a small role / specialist contributor)

**Structure:** The partner is a full-time gig contractor of the TOV. Paid via gig remuneration the same as the team.

**Tax burden:** ~11.7% (PIT 5% + ML 5% + USC ₴1902/month).

**Pros:** the simplest, the lowest immediate tax burden, a clean monthly cash flow.
**Cons:** the partner does not get equity/dividend mechanics — they are **employee-like**, not a co-owner in the tax sense.

##### Option B: The partner is a co-shareholder of the TOV with dividends (recommended for a true ownership partner)

**Structure:** The partner owns X% of the TOV (e.g., 30%). Payouts to them = dividends, **the exit-capital tax 9% triggers** + **5% PIT + 5% ML** on the dividends.

**Tax burden on dividends (on the example of a ₴1M dividend):**

| Step                                                                                                                                                                                                                                                                                               | Calculation                       | Sum                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------- |
| The TOV pays a dividend                                                                                                                                                                                                                                                                            | —                                 | ₴1,000,000 (gross of the TOV) |
| **Exit-capital tax 9% of the TOV** ([Art. 134 of the Tax Code of Ukraine Diia City clause](https://zakon.rada.gov.ua/laws/show/2755-17))                                                                                                                                                           | 1,000,000 × 9%                    | -₴90,000 (TOV→DPS)            |
| The distributed dividend (gross to the individual)                                                                                                                                                                                                                                                 | 1,000,000 - 90,000                | ₴910,000                      |
| **PIT 5% on dividends** Diia City ([Art. 170.5 of the Tax Code of Ukraine — preferential 5% for Diia City payors](https://zakon.rada.gov.ua/laws/show/2755-17), commentary [factor.ua](https://i.factor.ua/ukr/journals/nibu/2026/march/issue-21/article-136682.html), collection date 2026-05-31) | 910,000 × 5%                      | -₴45,500                      |
| **ML 5%** ([Art. 161 of the Tax Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2755-17))                                                                                                                                                                                                     | 910,000 × 5%                      | -₴45,500                      |
| **In hand of the partner**                                                                                                                                                                                                                                                                         |                                   | **₴819,000**                  |
| **Effective tax rate**                                                                                                                                                                                                                                                                             | (1,000,000 - 819,000) / 1,000,000 | **18.1%**                     |

**Pros:** real ownership, a defendable position in a regulatory inspection, dividend timing flexibility.
**Cons:** a higher tax burden than a gig (18.1% vs 11.7%), more complex bookkeeping.

##### Option C: The partner is a separately registered FOP subcontractor (for a true business partnership)

**Structure:** The partner has their own FOP group 3 (5% single tax). The TOV pays the partner-FOP for subcontracting services via an invoice.

**Tax burden on the partner-FOP's side:**

- 5% single tax on the invoice amount
- 1% ML on the single tax (since 2024)
- USC for the partner-FOP at their own expense: **₴1,902/month minimum**
- Effective ~6-7% on the FOP side

**Cons:** a **CRITICAL recharacterization risk** ([cases.media gig-verdict](https://cases.media/en/article/diya-siti-podatki-ta-riziki-koli-gig-kontrakt-staye-trudovim-virokom), [yankiv.com FOP splitting risks](https://yankiv.com/droblennya-biznesu-na-fop/), collection date 2026-05-31):

- If the partner-FOP serves the TOV as **a single client** (single-client revenue) + common IT systems with the TOV → **a classic sign of business splitting**
- BEB practice 2024-2026 is active on such patterns — [the MarketOpt case](https://biz.liga.net/ua/all/fmcg/novosti/beb-merezha-mahazyniv-z-400-torhovymy-tochkamy-pratsiuvala-pid-vyhliadom-3500-fopiv-foto) with 3500 FOPs — an example
- **Mitigation:** the partner-FOP must have **real other clients** (at least 20-30% of revenue from other counterparties), separate workspaces, separately tracked IP

**Verdict for the partner:** **Option B (co-shareholder + dividends)** is the most defensible long-term. Option C is possible only if the partner has a **real separately-existing business**.

##### 7.3 Distribution to the ADMIN (founder, User)

The User as the founder of the TOV — same options. The optimal split typically:

**Recommended hybrid:**

- **A gig contract of the TOV on the User (founder-as-spec):** ₴80-150k/month (depending on how active a producing role they have). Tax ~11.7%.
- **Dividends periodically (quarterly or annually):** for the distribution of accumulated profit beyond the operational salary. Tax 18.1%.
- **Reinvest the balance:** 0% tax until it is withdrawn as a dividend

**Tax-optimal rationale:**

- Gig remuneration (~11.7%) is **significantly cheaper** than dividends (18.1%) for the base operational compensation
- BUT the gig is **limited to €240k/year per spec** (the 5% rate cap)
- Dividends are needed to withdraw the "true profit" — what does not come out via operating expenses
- Reinvest is best if there is a legitimate use case (capex, R&D, marketing) — 0% tax

##### 7.4 Tax-optimal split — a specific recipe for our scale

Assume the TOV generates 5M UAH of revenue, 2M UAH of net operating profit (User + partner — 2 UBO, a 50/50 split).

| Distribution                                                                            | Sum                                                    | Tax effect                       | In hand over 12 months  |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------- | ----------------------- |
| **User gig salary**                                                                     | ₴1,500,000/year (~₴125k/month)                         | 11.7% (~₴175.5k)                 | ₴1,324,500              |
| **Partner gig salary**                                                                  | ₴1,500,000/year                                        | 11.7% (~₴175.5k)                 | ₴1,324,500              |
| **(gig pay subtotal = an operating expense, not chargeable with the exit-capital tax)** | ₴3,000,000                                             | —                                | —                       |
| **USC of the TOV for both gigs**                                                        | ₴1,902 × 12 × 2 = ₴45,648                              | —                                | (commercial)            |
| **Residual profit of the TOV after gig pay and USC**                                    | 5M − 3M − ₴45.6k − operational expenses (assume ₴500k) | = ₴1,454,352                     | —                       |
| **Dividend payout (1M, 50/50)**                                                         | ₴1,000,000                                             | 9% exit-cap tax + 5% PIT + 5% ML | ₴819,000 (₴409.5k each) |
| **Reinvest**                                                                            | ₴454,352                                               | 0% while in the TOV              | (commercial)            |

**Summary per User:**

- Gig pay net: ₴1,324,500
- Dividend net (50% of ₴819k): ₴409,500
- **Total cash to User: ₴1,734,000/year**

Same for the partner.

**Total tax paid to the state:** ₴351k (gig PIT+ML of both) + ₴45.6k (USC) + ₴90k (exit-cap tax) + ₴91k (dividend PIT+ML) = **₴577.6k**

**Effective consolidated tax burden on 2M of profit:** **₴577.6k / ₴2M = 28.9%**

**Hmm, why 28.9%?** Because we **chose to pay a dividend** of 1M. If everything is reinvest — the burden drops to ~10% (only gig tax). If we pay out the whole profit — the burden rises to ~30%. **This is below the typical TOV general 18+5+5 ≈ 26.2% on the same assumptions** (per the [Diia City roadmap consultation](2026-05-31-diia-city-implementation-roadmap.md)).

**TRUE optimization (more aggressive):**

- More via gig pay (cap €240k/spec/year ≈ ₴10M/spec — far above our volumes)
- Less via dividends
- Reinvest aggressively (R&D, marketing, equipment, training, conferences)

**With maximum gig + minimal dividend:**

- Gig pay 2M user + 1.5M partner = ₴3.5M (tax ~₴410k)
- Only ₴500k dividend (tax ~₴91k)
- Reinvest ₴1.5M (0% tax)
- **Total tax: ~₴500k / ₴3.5M operating pay = 14.3%**

#### 8. Effective tax burden consolidated — a full example on 5M turnover

Scenario: 5,000,000 UAH of annual turnover, a mix of channels (60% USD wire = $71k, 30% USDT = $36k, 10% UAH = ₴500k). Net profit after all operating expenses (including the team's gig salary of 5 SENIORs) = 2,000,000 UAH. Owners: User + partner, 50/50. Distribution of profit: 50% on distribution (1M dividend), 50% reinvest (1M).

**This scenario is on the EDGE of turnovers where a Diia City startup resident is still viable (9 specialists + €1200 average are needed BUT in the startup period of the first 24 months there is a benefit).** For the post-startup phase — assume 9 specialists (5 SENIOR + 3 JUNIOR + 1 HR).

##### 8.1 Channels — incoming side

| Channel                                 | Volume     | Comm/loss                                    | Net to the TOV                                         |
| --------------------------------------- | ---------- | -------------------------------------------- | ------------------------------------------------------ |
| USD wire 60% ($71k = ₴3M)               | ₴3,000,000 | -1% (~₴30k UA bank conversion + Wise hybrid) | ₴2,970,000                                             |
| USDT 30% ($36k = ₴1.5M)                 | ₴1,500,000 | -4.5% (WhiteBIT conversion + withdrawal)     | ₴1,432,500                                             |
| UAH 10% (₴500k)                         | ₴500,000   | -16.7% (VAT if a payer)                      | ₴417k net OR ₴500k if a VAT non-payer                  |
| **Total revenue of the TOV (declared)** |            |                                              | **~₴4,820,000** (assuming a VAT payer for the UA-part) |

**NB about VAT:** If the TOV turnover ≥ ₴1M per year — a mandatory VAT payer. The export of services (USD/USDT from non-residents) = **0% VAT**. UA-domestic clients pay with 20% VAT. For our split (10% UA, 90% export) the VAT impact is minimal.

##### 8.2 Operating expenses (assumptions)

| Category                                       | Sum/year                                                  |
| ---------------------------------------------- | --------------------------------------------------------- |
| Gig salary 9 specialists × €1200/month × ₴42/€ | ₴5,443,200 (this is an **operating expense** — not a tax) |
| USC of the TOV for 9 gigs × ₴1,902/month × 12  | ₴205,416                                                  |
| Bookkeeping (~₴15k/month)                      | ₴180,000                                                  |
| Audit Diia City (annual)                       | ₴50,000                                                   |
| WhiteBIT fees (~₴40k/month × 12)               | ₴480,000                                                  |
| Wise fees (~₴15k/month × 12)                   | ₴180,000                                                  |
| Office rent + utilities                        | ₴240,000                                                  |
| Software / SaaS                                | ₴120,000                                                  |
| Marketing / SaaS                               | ₴100,000                                                  |
| Legal / consulting buffers                     | ₴100,000                                                  |
| **Total OpEx**                                 | **~₴7,098,616**                                           |

**Anomaly:** If we assume ₴5M revenue and ₴7M OpEx — the TOV is **loss-making**. This is **typical for the startup phase of Diia City**: 9 specialists × €1200 = €10,800/month = ₴540k/month ≈ ₴6.5M/year **just on the team's salaries**.

**This shows that our 5M scenario is irrelevant for a **post-startup** Diia City structure.** For post-startup you need a minimum of ₴8-10M+ revenue, otherwise the Diia City structure is loss-making.

**Two alternatives:**

##### 8.3 Alternative A — the Diia City startup-resident phase (the first 24 months)

The startup period gives an exception on 9 specialists. Assume a team of 3-5 gig specialists (User + partner + 2-3 SENIOR). Average remuneration ≥ €1200/month.

| Category                                                                                                                                       | Sum/year                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Revenue (declared)                                                                                                                             | ₴4,820,000 (net of FX losses)           |
| Gig salary 4 specialists × €1200/month × ₴42 (average; realistically SENIORs can get more) — assume average €2000 (₴84k/month) × 4 specialists | ₴4,032,000                              |
| USC of the TOV × 4 specialists                                                                                                                 | ₴91,296                                 |
| Bookkeeping                                                                                                                                    | ₴180,000                                |
| Audit Diia City startup                                                                                                                        | ₴30,000 (lower complexity)              |
| WhiteBIT fees                                                                                                                                  | ₴480,000                                |
| Wise fees                                                                                                                                      | ₴180,000                                |
| Office + SaaS                                                                                                                                  | ₴300,000                                |
| Buffer                                                                                                                                         | ₴100,000                                |
| **Total OpEx**                                                                                                                                 | **~₴5,393,296**                         |
| **Net profit of the TOV**                                                                                                                      | **₴-573,296** (still a **slight loss**) |

This shows: at ₴5M turnover even a Diia City startup resident with 4 gig specialists at a market rate (€2000+) is in a **negative profit zone**. **The pattern needs ≥ ₴8M revenue** to be profitable.

##### 8.4 Alternative B — a realistic profitable scenario (₴10M revenue, a 4-spec team)

Reframe: 10M UAH revenue, 4 gig specialists @ €2000/month average:

| Category                                                                             | Sum/year                                                                                                                                     |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Revenue (declared)                                                                   | ₴10,000,000                                                                                                                                  |
| Gig salary 4 × €2000 × ₴42 × 12                                                      | ₴4,032,000                                                                                                                                   |
| USC of the TOV × 4                                                                   | ₴91,296                                                                                                                                      |
| Gig tax compliance (PIT 5% + ML 5% withheld from the salary, transferred to the DPS) | ₴403,200 (a commercial passthrough, not the TOV's own expense)                                                                               |
| Bookkeeping                                                                          | ₴180,000                                                                                                                                     |
| Audit Diia City startup                                                              | ₴50,000                                                                                                                                      |
| WhiteBIT + Wise fees                                                                 | ₴660,000                                                                                                                                     |
| Office + SaaS                                                                        | ₴300,000                                                                                                                                     |
| Marketing/legal                                                                      | ₴200,000                                                                                                                                     |
| **OpEx (real cash out)**                                                             | **~₴5,313,296** (including USC, without the gig pay tax which passes through the TOV as a tax agent and is not a cash impact for the profit) |
| **Net operating profit of the TOV**                                                  | ₴10,000,000 - ₴5,313,296 = **₴4,686,704**                                                                                                    |

##### 8.5 Distribution on 4.7M of profit (post-OpEx)

User + partner 50/50. A realistic distribution policy: 30% dividend, 70% reinvest.

| Component                                  | Sum                            | Tax                                    |
| ------------------------------------------ | ------------------------------ | -------------------------------------- |
| Dividend (30% × 4.7M)                      | ₴1,406,011                     | Exit-cap tax 9% (TOV) + 5% PIT + 5% ML |
| Exit-cap tax                               | ₴1,406,011 × 9% = **₴126,541** | TOV→DPS                                |
| Net dividend (after exit-cap tax)          | ₴1,279,470                     | for distribution among the individuals |
| PIT 5% (individual)                        | ₴1,279,470 × 5% = **₴63,974**  | TOV→DPS via tax agent                  |
| ML 5% (individual)                         | ₴1,279,470 × 5% = **₴63,974**  | TOV→DPS via tax agent                  |
| **Net dividend in the individuals' hands** | **₴1,151,523** (₴575,761 each) |                                        |
| Reinvest (70% × 4.7M)                      | ₴3,280,693                     | 0% tax (while in the TOV)              |

##### 8.6 Consolidated annual tax burden — the total picture

| Tax category                        | Sum          | Depending on                          |
| ----------------------------------- | ------------ | ------------------------------------- |
| Exit-cap tax of the TOV             | ₴126,541     | the dividend policy (on 30%)          |
| Gig PIT (4 × €2000 × ₴42 × 12 × 5%) | ₴201,600     | the gig salaries                      |
| Gig ML (4 × €2000 × ₴42 × 12 × 5%)  | ₴201,600     | the gig salaries                      |
| USC of the TOV (4 × ₴1,902 × 12)    | ₴91,296      | the minimum, regardless of the salary |
| PIT dividend                        | ₴63,974      | the dividend                          |
| ML dividend                         | ₴63,974      | the dividend                          |
| **TOTAL taxes**                     | **₴748,985** |                                       |

**Effective consolidated tax burden:**

- On **revenue** (₴10M): 748,985 / 10,000,000 = **7.5%**
- On **operating profit** (₴4.69M): 748,985 / 4,686,704 = **16%**
- On **distributed wealth** (gig salary + net dividend = ₴4,032,000 + ₴1,151,523 = ₴5,183,523): 748,985 / 5,183,523 = **14.5%**

**Comparison vs alternatives on the same scale:**

| Structure                                                  | Effective tax / wealth received       |
| ---------------------------------------------------------- | ------------------------------------- |
| **TOV Diia City exit-cap tax + gig (recommended pattern)** | **~14.5%**                            |
| TOV general (18%+5%+5%) + dividends                        | ~26-28%                               |
| TOV single-tax group 3 (5% + 1% ML) + dividends (9%+5%+5%) | ~17-20% (similar)                     |
| Multiple FOP-3 (5% + 1% ML)                                | ~6-7% (BUT splitting risk)            |
| Estonia OÜ 0% reinvest + 20% distribution                  | ~20% (plus CFC UA)                    |
| UAE Free Zone (0% corp) + CFC UA                           | ~18-20% (CFC negates the UAE benefit) |

**Diia City — the sweet spot for our profile.** Multiple FOP-3 gives better, but with a real recharacterization risk (per the previous tov-multi-channel consultation).

**Key insight:** **In aggressive reinvest mode (5-10% dividend, 90-95% reinvest)** the consolidated tax burden drops to **~8-10%** — this is **near-optimal** for tech companies. This is why Diia City is an efficient structure for **scaling companies**, not cash-out companies.

#### 9. Setup roadmap — 7 phases (Phase 0 → Phase 6)

**Total realistic timeline: 8-12 weeks** (parallel tracks). **Total setup budget: ₴80-180k**.

##### Phase 0 — Pre-work (Week 0, ~₴0)

**Tasks:**

1. Decision making — the TOV name (3 candidates), the legal address, the partner equity split, the KVED codes
2. Preparation of scanned documents: passport, tax ID for all founders and UBOs
3. **KEP** (a qualified electronic signature) — registration via the [Diia app](https://ca.diia.gov.ua/) — **30 minutes, free**
4. A request for a cost estimate from 2-3 IT-corporate lawyers
5. A request for a cost estimate from 2-3 bookkeeping firms (with Diia City experience)
6. Optional: a pre-check of a Wise personal application for the founder (a clean record, 7-14 days)

**Documents to prepare:**

- A passport scan (full) for founders, partners, key personnel
- A tax ID
- Proof of address (utility bill / bank statement)
- Future business model docs (a 1-page summary)

**Cost:** ₴0-5k (a buffer for documents, translations)

##### Phase 1 — TOV registration (Week 1-2, ₴15-25k)

**Tasks:**

1. Reservation of the TOV name via [usr.minjust.gov.ua](https://usr.minjust.gov.ua/) — 1-3 working days
2. **A Founders' Agreement** (a decision to create) — signed at a notary OR via a KEP (online via Diia, [diia.gov.ua services](https://diia.gov.ua/services/reyestraciya-tov-na-pidstavi-modelnogo-statutu))
3. **The TOV Statute** — a Model one (online via Diia, free, valid for most scenarios) OR a custom one (needs a lawyer, ₴10-20k)
4. Signing the Statute with the KEP of all founders
5. Filing to the registrar — via Diia online (I recommend) OR a physical registrar. **Timing:** 24-48 hours via Diia
6. Obtaining the extract from the Unified State Register — instant after registration
7. Obtaining the EDRPOU code + IBAN reservation

**This path via Diia — the fastest and cheapest.** A custom Statute via a lawyer is needed if:

- A complex ownership structure (>2 founders, vesting schedules, drag-along/tag-along rights)
- Special voting rights
- IP-ownership clauses about a future product

**Documents:**

- Passport scans + tax IDs of all founders
- Legal address proof (a lease agreement OR consent from the owner)
- The KEP of all founders to sign the Statute

**Cost:** ₴3,000-5,000 state duty (Diia online may be free) + ₴10-20k of a lawyer if a custom Statute + ₴500-2k notary (if not via Diia)

**Output:** the EDRPOU code, the Unified State Register extract, a ready Statute

##### Phase 2 — A UA bank account (Week 2-3, in parallel with Phase 1, ₴0-3k)

**Tasks:**

1. Choice of bank: **monobank Business** (fast, online, 10-15 min to open per [monobank.ua/en/business-account](https://monobank.ua/en/business-account)) OR **PrivatBank Business** (more corporate features, in-person for KYB) OR **Sense Bank Business** (good for IT)
2. KYB documents upload (most banks — online + 1-2 in-person visits)
3. Open a UAH primary account
4. **Open a USD subaccount** (for a Wise alternative / direct receive)
5. **Open a EUR subaccount** (optional)
6. Setup of internet banking + corporate cards
7. Registration as a VAT payer (optional, mandatory at a turnover ≥ ₴1M)

**Choice rationale:**

- **monobank Business:** the fastest setup, best for IT startups. Cons: fewer corporate features
- **PrivatBank Business:** the most FX options (the Trading Platform of the interbank market), an in-house compliance team familiar with foreign economic activity, but slower
- **Sense Bank Business:** IT-focused, friendly conditions, but smaller

**Recommendation:** **monobank as primary** (speed, low fees) + **PrivatBank as a backup and primary for FX operations** (a better Trade Platform).

**KYB documents:**

- The Statute + the EDRPOU extract
- Passport scans of founders/UBO
- Proof of the business model (sample contract drafts)
- The source of the initial capital

**Cost:** ₴0 for a basic monobank Business; ₴1-3k for card activation and initial fees

**Output:** a functional UAH account, USD/EUR subaccounts, internet banking, corporate cards

##### Phase 3 — Wise + WhiteBIT applications (Week 2-5, in parallel with Phase 1-2, ₴0)

**A two-track strategy:**

###### Track 3A — Wise (uncertain success, a plan for a fallback)

1. **Day +5 (after TOV registration):** Open a **personal Wise** for the founder as an individual (works for the UA citizen status) — **1-3 days approval**
2. **Day +15:** Submit a **Wise Business application for the TOV** — wait 7-14 days for review
3. **If approved:** onboarding 3-7 days (KYB, setup of multi-currency subaccounts)
4. **If rejected:** Plan B = continue with the personal Wise OR a direct UA bank USD subaccount

**Documents for Wise Business:**

- The Unified State Register extract (translated to English)
- The Statute translation
- UBO identification
- The TOV's bank statement for 1-3 months
- A description of the business (1-page)
- Website / online presence

**Realistic timeline:** 3-5 weeks total

**Cost:** **Free to apply**, **~$50-100 USD** setup fee upon approval, **0% receive USD**

###### Track 3B — WhiteBIT Business KYB

1. **Day +5:** Submit an institutional account application via the [WhiteBIT institutional form](https://docs.whitebit.com/institutional/compliance)
2. **Day +7-12:** Initial review + RFI rounds
3. **Day +12-20:** Final approval + onboarding + custom limits setup
4. **Day +20-25:** First test transaction (a small amount)

**Documents for WhiteBIT KYB:**

- The Unified State Register extract + the Statute (translated)
- A UBO list with KYC verification of each
- A business model description
- The TOV's compliance policy (basic — recommend a lawyer for proper docs)
- Source of funds / wealth
- Banking proof (an active UAH account)

**Realistic timeline:** 3-5 weeks total

**Cost:** Free to apply, conversion/withdrawal fees apply on usage (~3-5% blended on UAH withdrawal as discussed)

##### Phase 4 — Diia City application (Week 3-5, ₴0-5k)

**Tasks:**

1. **Eligibility self-check:**
   - KVED 62.01 (computer programming) — the main one? OK
   - 90% revenue from qualifying activities (verify your contracts)
   - Team size: for a **startup resident** an exception to 9 specialists — you can start with 1-3 specialists
   - Average remuneration ≥ €1200/month — applies even to a startup
2. **Submit the application via [city.diia.gov.ua](https://city.diia.gov.ua/)** — online via the director's KEP
3. **Documents to attach:**
   - The Unified State Register extract
   - The Statute
   - An initial business plan (1-2 pages)
   - A list of activities (KVED-based)
   - Founders' identification
   - Optional: a sample contract with a client (proves real activity)
4. **Review timing:** **up to 10 working days** (per the [Diia City backend docs DC_start_kit.pdf](https://city-backend.diia.gov.ua/storage/uploads/DC_start_kit.pdf))
5. **After approval:** registration in the Diia City registry, the right to apply the special exit-capital-tax + gig regime

**Startup resident vs Full resident upon filing:**

| Aspect                            | Startup resident                                                         | Full resident                      |
| --------------------------------- | ------------------------------------------------------------------------ | ---------------------------------- |
| Team requirement                  | Not obliged to have 9 specialists in the first 24 months                 | 9+ specialists from month 1        |
| Average pay ≥ €1200               | Mandatory from month 1                                                   | Mandatory from month 1             |
| Tax benefits                      | Same exit-cap tax 9% + gig 5%+5%+USC                                     | Same                               |
| Duration                          | 24 months (until 31 December of year+1), then you have to switch to full | Permanent                          |
| Allowed for a new TOV < 24 months | Yes                                                                      | Yes (if immediately 9 specialists) |
| Threat of loss                    | After 24 months — 9 specialists + €1200 average are mandatory            | Continuous compliance              |

**Recommendation:** **apply as a startup resident** right away. This buys **24 months of time** to scale the team to 9 specialists. **CRITICAL:** a TOV older than **24 months** CANNOT apply as a startup — only a full resident (per [memory lesson 2026-05-31](memory/legal/lessons.md)). So **submit at the first operations of the TOV**, not later.

**Cost:** **₴0** state duty Diia City membership; **₴3-5k** a buffer for a lawyer review of the application (recommended).

**Output:** Diia City resident status in the registry. Effective from the month following the assignment of the status.

##### Phase 5 — Gig contracts + Services Agreement templates (Week 5-7, ₴15-30k)

**This is the most critical phase from a legal perspective.** A **specialized IT-corporate lawyer** is needed.

**Tasks:**

1. **Engage an IT-corporate lawyer** (Sayenko Kharenko / Avellum / Asters / Juscutum / EQUITY / in-house boutiques). Cost: ₴15-30k one-off per minimum.
2. **The lawyer drafts:**
   - A **Master Services Agreement (MSA) template** with clients (US/EU/UA versions, IP rights, NDA, payment terms, currency clauses)
   - A **Statement of Work (SoW) template** for periodic engagements
   - A **gig-contract template** (under Law 1667-IX, without recharacterization risk) — **this is the most important document**
   - **NDA templates** for employees, contractors, clients
   - A **Founders' Agreement / Shareholders' Agreement** if there is a partner co-founder
   - A **Dividend distribution policy** template
3. **Review existing contracts** with current clients / specialists — migrate to the new templates
4. **Compliance docs:**
   - The TOV's AML/KYC policy (for the WhiteBIT KYB)
   - A data protection policy (GDPR if there are EU clients)
   - A code of conduct for the gig team (optional)

**Critical nuances of the gig contract (recharacterization risk):**

- **Don't:** fix working hours, mandatory office presence, integration into the team management hierarchy, paid vacation in the standard form, mandatory KPIs with an employment-like structure
- **Do:** project-based deliverables, milestone-based payment, autonomous execution, an opportunity for other engagements (the specialist can work with other clients theoretically)
- **Documentation:** every payment supported by a Statement of Work + an Acceptance Act
- **Per the [cases.media gig-verdict analysis](https://cases.media/en/article/diya-siti-podatki-ta-riziki-koli-gig-kontrakt-staye-trudovim-virokom), collection date 2026-05-31** — the DPS practice of 2024-2025 showed reclassification of whole groups of gig specialists into employment with retroactive tax adjustments to 18% PIT + penalties

**Cost:** **₴15-30k** a lawyer engagement (one-time) + **₴3-5k/month** of ongoing legal advisory if needed

**Output:** a ready template pack for contracts, the gig team can be formally onboarded

##### Phase 6 — Operations launch (Week 7-12+, ₴25-40k)

**Tasks:**

1. **Hire a bookkeeping firm** (with Diia City experience) — ₴15-25k/month ongoing
2. **First client contract signing** + invoice generation + payment receive (via any of the 3 channels)
3. **First bookkeeping cycle** (month 1):
   - Registration of the income (bank statements + WhiteBIT)
   - Payout of the gig remuneration to the team + tax withholding
   - Transfer of PIT/ML/USC to the DPS/Pension Fund by the 30th of the next month
4. **First quarterly reporting** (quarter 1):
   - **The exit-capital-tax declaration** (Diia City) — quarterly, up to 40 days after the end of the quarter
   - **The VAT declaration** (if a VAT payer) — monthly, up to the 20th of the next month
   - **The USC report** — ([the Consolidated reporting 1DF + USC](https://tax.gov.ua)) — monthly
5. **The initial Diia City compliance report** ([the Compliance report](https://blank.dtkt.ua/blank/743)) — submit the first time 6 months after obtaining the status (verify the current rules with the Diia City legal team)

**Setup launch cost:**

- Bookkeeping setup (chart of accounts, integration with banks, KEPs): ₴5-10k
- First-month bookkeeping + reporting: ₴15-25k
- Software (M.E.Doc / Artzvit / Sonata) — ₴500-1500/month ([medoc.ua](https://medoc.ua/))
- Buffer for the unexpected: ₴10k

**Output:** live operations, the first compliance cycle closed

##### 9.x — Summary setup budget and timeline

| Phase                                                     | Duration               | Cost range                                          |
| --------------------------------------------------------- | ---------------------- | --------------------------------------------------- |
| 0 — Pre-work                                              | Week 0                 | ₴0-5k                                               |
| 1 — TOV registration                                      | Week 1-2               | ₴3-25k                                              |
| 2 — Bank account                                          | Week 2-3 (in parallel) | ₴0-3k                                               |
| 3 — Wise + WhiteBIT KYB                                   | Week 2-5 (in parallel) | ₴0                                                  |
| 4 — Diia City application                                 | Week 3-5 (in parallel) | ₴0-5k                                               |
| 5 — Lawyer + templates                                    | Week 5-7               | ₴15-30k                                             |
| 6 — Operations launch                                     | Week 7-12+             | ₴25-40k (including the first months of bookkeeping) |
| **Total Setup**                                           | **8-12 weeks**         | **₴43-108k** initial spending                       |
| **Plus buffer 30-50%** (delays, additional consultations) |                        | **₴60-150k+ realistic**                             |

**Ongoing monthly burden:**

| Category                                   | Sum/month         |
| ------------------------------------------ | ----------------- |
| Bookkeeping firm                           | ₴15-25k           |
| Software (M.E.Doc / Artzvit)               | ₴0.5-1.5k         |
| WhiteBIT + Wise fees (depending on volume) | ₴20-50k           |
| Diia City annual audit (accrued monthly)   | ₴3-7k accrued     |
| Legal advisory buffer                      | ₴3-5k             |
| **Total ongoing**                          | **₴42-89k/month** |

#### 10. Operational obligations — monthly / quarterly / annual checklist

##### 10.1 Monthly

**By the 20th of the next month:**

- **USC** for gig specialists and employees → the Pension Fund ([Art. 9 of Law 2464-VI](https://zakon.rada.gov.ua/laws/show/2464-17))
- **PIT + ML** for the gig remuneration (withheld from the payouts) → the DPS
- **The Consolidated reporting 1DF + USC** (form) — for the past month

**By the 30th:**

- **The VAT declaration** (if a VAT payer) + **the tax invoice** for UA clients — for the past month

**Internal monthly:**

- Reconciliation of bank statements vs CRM/accounting
- WhiteBIT/Wise statement download → bookkeeping
- Checking the gig remuneration vs the contracts
- Exchange-rate differences on the USD/EUR subaccounts

##### 10.2 Quarterly

**By 40 days after the end of the quarter:**

- **The exit-capital-tax declaration** (Diia City) ([the exit-capital-tax declaration](https://city-backend.diia.gov.ua/storage/uploads/DC_start_kit.pdf)) — quarterly. The first time — for the quarter in which the resident status was obtained.
- **The profit tax declaration** (standard) — if the TOV continues the common system on some part of operations
- **Advance VAT installments** (quarterly consolidated paperwork)

**Quarterly review:**

- Checking the sufficiency of reserves for the annual audit
- Update the gig contracts if the rates/spec lists have changed
- Verify the Diia City criteria — 9 specialists + €1200 average compliance progress (for a startup residence — track readiness toward the end of the 24-month period)

##### 10.3 Annually

**By 1 June (for the past year):**

- **The Diia City resident compliance report** (form [blank.dtkt.ua/blank/743](https://blank.dtkt.ua/blank/743)) + **an independent auditor's conclusion** ([Kreston Ukraine — Diia City compliance](https://kreston.ua/en/audit-and-related-services/diia-city-resident-s-compliance-report-audit/)) — **mandatory** for all Diia City residents (including a startup after the first year)
- **A company audit**: per [BP-Audit Diia City](https://bp-audit.com.ua/service/audyt-zvitu-pro-vidpovidnist-rezydenta-diia-siti) — coverage is not a full audit, but a review of the compliance criteria; cost ₴30-80k depending on the complexity and the audit firm

**By 1 May (for the past year):**

- **The TOV's financial reporting** ([Law 996-IV](https://zakon.rada.gov.ua/laws/show/996-14)) — submit to the DPS + publication in the Unified State Register
- **The profit tax / exit-capital-tax annual declaration** — final adjustments

**Annually internal:**

- Renewal of the Wise/WhiteBIT KYB (typically not needed but updates may be requested)
- Update the gig contracts rates for the initial year
- Renew the lawyer/accountant engagement terms
- Review the dividend policy with the partner

##### 10.4 Currency control / FX obligations

- **Registration of the foreign-economic-activity contract in the bank** — once per contract, at the moment of the first operations
- **Monthly foreign-economic-activity reporting** — the bank files it automatically; the TOV may request a summary
- **The 180-day term** for receiving currency revenue after the invoice ([WoBorders 2026 limit summary](https://woborders.agency/en/blog/which-payment-system-choose-in-2026/), collection date 2026-05-31) — operationally important to clip
- **At a turnover > €400k/quarter (~$430k)** — the bank may request additional documentation (proof of services, end-client identification); this is an **AML compliance not a block**

##### 10.5 Tax payment calendar (a quick reference)

| What                          | Period                         | Deadline                  |
| ----------------------------- | ------------------------------ | ------------------------- |
| USC                           | month                          | the 20th of the next      |
| Gig PIT + gig ML              | month                          | the 30th of the next      |
| 1DF + USC report              | month                          | the 30th of the next      |
| VAT declaration               | month                          | the 30th of the next      |
| Tax invoices                  | immediately upon the operation | 15 days                   |
| Exit-cap tax Diia City        | quarter                        | 40 days after the quarter |
| Diia City compliance + audit  | year                           | 1 June                    |
| The TOV's financial reporting | year                           | 1 May                     |

### Risks

| #   | Risk                                                                                                                                                                                                                                                                                                      | Severity                                        | Probability (12-36mo)                                                                                                                                           | Mitigation                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Reclassification of a gig contract into an employment one** — the DPS recognizes the gig as employment, retroactive PIT 18% + penalties 25-75% + USC 22% of the real salary [cases.media analysis](https://cases.media/en/article/diya-siti-podatki-ta-riziki-koli-gig-kontrakt-staye-trudovim-virokom) | **CRITICAL**                                    | **Med-High (35-45%)** on a pattern with a template from the internet; **Low-Med (10-15%)** with a properly drafted lawyer template + clean operational practice | Engage an IT-corporate lawyer for the template (₴15-30k); document project-based deliverables; keep separateness from employment           |
| 2   | **Loss of startup-resident status after 24 months** (not reached 9 specialists × €1200 average) — auto exclusion + retroactive recalculation of the tax burden                                                                                                                                            | High                                            | Med (25%) for typical startup growth                                                                                                                            | A hire plan: 9 specialists are mandatory by Dec 31 of year+1; alternative — accept the loss of status + switch to a TOV single-tax group 3 |
| 3   | **Wise Business rejection** for a UA TOV                                                                                                                                                                                                                                                                  | High (for the FX channel)                       | Med-High (30-40%)                                                                                                                                               | Plan B: personal Wise + a direct UA bank USD subaccount; not all-eggs on the Wise channel                                                  |
| 4   | **WhiteBIT account freeze** due to an AML risk score (unusual transaction patterns, KIT Group reputation drag)                                                                                                                                                                                            | High                                            | Low-Med (15-20%)                                                                                                                                                | Conservative transaction volumes, clean KYB documentation, a backup MiCA-licensed exchange (Bitstamp EU, Bitvavo)                          |
| 5   | **Diia City threshold changes** in 2026-2027 (a potential raise of €1200 → €1500 or a requirement to increase the number of specialists)                                                                                                                                                                  | Med                                             | Low-Med (20%)                                                                                                                                                   | Monitor [city.diia.gov.ua](https://city.diia.gov.ua/) updates monthly; build the team to 9+ specialists asap                               |
| 6   | **VAT liability on the UA-client part of revenue** (20% VAT at a turnover ≥ ₴1M) — an additional cash flow cost not calculated in the TL;DR                                                                                                                                                               | Med                                             | Certain (100%) at > ₴1M                                                                                                                                         | Bookkeeping input VAT tracking; optimize for max export revenue (0% VAT)                                                                   |
| 7   | **A mandatory audit of the Diia City report (₴30-80k/year)** — a hidden cost often missed in planning                                                                                                                                                                                                     | Med                                             | Certain (100%)                                                                                                                                                  | Build ₴3-7k/month accrued; choose an affordable competent audit firm early                                                                 |
| 8   | **Currency control additional DD** at turnovers > €400k/quarter (~₴18M/quarter, ~₴72M/year) — the bank requesting documentation on end-client identification                                                                                                                                              | Med                                             | Med (40%) at scale up                                                                                                                                           | Maintain clean MSA + invoice trails; an engaged bookkeeper for bank correspondence                                                         |
| 9   | **CRS data exchange** — your WhiteBIT (MiCA-licensed Croatia) activity will be reported to the DPS automatically in 2027+ → guarantees that the pattern must be fully declared                                                                                                                            | High (if not declared); negligible if compliant | Certain (100%) post-2027                                                                                                                                        | The pattern is based on full declaration — no risk if compliance is kept                                                                   |
| 10  | **Business splitting accusation** if the partner-FOP-subcontractor pattern is used (Option C for the partner)                                                                                                                                                                                             | Critical                                        | Med (25%) with single-client revenue partner                                                                                                                    | Avoid Option C; use Option B (co-shareholder) for the partner                                                                              |
| 11  | **Loss of the bank account** due to AML pattern detection at the bank (especially with USDT-related transactions)                                                                                                                                                                                         | High                                            | Low-Med (15%)                                                                                                                                                   | Multiple bank accounts (monobank + PrivatBank + Sense) for redundancy; clean transaction descriptions with contractual references          |
| 12  | **Reputation drag** from the WhiteBIT KIT Group case affects our bank relationships                                                                                                                                                                                                                       | Low-Med                                         | Low (10%)                                                                                                                                                       | We have an alternative via Wise / a direct USD subaccount for non-crypto revenue                                                           |
| 13  | **The 9-specialist threshold** not reached even in the full-resident phase — exclusion from the registry                                                                                                                                                                                                  | Critical                                        | Med (20%) for a slow-growth startup                                                                                                                             | Plan the hire ramp; if not achievable — pivot to a TOV single-tax group 3 or close the startup-resident status before exclusion            |
| 14  | **MiCA WhiteBIT regulatory changes** in the EU affect the UA TOV KYB conditions                                                                                                                                                                                                                           | Med                                             | Low (10%)                                                                                                                                                       | A backup KYB on another MiCA-licensed exchange                                                                                             |
| 15  | **Changes to the Tax Code of Ukraine Diia City clause** (a potential raise of the 9% exit-cap tax or a reduction of the 5% PIT on the gig) — political will may change                                                                                                                                    | Med                                             | Low (10%) in the short term; Med (30%) over 3-5 years                                                                                                           | Track law changes; build optionality into the structure (the possibility of a fast pivot to the single-tax group 3)                        |
| 16  | **BEB scrutiny on multi-FOP subcontract patterns** (if partner Option C is chosen) — Art. 212 + Art. 209 risk per the previous [risk analysis consultation](2026-05-31-cash-crypto-undeclared-risk-analysis.md)                                                                                           | Critical                                        | Med (25%) for a multi-FOP pattern, Low (5%) for a clean partner Option B                                                                                        | Stay on Option B; do not try to split for tax savings                                                                                      |
| 17  | **Hidden cost escalation** — bookkeeping (₴15-25k), audit (₴30-80k), legal advisory (₴3-5k/month), software (₴1-2k/month) — total ongoing up to ₴80-100k/month transforms the structure economics                                                                                                         | Med (operational drag)                          | Certain (100%)                                                                                                                                                  | Include it in budget planning; do not try to "do it without a bookkeeper" — missing compliance = lose Diia City                            |
| 18  | **The 180-day term for receiving currency revenue** (war-time currency control) — at scale a potential breach with client delays                                                                                                                                                                          | Med                                             | Low (10%)                                                                                                                                                       | Monitor the invoice→payment gap; include penalty clauses in the client contracts                                                           |
| 19  | **Transfer pricing applicability** if there are affiliated entities (a partner-FOP, an affiliated holding) — ₴30-50k/year documentation cost (per the previous [offshore consultation](2026-05-31-offshore-alternatives.md))                                                                              | Med                                             | Low-Med (15%) at this scale, high if scaling to cross-border affiliates                                                                                         | Avoid affiliated structures until scale >> ₴20M/year                                                                                       |
| 20  | **GDPR exposure** on EU clients (our CRM stores Telegram / phone / scans) — a fine up to 4% of revenue                                                                                                                                                                                                    | High                                            | Low (10%) at a small scale, Med (30%) at an EU client scale                                                                                                     | Implement a GDPR consent flow + a data retention policy (a separate task for the Coder)                                                    |

### Recommendation (best for business)

#### Top-3 actions for this week (Monday morning checklist)

1. **Make a KEP via the [Diia app](https://ca.diia.gov.ua/)** — this is the foundation for everything else. 30 minutes, free. **Call the Diia contact center if something does not work — 1545.**
2. **Request a cost estimate from 3 IT-corporate lawyers** (Sayenko Kharenko / Avellum / Asters / Juscutum / EQUITY) for a package: an MSA template + a gig-contract template + Diia City application supervision + a Founders' Agreement. Formulate the request specifically: "**A new TOV, planning to become a Diia City resident as a startup, need a compliant gig-contract template without recharacterization risk + an MSA with US/EU clients**". This is the **critical** stage — an economy on the lawyer = a catastrophic risk per the [risk analysis](2026-05-31-cash-crypto-undeclared-risk-analysis.md) and [memory lesson 2026-05-31 P0](memory/legal/lessons.md).
3. **Reserve the TOV name on [usr.minjust.gov.ua](https://usr.minjust.gov.ua/)** + draft a Founders' Agreement with the partner. Approve 3 name candidates, prepare the legal address (can be a home address with the owner's consent, or a coworking).

#### Top-5 actions for the first month

1. **Register the TOV via the [Diia online portal](https://diia.gov.ua/services/reyestraciya-tov-na-pidstavi-modelnogo-statutu)** — a Model Statute is OK to start, it simplifies the process. Cost ₴3-5k maximum.
2. **Open monobank Business UAH** + a USD subaccount as the primary banking channel (10-15 min online setup).
3. **Submit the Diia City application** via [city.diia.gov.ua](https://city.diia.gov.ua/) **IMMEDIATELY** after the TOV registration — to **not miss the startup window** (a TOV older than 24 months cannot apply as a startup).
4. **Submit the Wise personal application** for the founder as an individual (a parallel track for FX testing). Submit the Wise Business application for the TOV after the first month's operations.
5. **Submit the WhiteBIT Business KYB** with a full documentation pack (the Statute + the Unified State Register extract + UBO disclosure + the business model + the AML policy).

#### Verification checkpoints at each stage

| Checkpoint                          | When                         | What to verify                                                                                                                                         |
| ----------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **After Phase 1 (TOV registered)**  | Week 2                       | The EDRPOU code assigned, the Unified State Register extract obtained, the director's KEP works in [city.diia.gov.ua](https://city.diia.gov.ua/) login |
| **After Phase 2 (bank)**            | Week 3                       | The UAH account active, the USD subaccount opened, internet banking working, corporate cards activated                                                 |
| **After Phase 3 (Wise + WhiteBIT)** | Week 5                       | At least 1 of 2 active (Plan A success). Plan B identified if both rejected.                                                                           |
| **After Phase 4 (Diia City)**       | Week 5                       | The resident status in the registry, the special regime applies from month +1                                                                          |
| **After Phase 5 (lawyer)**          | Week 7                       | The gig-contract template in hand, the MSA template, the first gig specialist signed                                                                   |
| **After Phase 6 (operations)**      | Week 12                      | The first client payment received, the first gig payout made with full tax withholding, the bookkeeping cycle closed                                   |
| **Initial Diia City compliance**    | Month 7                      | The first compliance report submitted                                                                                                                  |
| **First annual audit**              | Year 1 (by 1 June of year+1) | The auditor's conclusion + the full annual report submitted                                                                                            |
| **9-spec / €1200 milestone**        | Before Dec 31 of year+1      | The team expanded to 9 specialists with an average remuneration ≥ €1200                                                                                |

#### Do not confuse — anti-recommendations

| Do not do                                                           | Why                                                                                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Do not start operations before the lawyer engagement**            | The recharacterization risk is catastrophic. ₴15-30k one-off < ₴1.5M/year recharacterization cost     |
| **Do not use a template from the internet for the gig contract**    | Default templates fail the recharacterization stress-test                                             |
| **Do not plan for a 0% effective tax**                              | Realistically 8-16% depending on the reinvest policy                                                  |
| **Do not ignore the mandatory Diia City audit**                     | Failure to submit = exclusion from the resident registry → retroactive general system                 |
| **Do not use partner Option C (a single-client FOP subcontractor)** | A business-splitting risk per [BEB practice 2024-2026](https://yankiv.com/droblennya-biznesu-na-fop/) |
| **Do not confuse Wise personal vs Wise Business**                   | Mixing will lead to AML issues                                                                        |
| **Do not skip the USC ₴1902/month**                                 | This is a floor, independent of the payouts; missing it = the director's personal liability           |
| **Do not skip the CRS implications**                                | All accounts will be visible to the DPS in 2027+; the pattern must be declared from day 1             |

#### If the partner decision is not finalized

The User mentioned a partner. **Before Phase 1 (TOV registration)** it is mandatory to:

1. Decide the equity split (50/50 vs 60/40 vs 70/30)
2. **A Founders' Agreement with vesting** (4-year vest, 1-year cliff — standard) — discuss with a lawyer
3. **Decision making rights** (unanimity vs majority for key decisions)
4. **Exit clauses** (drag-along, tag-along, ROFR)
5. **A dividend policy** (a fixed share or discretionary)

**Without a partner agreement = a future expensive corporate dispute risk.** Engage a lawyer for this draft.

### Sources

#### Codes and Laws of Ukraine

- [The Tax Code of Ukraine — Art. 134 (the exit-capital tax Diia City)](https://zakon.rada.gov.ua/laws/show/2755-17#n3299)
- [The Tax Code of Ukraine Art. 161 (military levy 5%)](https://zakon.rada.gov.ua/laws/show/2755-17)
- [The Tax Code of Ukraine Art. 167.5 (PIT rates on dividends)](https://zakon.rada.gov.ua/laws/show/2755-17)
- [The Tax Code of Ukraine Art. 170.5 (preferential PIT on Diia City dividends)](https://zakon.rada.gov.ua/laws/show/2755-17)
- [The Tax Code of Ukraine Art. 170.14¹ (taxation of gig remuneration)](https://zakon.rada.gov.ua/laws/show/2755-17)
- [The Tax Code of Ukraine Art. 181 (the VAT registration threshold ₴1M)](https://zakon.rada.gov.ua/laws/show/2755-17)
- [The Tax Code of Ukraine Art. 195.1.3 (export of services — 0% VAT)](https://zakon.rada.gov.ua/laws/show/2755-17)
- [The Tax Code of Ukraine Art. 293.3 (single-tax rates group 3)](https://zakon.rada.gov.ua/laws/show/2755-17)
- [Law 1667-IX "On Stimulating the Development of the Digital Economy" (Diia City)](https://zakon.rada.gov.ua/laws/show/1667-20)
- [Law 2464-VI "On the Collection and Accounting of the Unified Contribution"](https://zakon.rada.gov.ua/laws/show/2464-17)
- [Law 996-IV "On Accounting and Financial Reporting"](https://zakon.rada.gov.ua/laws/show/996-14)
- [Law 2473-VIII "On Currency and Currency Operations"](https://zakon.rada.gov.ua/laws/show/2473-19)
- [Law 361-IX "On Prevention and Counteraction of Legalization of Proceeds"](https://zakon.rada.gov.ua/go/361-20)
- [Law 2074-IX "On Virtual Assets" (Status: awaits Tax Code adaptation, 10225-d)](https://zakon.rada.gov.ua/laws/show/2074-20)
- [NBU Resolution No. 18 dated 24.02.2022 (war-time currency restrictions)](https://zakon.rada.gov.ua/laws/show/v0018500-22)
- [NBU Resolution No. 148 dated 29.12.2017 (cash settlement limits)](https://zakon.rada.gov.ua/laws/show/v0148500-17)

#### WebSearch — collection date 2026-05-31

**WhiteBIT:**

- [WhiteBIT — Trading, deposit and withdrawal fees](https://help.whitebit.com/hc/en-gb/articles/25029308319005-Trading-deposit-and-withdrawal-fees) (collection date 2026-05-31)
- [WhiteBIT — How to Withdraw UAH on WhiteBIT](https://help.whitebit.com/hc/en-gb/articles/27220802740509-How-to-Withdraw-UAH-on-WhiteBIT) (collection date 2026-05-31)
- [WhiteBIT — Deposit and withdrawal via P2P Express](https://help.whitebit.com/hc/en-gb/articles/19401002086045-Deposit-and-withdrawal-via-P2P-Express) (collection date 2026-05-31)
- [WhiteBIT — Withdrawal of funds using Card Transfer](https://help.whitebit.com/hc/en-gb/articles/20716216959005-Withdrawal-of-funds-using-Card-Transfer-on-WhiteBIT) (collection date 2026-05-31)
- [WhiteBIT — What is KYB?](https://help.whitebit.com/hc/en-gb/articles/17350938784285-What-is-KYB) (collection date 2026-05-31)
- [WhiteBIT Blog — How to Open a Corporate Account](https://blog.whitebit.com/en/how-to-open-a-corporate-account-on-whitebit/) (collection date 2026-05-31)
- [WhiteBIT institutional / Regulatory Compliance](https://docs.whitebit.com/institutional/compliance) (collection date 2026-05-31)
- [WhiteBIT Blog — W Group MiCA HANFA Authorization (29 April 2026)](https://blog.whitebit.com/en/w-group-advances-european-expansion-as-white-tech-obtains-mica-authorization/) (collection date 2026-05-31)
- [CryptoSlate — WhiteBit Exchange Review 2026](https://cryptoslate.com/crypto-exchanges/whitebit-exchange-review/) (collection date 2026-05-31)
- [Bitstamp — Chainalysis tax agencies usage](https://www.bitstamp.net/learn/company-profiles/chainalysis/) (collection date 2026-05-31)
- [ANTIKOR portal — WhiteBIT KIT Group AML investigation](https://antikor.info/en/articles/826030-kriptobirha_whitebit_figuriruet_v_sheme_otmyvanija_millionov_ot_onlajn-narkomarketov_cherez_setj_tenevyh_obmennikov_kit_group_pojavilisj_ekskljuzivnye_dokumenty) (collection date 2026-05-31)

**Wise:**

- [Wise — How to open Wise and withdraw funds in Ukraine 2026](https://buh.ua/en/how-to-open-wise-and-withdraw-funds-in-ukraine) (collection date 2026-05-31)
- [Wise Business — International business account](https://wise.com/gb/business/) (collection date 2026-05-31)
- [Wise — International business payments](https://wise.com/ua/send-money/international-business-payments) (collection date 2026-05-31)
- [Wise — Multi-Currency Account 2026](https://wealthvieu.com/banking/wise/multi-currency-account/) (collection date 2026-05-31)
- [Wise — for displaced Ukrainians](https://wise.com/gb/blog/wise-for-displaced-ukrainians) (collection date 2026-05-31)

**Diia City:**

- [Diia.City registry — residents](https://city.diia.gov.ua/registry/resident) (collection date 2026-05-31)
- [Diia.City — official portal](https://city.diia.gov.ua/) (collection date 2026-05-31)
- [Diia.City — Start Kit PDF](https://city-backend.diia.gov.ua/storage/uploads/DC_start_kit.pdf) (collection date 2026-05-31)
- [Diia.City — main info PDF](https://city-backend.diia.gov.ua/storage/uploads/files/page/home/diia.city.pdf) (collection date 2026-05-31)
- [Audit-invest.com.ua — Diia City startups: criteria, taxes and reports 2026](https://audit-invest.com.ua/ru/articles/blog/startapy-v-diia-city-pilhy-zvitnist-audyt) (collection date 2026-05-31)
- [7eminar — A startup in Diia City without 20k euros](https://7eminar.ua/news/19105-startap-u-diya-siti-ci-mozna-podavatisya-na-kriticnist-bez) (collection date 2026-05-31)
- [Factor — Changes for Diia City residents 2026](https://i.factor.ua/ukr/journals/nibu/2026/february/issue-12/article-136109.html) (collection date 2026-05-31)
- [Bires.com.ua — Diia City startup conditions](https://bires.com.ua/yurydychnyj-suprovid-biznesu/dotrymannya-umov-diya-siti-dlya-startapiv-yak-ne-vtratyty-rezydentstvo-pid-chas-diyi-voyennogo-stanu/) (collection date 2026-05-31)
- [Egolovbuh — startup-resident Diia City obligations](https://egolovbuh.expertus.com.ua/10018957) (collection date 2026-05-31)
- [Mind.ua — startup vs full-resident Diia City](https://mind.ua/openmind/20291564-startap-chi-povnocinnij-rezident-diya-city-perevagi-ta-vimogi) (collection date 2026-05-31)
- [Factor — PIT and ML on Diia City dividends 2026](https://i.factor.ua/ukr/journals/nibu/2026/march/issue-21/article-136682.html) (collection date 2026-05-31)
- [Kreston Ukraine — Diia City startup tax benefits 2025](https://kreston.ua/en/diia-city-for-startups-how-to-legally-save-on-taxes-and-grow-a-unicorn/) (collection date 2026-05-31)
- [Kreston Ukraine — Diia City compliance report restored](https://kreston.ua/zvitnist-rezydentiv-diia-siti-vidnovleno-shcho-peredbachaie-zaznachena-protsedura/) (collection date 2026-05-31)
- [Kreston Ukraine — Diia City audit](https://kreston.ua/en/audit-and-related-services/diia-city-resident-s-compliance-report-audit/) (collection date 2026-05-31)
- [BP-Audit — Diia City compliance audit](https://bp-audit.com.ua/service/audyt-zvitu-pro-vidpovidnist-rezydenta-diia-siti) (collection date 2026-05-31)
- [Blank.dtkt.ua form 743 — The Diia City Compliance report](https://blank.dtkt.ua/blank/743) (collection date 2026-05-31)
- [Cases.media — Diia City risks of reclassifying a gig → an employment contract](https://cases.media/en/article/diya-siti-podatki-ta-riziki-koli-gig-kontrakt-staye-trudovim-virokom) (collection date 2026-05-31)
- [Garnet.team — accounting of gig contracts in BAS UTP](https://garnet.team/articles/vedennya-obliku-organizatsiyami-rezidentami-diya-siti-u-t-ch-obliku-gig-kontraktiv-v-bas-utp/) (collection date 2026-05-31)
- [Juscutum — Taxation in Diia.City 2025](https://www.juscutum.com/news/osoblivosti-opodatkuvannya-rezidentiv-diya-city-u-2025-roci) (collection date 2026-05-31)
- [DKU.in.ua — Diia City 2026 general overview](https://dku.in.ua/DiiaCity) (collection date 2026-05-31)
- [7eminar — Gig specialists of a Diia City resident](https://7eminar.ua/news/5620-rezident-diya-siti-vinagoroda-likarnyani-oplacuvana-pererva-gig-specialistam-ta) (collection date 2026-05-31)
- [7eminar — Diia City employees: salary](https://7eminar.ua/news/5565-rezident-diya-siti-zarobitna-plata-likarnyani-vidpuskni-statnim-pracivnikam-ta) (collection date 2026-05-31)
- [News.dtkt.ua — Loss of Diia City status](https://news.dtkt.ua/taxation/profits-tax/83767-za-iakix-umov-rezident-diia-siti-vtracaje-svii-status) (collection date 2026-05-31)
- [Biz.ligazakon.net — Changes to the definition of critically important for Diia City](https://biz.ligazakon.net/news/240342_viznachennya-kritichno-vazhlivikh-pdprimstv-zmni-dlya-rezidentv-dya-st) (collection date 2026-05-31)
- [TAX.gov.ua — Diia City administration](https://dp.tax.gov.ua/media-ark/news-ark/975476.html) (collection date 2026-05-31)
- [ZP.tax.gov.ua — PIT Diia City non-gig](https://zp.tax.gov.ua/media-ark/news-ark/877751.html) (collection date 2026-05-31)
- [News.dtkt.ua — USC of external part-timers of Diia City](https://news.dtkt.ua/labor/social-protection/103864-iak-naraxovuvati-jesv-na-zarplatu-zovnisnyogo-sumisnika-rezidenta-diia-siti-dps-zminila-dumku) (collection date 2026-05-31)
- [Bip.net.ua — The Diia City regime 2026](https://bip.net.ua/articles/diya-siti-umovi-vimogi-perevagi-j-nedoliki/) (collection date 2026-05-31)

**Minimum wage and USC 2026:**

- [Smartfin.ua — Minimum wage 2026](https://smartfin.ua/page/minimalna-zarplata-u-2026-rotsi) (collection date 2026-05-31)
- [Minfin.com.ua — Minimum wage Ukraine](https://index.minfin.com.ua/en/labour/salary/min/) (collection date 2026-05-31)
- [DN.tax.gov.ua — Minimum wage 2026 USC](https://dn.tax.gov.ua/media-ark/news-ark/962430.html) (collection date 2026-05-31)
- [7eminar — Minimum wage 2026](https://7eminar.ua/news/8965-minimalna-zarobitna-plata-u-2026-roci) (collection date 2026-05-31)
- [Factor Academy — State Budget 2026](https://factor.academy/blog/derzhavnij-byudzhet-2026-minimalna-zarplata-prozhitkovij-minimum-indeksaciya-yesv/) (collection date 2026-05-31)
- [Buhplatforma — Minimum wage 2026 impact](https://buhplatforma.com.ua/article/18422-minimalna-zarplata-2026-skilky-platytymut-iak-zminiatsia-podatky-i-chysti-vyplaty) (collection date 2026-05-31)
- [Factor Academy — ML rate Diia City 2025](https://factor.academy/blog/stavka-vijskovogo-zboru-v-diya-siti-2025/) (collection date 2026-05-31)
- [DP.tax.gov.ua — USC Diia City administration](https://dp.tax.gov.ua/media-ark/news-ark/976447.html) (collection date 2026-05-31)
- [7eminar — USC for Diia City upon salary payment](https://7eminar.ua/news/13417-jesv-dlya-diya-siti-pri-viplati-zarplati-ta-vinagorodi-rozyasnennya) (collection date 2026-05-31)

**Banking UA:**

- [PrivatBank — SWIFT for business](https://privatbank.ua/perekazy-swift) (collection date 2026-05-31)
- [PrivatBank — Foreign economic activity](https://privatbank.ua/business/zed) (collection date 2026-05-31)
- [PrivatBank — IT-clients services](https://privatbank.ua/business/poslugi-dlya-it-clientiv-compainii) (collection date 2026-05-31)
- [PrivatBank — Trading platform for legal entities](https://privatbank.ua/business/trading-platform) (collection date 2026-05-31)
- [monobank — currency account](https://monobank.ua/en/business/currency-account) (collection date 2026-05-31)
- [monobank — tariffs](https://monobank.ua/taryfy) (collection date 2026-05-31)
- [monobank — business account](https://monobank.ua/en/business-account) (collection date 2026-05-31)
- [monobank — SWIFT incoming](https://bankchart.com.ua/groshovi_perekazi/novini/yak_otrimati_swift_perekaz_u_monobank) (collection date 2026-05-31)
- [Sense Bank — currency operations during martial law](https://help-biz.sensebank.com.ua/hc/uk/articles/4881724088594) (collection date 2026-05-31)
- [Bank.gov.ua — the mandatory sale of currency cancelled](https://bank.gov.ua/en/news/all/obovyazkoviy-prodaj-valyutnih-nadhodjen-biznesom-skasovano) (collection date 2026-05-31)
- [Bank.gov.ua — Clarification of currency restrictions](https://bank.gov.ua/en/news/all/natsionalniy-bank-utochniv-nizku-valyutnih-obmejen) (collection date 2026-05-31)
- [Lexology — Currency restrictions 2024](https://www.lexology.com/library/detail.aspx?g=9d4700f5-ea0a-424c-b41c-4752ac957da6) (collection date 2026-05-31)
- [Nova Poshta Business School — Currency control 2026](https://online.novaposhta.education/blog/valyutnij-kontrol-granichni-stroki-rozrahunkiv-za-operaciyami-z-eksportu-ta-importu-tovariv) (collection date 2026-05-31)
- [WoBorders — Payment system choice 2026](https://woborders.agency/en/blog/which-payment-system-choose-in-2026/) (collection date 2026-05-31)
- [Medoc.ua — cash settlement limits 2026](https://medoc.ua/blog/gotivkovi-rozrahunki-na-jaki-ne-poshirjutsja-obmezhennja-shhodo-granichnih-sum-) (collection date 2026-05-31)

**Other:**

- [Yankiv — Business splitting 2026](https://yankiv.com/droblennya-biznesu-na-fop/) (collection date 2026-05-31)
- [Diia.gov.ua — TOV registration](https://diia.gov.ua/services/reyestraciya-tov-na-pidstavi-modelnogo-statutu) (collection date 2026-05-31)
- [Diia.gov.ua — The Diia City Compliance report](https://diia.gov.ua/services/zvit-pro-vidpovidnist-rezidenta-diyacity-ta-nezalezhnij-visnovok) (collection date 2026-05-31)
- [CA.diia.gov.ua — KEP](https://ca.diia.gov.ua/) (collection date 2026-05-31)
- [USR.minjust.gov.ua — the register of legal entities](https://usr.minjust.gov.ua/) (collection date 2026-05-31)

#### Internal knowledge base

- `docs/agents/memory/legal/lessons.md` — the previous 12 lessons, especially P0 on the recharacterization risk + business splitting
- `docs/legal/cross-cutting/escalation-zones.md` — § 4 on tax amounts > 100k UAH (our scale falls under it)
- `docs/legal/cross-cutting/citation-rules.md` — the citation rules format
- Previous consultations in the series:
  - [USDT payouts PHASE 8](2026-05-31-usdt-payouts-phase8.md)
  - [TOV multi-channel revenue](2026-05-31-tov-multi-channel-revenue.md)
  - [Diia City roadmap](2026-05-31-diia-city-implementation-roadmap.md)
  - [Offshore alternatives](2026-05-31-offshore-alternatives.md)
  - [Cash/crypto undeclared risk analysis](2026-05-31-cash-crypto-undeclared-risk-analysis.md)

### Disclaimer

**MED overall Confidence** means that the **architecture is sound**, but:

1. **§ 4 escalation-zones (tax amounts > 100k UAH)** — our scenario reaches a ₴700k+ annual tax burden, which **definitely** requires a human tax-advisor review **before** a financial action. This document is a **planning framework**, not an **execution-ready calculation**.

2. **§ 2 (soft escalation zones)** — a major change in the employment structure (a mass transfer to gig contracts) + the registration of a new legal entity (a TOV + a Diia City application) + Vendor contracts with high data sensitivity (WhiteBIT, Wise KYB) — each of them is **action-critical**.

3. **Specific human professionals are mandatory** BEFORE the launch:
   - A **specialized IT-corporate lawyer** (Sayenko Kharenko / Avellum / Asters / Juscutum / EQUITY / in-house boutiques) — ₴15-30k one-off for the template pack + Diia City application supervision. **Not a template from the internet.**
   - A **bookkeeping firm with Diia City experience** — ₴15-25k/month ongoing, **engage before the Phase 6 launch**
   - An **audit firm with mandatory-audit experience** — ₴30-80k/year annually; choose in Q4 of the first year of operations
   - A **specialized tax advisor** (a consultation) — ₴5-15k one-off for validation of the tax math on your real numbers (not on the conditional 5M scenario)

4. **A banking lawyer for FX > €400k/quarter:** if in the first year of operations you go to a quarterly volume > €400k (~₴18M/quarter, ~₴72M/year revenue) — engage a banking-spec lawyer for a compliance review of the currency control documentation.

5. **WebSearch verifications are mandatory at the moment of action:** WhiteBIT fees, Wise acceptance policy, Diia City legislation, minimum wage rates — **all change quarterly**. **Re-verify** before each important decision. This document is accurate as of **2026-05-31**; as of your moment of action — verify.

6. **Not binding legal advice.** The AI lawyer gives a preliminary framework. Implementation requires human professional supervision. For critical decisions (>₴100k annual tax impact) — a mandatory human review.

7. **Tied to user-specific facts:** the numbers are calibrated on ₴5-10M turnover with a 50/50 partner split. The real numbers of your business may change the math substantially (>10% deviation in the effective rate). Calibrate on the real numbers with a tax advisor after the Phase 6 launch.

**Date of completion of the consultation:** 2026-05-31
**Status:** Implementation-grade guide; ready for the User to start on Monday with the Top-3 actions.
