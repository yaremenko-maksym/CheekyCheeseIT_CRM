# Legal Consultation: USDT Payouts (PHASE 8) — UA Legal + AML + Tax Risks

## Mode: strategic

## Date: 2026-05-31

## Requested by: User direct → PM

## Context

CRM Cheeky Cheese IT — an outsource/outstaffing company (Ukraine). Teams: ADMIN, SENIOR, JUNIOR, HR, ACCOUNTANT. SENIORs work for international clients (US/EU), JUNIORs participate in the seniors' projects.

### Current structure (PHASE 5, implemented)

1. The client pays the SENIOR directly (USD/USDT/EUR to their requisites)
2. The SENIOR enters the transaction in the CRM (date, amount, currency, project, attached receipt)
3. The ACCOUNTANT validates the transaction
4. After validation — the "Pay for services" button is unlocked for the SENIOR
5. The SENIOR keeps 26% for themselves, the remaining **74%** is paid to the smart contract (phase 8)

### PHASE 8 — the planned crypto structure

- **Smart contract:** `PaymentSplitter` on Ethereum mainnet
- **Deployment:** Hardhat, the contract is deployed once (or per-project)
- **Currency:** USDT ERC-20
- **Distribution** (automatically at the moment of receipt):
  1. To the JUNIOR — a fixed amount (from `project_finance_settings.juniorSalary`), first
  2. The remainder 50/50:
     - ADMIN wallet (company)
     - Partner wallet (co-founder)
- **Addresses:** configured at project deployment (`adminWallet`, `partnerWallet`, `juniorWallet`)
- **Frontend:** ethers.js v6, signing via MetaMask/WalletConnect

### User profile

- Each user in the CRM stores their USDT wallet in the profile (field `walletAddress` or a new multi-method structure: USDT ERC-20 + Bank UAH FOP + preferredMethod)
- Wallets can be changed (with confirmation)
- JUNIOR and SENIOR wallets are used by the smart contract

### Employment structure (current)

- SENIOR and JUNIOR work as FOP group 3 (5% single tax)
- ADMIN — founder of a TOV (LLC) + FOP
- Partner — a separate figure (probably also a FOP)
- HR / ACCOUNTANT — hypothesis: FOP or TOV workers (we do not know exactly)

## Question

**Main:** What legal risks (UA legislation + AML/KYC + crypto regulation + taxation) does this payout scheme carry? What is the best structure for compliance + minimizing tax risks?

**Sub-questions:**

1. **UA crypto law.** The Law of Ukraine "On Virtual Assets" (2022) — what requirements apply to us as (a) a provider of services for VA operations, (b) a VA user? Do we need registration / a license from the NSSMC? If so — what volume of operations triggers obligations?

2. **Taxation of USDT income in UA.**
   - A client sending USDT → a SENIOR on FOP group 3 — is this counted as FOP income? The USDT/USD/UAH rate — how to fix the date/rate?
   - Distribution via smart contract is automatic — the moment a tax liability arises for JUNIOR / ADMIN / partner?
   - Double taxation: 5% single tax + military levy (1.5% since 2024)?

3. **AML/KYC.** Financial Monitoring — which transactions trigger a screening obligation? USDT > X per day to one recipient? Do we, as operators of the smart contract, need to run KYC on the recipients (JUNIOR / partner)? What are the risks of payouts to blacklisted addresses (UA / OFAC)?

4. **Smart contract as a "VA operations operator".** Deploying a PaymentSplitter with the ability to receive and distribute USDT — does this make us an operator / provider? Or is it just a self-custody pass-through (does not trigger regulation)?

5. **Contractual basis.** Should there be separate agreements between:
   - SENIOR ↔ ADMIN (for "payment for services" 74%)
   - ADMIN ↔ JUNIOR (salary via distribution)
   - ADMIN ↔ partner (50/50 split)?
     What is the legal nature of these payments (gift / services / dividend)?

6. **Risk mitigation proposals.** What can we do BEFORE launching PHASE 8 to minimize legal exposure?

## Relevant links

- CLAUDE.md → section "PHASE 8 — Smart contracts (USDT ERC-20)" — the current plan
- CLAUDE.md → section "Financial flow" — the distribution structure 26%/74%, 50/50
- (Possibly) `docs/business/modules/finance.md` if it exists

## What we do NOT want to hear

- General crypto / blockchain theory — we understand the technology
- General compliance theory without UA specifics (we are in UA, not EU/US)
- Recommendations requiring multimillion legal budgets (we are a small business)

## What matters for the decision

- The decision must be actionable — concrete steps, not "consult an expert"
- Ready to spend reasonably (tens of thousands of UAH, not hundreds) on a compliance setup
- The PHASE 8 deploy — in the next 3-6 months, we need to understand what to prepare in advance
- The main priority — **minimizing tax risks** (FOP limits, double taxation, audit risk)
- The second priority — **AML compliance** to avoid falling under sanctions / Financial Monitoring

---

<!-- The Legal agent will add the `## Lawyer answer` section below -->

## Lawyer answer

**Confidence:** LOW (overall) — with a breakdown by sub-questions:

- Q1 (crypto-law / VASP) — **LOW** (Law 2074-IX not in force, awaiting changes to the Tax Code; the status of 10225-d is fluid)
- Q2 (taxation) — **LOW→MED** (the current DPS position is known, but changes are coming on 01.01.2026)
- Q3 (AML / Fin Mon) — **LOW** (the 30k UAH threshold is known, but the specifics of VASP obligations are future)
- Q4 (smart contract / VASP status) — **LOW** (no enforcement practice, pure hypothetical analysis)
- Q5 (contract structure) — **MED** (general law of obligations applies, the Civil Code of Ukraine)
- Q6 (risk mitigation) — **MED** (actionable recommendations of a general nature)

**Mode:** strategic
**Date:** 2026-05-31

**Important before reading:** This is the first consultation of the Legal agent (the knowledge base in Phase 0 is empty by topic folders). Primary source = WebSearch + general principles. The regulatory landscape of cryptocurrencies in Ukraine in 2025–2026 is in a **transitional state** — Law 2074-IX is adopted but not in force; draft law 10225-d passed the first reading on 03.09.2025 and should take effect on 01.01.2026 (but this is a planned date, not a guarantee). Any HIGH-confidence recommendation in such an environment = overconfident. For at least 5 of the 6 sub-questions, verification with a practicing UA tax/crypto lawyer is needed **before launching PHASE 8**.

### TL;DR

**The current scheme (74% SENIOR → smart contract → JUNIOR + ADMIN + partner) carries three fundamental legal risks under the current wording of the law:** (1) FOP group 3 effectively **does not have the right** to settle in cryptocurrency until the tax changes take effect (risk of forced transfer to the general system + a 15% penalty), (2) the `PaymentSplitter` smart contract with automatic distribution of funds among several recipients **will very likely** be qualified as a VASP operation "transfer of VA on behalf of a client" (requires registration/a license after the law takes effect), (3) the Financial Monitoring thresholds (30k UAH / ~720 USD) are triggered on practically every typical transaction — without KYC procedures there is an AML risk. **It is recommended to postpone the PHASE 8 launch until Q3 2026** (after the real activation of 10225-d) or **restructure via a TOV (LLC) + a contractual network** with direct bank / USDT transfers without an on-chain auto-split.

### Analysis

#### Q1 — UA crypto law (Law 2074-IX, draft law 10225-d)

**Current status of the law:**

[The Law of Ukraine "On Virtual Assets" No. 2074-IX dated 17.02.2022](https://zakon.rada.gov.ua/laws/show/2074-20) is formally adopted, but **not in force**. Per paragraph 4 of the Final and Transitional Provisions — the law takes effect from the day the changes to the Tax Code of Ukraine regarding the specifics of taxation of VA operations take effect. These changes are now being formalized in [draft law 10225-d](https://itd.rada.gov.ua/billinfo/Bills/Card/56271), which **passed only the first reading on 03.09.2025** (WebSearch: https://itd.rada.gov.ua/billinfo/Bills/Card/56271, collection date: 2026-05-31). The planned effective date is 01.01.2026, but this is a target, not a given.

**Regulator:** [NSSMC (the National Securities and Stock Market Commission)](https://www.nssmc.gov.ua/en/u-nktspfr-rozpovily-iak-rehuliuvatymut-rynok-virtualnykh-aktyviv-v-ukraini/) is designated as the main regulator of the VA market (WebSearch: https://www.nssmc.gov.ua/en/u-nktspfr-rozpovily-iak-rehuliuvatymut-rynok-virtualnykh-aktyviv-v-ukraini/, collection date: 2026-05-31).

**The volume of operations that triggers licensing:** At the moment (before the law takes effect), **VASP licensing in Ukraine itself does not work** — the regime is in a legal vacuum. After it takes effect, conceptually a VASP is a legal entity that professionally provides VA circulation services to clients, including "custody and administration of VA on behalf of clients" and "transfer of VA on behalf of clients" (WebSearch: https://golaw.ua/insights/publication/novij-etap-regulyuvannya-virtualnih-aktiviv-v-ukrayini-shho-zminyuyetsya-dlya-biznesu-ta-investoriv/, collection date: 2026-05-31).

**Applicability to our case (Confidence: LOW):**

- If SENIORs pay their own USDT through their own wallet into the PaymentSplitter — this is arguably self-custody, not a VASP service for third parties.
- BUT: if the ADMIN (company) **deploys and owns** the PaymentSplitter contract, which automatically redirects funds to JUNIORs and the partner — this, IMHO, looks like "transfer of VA on behalf of a client" (client = SENIOR; recipients = JUNIOR / partner). This is a gray area requiring authoritative verification.
- Existing practice in the EU under MiCA: non-custodial infrastructure (the platform never controls users' funds) usually avoids a VASP/CASP license (WebSearch: https://www.crossmint.com/learn/eoas-vs-smart-wallets, collection date: 2026-05-31), but this is **not UA law**, but an EU analogy.

#### Q2 — Taxation of USDT income in UA

**DPS position on FOP and crypto (current, pre-reform):**

> FOPs — single-tax payers of **groups two and three**, except e-residents, **may not sell or realize cryptocurrency**. The DPS explains this by the fact that cryptocurrency has no defined legal status.

(WebSearch: https://taxer.ua/uk/kb/kryptovalyuta-u-fop-na-ep, collection date: 2026-05-31; and news.dtkt.ua/simple/individual-single-tax/85485)

> FOPs on the single tax, groups I-III, cannot use cryptocurrencies in settlements, which may lead to a **forced transfer to the general system** of taxation and payment of the single tax at a penalty rate — **15%**.

(WebSearch: https://taxer.ua/uk/kb/kryptovalyuta-u-fop-na-ep, collection date: 2026-05-31)

**This is a critical risk for the entire current scheme PHASE 5 + PHASE 8.** Right now SENIORs receive USDT and enter it as FOP income — formally this **may already** be contested by the DPS as "settlements in cryptocurrency".

**Upcoming changes (10225-d, after it takes effect):**

> For virtual assets acquired before the law takes effect, in case of sale during 2026 — a preferential rate of **5% PIT** (plus 5% military levy). From 2026 and onward — the standard rate of **18% PIT + 5% military levy**.

(WebSearch: https://www.ey.com/uk_ua/it-tax-law-digest/the-draft-law-on-the-taxation-of-income-from-virtual-assets-approved-by-the-parliamentary-committee, collection date: 2026-05-31)

**Important:** These rates concern **individuals**, not FOPs. Whether FOP regimes will be integrated with VA operations is at the moment an **open question** (commentary indicates that a separate regime for FOPs with crypto is not yet envisaged in 10225-d).

**Rate / moment income arises (general logic for FOP foreign-currency income):**

> The income of a FOP on the single tax received in foreign currency is determined at the **NBU rate on the date funds arrive** in the FOP's account.

(WebSearch: https://i.factor.ua/ukr/journals/nibu/2026/january/issue-9/article-135899.html, collection date: 2026-05-31)

**Applicability to USDT:** the problem is that USDT does not "arrive in an account" — it comes to a blockchain wallet. The DPS has no clear position on the moment of the tax event for crypto in self-custody (as of 2026-05-31). Most likely — the moment of conversion of USDT into fiat through a licensed exchange/exchanger + a bank transfer to the FOP's account.

**Military levy:**

> For FOPs of **group 3** the military levy in 2026 is paid at a rate of **1% of all income received for the reporting period**.

(WebSearch: https://bip.net.ua/articles/vijskovij-zbir/, collection date: 2026-05-31)

This is in addition to the 5% single tax. In total for a FOP of group 3: **5% single tax + 1% military levy = 6%** of gross income (for the 2025-2026 period of martial law).

**Double taxation via smart contract auto-split (Confidence: LOW, hypothesis):**

- Moment 1: the SENIOR receives USDT → a tax event for the SENIOR (at least under the future law).
- Moment 2: the PaymentSplitter redirects a fixed amount to the JUNIOR → formally this is a **second** tax event for the JUNIOR (income of an individual or FOP).
- Moment 3: ADMIN/partner receive their 50/50 → a third event.

If the SENIOR has already declared 100% of the income (because they received it to their own address), and then 74% "went" into the smart contract — formally the SENIOR **has already paid tax on those 74%**, and then JUNIOR/ADMIN/partner pay tax again. This is **triple taxation** of the same money flow, unless the contractual nature is formalized (see Q5).

#### Q3 — AML / Financial Monitoring

**Law 361-IX and thresholds:**

> The threshold for carrying out due diligence measures in the case of **transfers** is **30 thousand UAH**.

(WebSearch: https://buhplatforma.com.ua/article/7558-fnansoviy-montoring, collection date: 2026-05-31)

> Operations with virtual assets fall under financial monitoring; if exchanges, exchangers, banks or other companies make payments in cryptocurrencies in an amount **greater than 30 thousand UAH**, they are subject to monitoring.

(WebSearch: https://buhplatforma.com.ua/article/7558-fnansoviy-montoring, collection date: 2026-05-31; and [Law No. 361-IX](https://zakon.rada.gov.ua/go/361-20))

**Applicability:**

- 30k UAH ≈ 720 USD at a rate of ~41.5. A typical SENIOR rate in IT outsource = $3000-8000/month → each payout to a SENIOR is **dozens of times** over the threshold.
- Financial Monitoring covers **primary financial monitoring entities** (SPFM): banks, exchanges, exchangers, VASPs (after the introduction of 2074-IX).
- **The SENIORs themselves, as individuals or FOPs, are not SPFM.** But the bank / exchange through which the USDT/UAH conversion passes — yes, and they will notify Financial Monitoring.
- **PaymentSplitter** at the ADMIN's self-custody address: formally, if the ADMIN is not a VASP, they are not an SPFM → no obligation to do KYC. BUT (see Q4) — the ADMIN's status as an "operator" in an auto-split is disputable.

**Blacklisted addresses (UA / OFAC):**

- UA sanctions lists: [Presidential decrees 2014-2024 + NSDC decisions](https://zakon.rada.gov.ua/laws/main/index/all/sanctions). A USDT transfer to a sanctioned address = administrative + potentially criminal (Art. 209 of the Criminal Code of Ukraine — legalization).
- OFAC SDN list: for a cross-border transfer involving US residents/USD denomination — risk-bearing. The USDT issuer (Tether), upon request, **may freeze** funds at blacklisted addresses. The mere fact of deploying a smart contract on Ethereum mainnet does not automatically make the company a subject of OFAC, but if a transaction with an SDN address appears in the smart contract's blockchain history — this is a compliance incident.

**This falls into § 5 of escalation-zones.md (Sanctions / OFAC) → human escalation is mandatory for a specific screening procedure.**

#### Q4 — Smart contract as a "VA operations operator"

**Confidence: LOW** — there is no enforcement practice in Ukraine for this specific case.

**Arguments "PaymentSplitter = self-custody pass-through, not a VASP":**

- The contract does not hold funds long-term — input → instant split → output.
- There is no custody (no user accounts, no users' private keys in the contract).
- The source of funds is the sender themselves (the SENIOR), who also signs the transaction.

**Arguments "PaymentSplitter = transfer of VA on behalf of a client":**

- The contract is deployed by the ADMIN. The ADMIN is the party that **systematically** organizes the distribution of funds to several recipients.
- The recipients (JUNIOR, partner) do not sign the incoming transaction; they are "clients" from the regulator's point of view.
- In 10225-d "VA transfer services" are defined broadly — including anyone who professionally makes a transfer on behalf of third parties.
- The regularity of the operations (every month, every SENIOR) = "professional activity".

**My reading (subject to verification):** PaymentSplitter, **deployed by the ADMIN**, with **regular** auto-splits to JUNIOR/partner — **will most likely** be qualified by the NSSMC as a VASP service after the introduction of 2074-IX. If each SENIOR deployed their own contract with their own recipient addresses — the self-custody argument would be stronger.

#### Q5 — Contractual basis

**Confidence: MED** — here the general law of obligations of the Civil Code of Ukraine works, it is stable.

Without a contractual basis, all three cashflows (SENIOR↔ADMIN, ADMIN↔JUNIOR, ADMIN↔partner) are a **gift** ([Art. 717 of the Civil Code of Ukraine](https://zakon.rada.gov.ua/laws/show/435-15)). A gift between individuals/FOPs is not the best legal frame: the tax nature is unclear, there is no defensive position if the DPS asks "why does money move back and forth".

**Recommended legal nature:**

| Cashflow                      | Nature                                                                                                                                  | Agreement                                                                                         | Tax characterization                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| SENIOR → ADMIN (74%)          | Services (marketing, recruiting, business development) — **ADMIN provides the SENIOR with a service of finding and supporting clients** | Services agreement                                                                                | Income of the ADMIN's FOP (5% single tax + 1% military levy)                                                                          |
| ADMIN → JUNIOR (fixed amount) | Services (the JUNIOR provides development services on the project, ADMIN — coordinator/contractor)                                      | Subcontracting / civil-law (CPH) agreement                                                        | Income of the JUNIOR's FOP (5% + 1%)                                                                                                  |
| ADMIN → partner (50/50)       | Corporate relations — TOV dividends, or "co-founder services" via the partner's FOP                                                     | TOV founding agreement + a decision on profit distribution, or a partner's FOP services agreement | Dividends (5% PIT + 1.5% military levy for residents; 9% + 1.5% for non-residents) OR FOP services (5% single tax + 1% military levy) |

**Key (Confidence: MED):** the legal nature must NOT be a "gift". There must be an identifiable service exchange or a corporate-distribution rationale. Otherwise, under a tax audit the scheme **falls apart** as "unjust enrichment".

#### Q6 — Risk mitigation (in detail in the "Recommendation" section)

See the "Recommendation" section below.

### Risks

| #   | Risk                                                                                                                                                                                         | Severity     | Probability | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Forced transfer of SENIORs from FOP 3 to the general system + a 15% penalty** for settlements in crypto (current DPS position: a FOP on the single tax has no right to crypto settlements) | **Critical** | High        | (a) Convert USDT → UAH through a licensed exchange before crediting to the FOP's account (FOP income = UAH, not USDT); (b) wait for 10225-d and a special regime for FOPs to take effect; (c) alternatively — transfer of SENIORs to a TOV structure (see recommendation #3)                                                                                                                                                                                                                                                             |
| 2   | **VASP qualification of the PaymentSplitter** contract deployed by the ADMIN → requirement of an NSSMC license after 2074-IX takes effect (~Q3 2026)                                         | High         | Medium-High | (a) Deploy the contract **by each SENIOR separately** for their own projects (self-custody argument); (b) alternatively — refusal of the smart contract auto-split, manual USDT transfers through an exchange with tagging the purpose in a memo                                                                                                                                                                                                                                                                                         |
| 3   | **AML / Financial Monitoring block** on USDT→UAH conversion (the bank/exchange qualifies the operation as suspicious due to a multi-party flow without an identifiable contractual basis)    | High         | Medium      | (a) The contractual network BEFORE launch (see Q5); (b) use of licensed UA exchanges with KYC (Whitebit, Kuna) — they are already SPFM, they have established procedures; (c) keeping one's own journal of transactions with attached agreements                                                                                                                                                                                                                                                                                         |
| 4   | **Double/triple taxation** of a single money flow (the SENIOR declares 100% of the income → then JUNIOR/ADMIN/partner declare their part as their own income)                                | High         | High        | A clear contractual flow: the SENIOR's — this is **income for their services to the client**, 74% — this is an **expense** of the SENIOR for the ADMIN's services (a services agreement). Expenses of a FOP group 3 do not reduce the base for the single tax (single tax = gross income), but they protect the **subsequent** characterization: the ADMIN then receives this income as their own and pays their own 5% + 1%. Net effect: tax is paid twice down one chain, but this is **legal**, not a "doubling of the same payment". |
| 5   | **Criminal risks of Art. 209 of the Criminal Code of Ukraine (legalization)** on hitting a blacklisted address or working with a sanctioned counterparty                                     | Critical     | Low         | (a) OFAC SDN screening for each client BEFORE signing a contract; (b) USDT transfers only to whitelist addresses (one's own JUNIORs / partner); (c) an AML-policy document with procedures; (d) **this item = a hard escalation zone (§ 5 escalation-zones.md), a human compliance lawyer is mandatory**                                                                                                                                                                                                                                 |
| 6   | **GDPR/UA personal data risks** of storing users' wallet addresses in the CRM                                                                                                                | Medium       | Medium      | (a) A USDT wallet is pseudonymous, formally not personal data on its own; (b) BUT in combination with email/phone/name — it becomes personal data → Art. 5 of the [Law on the Protection of Personal Data](https://zakon.rada.gov.ua/laws/show/2297-17); (c) encryption-at-rest for wallet fields; (d) audit log of changes (who/when changes a wallet)                                                                                                                                                                                  |
| 7   | **Smart contract bug → loss of funds** (a PaymentSplitter with a bug → the JUNIOR gets 0, the remainder goes to the wrong place)                                                             | Critical     | Low-Medium  | (a) Audit of the contract by Hacken/CertiK before mainnet deployment; (b) Hardhat tests with 100% coverage of scenarios; (c) a testnet pilot ≥3 months; (d) reentrancy protection (OpenZeppelin ReentrancyGuard); (e) at the start — a manual review of each transaction via MultiSig (Safe), not fully automatic                                                                                                                                                                                                                        |
| 8   | **Inability to validate the USDT/UAH rate** for tax accounting in self-custody (there is no "date of arrival in an account" at a bank — there is only a blockchain timestamp)                | Medium       | High        | (a) Conversion USDT→UAH through an exchange = a banking event with a definite date and rate for the DPS; (b) keeping one's own journal with the NBU rate on the date of blockchain confirmation — as a fallback position                                                                                                                                                                                                                                                                                                                 |
| 9   | **A partner conflict without formalization** — if the partner has no clear legal status (individual/FOP/TOV co-founder), the partner 50/50 split = a time bomb                               | High         | Medium      | Registering a TOV with the partner as a founder, or a notarized partnership agreement fixing the % distribution                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 10  | **Change of the regulatory environment before Q3 2026** (10225-d is still fluid, may change as a result of the 2nd-3rd readings)                                                             | Medium       | High        | A quarterly re-review by the Legal agent + a practicing lawyer; do not launch PHASE 8 until the final adoption of the law                                                                                                                                                                                                                                                                                                                                                                                                                |

### Recommendation (best for business, in priority order)

#### 0. MANDATORY BEFORE EVERYTHING ELSE — human escalation for three hard zones

These three topics AI Legal cannot cover with sufficient confidence. **Before any PHASE 8 action:**

1. **Tax counsel (UA crypto/FOP specialization)** — to finalize the tax structure, to check the calculations on a pilot of 2-3 SENIORs. Budget: 15-30k UAH initial consultation + 5-10k UAH quarterly review.
2. **AML/compliance consultant** — for OFAC/UA sanctions screening procedures + Financial Monitoring policy documentation. Budget: 20-40k UAH initial setup.
3. **Smart contract auditor** (Hacken, CertiK, Trail of Bits) — to audit PaymentSplitter before mainnet deployment. Budget: 100-300k UAH depending on scope.

Total compliance budget at the start: **150-400k UAH** (fits within "tens of thousands of UAH" if low-cost options are chosen, but realistically — the lower edge comes out to 150k+).

#### 1. Postpone the PHASE 8 launch until Q3 2026 (after the real activation of 10225-d)

**Rationale:** launching a smart contract auto-split **before** 2074-IX takes effect is work in a legal vacuum, where the DPS can retrospectively declare any crypto operation illegal. After 01.01.2026 (the planned date) there will be certainty on taxes, and after Q3 2026 — real VASP registration (the law gives existing providers a deadline of 01.07.2026 to register, see EY commentary, WebSearch: ey.com/uk_ua/it-tax-law-digest/...).

**Measures until Q3 2026:**

- PHASE 5 continues to work in its current form (manual recording of transactions in the CRM, manual payout via an exchange).
- Prepare the contractual network in advance (see recommendation #2).
- Prepare and test PaymentSplitter in testnet.
- Monitor the status of 10225-d monthly (a WebSearch iteration in the Legal agent).

#### 2. Prepare the contractual network (Q5) — regardless of PHASE 8

The minimal set of templates (prepared **before** launch):

1. **A services agreement between the SENIOR (as a FOP customer) and the ADMIN (as a FOP provider)** — "services of finding and supporting clients, business development"; rate = 74% of the SENIOR's client income; period = monthly; settlements = USDT ERC-20 to the ADMIN's address **or** UAH to the ADMIN's FOP bank account.

2. **A subcontracting / civil-law (CPH) agreement between the ADMIN (as customer) and the JUNIOR (as provider)** — "development services on project X"; rate = a fixed amount from `project_finance_settings.juniorSalary`; settlements = USDT or UAH.

3. **A TOV founding agreement or a partnership agreement ADMIN ↔ partner** — fixing the 50/50 profit distribution. If a TOV — a standard registration procedure + a decision on dividend distribution. If a partner FOP — a joint activity agreement (weaker legally, but acceptable for a small business).

4. **Optionally:** A master agreement with the client → SENIOR (a template for outsource contracts), fixing **that 100% of the payment goes to the SENIOR**, and the internal distribution with the ADMIN is not the client's concern.

**This immediately reduces risk #4 (double taxation) and #3 (AML legalization of the flow).**

#### 3. Restructure via a TOV (if growth >20M UAH/year and/or >5 active projects)

**When:** if the total income of all SENIORs' FOPs exceeds 20M UAH/year (this is ~4-5 SENIORs at a rate of $5k+/month), or if >5 active projects are connected.

**What:** registering a TOV → client contracts are concluded by the TOV → the TOV pays SENIORs as FOP contractors → the TOV distributes dividends to the partners.

**Pros:**

- A TOV can be a VASP (or work with a licensed VASP) — no need for a self-deployment of a smart contract.
- Tax protection is better: dividends (5% PIT + 1.5% military levy for residents) are more predictable than a mix of FOP-CPH-crypto.
- Corporate protection: limited liability vs. full personal liability of a FOP.

**Cons:**

- 18% VAT upon exceeding 1M UAH/year of turnover (but IT services for non-residents = 0% VAT, Art. 195.1.1 of the Tax Code of Ukraine).
- 18% corporate profit tax of the TOV before dividends → de facto double taxation: 18% profit + 5% dividends = 22% effective.
- Compare: FOP group 3 = 6% (5+1) — for outsource at a small/medium scale **a FOP is more advantageous**.

**Verdict:** a TOV is justified only at a scale > 20M UAH/year of turnover **or** when it is necessary to hold a VASP license. Otherwise a FOP structure + contractual network is sufficient.

#### 4. An alternative to the smart contract: a manual distributed payout via an exchange

**Instead of** PaymentSplitter on mainnet:

1. The SENIOR converts USDT → UAH through a licensed UA exchange (Whitebit/Kuna — both SPFM).
2. UAH is credited to the SENIOR's FOP bank — this is a **clean tax event** of the FOP under the existing rules.
3. The SENIOR makes a bank transfer of 74% to the UAH account of the ADMIN's FOP with the note "payment for services under agreement No. X".
4. The ADMIN makes a bank transfer to the JUNIOR of a fixed amount and to the partner 50%/50% of the remainder.

**Pros:**

- Fully compliant with current UA tax/banking practice.
- KYC done by the exchange + bank automatically.
- No VASP risk (no smart contract at all).
- Audit trail in the bank statement (ideal for a DPS audit).

**Cons:**

- Manual work (but the CRM already exists for tracking).
- Exchange fee (0.1-0.5%) + bank fee.
- Speed: 1-3 days instead of 30 seconds on-chain.

**Budget effective cost for compliance:** ~1% of the volume (exchange + bank) vs. 100-300k UAH audit + ongoing VASP registration ≥10k UAH/month after the law takes effect. For outsource at an amount <100k USD/month — manual is more advantageous.

#### 5. If PHASE 8 is still necessary — a hybrid architecture

If a smart contract auto-split is fundamentally needed:

1. **Each SENIOR deploys their own PaymentSplitter** (a Hardhat script from the CRM, the deploy fee is paid by the SENIOR from their own wallet). The recipient addresses are set by the SENIOR themselves. The ADMIN is just one of the recipients, the same as the partner.
2. **Self-custody argument:** the contract is an extension of the SENIOR's own wallet, not a VASP service for third parties.
3. **MultiSig (Gnosis Safe) on the ADMIN/partner address** — adds a KYC checkpoint and protects against a PaymentSplitter bug.
4. **Audit + a testnet pilot ≥3 months** before mainnet.
5. **The contractual network from recommendation #2 — mandatory.**
6. **An AML procedure document** — describes what to do if a blacklisted address is detected; who approves a new wallet.

#### 6. A quarterly legal review

10225-d is fluid, the regulatory environment is fluid. After the initial restructuring:

- **Q3 2026:** a status check of 10225-d (in force? informed by taxes?), the status of VASP registration.
- **Q1 2027:** a review of the first year under the new regime, correction of the structure if needed.
- **Every 6 months:** a WebSearch of key clarifications of the DPS + NSSMC + Financial Monitoring.

These reviews — Mode D strategic consultations of the Legal agent with mandatory human follow-up for high-impact changes.

### Sources

**Primary regulatory acts (UA):**

- [The Law of Ukraine "On Virtual Assets" No. 2074-IX dated 17.02.2022 (version 15.11.2024)](https://zakon.rada.gov.ua/laws/show/2074-20) — the main VA law, not in force.
- [The Law of Ukraine "On Prevention and Counteraction of Legalization (Laundering) of Proceeds..." No. 361-IX dated 06.12.2019](https://zakon.rada.gov.ua/go/361-20) — Financial Monitoring, the 30k UAH threshold.
- [The Tax Code of Ukraine, Article 291 (Section XIV — the simplified taxation system)](https://zakon.rada.gov.ua/laws/show/2755-17) — FOP group 3, limits.
- [The Civil Code of Ukraine](https://zakon.rada.gov.ua/laws/show/435-15) — the basis of the contractual nature (Art. 717 gift, Art. 901 services).
- [The Law of Ukraine "On the Protection of Personal Data" No. 2297-VI](https://zakon.rada.gov.ua/laws/show/2297-17) — the UA analog of GDPR for wallet fields.
- [The Criminal Code of Ukraine, Art. 209 (legalization)](https://zakon.rada.gov.ua/laws/show/2341-14) — the crypto-AML criminal dimension.

**Draft laws in progress:**

- [Draft law 10225-d — VRU Card](https://itd.rada.gov.ua/billinfo/Bills/Card/56271) — first reading 03.09.2025, planned entry into force 01.01.2026. WebSearch (collection date: 2026-05-31).

**Regulator and official clarifications:**

- WebSearch: [NSSMC — Virtual assets in the law](https://www.nssmc.gov.ua/en/virtualni-aktyvy-v-zakoni-v-ukraini-predstavlenyi-dovhoochikuvanyi-dokument-dlia-zapusku-rynku/) (collection date: 2026-05-31).
- WebSearch: [NSSMC — How VA market will be regulated](https://www.nssmc.gov.ua/en/u-nktspfr-rozpovily-iak-rehuliuvatymut-rynok-virtualnykh-aktyviv-v-ukraini/) (collection date: 2026-05-31).
- WebSearch: [NSSMC — Taxation of cryptocurrencies (interview)](https://www.nssmc.gov.ua/en/nktspfr-pro-opodatkuvannia-kryptovaliut-v-ukraini-ta-zminy-do-zakonu-pro-virtualni-aktyvy-interv-iu/) (collection date: 2026-05-31).

**Authoritative commentary (secondary, classified Commentary):**

- Commentary: [EY Ukraine — Bill 10225 approved by the parliamentary committee](https://www.ey.com/uk_ua/it-tax-law-digest/the-draft-law-on-the-taxation-of-income-from-virtual-assets-approved-by-the-parliamentary-committee) (collection date: 2026-05-31).
- Commentary: [GoLaw — A new stage of VA regulation in Ukraine](https://golaw.ua/insights/publication/novij-etap-regulyuvannya-virtualnih-aktiviv-v-ukrayini-shho-zminyuyetsya-dlya-biznesu-ta-investoriv/) (collection date: 2026-05-31).
- Commentary: [DTKT — The DPS position on FOP single-tax payers and crypto](https://news.dtkt.ua/simple/individual-single-tax/85485-ci-mozut-fizosobi-jedinniki-otrimuvati-doxid-u-kriptovaliuti-poziciia-dps) (collection date: 2026-05-31).
- Commentary: [DTKT — What awaits accountants from 01.01.2026](https://news.dtkt.ua/state/other/103083-virtualni-aktivi-v-ukrayini-shho-cekaje-buxgalteriv-z-1-sicnia-2026-roku) (collection date: 2026-05-31).
- Commentary: [Taxer.ua — Cryptocurrency and a FOP on the single tax](https://taxer.ua/uk/kb/kryptovalyuta-u-fop-na-ep) (collection date: 2026-05-31).
- Commentary: [Yankiv — Changes for FOPs in 2026](https://yankiv.com/zminy-dlya-fop-u-2026/) (collection date: 2026-05-31).
- Commentary: [Factor — Foreign-currency income of a FOP on the simplified system: the NBU rate](https://i.factor.ua/ukr/journals/nibu/2026/january/issue-9/article-135899.html) (collection date: 2026-05-31).
- Commentary: [BIP.net.ua — The military levy 2026](https://bip.net.ua/articles/vijskovij-zbir/) (collection date: 2026-05-31).
- Commentary: [BuhPlatforma — Financial monitoring 2025: entities, operations, penalties](https://buhplatforma.com.ua/article/7558-fnansoviy-montoring) (collection date: 2026-05-31).
- Commentary: [Global Legal Insights — Blockchain & Cryptocurrency Laws 2026 / Ukraine](https://www.globallegalinsights.com/practice-areas/blockchain-cryptocurrency-laws-and-regulations/ukraine/) (collection date: 2026-05-31).
- Commentary: [CMS Legal — Crypto Regulation in Ukraine](https://cms.law/en/int/expert-guides/cms-expert-guide-to-crypto-regulation/ukraine) (collection date: 2026-05-31).

**Internal knowledge base:**

- `docs/legal/cross-cutting/escalation-zones.md` — §1 (criminal liability Art. 209/212), §2 (disputes with the DPS), §5 (Sanctions/OFAC) — all three apply to this consultation.
- `docs/legal/cross-cutting/citation-rules.md` — the citation format is followed.
- `docs/legal/ua-fop/`, `docs/legal/crypto-usdt/` — **empty** (Phase 0), not used.
- `CLAUDE.md` (root) — sections "PHASE 8 — Smart contracts", "Financial flow", "Business logic".

### Disclaimer

**Confidence: LOW (overall).** This consultation is a preliminary AI check, NOT binding legal advice. The current moment (2026-05-31) is transitional for UA crypto regulation: the main law (2074-IX) is adopted but not in force; the tax draft law that triggers it (10225-d) has passed only the first reading. No HIGH-confidence recommendation on PHASE 8 is possible in such an environment.

**MANDATORY human verification BEFORE any PHASE 8 action:**

1. **A UA tax/crypto practicing lawyer** — to finalize the tax structure (especially FOP group 3 + crypto), the contractual network, and to check specific tax amounts (they fall into § 4 of escalation-zones.md → if >100k UAH of obligations/period, the exact calculations are for a tax consultant, not AI).
2. **An AML/sanctions compliance consultant** — for OFAC screening procedures, UA sanctions checks, a KYC policy (§ 5 escalation-zones.md, hard escalation).
3. **A smart contract auditor (Hacken / CertiK / Trail of Bits)** — for a PaymentSplitter audit before mainnet deployment.

**This consultation does not cover (hard escalation per docs/legal/cross-cutting/escalation-zones.md):**

- § 1 — Criminal-law risks of Art. 209 of the Criminal Code of Ukraine (legalization) on hitting blacklisted addresses. AI pointed out the risk, the specific criminal defense / procedure is for a lawyer.
- § 4 — Specific tax amounts > 100k UAH / period. A general framework is given (5% single tax + 1% military levy), but the exact calculation of obligations taking into account exchange-rate differences and a multi-party flow is for a tax consultant.
- § 5 — Sanctions / OFAC specifics. A general warning is given, the specific screening procedures and vendor approval are for a specialized compliance lawyer.

**Use this answer as:** a brainstorming map to understand the scope of the risks and prepare for a conversation with a practicing lawyer. Do NOT use it as: a basis for action without human review.

**Additionally for PM:** given that this is the **first real Legal consultation** in the system — PM should record in `docs/agents/memory/legal/lessons.md` lessons on the structure of the output (especially: was the breakdown into 6 sub-questions with individual confidence clear). For future strategic consultations on PHASE 8 evolution — re-trigger the Legal agent every quarter after progress on 10225-d.
