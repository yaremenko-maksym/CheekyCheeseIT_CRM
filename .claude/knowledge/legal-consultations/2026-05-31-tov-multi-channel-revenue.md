# Legal Consultation: TOV structure + Multi-Channel Revenue + Invoice Issuer

## Mode: strategic

## Date: 2026-05-31

## Requested by: User direct → PM

## Context

CRM Cheeky Cheese IT — an outsource/outstaffing company (Ukraine). Business model:

- SENIORs work for foreign clients (US/EU)
- JUNIORs — subcontractors of the SENIORs on projects
- Income distribution: the SENIOR keeps 26%, the remaining 74% go to the JUNIOR (fixed) + the remainder 50/50 ADMIN/partner
- Scale on a 12-month horizon: up to 10 teams × 3-5 people = ~30-50 effective contributors

Current structure (which the user wants to change):

- ADMIN — a founder with a TOV + a FOP
- SENIOR, JUNIOR — FOP group 3 (5% single tax)
- All client payments → the SENIOR-FOP directly
- The "company's" income = the ADMIN's share of the 74% after the partner split

## Restructuring intent

The user wants to **make a TOV the main entity** (not FOP-centric), through which all business flows pass.

**Multi-channel revenue** — a client can pay in three ways:

1. **The TOV's bank account** (UAH or FX via a currency sub-account)
2. **Crypto to a smart contract** → an automatic split to admin wallets (the question is related to the [previous USDT consultation](2026-05-31-usdt-payouts-phase8.md))
3. **Cash to the admin** (directly, without a bank)

**All invoices must have legal weight.** The terms must be fixed:

- In the **client contracts** (Services Agreement)
- In the **user agreement** (Terms of Service for the CRM platform)

## Questions

### Q1 — Which company model in Ukraine is best suited? (NOT FOP)

Options we know (the User is open to others):

- **A TOV on the general system** (18% corporate profit tax + 19.5% dividend income for an individual participant)
- **A TOV on the single tax group 3** (5% of turnover, limit ~8.4M UAH / 2026, without VAT; or 3% + VAT)
- **A TOV on the single tax group 4** (agricultural — not our case)
- **JSC / full partnership / limited partnership** — overkill for our scale?
- Combo: a TOV + supporting FOPs — if this is legitimate

**Critical criteria:**

- Supports international settlements from foreign clients (USD/EUR/USDT) with a minimal currency burden
- Supports cash turnover (if legally possible)
- Compatible with future crypto operations (when Law 2074-IX takes effect)
- Minimizes the tax burden with reasonable compliance overhead
- Can scale to ~50 contributors (employees vs FOP subcontractors — what model of working with the team?)

### Q2 — Multi-channel revenue legalization

**How to legally arrange the acceptance of payments through 3 channels simultaneously so that an invoice has legal weight?**

#### Q2.1 — The TOV's bank account

- What requirements for the invoice (DPS numbering? a seal? an electronic signature?)
- VAT obligations if the TOV is a VAT payer; alternatives without VAT
- Currency control for FX receipts (a transaction passport if applicable, limits of 400k EUR/quarter?)

#### Q2.2 — Crypto to a smart contract → admin wallets

- What is considered the "moment of payment" from the point of view of revenue recognition (on the TOV side)?
- The USDT→UAH conversion rate — which fixation date (the day of on-chain receipt?)
- How does the TOV reflect crypto income in bookkeeping when the money is in a smart contract / on private wallets?
- Is it even possible without VASP registration after Law 2074-IX takes effect?

#### Q2.3 — Cash to the admin

- Limits on cash operations through an RRO / PRRO for a TOV
- How is the receipt from the client arranged (a cash receipt order? a PRRO receipt? a tax invoice?)
- How does this cash get into the TOV's bookkeeping (a deposit to the bank account? or alternative legitimate paths?)
- The cash limit per day / month for a TOV from one counterparty

#### Q2.4 — Contractual requirements

- What to specify in the **Services Agreement with the client** so that any of the 3 channels is valid?
- What in the **Terms of Service** of the CRM platform (for users who work through our system)?
- A multi-payment-method clause — a specific template/wording

#### Q2.5 — The legal weight of the invoice

- The minimum mandatory details of an invoice in UA
- A seal / a qualified electronic signature — what is mandatory
- Numbering and registration (DPS / tax invoice)
- Payment terms of the invoice — what to specify

### Q3 — Cash/Crypto — the invoice issuer ≠ CheekyCheeseIT?

**User assumption:** "if a person pays in cash or crypto, then the invoice should not indicate that the payment goes to the company CheekyCheeseIT".

**We ask Legal:**

1. **Is this assumption correct?** If the invoice is from the TOV — can it be paid in cash / crypto with proper arrangement? If not — why specifically?

2. **If the assumption is correct** (cash/crypto require a different issuer):
   - Who can legitimately be the issuer (the ADMIN's FOP? the partner's FOP? a separate FOP "for non-bank flows"? a smart contract as a "technical executor"?)
   - How to structure it so that it is audit-proof and does not look like a profit-shifting or tax evasion scheme
   - What contractual links between the different issuers and the TOV are necessary

3. **If the assumption is incorrect:**
   - How to correctly issue an invoice from the TOV that is paid in cash / crypto
   - What additional documents are needed on the TOV's side

**Important for the User:** we are not looking for an evasion scheme. We want a legitimate structure where the cash/crypto channels have formal arrangement, everything is transparently auditable and legally separable if someone starts digging.

## What matters for the decision

- The solution is **audit-proof** (will withstand a DPS audit without revealing compromising connections)
- **Scalable** to ~50 contributors within a year
- **Without criminal risk** (Art. 212 of the Tax Code — evasion, Art. 209 — laundering — not our profile)
- A budget for the initial setup up to **200k UAH** (licensing + contract packages + bookkeeping setup)
- Minimum ongoing admin overhead — we are a tech company, not a financial one

## What we do NOT discuss

- The general theory of UA accounting — we need concrete decisions
- Crypto in general — already covered in the [previous consultation](2026-05-31-usdt-payouts-phase8.md)
- Foreign structures (Estonia e-Residency, Cyprus, Dubai) — only UA scope for this consultation (we will discuss offshore options separately if applicable)

---

<!-- The Legal agent will add the `## Lawyer answer` section below -->

## Lawyer answer

**Confidence:** MED (overall) — with a breakdown by question:

- Q1 (choice of legal form) — **MED** (the norms are stable: the Tax Code, the Diia City regime — Law 1667-IX; but a specific recommendation depends on the scale strategy, requires a human-tax review for the final model)
- Q2 (multi-channel revenue) — **MED → LOW** for Q2.2 (crypto in TOV bookkeeping — a legal vacuum until the activation of 2074-IX, see the previous consultation)
- Q3 (issuer ≠ CheekyCheeseIT for cash/crypto) — **LOW** (this question has direct overlap with § 1 escalation-zones.md — potential criminal risk of Art. 212 of the Criminal Code of Ukraine when attempting to split issuers across several entities to circumvent taxes)

**Mode:** strategic
**Date:** 2026-05-31

**CRITICAL before reading:** This answer touches on hard-escalation zones per [`docs/legal/cross-cutting/escalation-zones.md`](../../legal/cross-cutting/escalation-zones.md):

- **§ 1 (Criminal-law risks of Art. 212 of the Criminal Code of Ukraine)** — Q3 (issuer ≠ CheekyCheeseIT) requires extreme caution. A structure where cash/crypto is arranged on a separate entity "so as not to expose the TOV" may be qualified by the DPS/investigators as **intentional tax evasion through artificial splitting of income among related parties**. The User explicitly emphasized "we are not looking for an evasion scheme" — in the Analysis of Q3 it is shown **where the red line runs** and which structure does NOT cross it.
- **§ 4 (Specific tax amounts > 100k UAH)** — Q2.3 (cash) at a volume > 100k UAH/period — the exact calculations of obligations are for a tax consultant.
- The crypto part (Q2.2) is fully inherited from the previous consultation [`2026-05-31-usdt-payouts-phase8.md`](./2026-05-31-usdt-payouts-phase8.md) — there is no repeated analysis here, there is **integration** with the TOV structure.

### TL;DR

**Direct recommendation on the structure:** **A TOV — a resident of Diia City with an exit-capital tax rate of 9%** (for a reinvest strategy) **+ a contractual network with the team via gig contracts** (5% PIT + 5% military levy + 22% USC of the minimum wage, ~₴418/month per gig specialist) — this is the **only** legitimate path to scale to 30-50 contributors in UA IT outsource, which simultaneously gives low-tax + valid invoices + a currency-control exemption for the export of services + a reserve for a future crypto integration. **Multi-channel revenue (Q2) — bank-only is recommended**: cash and crypto through a TOV in 2026 is a **major compliance risk** without a proportional business benefit. **Q3 user assumption "issuer ≠ CheekyCheeseIT for cash/crypto" — categorically NOT recommended** — this is a direct path to Art. 212 of the Criminal Code of Ukraine; the correct approach is for all three channels to **go through one entity** with the proper arrangement of each.

### Analysis

#### Q1 — Which legal form of company in Ukraine is best suited

**A comparative matrix of regimes for IT outsource (~30-50 contributors, ~$1-5M of annual turnover):**

| Regime                                                | Tax on the entity's income                                                                                                                                                                                                                                                                                        | Tax on the "withdrawal" to the owner                                                                                                        | TURNOVER LIMIT                                                                                                                                                                                               | Compatibility with gig/employees                                                                                                                                            | Crypto readiness                                                                                                      | Verdict                                                                                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **TOV single tax group 3 (5%, without VAT)**          | 5% of turnover + 1% military levy = **6% of gross**                                                                                                                                                                                                                                                               | Dividends: 9% PIT + 5% military levy for a resident participant (non-resident: 15%+5%)                                                      | **~10 091 049 UAH** (1167 minimum wages as of 01.01.2026) ([WebSearch: bip.net.ua/yedinij-podatok-dlya-fop-i-tov](https://bip.net.ua/articles/yedinij-podatok-dlya-fop-i-tov/), collection date: 2026-05-31) | Employees without limits, but payments — under an employment/civil-law contract → additional burden (18% PIT + 5% military levy + 22% USC for employees)                    | Low — a formal ban for single-tax regimes on crypto settlements (while 10225-d (original: 10225-д) is not introduced) | **Limit ~10M UAH = ~$240k/year. For 30-50 contributors at $3-5k/month — too little.** Will burn the limit on 2-3 projects per year.       |
| **TOV general system (18% corporate profit tax)**     | 18% of taxable profit ([Article 134 of the Tax Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2755-17#n3299)) ([WebSearch: tax.gov.ua/nk/spisok3](https://tax.gov.ua/nk/spisok3/), collection date: 2026-05-31)                                                                                             | Dividends: 5% PIT (resident) + 5% military levy ([Article 167.5.4 of the Tax Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2755-17)) | No limits                                                                                                                                                                                                    | Employees + FOP contractors OK; standard tax burdens                                                                                                                        | Concept-OK for crypto **after the introduction of 2074-IX**; now — uncertainty                                        | Unlimited, but the **effective tax is 18% + 10% = ~26%** when withdrawing profit. Expensive.                                              |
| **TOV — a Diia City resident, exit-capital tax (9%)** | **0% while the profit is reinvested**; **9% exit-capital tax** only at the moment of withdrawal (dividends, free-fund sale, payments to non-residents) ([WebSearch: i.factor.ua/2026/march/issue-18](https://i.factor.ua/ukr/journals/nibu/2026/march/issue-18/article-136492.html), collection date: 2026-05-31) | Resident: 5% PIT + 5% military levy (via salary), 9% exit-capital tax on dividends (at the moment of payment)                               | No limits                                                                                                                                                                                                    | **Gig contracts** — a unique Diia City instrument: 5% PIT + 5% military levy + 22% USC of the minimum wage (~₴418/month) for a gig specialist. Employees are also possible. | High — Diia City was specifically designed for IT, including crypto-pay-flows (conceptually)                          | **WINNER** for our case                                                                                                                   |
| **TOV — a Diia City resident, profit (18%)**          | 18% of profit on general grounds                                                                                                                                                                                                                                                                                  | Dividends: standard 5%+5%                                                                                                                   | No limits                                                                                                                                                                                                    | Gig contracts + employees                                                                                                                                                   | High                                                                                                                  | An alternative if a lot of distribution (then 18%+10% ≈ 26% in total, as on the general system; the gig benefits apply separately anyway) |
| **JSC / full partnership / limited partnership**      | Depends on the form                                                                                                                                                                                                                                                                                               | Depends                                                                                                                                     | None                                                                                                                                                                                                         | Yes                                                                                                                                                                         | High                                                                                                                  | **Overkill** for our scale — complex corporate governance, expensive to administer                                                        |
| **Combo TOV + FOPs (as now)**                         | TOV-share + FOP 5%+1% each                                                                                                                                                                                                                                                                                        | Depending on the config                                                                                                                     | TOV limits — as above; FOP limit ~₴8.4M/year                                                                                                                                                                 | Yes                                                                                                                                                                         | Weak — for a FOP on the single tax crypto is prohibited                                                               | Works for small scale (≤5 SENIORs), but does not scale                                                                                    |

**Expanded per option:**

1. **TOV single tax group 3 (5% / 3%+VAT) — REJECTED for our scale.**

   The limit is **10 091 049 UAH** ([Article 291.4.1 of the Tax Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2755-17#n4877); WebSearch: [bip.net.ua/yedinij-podatok-dlya-fop-i-tov](https://bip.net.ua/articles/yedinij-podatok-dlya-fop-i-tov/), collection date: 2026-05-31) — this is ~$240k/year at a rate of ₴42. At 10 teams × $50k/team — the limit is already exceeded at the start. Exceeding it = **loss of single-tax-payer status** + transfer to the general system with a quarterly calculation + penalties. For a test launch on 1-2 SENIORs it will do, for the **planned 30-50 contributors — NO**.

2. **TOV general system — a working fallback, but expensive.**

   18% of profit + 5% PIT + 5% military levy on dividends (for a resident participant) = **effective ~26%** of the net profit before withdrawal. If ADMIN + partner are both UA residents, that holds for them. For non-residents (Q1.partner) the PIT rate on dividends is **15%** + 5% military levy ([Article 167.5.1 of the Tax Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2755-17)). No turnover limit, no specific licensing requirements. One can (with registration) be a VAT payer at a turnover > ₴1M/year (the export of IT services — **0% VAT** per [Art. 195.1.1 of the Tax Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2755-17), reverse-charge not applicable to exports → no real-life VAT burden on income).

3. **TOV — a Diia City resident — I RECOMMEND it as the main structure.**

   Diia City is a special legal regime under **[Law No. 1667-IX "On Stimulating the Development of the Digital Economy in Ukraine"](https://zakon.rada.gov.ua/laws/show/1667-20)** (introduced 14.10.2021). Parameters (confirmed via WebSearch):
   - **Residency:**
     - Min. 9 employees (including gig specialists) at the moment of entering the regime (for a startup it can start at 0; for a full resident — must hit 9 within the term) ([WebSearch: bip.net.ua/articles/diya-siti-umovi-vimogi-perevagi-j-nedoliki](https://bip.net.ua/articles/diya-siti-umovi-vimogi-perevagi-j-nedoliki/), collection date: 2026-05-31)
     - The average monthly remuneration of each specialist ≥ **€1200** equivalent
     - Qualified business-activity codes (for IT — the main ones 62.01 "computer programming", 62.02, 63.11, etc.) — applicable for us
     - ≥ 90% of income from the qualified activity

   - **Tax regime (options):**
     - **Option A — exit-capital tax 9%:** the profit tax is paid **only at the moment of dividend payment** or other capital-withdrawal operations. Until that moment — **0% tax** on reinvest. ([WebSearch: kpmg.com/ua/uk/blogs/2024/03/diya-siti-ta-vidstrocheni-podatky](https://kpmg.com/ua/uk/blogs/home/posts/2024/03/diya-siti-ta-vidstrocheni-podatky.html), collection date: 2026-05-31; [WebSearch: i.factor.ua/2026/march/issue-18](https://i.factor.ua/ukr/journals/nibu/2026/march/issue-18/article-136492.html), collection date: 2026-05-31)
     - **Option B — 18% regular profit tax:** makes sense if you constantly withdraw a large part of the profit as dividends (then 18% + 5% PIT + 5% military levy on dividends ≈ 26%; vs exit-capital tax 9% on each withdrawal = ~14% in total, i.e., the exit-capital tax wins at any rational reinvest/distribute ratio)

   - **The gig contract — a key instrument:**
     - A gig specialist = an **individual** with a "mixed" legal nature (labor + civil-law)
     - A Diia City resident as a tax agent pays: **5% PIT + 5% military levy + 22% USC of the minimum wage (₴1902.34 in 2026)** = USC ~ **₴418/month per specialist** ([WebSearch: bip.net.ua/articles/diya-siti-umovi-vimogi-perevagi-j-nedoliki](https://bip.net.ua/articles/diya-siti-umovi-vimogi-perevagi-j-nedoliki/), collection date: 2026-05-31)
     - Compare: FOP group 3 = 5% single tax + 1% military levy + USC ₴1760/month — practically **analogous in cash flow**, but:
       - A gig contract gives **social guarantees** (vacation, sick leave, insurance)
       - A gig contract **can be combined with a FOP** (an individual can simultaneously be a gig specialist of a Diia City resident + a FOP in another activity, [WebSearch: news.dtkt.ua/simple/individual-single-tax/88330](https://news.dtkt.ua/simple/individual-single-tax/88330-ci-moze-fizosoba-jedinnik-iii-grupi-uklasti-gig-kontrakt-na-vikonannia-robit-z-rezidentom-diia-siti), collection date: 2026-05-31) — gives flexibility for the current SENIORs: they can keep their FOP for some parallel activities and simultaneously be gig specialists in the TOV Diia City resident

   - **Dividend payment to the partner:** via the exit-capital tax — at the moment of payment, 9% exit-capital tax on the amount + the recipient's dividends 5% PIT + 5% military levy for a resident (for a non-resident — 15% + 5%, but there are double taxation treaties with most EU/US countries, which lower it to 5-10%).

   - **Cryptocurrency:**
     Diia City conceptually provides for **special conditions for VA operations** after the introduction of 2074-IX. The detailed regulation is in draft law 10225-d ([see the previous consultation](./2026-05-31-usdt-payouts-phase8.md) Q1, Q2). As of 2026-05-31 — **status invariant**: until the base VA law takes effect — operations with USDT in a TOV regime are formalized through conversion via a licensed exchange, not through a direct on-chain receipt. **Diia City does NOT create an exemption** from this.

**Verdict Q1:** **A TOV — a Diia City resident, exit-capital tax 9%, with the team on gig contracts** — this is the best structure for our scale + IT-outsource profile + future crypto integration.

**An alternative if Diia City is unreachable at the start** (no 9 specialists, no €1200 payment): **A TOV on the general system** with a plan to transition to Diia City upon reaching the minimum thresholds.

#### Q2 — Multi-channel revenue legalization

##### Q2.1 — The TOV's bank account (recommended primary channel)

**Invoice details (invoice-factura) for payment to the TOV's bank:**

[Article 9 of Law No. 996-XIV "On Accounting and Financial Reporting in Ukraine"](https://zakon.rada.gov.ua/laws/show/996-14) establishes the list of **mandatory details of a primary document** ([WebSearch: kodeksy.com.ua/pro_buhgalters_kij_oblik_ta_finansovu_zvitnist/statja-9.htm](https://kodeksy.com.ua/pro_buhgalters_kij_oblik_ta_finansovu_zvitnist/statja-9.htm), collection date: 2026-05-31):

1. The name of the document (form)
2. The date of drawing up
3. The name of the enterprise on whose behalf the document is drawn up
4. The content and volume of the economic operation, the unit of measurement
5. The positions of the persons responsible for carrying out the operation and the correctness of its arrangement
6. A personal signature or other data that make it possible to identify the person who participated in the operation

**For an invoice to a non-resident specifically:**

A DPS letter (for example, [Letter of the DPS in the Odesa region from 2024 "On the application of invoices-facturas (invoices)"](https://od.tax.gov.ua/media-ark/news-ark/669798.html); WebSearch collection date: 2026-05-31) clarifies: an invoice from the TOV to a non-resident, which contains the main terms of the contract (description, price, requisites), **has the force of a foreign economic contract** and **an acceptance act is not separately needed**. This mechanism is fixed by [Cabinet of Ministers Resolution No. 1186 dated 15.09.2017](https://zakon.rada.gov.ua/laws/show/1186-2017-%D0%BF) (relevant as of 2026).

**What this means for us:**

- An invoice from the TOV → to the client (US/EU) in PDF format with mandatory details + price + bank requisites → the client pays → the bank credits it without the need for a separate contract with wet signatures.
- **A qualified electronic signature (KEP)** is mandatory only if the invoice is electronic and is used for document flow between the parties in Ukraine. For foreign economic invoices — a simple PDF with the director's signature (a sole signature is OK) + a seal (since 2018 the seal is not mandatory, but **recommended** for non-resident invoices — banks are more comfortable during FX checks).

**Numbering:** Sequential, without gaps, in a format that is clear to accounting (for example, `INV-2026-00001`). Registration with the DPS is not needed (for non-VAT payers). If the TOV is a VAT payer (turnover > ₴1M/year), then in addition to the invoice for **resident** clients — a **tax invoice** in the Unified Register of Tax Invoices (ERPN) is mandatory ([Article 201 of the Tax Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2755-17#n5283); WebSearch: [ibuhgalter.net/tax-codex/203](https://ibuhgalter.net/tax-codex/203), collection date: 2026-05-31). For non-resident clients — **the export of services is 0% VAT per [Art. 195.1.1 of the Tax Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2755-17)**, the tax invoice is registered with a 0% rate code.

**Currency control for FX receipts:**

[Law No. 2473-VIII "On Currency and Currency Operations"](https://zakon.rada.gov.ua/laws/show/2473-19) defines the basic rules. The current practice (as of 2026-05-31, WebSearch: [export.gov.ua/138-valiutnii_kontrol_pri_vikonanni_zovnishnoekonomichnikh_dogovoriv](https://export.gov.ua/138-valiutnii_kontrol_pri_vikonanni_zovnishnoekonomichnikh_dogovoriv) collection date: 2026-05-31):

- **The export of services — without currency control on receipts** (this is not an import, for which there is a term-of-payment-180-days rule)
- The limit of "settlements without currency control" — operations < **₴400k** equivalent per one contract (this is for imports; for the export of services the liberalization is broader)
- The specific case "IT services to a non-resident": the bank may request an invoice + a contract (or an invoice-as-contract per Resolution 1186) to credit to the currency account. This is a **routine compliance check**, not a barrier.

**Conclusion Q2.1:** The bank channel — straightforward, legal, scalable. It is the **primary channel** for all clients.

##### Q2.2 — Crypto to a smart contract → admin wallets

**This section has overlap with the previous consultation.** Here — integration into the TOV structure.

**The current (2026-05-31) situation:**

- Law 2074-IX "On Virtual Assets" is **not in force** (awaiting the entry into force of the changes to the Tax Code via draft law 10225-d) — [details in the previous consultation Q1](./2026-05-31-usdt-payouts-phase8.md#q1--ua-crypto-law)
- Until 10225-d passes the final reading + takes effect, the TOV **cannot legitimately record a crypto receipt in bookkeeping as income directly** without an intermediate banking event
- The only real flow for now: USDT comes **to the address of the TOV's director** (an individual) → conversion via a licensed exchange (Whitebit, Kuna) → UAH to the bank → a deposit to the TOV via one of:
  - A founder's loan agreement (to be repaid later without taxation)
  - Irrevocable financial assistance (without interest) — taxed as the TOV's income
  - A contribution to the statutory capital (requires registering changes to the Statute)

**This is NOT clean revenue recognition.** The TOV cannot show in bookkeeping "income in cryptocurrency received on 15 April 2026" — there is no legal basis for accounting standard recognition.

**What will change after the introduction of 2074-IX:**

- The TOV will be able to legitimately receive VA as payment for services
- The USDT→UAH conversion rate will be fixed at the NBU rate on the date of receipt or at the market rate of a licensed exchange (the exact norm will be introduced by 10225-d)
- A TOV Diia City resident will conceptually have special eased rules (in detail in the by-laws of the NSSMC)

**Recommendation for Q2.2:** **While 2074-IX is not introduced — do NOT arrange crypto as a direct channel of the TOV.** Instead:

- Keep the crypto channel in the CRM as a **future feature** (phase 8 per the roadmap)
- For current cash-flow clients who want to pay in USDT — either (a) move to the bank rail with conversion of USDT via the client's/executor's exchange, (b) in exceptional cases — accept to the ADMIN's personal address with conversion and a deposit to the TOV as a founder's loan (audit-OK, but **not the TOV's income** in bookkeeping)

**Confidence Q2.2: LOW** — this is a legal vacuum, the exact structure will be clear only after 10225-d takes effect.

##### Q2.3 — Cash to the admin

**Cash settlement limits ([NBU Resolution No. 148 dated 29.12.2017](https://zakon.rada.gov.ua/laws/show/v0148500-17); WebSearch: [yankiv.com/limity-na-rozrahunky-gotivkoyu](https://yankiv.com/limity-na-rozrahunky-gotivkoyu/), collection date: 2026-05-31):**

| Parties to the settlement                     | Daily limit                             |
| --------------------------------------------- | --------------------------------------- |
| Legal entity ↔ legal entity (including a FOP) | **₴10 000 / day with one counterparty** |
| Legal entity ↔ individual                     | **₴50 000 / day with one counterparty** |

**Neither option is suitable for typical IT-outsource invoices** ($3-5k+/month = ₴125-200k):

- If the client is a legal entity: the ₴10k/day limit excludes cash for our profile
- If the client is an individual: the ₴50k/day limit; a payment of $3k = ₴125k = requires **3 calendar days** of separate payments = artificial splitting → this is a **sign of transactions structuring**, which the DPS/Financial Monitoring may treat as an intentional circumvention of the limit → penalties + the risk of Art. 212 of the Criminal Code of Ukraine

**Accepting cash by a TOV — mandatory elements:**

1. **RRO/PRRO** — per [Law No. 265/95-VR (original: 265/95-ВР) "On the Use of Payment Transaction Recorders"](https://zakon.rada.gov.ua/laws/show/265/95-вр) a TOV is obliged to use an RRO/PRRO for any cash settlement for goods/services (including services to non-residents in foreign currency) ([WebSearch: yankiv.com/rro-prro-2026-komu-oboviazkovo](https://yankiv.com/rro-prro-2026-komu-oboviazkovo/), collection date: 2026-05-31). Exception: a FOP of group 1 + some specific ones.
2. **A cash receipt order (form KO-1)** — drawn up for each cash receipt, with reflection in the cash book (form KO-4) ([WebSearch: medoc.ua/blog/pributkovij-kasovij-order-shho-slid-znati](https://medoc.ua/blog/pributkovij-kasovij-order-shho-slid-znati-/), collection date: 2026-05-31)
3. **The signature of the responsible persons** (the cashier + the accountant/director)
4. **The subsequent deposit of cash to the bank** — according to the terms of the cash service agreement

**Cash from a non-resident — a separate ban:** [NBU Resolution No. 5 dated 02.01.2019 "On approval of the Regulation on carrying out operations with currency valuables"](https://bank.gov.ua/admin_uploads/law/02012019_5.pdf) prohibits cash settlements in foreign currency under foreign economic contracts with non-residents, except for very specific narrow cases (operational expenses of transport, etc.) ([WebSearch: help-biz.sensebank.com.ua](https://help-biz.sensebank.com.ua/hc/uk/articles/6441120324498), collection date: 2026-05-31). **That is, a non-resident client CANNOT pay cash (USD/EUR) to a TOV legally.**

**Conclusion Q2.3:** The cash channel for a TOV IT outsource in our profile (non-residents, $3k+ invoices) is **practically impossible legally**. If the client is a resident individual and pays ₴50k/day — theoretically OK with an RRO+cash receipt order. But this is a rare edge case, not a business model.

##### Q2.4 — Contractual requirements (Services Agreement + Terms of Service)

**Services Agreement with the client — mandatory clauses for multi-payment-method support:**

1. **Payment methods clause** (Articles at choice):

   ```
   Article X. Payment Methods.
   X.1. Client may settle invoices via one of the following methods, at Client's
        discretion:
        (a) Bank wire transfer in EUR/USD/UAH to the bank account of Service
            Provider indicated in the relevant invoice;
        (b) [reserved for future activation: cryptocurrency settlement in USDT
            (ERC-20) to a designated wallet address upon mutual written agreement
            of both Parties and subject to applicable Ukrainian law]
   X.2. Cash settlements are not accepted under this Agreement.
   X.3. The choice of payment method shall be confirmed in writing before the
        first invoice and documented in Appendix B (Payment Details).
   X.4. Invoice is deemed paid on the date funds are received in Service
        Provider's account (for bank) or recorded on-chain confirmation
        (for crypto, when activated).
   ```

2. **Invoice format clause:**

   ```
   Article Y. Invoicing.
   Y.1. Service Provider shall issue an invoice no later than 5 business days
        after the end of the reporting period.
   Y.2. Each invoice shall contain the following mandatory details:
        - Invoice number and date
        - Service Provider's full legal name, address, EDRPOU code, VAT
          number (if applicable), bank details
        - Client's full legal name, address, registration number
        - Description of services rendered, period, hours/units, rate, total
        - Currency of settlement (EUR/USD/UAH)
        - Payment terms (e.g., NET 30) and due date
        - Designated payment method per Appendix B
   Y.3. Invoice signed by Service Provider's authorized representative.
        For invoices to non-residents, this Invoice shall constitute the
        sole document required for cross-border services rendering under
        Ukrainian Cabinet of Ministers Resolution No. 1186 dated 15.09.2017,
        and serves as the Services Agreement equivalent in lieu of a
        separately executed acceptance act.
   ```

3. **Multi-method but single-issuer clause** (CRITICAL for Q3):
   ```
   Article Z. Single Counterparty.
   Z.1. All settlements under this Agreement, regardless of payment method
        chosen by Client (Article X), are made to and from Service Provider
        as a single legal entity. Service Provider is solely responsible
        for accounting and tax compliance regarding all received payments.
   Z.2. Client is not required to interact with any third party for
        settlement purposes. Any internal allocation of funds by Service
        Provider is not Client's concern.
   ```

**Terms of Service for the CRM platform (internal users):**

This is a **separate document** from the Services Agreement. It governs the relationship between the TOV as the owner of the CRM platform and the users (the SENIOR/JUNIOR/HR/ACCOUNTANT employees). It must cover:

- The lawful basis for processing personal data ([Art. 6 GDPR](https://gdpr-info.eu/art-6-gdpr/) — for EU users, [Art. 11 of Law No. 2297-VI "On the Protection of Personal Data"](https://zakon.rada.gov.ua/laws/show/2297-17) for UA users)
- Wallet address handling, an AML disclaimer for crypto-related fields
- User confidentiality / NDA-style provisions
- Termination clauses

**This is a separate legal consultation for elaboration** — the current focus is Q1-Q3.

##### Q2.5 — The legal weight of the invoice

Covered in Q2.1 above (Article 9 of No. 996-XIV + Cabinet of Ministers Resolution No. 1186). Summary:

| Detail                                   | Bank/UAH (resident)                    | Bank/FX (non-resident)                                    | Crypto (post-2074-IX)                      |
| ---------------------------------------- | -------------------------------------- | --------------------------------------------------------- | ------------------------------------------ |
| Company name, EDRPOU, address            | Mandatory                              | Mandatory                                                 | Mandatory                                  |
| Recipient's bank details                 | Mandatory                              | Mandatory (including SWIFT, IBAN)                         | The wallet address instead of a bank       |
| Director's signature                     | Mandatory (wet or KEP)                 | Mandatory (wet or KEP; for a non-resident — facsimile OK) | Depending on the implementation of 2074-IX |
| Seal                                     | Not mandatory (since 2018)             | Recommended for FX                                        | TBD                                        |
| Tax invoice in the ERPN                  | Yes, if a VAT payer                    | Yes (0% rate export of services)                          | TBD                                        |
| Registration of the invoice with the DPS | No (only the tax invoice)              | No                                                        | TBD                                        |
| Payment term                             | At discretion (specify in the invoice) | At discretion (specify)                                   | At discretion                              |
| Electronic document tool                 | NOT mandatory (paper is OK)            | NOT mandatory                                             | Electronic (a smart contract receipt)      |

#### Q3 — Cash/Crypto — the invoice issuer ≠ CheekyCheeseIT?

**CRITICAL.** This section requires the greatest caution. The User has already said "we are not looking for an evasion scheme", and this is the correct position — one must clearly show **where the criminal red line runs** and why **the user assumption must be reconsidered**.

##### Scenario A — User assumption: "cash/crypto through a different entity (not the TOV)"

**User formulation:** "if a person pays in cash or crypto, then the invoice should not indicate that the payment goes to the company CheekyCheeseIT".

**Analysis of this as a legal construction:**

If CheekyCheeseIT (the TOV) provides services to the client (per the Services Agreement) and the client wants to pay cash/crypto, but this payment is arranged on a **separate individual or FOP** (ADMIN, partner, or a "service FOP"), although it is really remuneration for the TOV's services — this is classified as:

1. **"Income splitting" (the TOV's actual income → is artificially attributed to another person)** — this is a basic pattern of intentional tax evasion ([Article 212 of the Criminal Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2341-14#n1395)), especially if the goal is to hide part of the TOV's turnover (e.g., to stay under the single tax limit, or to avoid VAT registration, or simply to reduce the effective tax).

2. **The threshold of criminal liability under Art. 212 of the Criminal Code of Ukraine in 2026** — a budget shortfall ≥ **3000 non-taxable minimum incomes of citizens = ₴4 992 000** (significant amounts) ([WebSearch: smartsolutions.ua/porohy-prytiahnennia-do-kryminalnoi-vidpovidalnosti-za-ukhylennia-vid-splaty-podatkiv](https://smartsolutions.ua/porohy-prytiahnennia-do-kryminalnoi-vidpovidalnosti-za-ukhylennia-vid-splaty-podatkiv/), collection date: 2026-05-31). For our scale (30-50 contributors × $3-5k × 12 months) — the turnover is ~₴50-90M/year. Evasion of even 5-10% of income = easily exceeds the threshold of Art. 212.
   - Significant amounts (≥₴4.99M): a fine of ₴5k-10k non-taxable minimums
   - Large amounts (≥₴8.32M = 5000 non-taxable minimums): a fine of ₴10k-15k non-taxable minimums + deprivation of the right to hold positions
   - Especially large (≥₴11.65M = 7000 non-taxable minimums): a fine of ₴15k-25k non-taxable minimums + confiscation

3. **Co-conspirator liability:** not only ADMIN, but also the partner and any person who knew about the scheme (an accountant, a lawyer, another employee) may be brought to criminal liability as **accomplices** ([Art. 27 of the Criminal Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2341-14)).

4. **AML dimension ([Art. 209 of the Criminal Code of Ukraine — legalization (laundering) of proceeds](https://zakon.rada.gov.ua/laws/show/2341-14#n1377))**: if this cash/crypto income is then "legalized" through banking operations (a deposit to the TOV, conversion to acquire assets) — this is a separate corpus delicti, on top of Art. 212.

**Verdict Scenario A: CATEGORICALLY NOT RECOMMENDED.** This is a direct path to Art. 212 of the Criminal Code of Ukraine. The user assumption here is fundamentally mistaken — the issuer must coincide with the real economic beneficiary, not with the payment channel.

##### Scenario B — The alternative: a legitimate single-issuer structure

**The correct approach:**

All payments for the TOV's services — an **invoice from the TOV**, regardless of channel:

- Bank → invoice from the TOV → the TOV's bank account
- Crypto (post-2074-IX) → invoice from the TOV → the TOV's wallet (or via a licensed VASP exchange as a conversion bridge)
- Cash → invoice from the TOV → the TOV's cash desk via an RRO/cash receipt order (where legal — see Q2.3 — for our profile practically impossible)

**Issuer = the TOV always.** The channel is a property of the payment, not the identity of the recipient.

**The internal distribution among ADMIN/partner/team — a separate matter:**

After the TOV has received the income (legitimately via invoice + channel), the distribution among the participants is done through:

- **Salaries/gig remuneration** to employees/gig specialists (5% PIT + 5% military levy + 22% USC of the minimum wage — for Diia City)
- **Dividends** to the founders (9% exit-capital tax for a Diia City resident)
- **Services agreements** with FOP counterparties (if the partner is a FOP)

Each of these flows is **legitimate and taxed by the corresponding tax**. The total burden — in detail in the "Analysis Q1" section — ~5% PIT on the gig + 9% exit-capital tax on dividends = **effectively ~14%** of the net profit with a reinvest-friendly strategy.

##### Scenario C — Separate issuers legitimately (only if there is a substantive economic basis)

There is a **limited set of cases** when issuer ≠ the TOV is justified and is **not a criminal risk**:

1. **The partner provides the client with separate services personally** (consulting, training, code review as an independent contractor) — the partner-FOP issues an invoice **for their separate services**, not those of the TOV. This is a purely distinct service exchange. Documentation: a separate contract between the client and the partner-FOP, without overlap with the TOV's services. Not for our "cash/crypto channel" use-case — these are completely different business relations.

2. **Subcontracting of the TOV to the partner-FOP:** the TOV issues an invoice to the client (for its part) → the partner-FOP issues an invoice to the TOV (for their part of the subcontract) → the TOV pays the partner-FOP per a subcontracting agreement. This is a **traceable double-flow** with consistent documentation at both levels. Legitimate, but **not "issuer ≠ the TOV for the client"** — the client still sees the TOV as their contractor.

3. **An affiliate sales relationship:** a separate entity (the partner-FOP) acts as a **sales agent** of the TOV, receives a commission. The client pays the TOV → the TOV pays a commission to the partner-FOP. Again — the issuer for the client = the TOV.

**In none of the legitimate cases does the issuer for the client change depending on the payment method.**

##### Conclusion Q3 (categorical)

**The user assumption "cash/crypto through a different entity, not the TOV" is a pattern of tax evasion that the DPS/investigation recognizes instantly.** The risk of Art. 212 of the Criminal Code of Ukraine + Art. 209 of the Criminal Code of Ukraine + penalties + confiscation + criminal prosecution of ADMIN, the partner and all informed persons.

**The correct solution:**

- **All invoices — from the TOV.** The channel is a detail of the payment, not the identity of the issuer.
- **Cash for our profile is practically absent** (per Q2.3 NBU restrictions + the Art. 212 risk even when splitting through small cash payments). If the client offers cash — **a refusal + a redirect to the bank**.
- **Crypto — while we wait for the activation of 2074-IX.** Until then — conversion via a licensed exchange + the bank channel.
- **Issuer = the TOV ALWAYS.** This is a non-negotiable architectural decision.

**If the user insists on cash/crypto with a different issuer** — this is territory where AI Legal **refuses further consultation** (§ 1 escalation-zones.md activated). This needs to be addressed with a practicing criminal defense lawyer (NOT a tax consultant) to understand the full scope of the criminal exposure.

### Risks

| #   | Risk                                                                                                                                                                                                                            | Severity     | Probability                                  | Mitigation                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Criminal liability Art. 212 of the Criminal Code of Ukraine** for structuring income through split issuers (Q3 user assumption if implemented). The threshold ₴4.99M shortfall = easily exceeded at turnovers of ₴50-90M/year | **Critical** | High (if Scenario A is actually implemented) | (a) **Reject the Scenario A user assumption**: all invoices issuer = the TOV; (b) exclude the cash channel from the production architecture (per Q2.3); (c) crypto channel — `feature flag OFF` until the activation of 2074-IX; (d) consult a practicing criminal/tax lawyer **before** any attempt at a multi-issuer structure |
| 2   | **Criminal liability Art. 209 of the Criminal Code of Ukraine (legalization)** in a cash flow → a deposit to the TOV as a "founder's loan" without real economic substance                                                      | **Critical** | Medium (depends on the document flow)        | (a) If the internal flow USDT via ADMIN → conversion via a licensed exchange → bank → a deposit to the TOV as a "founder's loan" — arrange a **real loan agreement** with a repayment schedule, not fake; (b) **do not use a "founder's loan"** to hide the real revenue of the TOV; (c) a human compliance review               |
| 3   | **Exceeding the TOV single-tax group 3 limit** (₴10 091 049/year) at scale → automatic loss of single-tax-payer status + penalties                                                                                              | High         | High (at our target scales)                  | (a) Do NOT use a TOV on single-tax group 3 for the planned scale; (b) choose a TOV general / Diia City from the very start; (c) if we start on single-tax group 3 for a test — a plan to transition upon reaching 80% of the limit                                                                                               |
| 4   | **AML/Financial Monitoring block** on USDT→UAH conversion of large amounts via an exchange, if there is no consistent document flow (a contractual network)                                                                     | High         | Medium                                       | (a) A contractual network BEFORE the first crypto conversion: a client↔TOV contract, a TOV↔partner-FOP contract, a TOV↔gig-specialist contract; (b) use licensed UA exchanges (Whitebit, Kuna) — they are SPFM; (c) keeping an internal AML-policy document                                                                      |
| 5   | **Non-compliance with Diia City requirements** (min. 9 specialists, €1200/month each) → loss of residency, transfer to the general 18%                                                                                          | High         | Medium                                       | (a) Calculate the payroll budget BEFORE entering the regime — make sure we can stably keep ≥9 specialists × €1200; (b) a startup-resident option (more relaxed thresholds) for the first year; (c) monthly monitoring of compliance metrics                                                                                      |
| 6   | **Cash transaction structuring** (artificial splitting into sub-limit payments of ₴10k/day between the TOV and the client) → structuring of operations → Art. 212 of the Criminal Code of Ukraine                               | High         | Medium                                       | (a) Exclude the cash channel from the product roadmap altogether; (b) if a cash payment is received from an individual client within ₴50k/day — full RRO+cash receipt order documentation + monitoring of patterns                                                                                                               |
| 7   | **A crypto receipt in TOV bookkeeping** without a legal basis as of 2026-05-31 → the risk of a DPS inspection / adjustment of the financial result                                                                              | High         | Medium                                       | (a) Do NOT arrange USDT receipts directly as "the TOV's income" while 2074-IX is not introduced; (b) use a proxy flow via the bank after conversion; (c) a quarterly review by the Legal agent + a practicing lawyer on the status of 10225-d                                                                                    |
| 8   | **Double taxation of a non-resident partner** when paying dividends (15% PIT UA + tax in residence)                                                                                                                             | Medium       | High                                         | (a) Check the existence of a double-taxation treaty with the partner's country of residence (for most EU/US — there is one); (b) if present — apply a reduced rate (usually 5-10%); (c) a tax-authority certification for the partner                                                                                            |
| 9   | **An invalid invoice (missing mandatory details of Art. 9 No. 996-XIV)** → a non-resident client's bank refuses to credit the payment + the risk of the DPS recognizing the income as "untimely"                                | Medium       | Low-Medium                                   | (a) Invoice templates with all details + an accountant's review; (b) for non-residents — a bilingual format (UA/EN) + IBAN/SWIFT; (c) a monthly audit of the invoice format in the CRM accounting module                                                                                                                         |
| 10  | **Loss of exit-capital-tax-payer status (Diia City)** with non-qualifying expenditures (payments to non-resident individuals without a CCT, acquisition of assets in the presence of related parties)                           | Medium       | Medium                                       | (a) Educate the accountant on the exit-capital-tax rules; (b) review each significant payment > ₴100k for compliance with the exit-capital-tax criteria; (c) Diia City compliance consulting                                                                                                                                     |
| 11  | **GDPR/UA personal-data risks** when storing users' wallet addresses in the CRM (Q3 of the previous consultation)                                                                                                               | Medium       | Medium                                       | (a) Encryption-at-rest for wallet fields; (b) an audit log on wallet changes; (c) a consent flow at the onboarding spec; (d) a DPA for all processors (S3, email service)                                                                                                                                                        |
| 12  | **Regulatory flux of 10225-d before Q3 2026** — the possibility of a change in the VA taxation regime for a TOV → the structure may need re-architecture                                                                        | Medium       | High                                         | A quarterly legal review + flexibility in the CRM architecture (the crypto channel as a feature flag, not hard-coded)                                                                                                                                                                                                            |

### Recommendation (best for business, in priority order)

#### 0. MANDATORY BEFORE ANY DECISION — human verification

This strategic consultation must be verified with **three** practicing lawyers BEFORE implementation:

1. **A tax consultant with a Diia City specialization** — verify the Q1 modeled cost per the TOV Diia City structure for our specific profile (30-50 specialists, $50-90M/year), check for the dividend policy, the exit-capital-tax vs 18% choice. Budget: ~₴30-50k initial consultation + ₴10-15k/quarter review.

2. **A criminal defense lawyer / compliance lawyer** — verify the expanded Q3 analysis (the issuer = the TOV always rule), in detail on the user's specific cash/crypto idea. Budget: ~₴20-40k initial.

3. **A practicing corporate lawyer for registering the TOV + entering Diia City + the contractual network** — preparing the Statute, contracts with the team (labor + gig + FOP subcontracting), a Services Agreement template with a multi-payment clause (Q2.4). Budget: ~₴50-100k complex.

**In total: ~₴100-200k initial compliance setup** — fits within the budget of ₴200k voiced by the User.

#### 1. Register a TOV → a Diia City startup resident → a full resident

**Step-by-step roadmap:**

1. **Week 1-4: Registration of the TOV.**
   - Founders: ADMIN + partner (I recommend a share of 50/50 or 70/30 according to the real distribution agreement)
   - Statutory capital: the minimum ₴1 (under the new LimitedLiability rules) or symbolic — I recommend ₴10 000-50 000 for credibility
   - Business-activity codes: 62.01 "computer programming" as the main one + 62.02, 62.09, 63.11 — additional
   - The general taxation system at the start (NOT single-tax group 3) — this is a prerequisite for Diia City
   - Opening bank accounts UAH + USD + EUR (multi-currency)
   - **Budget: ₴5-15k (notary + state registration + bank)**

2. **Week 5-12: Entry into Diia City as a startup resident.**
   - Filing the application via [city.diia.gov.ua](https://city.diia.gov.ua/) (WebSearch collection date: 2026-05-31)
   - Startup resident: relaxed thresholds — one can start with fewer than 9 specialists
   - Choosing the exit-capital tax (9%) as the preferred regime
   - **Budget: ₴3-5k (administrative fees + consultation)**

3. **Week 13-26: Onboard the team onto gig contracts.**
   - Compile a gig-contract template with integration into the CRM (role = SENIOR/JUNIOR/HR/ACCOUNTANT, rate = €1200-5000+/month depending on the profile, reporting period = quarterly)
   - Transfer the current SENIORs (FOP group 3) to a gig contract: they keep their FOP for some parallel activities, but the main income is via the gig
   - Onboard JUNIORs: a new contracting flow, no need for a FOP
   - HR/ACCOUNTANT — gig or employee (an employment contract) depending on the daily workload
   - **Budget: ₴30-50k (legal review + template + re-arrangement)**

4. **Week 13+: Transition to a full Diia City resident** upon reaching 9 specialists × €1200/month.

#### 2. Multi-channel revenue architecture: **BANK-ONLY** with future crypto

**For 2026-2027:**

- **The bank channel (UAH + USD + EUR)** — the primary and only production channel.
  - Invoices with all details per Q2.1
  - A Services Agreement with a multi-payment clause (per Q2.4) — a **reserved slot for crypto** (a text placeholder, not active)
  - The TOV's currency account — for FX receipts from non-residents
  - The export of services 0% VAT per Art. 195.1.1 of the Tax Code of Ukraine — a clean position

- **The cash channel — EXPLICITLY EXCLUDED from the architecture.**
  - In the CRM **do not implement** the UI/backend for the TOV's cash flow
  - In the Services Agreement: an explicit ban on cash (`Article X.2. Cash settlements are not accepted under this Agreement`)
  - Training the sales/onboarding team: refusal + a redirect to the bank

- **The crypto channel — `feature_flag: false` until Q3 2026.**
  - The smart contract and the CRM integration with PHASE 8 continue in development (testnet)
  - **Production deployment** — only after 2074-IX takes effect + a practicing lawyer's verification of the structure
  - In the Services Agreement: a reserved slot with the condition "upon mutual written agreement and applicable Ukrainian law"

#### 3. The contractual network — prepare it BEFORE the first invoice

Templates in the repo (under version + a sign-off by a practicing lawyer):

1. **A Master Services Agreement (with the client)** — bilingual UA/EN, a multi-payment clause, IP rights, an NDA, governing law (Ukraine), dispute resolution (LCIA arbitration or a UA commercial court).
2. **An Order Form / Statement of Work** — a per-project addendum to the MSA with a specific scope, period, rate, deliverables.
3. **An invoice template** — bilingual, with all mandatory details (Q2.1).
4. **A gig-contract template** — for the team, with role-based variations (SENIOR/JUNIOR/HR/ACCOUNTANT).
5. **A services agreement TOV ↔ partner-FOP** (if the partner stays a FOP consultant) — a separate consulting relationship.
6. **A TOV founding agreement** — distribution 50/50 (or as agreed) between ADMIN and the partner.
7. **An NDA template** — for clients, gig specialists, partners.
8. **A Privacy Policy + Terms of Service for the CRM platform** — GDPR-compliant, UA Law 2297-VI compliant.

#### 4. Compliance & monitoring infrastructure

- **Bookkeeping:** outsource it to a practicing accounting firm with Diia City experience (budget: ₴5-15k/month). DIY is not recommended — the exit-capital tax has nuances that even experienced accountants easily get wrong.
- **An AML policy document** — an internal procedure: KYC of clients before signing the MSA, OFAC screening at startup (free tools exist + paid services), monitoring of transactions > ₴400k (the deepened-check threshold of Financial Monitoring).
- **A quarterly legal review** — a Mode D consultation by the Legal agent + a practicing lawyer once/quarter on the status of 10225-d, changes in the DPS practice, new Diia City clarifications.

#### 5. CRM-specific changes (for integration with the real business structure)

**The current CRM architecture** has several mismatches with the recommended structure:

1. **The `users.role` enum** — add `GIG_SPECIALIST` as a combined role (not there yet — everything is under ADMIN/SENIOR/JUNIOR/HR/ACCOUNTANT). A gig contract is a separate legal status, but for CRM functionality it can be mapped to an existing role + add an `employmentType` field (FOP / GIG_CONTRACT / EMPLOYMENT).
2. **The `projects` + `transactions` model** — add a `companyEntityId` that references the legal entity (now hardcoded as "CheekyCheeseIT"). On the horizon several entities may appear (for example, an EU branch).
3. **The `invoices` model** — extend the `paymentMethod` enum: `BANK_UAH | BANK_USD | BANK_EUR | CRYPTO_USDT_ERC20` (without `CASH`). We want to hardwire the cash ban at the schema level.
4. **The `payouts` model** — add `payoutType: SALARY | GIG_REMUNERATION | DIVIDEND | CONTRACT_PAYMENT` for proper tax category classification.
5. **The `auditLog`** — mandatory for wallet/bank/role changes. PII handling per Law 2297-VI.

These changes — separate technical tasks for PM → Coder after locking in the legal structure.

#### 6. Quarterly cadence for 12 months

| Period            | Action                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| Q1 2026 (current) | Tax consultant + corporate lawyer engagement, TOV registration, Diia City startup resident                           |
| Q2 2026           | Onboard the team onto gig contracts, the first client MSAs, the first bank invoices                                  |
| Q3 2026           | Status check of 2074-IX (introduced?), Diia City full resident upon threshold reach, the first quarterly review      |
| Q4 2026           | Expansion of the team to ~30 contributors, formalization of the AML policy, an OFAC screening procedure              |
| Q1 2027           | A first-year review, optimization of the structure, readiness for PHASE 8 crypto activation if 2074-IX is introduced |

### Sources

**Primary regulatory acts (UA):**

- [Law of Ukraine "On Stimulating the Development of the Digital Economy in Ukraine" No. 1667-IX dated 15.07.2021](https://zakon.rada.gov.ua/laws/show/1667-20) — the Diia City regime.
- [The Tax Code of Ukraine, Article 134 (the object of taxation with profit tax)](https://zakon.rada.gov.ua/laws/show/2755-17#n3299) — the 18% base rate of a TOV on the general system.
- [The Tax Code of Ukraine, Article 137 (the procedure for calculating profit tax)](https://zakon.rada.gov.ua/laws/show/2755-17#n3373).
- [The Tax Code of Ukraine, Article 141.91 (special conditions of the exit-capital tax for Diia City)](https://zakon.rada.gov.ua/laws/show/2755-17) — 9% exit-capital tax.
- [The Tax Code of Ukraine, Article 291.4 (limits of the simplified system)](https://zakon.rada.gov.ua/laws/show/2755-17#n4877) — ₴10 091 049 for 2026 for group 3.
- [The Tax Code of Ukraine, Article 195.1.1 (export of services 0% VAT)](https://zakon.rada.gov.ua/laws/show/2755-17).
- [The Tax Code of Ukraine, Article 201 (the tax invoice)](https://zakon.rada.gov.ua/laws/show/2755-17#n5283) — mandatory details, ERPN registration.
- [The Criminal Code of Ukraine, Article 212 (tax evasion)](https://zakon.rada.gov.ua/laws/show/2341-14#n1395) — the liability thresholds 2026.
- [The Criminal Code of Ukraine, Article 209 (legalization of proceeds)](https://zakon.rada.gov.ua/laws/show/2341-14#n1377).
- [The Criminal Code of Ukraine, Article 27 (complicity in a criminal offense)](https://zakon.rada.gov.ua/laws/show/2341-14).
- [Law of Ukraine "On Accounting and Financial Reporting in Ukraine" No. 996-XIV, Article 9](https://zakon.rada.gov.ua/laws/show/996-14) — the mandatory details of a primary document.
- [Law of Ukraine "On the Use of Payment Transaction Recorders..." No. 265/95-VR](https://zakon.rada.gov.ua/laws/show/265/95-вр) — RRO/PRRO.
- [Law of Ukraine "On Currency and Currency Operations" No. 2473-VIII](https://zakon.rada.gov.ua/laws/show/2473-19) — currency control.
- [Law of Ukraine "On the Protection of Personal Data" No. 2297-VI](https://zakon.rada.gov.ua/laws/show/2297-17) — the UA analog of GDPR.
- [NBU Resolution No. 148 dated 29.12.2017 "On approval of the Regulation on conducting cash operations"](https://zakon.rada.gov.ua/laws/show/v0148500-17) — cash settlement limits.
- [NBU Resolution No. 5 dated 02.01.2019 "On carrying out operations with currency valuables"](https://bank.gov.ua/admin_uploads/law/02012019_5.pdf) — the ban on cash FX settlements with non-residents.
- [Cabinet of Ministers Resolution No. 1186 dated 15.09.2017 "On approval of the procedure for registering foreign economic contracts"](https://zakon.rada.gov.ua/laws/show/1186-2017-%D0%BF) — an invoice as the equivalent of a foreign economic contract.

**WebSearch results (all — collection date: 2026-05-31):**

- WebSearch: [BIP — The single tax in 2026: rules for FOPs and TOVs](https://bip.net.ua/articles/yedinij-podatok-dlya-fop-i-tov/) — single-tax limits, rates.
- WebSearch: [BIP — A TOV on the single tax: types of reporting, limits](https://bip.net.ua/articles/ooo-na-en/).
- WebSearch: [BIP — Diia City in 2026: conditions, requirements, advantages](https://bip.net.ua/articles/diya-siti-umovi-vimogi-perevagi-j-nedoliki/) — the gig contract, 5%+5%+22% USC.
- WebSearch: [BuhPlatforma — Profit tax on general grounds](https://buhplatforma.com.ua/article/7206-platnik-podatku-na-pributok-na-zagalnih-pdstavah) — Article 134 of the Tax Code of Ukraine.
- WebSearch: [Factor — Article 134 of the Tax Code of Ukraine, the object of taxation](https://i.factor.ua/ukr/law-24/section-517/article-39003/).
- WebSearch: [DTKT — Posluhy.dt — Profit tax rates](https://services.dtkt.ua/catalogues/tax_rates/67-stavki-podatku-na-pributok).
- WebSearch: [Yankiv — Cash settlement limits 2026](https://yankiv.com/limity-na-rozrahunky-gotivkoyu/) — ₴10k / ₴50k.
- WebSearch: [NBU — Reducing the maximum amount of cash settlements](https://bank.gov.ua/en/news/all/znijennya-granichnoyi-sumi-rozrahunkiv-gotivkoyu-za-uchastyu-fizichnih-osib-do-50-tis-grn-spriyatime-podalshomu-rozvitku-bezgotivkovih-rozrahunkiv--).
- WebSearch: [Yankiv — RRO and PRRO in 2026: who is obliged](https://yankiv.com/rro-prro-2026-komu-oboviazkovo/).
- WebSearch: [SystemGroup — Penalties 2025-2026 for the absence of a cash register](https://systemgroup.com.ua/uk/o-kompanii/article/shtrafy-2025-2026-za-vidsutnist-kasovogo-aparatu-rro-chy-prro).
- WebSearch: [Kodeksy — Art. 9 of the Law on Accounting](https://kodeksy.com.ua/pro_buhgalters_kij_oblik_ta_finansovu_zvitnist/statja-9.htm).
- WebSearch: [Mogol Alfa — All about an invoice: a sample](https://www.mogol-alfa.com.ua/ua/buhgalterski-novini/invojs-zrazok/) — the invoice format UA.
- WebSearch: [DPS Odesa — On the application of invoices-facturas (invoices)](https://od.tax.gov.ua/media-ark/news-ark/669798.html) — an invoice to a non-resident as a foreign economic contract.
- WebSearch: [iBuhgalter — Article 201 of the Tax Code of Ukraine, the tax invoice](https://ibuhgalter.net/tax-codex/203).
- WebSearch: [BuhPlatforma — Registration of tax invoices 2026](https://buhplatforma.com.ua/article/7217-restratsya-podatkovih-nakladnih).
- WebSearch: [KPMG — Diia City and deferred taxes](https://kpmg.com/ua/uk/blogs/home/posts/2024/03/diya-siti-ta-vidstrocheni-podatky.html) — the exit-capital tax deep dive.
- WebSearch: [Factor — Dividend payment in Diia City: how the exit-capital tax works](https://i.factor.ua/ukr/journals/nibu/2026/march/issue-18/article-136492.html).
- WebSearch: [Flex Partners — The exit-capital tax for Diia City residents](https://partnersflex.com/blog/pnvk-dlya-rezydentiv-diya-siti/).
- WebSearch: [DTKT — Can an individual single-tax payer of group III conclude a gig contract](https://news.dtkt.ua/simple/individual-single-tax/88330-ci-moze-fizosoba-jedinnik-iii-grupi-uklasti-gig-kontrakt-na-vikonannia-robit-z-rezidentom-diia-siti) — combining a FOP + a gig contract.
- WebSearch: [SmartSolutions — Tax evasion 2026: liability thresholds](https://smartsolutions.ua/porohy-prytiahnennia-do-kryminalnoi-vidpovidalnosti-za-ukhylennia-vid-splaty-podatkiv/) — Art. 212 of the Criminal Code of Ukraine thresholds.
- WebSearch: [Protocol — Article 212 of the Criminal Code of Ukraine, evasion](https://protocol.ua/ua/kriminalniy_kodeks_ukraini_stattya_212/).
- WebSearch: [Export.gov.ua — Currency control in the performance of foreign economic contracts](https://export.gov.ua/138-valiutnii_kontrol_pri_vikonanni_zovnishnoekonomichnikh_dogovoriv).
- WebSearch: [Sense Bank — Currency contracts and import operations during martial law](https://help-biz.sensebank.com.ua/hc/uk/articles/6441120324498) — the ban on cash with a non-resident.
- WebSearch: [Medoc — The cash receipt order](https://medoc.ua/blog/pributkovij-kasovij-order-shho-slid-znati-) — form KO-1.
- WebSearch: [DTKT — How a founder should deposit funds in cash](https://consulting.dtkt.ua/ru/state/cash-handling/10516) — a deposit to the TOV.
- WebSearch: [Diia.City official portal](https://city.diia.gov.ua/) — registration as a resident.
- WebSearch: [DKU — Diia City 2026 advantages and rules](https://dku.in.ua/DiiaCity).

**Internal knowledge base:**

- `docs/legal/cross-cutting/escalation-zones.md` — §1 (criminal liability Art. 212), §4 (>100k UAH), §5 (Sanctions) — apply.
- `docs/legal/cross-cutting/citation-rules.md` — the citation format is followed.
- `docs/legal/ua-fop/`, `docs/legal/crypto-usdt/` — **empty** (Phase 0).
- [`docs/specs/legal-consultations/2026-05-31-usdt-payouts-phase8.md`](./2026-05-31-usdt-payouts-phase8.md) — the crypto/USDT base analysis (Q2.2 of this consultation references it).
- `CLAUDE.md` (root) — the sections "Business logic", "PHASE 5/8", "Financial flow".

### Disclaimer

**Confidence: MED (overall).** This answer is a preliminary AI check, NOT binding legal advice.

**MANDATORY human verification BEFORE any implementation action:**

1. **A practicing tax consultant (Diia City specialization)** — to verify the Q1 recommendations (TOV + Diia City + the exit-capital tax for our specific scale + revenue mix). Check that Diia City is optimal vs a TOV general for our profile's distribution/reinvest.
2. **A practicing corporate lawyer** — to prepare the TOV Statute, the contractual network (MSA, gig contract, FOP subcontracting), the Privacy Policy, the platform ToS.
3. **A practicing criminal defense / compliance lawyer** — **mandatory** for the discussion of Q3 (the issuer ≠ the TOV assumption). If there is any idea to implement Scenario A — this REQUIRES a criminal lawyer BEFORE action.

**This answer does NOT cover (hard escalation per [`docs/legal/cross-cutting/escalation-zones.md`](../../legal/cross-cutting/escalation-zones.md)):**

- **§ 1 — Criminal-law risks of Art. 212 of the Criminal Code of Ukraine.** Q3 shows the red line, but the specific criminal defense / structuring procedure is for a criminal-law lawyer. AI refuses further consultation if the user is preparing to implement a multi-issuer structure.
- **§ 1 — Criminal risks of Art. 209 of the Criminal Code of Ukraine (legalization).** If there is any flow of cash/crypto→the TOV's bank — an AML/compliance lawyer review of the documentation is mandatory.
- **§ 4 — Specific tax amounts > ₴100k.** The exact calculations of the effective burden (5% PIT + 5% military levy + 22% USC + exit-capital tax 9%) for our specific revenue mix — for a tax consultant. AI gave a framework, not precise numbers.
- **§ 5 — Sanctions/OFAC** for non-resident clients — for a specialized compliance consultant.

**Use this answer as:** a decision framework + a scope map for negotiations with practicing lawyers. **Do NOT use it as:** a basis for action without human review. Especially do NOT implement Q3 Scenario A (issuer ≠ the TOV for cash/crypto) without a criminal defense lawyer's verification — this is a **red line** which AI Legal explicitly marks as criminal exposure.

**Additionally for PM/User:** this consultation has a direct strategic impact on:

- CRM architecture (recommendation #5 — schema changes for `companyEntityId`, `paymentMethod` without cash, the `employmentType` enum) — potentially a new Phase in the roadmap
- The PHASE 8 timeline — Recommendation #2 (`feature_flag: false`) is a **soft block** on implementation until the activation of 2074-IX
- Business operations — recommendation #1 (TOV + Diia City) is a **year of setup work** with legal budgeting ₴100-200k

PM must record lessons in `docs/agents/memory/legal/lessons.md`:

- `2026-05-31 [P0] [tov-multi-channel] #tax #criminal-risk A multi-issuer structure for cash/crypto ≠ the TOV — direct Art. 212 of the Criminal Code of Ukraine exposure. Always single-issuer (the TOV) regardless of the payment channel.`
- `2026-05-31 [P0] [tov-multi-channel] #tax #diya-city Diia City exit-capital tax 9% — a game-changer for IT scale-ups in UA: 0% tax while reinvesting + 5% PIT for the gig team. Vs a TOV general 18% — Diia City wins at any rational distribute/reinvest mix.`
- `2026-05-31 [P1] [tov-multi-channel] #cash Cash for an IT-outsource TOV is practically impossible legally: a limit of ₴10k/day B2B, ₴50k/day for an individual, plus the ban on FX cash with a non-resident. Architecturally exclude.`
