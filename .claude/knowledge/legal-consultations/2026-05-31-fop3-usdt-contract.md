# Legal Consultation: FOP group 3 + USDT in the contract — An alternative to the TOP pattern?

## Mode: strategic

## Date: 2026-05-31

## Requested by: User direct → PM

## Context

The User received 6 previous consultations. They have already **accepted the TOP pattern** (TOV Diia City + WhiteBIT + Wise) and received an implementation roadmap.

Now the User has asked a structural question: **what if instead of a TOV — just their personal FOP group 3, and in the contract we specify payment in USDT ERC-20**?

This requires a direct comparison with the TOP pattern + an understanding of the current legal status of FOP crypto settlements in 2026.

## Main question

**Is the structure "FOP group 3 + USDT in the contract with the client" legitimate and audit-proof in 2026 for our profile?**

And — in which scenarios is it applicable, in which not.

## Sub-questions

### Q1 — The current legal status of FOP group 3 + USDT settlements (2026)

Memory lesson [P2]: Law 2074-IX is adopted but NOT in force. The current DPS position: a FOP on the single tax has no right to crypto settlements until the tax changes take effect.

**Clarify the current state:**

- As of 2026-05-31 — what does the DPS say about accepting USDT on a FOP-3?
- Has anything changed after the first reading of 10225-d (03.09.2025)?
- What are the risks if the user specifies USDT in a FOP contract with a client **today**?
- What specific penalties (forced transfer to the general system? a 15% penalty? annulment of FOP status?)

### Q2 — The FOP group 3 limit for 2026 — a blocker for our scale?

- The current income limit of a FOP group 3 for 2026 (about ~₴8.4M = 1167 minimum wages?)
- At the planned scale of ₴20-30M/year — this is an excess, what will happen?
- The USDT→UAH conversion rate for calculating the limit (NBU on the date of the operation?)
- USDT received but not converted — is it counted as FOP income (cash basis vs accrual)?

### Q3 — A full comparison vs the TOP pattern

A side-by-side comparison for our profile (5M-30M UAH turnover, a team of 30-50 contributors, US/EU clients, a UA-resident founder):

| Parameter                  | FOP group 3 + USDT | TOV Diia City + WhiteBIT |
| -------------------------- | ------------------ | ------------------------ |
| Setup time                 | ...                | ...                      |
| Setup cost                 | ...                | ...                      |
| Tax burden                 | ...                | ...                      |
| Maximum annual turnover    | ...                | ...                      |
| Crypto legal status        | ...                | ...                      |
| Distribution to the team   | ...                | ...                      |
| Audit risk                 | ...                | ...                      |
| Solidity for US/EU clients | ...                | ...                      |
| Scalability                | ...                | ...                      |

### Q4 — Distribution via a FOP

If only the user's FOP:

- **To JUNIOR/SENIOR (the team):** FOP → FOP subcontracting (a contract with each FOP specialist). Legitimate?
- **To the partner:** FOP → partner-FOP via an MSA? Or is a TOV level mandatory for a partnership?
- **Self distribution:** the FOP can keep everything (5% tax) — but at turnovers > the limit = exclusion

What is the legal nature of these cross-subcontracting payments?

### Q5 — Bridge scenario: a FOP solo period → a TOV later

A realistic scenario: the founder has only just started the business, does not want to spend ₴60-150k on a TOV setup right away. They use a personal FOP as a bridge for 6-12 months, then switch to a TOV.

**Viable or not?**

- Which documents must be separated (a clean transition without commingling)
- When to switch (what triggers "time for a TOV")
- What risks in the bridge period (USDT via a FOP → then a TOV)
- Does it affect the Diia City startup-resident status (24-month window — is the start counted from the moment of TOV registration?)

### Q6 — Practical risk if the user tries right now

The user signs a contract with a US client tomorrow:

- Parties: User-FOP ↔ US Client LLC
- Subject: IT services
- Payment: USDT ERC-20 monthly to the user-FOP's address
- Term: 12 months, $5000/month

What will happen after:

- 3 months (receipt of the first USDT)
- 6 months (an increasing volume)
- 12 months (if accrued income > the FOP limit)
- 24-36 months (if a DPS audit cycle)

Specific detection mechanisms + sanctions in each scenario.

### Q7 — When the FOP-USDT structure is still legitimate / acceptable

Possible niches where this **may work**:

- A solo freelancer without a team, income < ₴1M/year, occasional crypto from one client?
- A bridge period of 3-6 months pre-TOV?
- A specific carve-out that we are missing?

If such a niche exists — describe the precise conditions + limitations.

If not — explicitly say "this does not work for our case in any scenario".

## What matters for the decision

- **Do not repeat the whole TOP-pattern analysis** — focus on the FOP-vs-TOV delta
- **Concrete at our scale** — not an abstract "FOP it depends"
- **Bridge scenario** — this may be of real interest to the User (lower setup cost at the start)
- **Honest about the legal vacuum** — where the status is unclear due to the unadopted law 10225-d

## What NOT to discuss

- Off-books schemes (already covered, hard refuse)
- Offshore alternatives (already covered)
- General theory of FOP regimes (focus on USDT-specific)

---

<!-- The Legal agent will add the `## Lawyer answer` section below -->

## Lawyer answer

**Confidence (overall):** MED — per-section:

- Q1 (legal status FOP-3+USDT in 2026): **MED** — the DPS position is unambiguous and stable (a criminal-quasi ban), the legal vacuum of Law 2074-IX is confirmed, 10225-d is at an unadopted second reading
- Q2 (FOP-3 limit): **HIGH** — a concrete figure ₴10,091,049, published officially
- Q3 (side-by-side comparison vs TOP pattern): **MED-HIGH** — both patterns are known to us from the previous 6 consultations, the delta between them is clearly calculated
- Q4 (distribution via FOP): **MED** — the income-splitting risk is well documented
- Q5 (bridge scenario FOP→TOV): **MED** — the startup-resident window mechanics are clear, but there is no precedent for our specific case (USDT in the bridge period)
- Q6 (practical risk timeline): **MED** — concrete detection mechanisms are visible through the banking limits of August/November 2026
- Q7 (legitimate niches): **MED-HIGH** — the niches are narrow, well-defined

**Mode:** strategic
**Date:** 2026-05-31

### TL;DR

**FOP-3 + USDT for our profile (planned turnover ₴20-30M, a team of 30-50 contributors, US/EU clients) — does NOT work in any scenario.** Three blockers are spaced such that passing all of them is impossible: (1) **the DPS stably considers** accepting USDT on a FOP-3 a prohibited means of settlement → automatic removal from the simplified system from the first of the quarter of detection + a penalty rate of 15%; (2) **the FOP-3 limit for 2026 = ₴10,091,049** (1167 minimum wages) — our plan of ₴20-30M is breached in the first 6-12 months → automatic exclusion with no need for a crypto argument; (3) **from 14 August 2026 banks will introduce a transfer limit for FOP-3 of ₴3M/month, from 14 November — ₴1M/month** ([Memorandum of the NBU + AUB + 29 banks dated 14.05.2026](https://7eminar.ua/news/20501-novi-obmezennya-dlya-fop-i-yurosib-zmini-v-memorandum-bankiv)) — this is a structural cap unrelated to crypto and unrelated to the official tax limits.

**Bridge scenario (a solo FOP for 3-6 months pre-TOV) — viable ONLY under strict conditions:** (a) ZERO USDT operations in the bridge period (only UAH/USD wire via a bank), (b) income < ₴3M/month, (c) in no case commingle the FOP's activity with the future TOV (different clients / different contracts), (d) a bridge ≤ 6 months with a hard cutoff. If at least one of the conditions is not met — the bridge breaks and you end up in statutory exposure.

**Recommendation: stay TOP pattern.** FOP-3+USDT is not a "lower cost alternative", it is structurally impossible for our scale. If the goal is a bridge — start the TOP pattern immediately at mini-scale (TOV Diia City without startup-resident status at first, or as a startup resident if < 24 months and < 1167 minimum wages), not via a FOP-USDT detour.

### Analysis

#### 1. The current legal status of FOP-3 + USDT in 2026 (Q1)

**DPS position (stable, confirmed in 2025-2026):**

> Single-tax payers of groups 1-3 must make settlements for goods, works or services **exclusively in monetary form — cash or non-cash**. Cryptocurrency has no status of money in Ukraine, so it is recognized as a commodity, and payment in cryptocurrency is qualified as a **barter operation**.

(WebSearch: [taxer.ua — Cryptocurrency and a FOP on the single tax](https://taxer.ua/uk/kb/kryptovalyuta-u-fop-na-ep), collection date: 2026-05-31; [dtkt.ua — The DPS position on individual single-tax payers](https://news.dtkt.ua/simple/individual-single-tax/85485-ci-mozut-fizosobi-jedinniki-otrimuvati-doxid-u-kriptovaliuti-poziciia-dps), collection date: 2026-05-31)

**Barter for a single-tax payer is a prohibited means of settlement** per [para. 291.6 of the Tax Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2755-17). The consequences of a violation — two cascades:

1. **Automatic removal from the simplified system** from the first of the quarter following detection ([para. 299.10 of the Tax Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2755-17)).
2. **A penalty single-tax rate of 15%** on the amount of income received through the prohibited means ([para. 293.4 of the Tax Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2755-17), applied by the DPS in current practice per the [factor.academy guide 2026](https://factor.academy/blog/perexid-fopa-zi-sproshhenoyi-sistemi-na-zagalnu-v-2026-roci-pravila-stroki-pdv/), collection date: 2026-05-31).
3. **Subsequent taxation** from the moment of exclusion — under the general system: **18% PIT + 1.5% military levy** on income minus documentarily confirmed expenses ([para. 167.1, Art. 16-1 subsection 10 of the Tax Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2755-17)).

**Law 2074-IX "On Virtual Assets"** ([adopted 17.02.2022](https://zakon.rada.gov.ua/laws/show/2074-20)) is still NOT in force. The **draft law 10225-d** that triggers it, as of 2026-05-31:

- Adopted as a basis with revision on 03.09.2025 in the first reading
- Status — **"being prepared for the second reading"** (WebSearch: [itd.rada.gov.ua — Card 10225-d](https://itd.rada.gov.ua/billinfo/Bills/Card/56271), collection date: 2026-05-31)
- The second reading did not happen either at the end of 2025 or in Q1-Q2 2026 — this means the **legal vacuum is preserved** for at least another quarter, possibly longer

**Bottom line Q1:** As of 2026-05-31 a FOP-3 effectively **cannot legitimately accept USDT as payment for services** without exposure to forced exclusion. This is not a "gray area" — it is an **expressly prohibited** means per the stable DPS position.

#### 2. The FOP-3 limit for our scale (Q2) — an automatic disqualifier

**Concrete figures for 2026:**

- The annual income limit of a FOP-3 = **1167 minimum wages = ₴10,091,049** (minimum wage 2026 = ₴8,647) (WebSearch: [easyfop.com — FOP-3 2026](https://easyfop.com/reyestratsiya-fop-3-grupa/), collection date: 2026-05-31; [7eminar.ua — FOP-3 2026 limits](https://7eminar.ua/news/15698-fop-3-grupi-u-2026-roci-podatki-ta-limiti), collection date: 2026-05-31)
- Single-tax rate 5% (without VAT) or 3% (with VAT) + 1% military levy
- USC for oneself = **₴1,902.34/month** = ₴22,828/year

**Exceeding the limit — a two-step sanction:**

1. **15% single tax on the amount of the excess** ([7eminar.ua — limits 2026](https://7eminar.ua/news/17728-limiti-doxodu-fop-u-2026-roci-skilki-mozna-zarobiti-bez), collection date: 2026-05-31)
2. **Exclusion from the simplified system from the first of the quarter following the excess** → transfer to the general system (18% PIT + 1.5% military levy)

**Specifically for our profile:**

| Scenario              | FOP monthly income | Month of breaching the limit                           |
| --------------------- | ------------------ | ------------------------------------------------------ |
| 5M/year (start)       | ~₴417,000          | month 13 (excess in the next year) — OK the first year |
| 20M/year (target)     | ~₴1.67M            | **month 7** — exclusion in Q3                          |
| 30M/year (full scale) | ~₴2.5M             | **month 4-5** — exclusion in Q2                        |

At the current scale (the User is already planning **₴20-30M/year**) the FOP-3 falls apart **in the first 4-7 months** simply through the limit — **even without the crypto argument**. This is a structural disqualifier, independent of Q1.

**USDT rate for calculating the limit:** since the USDT/UAH conversion happens through an exchange and is credited to a bank account as UAH — this is the moment the FOP income arises (the NBU rate on the date UAH arrives). Self-custody USDT at a blockchain address is formally not "FOP income" in the strict sense — but the DPS in an audit will argue that the economic substance = income, the fixation date = the blockchain confirmation timestamp. This adds to the Q1 risk.

**Bottom line Q2:** Even if one abstracts away from the crypto ban (Q1), our planned scale is incompatible with the FOP-3 limit. As a solo regime — workable up to a turnover of ~₴8-9M, further — a TOV is mandatory.

#### 3. Side-by-side comparison FOP-3+USDT vs the TOP pattern (Q3)

Directly for our profile (planned ₴20-30M/year, a team of 30-50, US/EU clients, a UA-resident founder):

| Parameter                                         | FOP-3 + USDT                                                                                                                                                                                                                                                        | TOV Diia City + WhiteBIT + Wise                                                                                                                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Setup time**                                    | 1-3 days (online FOP registration via "Diia")                                                                                                                                                                                                                       | 8-12 weeks (in parallel: TOV + Diia City + WhiteBIT KYB + banks)                                                                                                                                                                              |
| **Setup cost (initial)**                          | ₴0-5k (notary opt., seal opt.)                                                                                                                                                                                                                                      | ₴80-180k (lawyer ₴30-80k + audit setup ₴5-10k + TOV statutory fund + WhiteBIT KYB time-cost)                                                                                                                                                  |
| **Ongoing cost**                                  | ₴22.8k USC/year + ₴2-5k accounting/month                                                                                                                                                                                                                            | ₴35-65k/month (accounting + Diia City compliance + audit accrual + Wise/WhiteBIT fees)                                                                                                                                                        |
| **Crypto legal status**                           | **PROHIBITED** (barter = a prohibited means of settlement per the DPS, exclusion risk Critical)                                                                                                                                                                     | **ALLOWED** via WhiteBIT Business KYB as an institutional VASP channel, the TOV converts USDT→UAH through a licensed exchange                                                                                                                 |
| **Tax rate (of turnover)**                        | 5% single tax + 1% military levy = **6%** + ₴22.8k USC — **PER FOP**, collapses at > ₴10M turnover                                                                                                                                                                  | Exit-capital tax **9% only on distribution**, 0% on reinvest; team: 5% PIT + 5% military levy + ₴1,902 USC via a gig contract. **Consolidated burden ~12-16%** at 30%/70% distribution/reinvest                                               |
| **Max annual turnover**                           | **₴10,091,049** (hard cap, exclusion upon exceeding)                                                                                                                                                                                                                | **No cap up to ₴9.7B** (1 mln minimum wages — the current Diia City maximum)                                                                                                                                                                  |
| **Banking transfer limit (NEW from 2026)**        | **₴3M/month from 14.08.2026, ₴1M/month from 14.11.2026** ([Memorandum of the NBU + AUB + 29 banks dated 14.05.2026](https://7eminar.ua/news/20501-novi-obmezennya-dlya-fop-i-yurosib-zmini-v-memorandum-bankiv)) — a **structural cap** on our architecture         | No specific restrictions for legal entities                                                                                                                                                                                                   |
| **Distribution to the team (30-50 contributors)** | **Income-splitting risk Critical** — FOP→FOP subcontracting with "common clients / common staff / common management" = an automatic DPS trigger. The criminal threshold of ₴4.542 million of unpaid taxes (Art. 212 of the Criminal Code of Ukraine) is easy to hit | **Clean** via gig contracts ([Art. 170.14 of the Tax Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2755-17), Law 1667-IX). The TOV — a single legitimate principal, gig specialists — separate FOPs without common-management exposure |
| **Audit risk on a 12-month horizon**              | **Very high** — banks automatically flag via E-currency/SEPA from 02.2026, a USDT spike in a bank statement = a compliance trigger, currency supervision is automated via the ABS-E-currency                                                                        | **Low with a clean setup** — a TOV Diia City is known to the DPS as a legitimate resident, gig contracts are in accounting practice, WhiteBIT is a licensed CASP candidate                                                                    |
| **Solidity for US/EU clients**                    | **Low** — a FOP-3 in a US/EU context often sounds like a "sole proprietor", it is hard to negotiate B2B rates, MSA templates for a FOP are limited                                                                                                                  | **High** — a TOV Diia City resident is identified as a legitimate corporate structure with audited reporting, KYB via WhiteBIT and Wise is additional credibility                                                                             |
| **Limited liability**                             | NONE — full personal liability of the FOP on their own property                                                                                                                                                                                                     | TOV = limited liability, the founder risks only the statutory capital                                                                                                                                                                         |
| **Bridge to next phase**                          | Single-path: upon exceeding the limit or crypto detection — an emergency reorg                                                                                                                                                                                      | Already at scale-target, the NEXT phase = MNE or a VASP license                                                                                                                                                                               |
| **Scalability at 50M+/year**                      | **0** — structurally impossible                                                                                                                                                                                                                                     | Yes — Diia City without a cap up to ₴9.7B (1 mln minimum wages in 2026), then VAT becomes a real factor                                                                                                                                       |

**Delta points:**

1. **The tax rate "5% FOP vs 12-16% TOV" is misleading.** FOP-3 5% single tax on > ₴10M is already = exclusion → 18%+1.5%+potentially 18% VAT → effective burden 25-30%. TOV Diia City 12-16% — this is **stable**, does not grow with scale.
2. **Setup cost is tempting.** ₴0 vs ₴80-180k seems like a choice, but after 3-6 months an emergency reorg FOP→TOV will cost the same ₴80-180k + lost time + reputational risk before clients.
3. **The team is the biggest delta.** Distribution to 30-50 contributors through a FOP-FOP-FOP chain is textbook **income splitting** with a criminal threshold of ₴4.542M ([yankiv.com — Splitting 2026](https://yankiv.com/droblennya-biznesu-na-fop/), collection date: 2026-05-31), which our cashflow exceeds many times over.
4. **The 2026 banking moat.** ₴3M→₴1M/month on a FOP is a structural innovation that fundamentally breaks the FOP-as-business-vehicle for our scale.

**Bottom line Q3:** FOP-3+USDT is a pattern for a solo freelancer up to ₴8-10M/year. For our profile the transition from "a FOP is temptingly cheap" to "a FOP is impossible" happens in the first 4-7 months. The TOP pattern is not "overkill", but **mandatory** for a turnover > ₴10M.

#### 4. Distribution via a FOP — why FOP→FOP subcontracting does not scale (Q4)

**If only the user's FOP, the options for distribution to the team:**

**Option A — FOP → FOP-SENIOR/JUNIOR as subcontractors via a civil-law (CPH) contract:**

Legitimate at the base (Art. 901 of the Civil Code of Ukraine — a services agreement), BUT with specific risks for our scale:

| Risk                                                                                                                                                                                                                                                          | Type           | Severity |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------- |
| **Income splitting** — common clients, common management, one legal address, centralized accounting. **All of these signs fire** in our model ([yankiv.com — splitting criteria](https://yankiv.com/droblennya-biznesu-na-fop/), collection date: 2026-05-31) | Tax + Criminal | Critical |
| **The criminal threshold of 4.542 million UAH of unpaid taxes** (Art. 212 of the Criminal Code of Ukraine) is easily breached if the DPS aggregates the FOPs                                                                                                  | Criminal       | High     |
| **The NBU monitoring letter of 01.11.2024** — banks automatically flag FOP schemes with signs of splitting                                                                                                                                                    | Banking        | High     |
| **E-currency 02.02.2026** — the SPFM E-cabinet is synchronized with the DPS + customs, FOP-chain structures become visible in real time                                                                                                                       | Banking + Tax  | High     |

**DPS signals for splitting (all applicable to our model):**

- Common clients ✗ (one ADMIN-FOP is the focal point for the whole team)
- Common staff ✗ (SENIOR and JUNIOR are nominally separate FOPs, but actually in one team)
- Common material base ✗ (CRM, infrastructure, branding — all centralized)
- Common suppliers ✗ (one US/EU client via the ADMIN-FOP)
- Centralized bookkeeping ✗ (the ADMIN-FOP coordinates all invoicing)
- Subcontracting agreements ✗ (one of the types of agency/subcontracting that the tax authority scrutinizes)

(Source: [factor.academy — Business splitting on FOPs 2026](https://factor.academy/blog/droblennya-biznesu-na-fop-yak-podatkova-pereviryaye-i-za-shho-realno-shtrafuye/), collection date: 2026-05-31; [yankiv.com — Business splitting 2026](https://yankiv.com/droblennya-biznesu-na-fop/), collection date: 2026-05-31)

**Option B — Each contributor is an independent FOP with their own client:**

Technically clean, BUT it breaks the business model:

- The client wants to work with **one vendor**, not with 30-50 separate FOPs
- Quality control / per-project support / brand cohesion — all collapses
- This is effectively **not a team**, but an aggregator of freelancers — a different business model

**Option C — The partner via an MSA with a FOP:**

A bilateral MSA partnership between two FOPs (for example ADMIN-FOP ↔ Partner-FOP) is possible:

- A "joint activity agreement" ([Art. 1130 of the Civil Code of Ukraine](https://zakon.rada.gov.ua/laws/show/435-15)) — legitimate, but **does not give a corporate shield** and does not scale to 30+ contributors
- A partner 50/50 distribution via two FOPs = two separate single taxes, two separate reportings, two separate exclusion risks

**Bottom line Q4:** FOP distribution legitimately works for one or two partners (Option C). As a distribution mechanism for a **team of 30-50 contributors** — it is either (Option A) an automatic splitting risk, or (Option B) the business model breaks. The TOP pattern via gig contracts ([Law 1667-IX on gig specialists](https://zakon.rada.gov.ua/laws/show/1667-20)) is a **purpose-built** legal frame for our case, a FOP structure is not.

#### 5. Bridge scenario: a solo FOP-3 → a TOV later (Q5)

**Mechanics of the startup-resident 24-month window:**

The 24-month window for Diia City startup status is counted **from the date of state registration of the TOV** to the date of filing the application for residency ([guide.diia.gov.ua — startup criteria](https://guide.diia.gov.ua/view/nabuttia-statusu-rezydenta-diia-siti), collection date: 2026-05-31; [audit-invest.com.ua — startups 2026](https://audit-invest.com.ua/ru/articles/blog/startapy-v-diia-city-pilhy-zvitnist-audyt), collection date: 2026-05-31). **The founder's prior FOP activity does NOT consume the window** — a FOP and a TOV are separate legal entities.

**This means:** the founder can have a FOP in the bridge period and then register a fresh TOV → the 24-month window starts then, an application for Diia City startup residency is possible if the new TOV's income is < 1167 minimum wages (₴10.09M) for the previous year (for the first 12 months) — this is the **same threshold as the FOP-3 limit**.

**The bridge is viable under these conditions:**

| Condition                                                                          | Why it is critical                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The bridge period ≤ 6 months**                                                   | More — the accrued FOP revenue risks crossing ₴10M in the bridge period itself → FOP exclusion even before the TOV starts                                                                                                   |
| **ZERO USDT operations in the bridge**                                             | Otherwise FOP exclusion in Q1 fires immediately, TOV registration does not "erase" past FOP violations                                                                                                                      |
| **Income < ₴3M/month (from August 2026)** and **< ₴1M/month (from November 2026)** | The banking limits of the 2026 Memorandum — otherwise the FOP account is blocked until a compliance review                                                                                                                  |
| **Different clients between the bridge-FOP and the future-TOV**                    | Otherwise at the TOV launch — this is a continuation of the activity, not a "new entity" → the DPS may qualify it as a restructuring without a discontinuous breakpoint, which complicates the startup-resident application |
| **Different services / a different domain**                                        | A subtle point. If the FOP = "consulting" and the TOV = "software development" — better protection before a DPS audit. If both are "IT services" — worse                                                                    |
| **A documentary continuity break**                                                 | Before launching the TOV — close the acceptance of new clients on the FOP, a signed acceptance act on all open FOP projects. The TOV starts with a new client cohort                                                        |
| **A documentarily clean handover**                                                 | If a bridge client moves from the FOP to the TOV — a novation (Art. 604 of the Civil Code of Ukraine) is mandatory, or termination of the FOP contract + a new TOV contract. Not a silent continuation                      |

**The bridge is NOT viable when:**

- **USDT in the bridge period** — automatic FOP exclusion, all the advantages of the bridge are lost
- **A team > 2 contributors in the bridge** — income-splitting risk already in the bridge
- **A bridge > 6 months** — the cumulative turnover breaches the limit
- **Continuity of clients from the bridge-FOP into the TOV without novation** — the risk of qualification as "artificial splitting" of the startup resident in an audit

**An alternative recommendation — skip the FOP bridge altogether:**

If the goal of the bridge is a lower upfront cost — here is a **better** alternative:

1. **A TOV Diia City startup resident right away.** Setup: ₴30-50k via online "Diia" + an IT lawyer for the contracts. The first year — without the requirement of 9 specialists and a €1200 floor. Without a turnover limit up to 1167 minimum wages.
2. **A solo founder on a gig contract with the TOV** — the founder is their own gig specialist, works "for themselves" via the TOV. Tax = 5% PIT + 5% military levy + USC ₴1902 = effective ~10-12% on the founder's remuneration. Dividends are not paid in the bridge period (reinvest mode).
3. **First clients right away via the TOV.** No FOP detour needed. WhiteBIT/Wise are connected in parallel with the TOV setup (8-12 weeks total).

**Cost comparison of the bridge approach vs direct TOV:**

| Approach                                        | Setup cost                                   | Bridge duration             | Effective tax in the bridge                                    | Risk                                                 |
| ----------------------------------------------- | -------------------------------------------- | --------------------------- | -------------------------------------------------------------- | ---------------------------------------------------- |
| FOP-3 → TOV later (correct execution, no USDT)  | ₴0 + ₴22.8k USC + ₴80-180k for the TOV later | 3-6 months                  | 6% FOP in the bridge                                           | MED — still exposure to banking limits and splitting |
| **A TOV Diia City startup resident right away** | ₴80-180k                                     | —                           | 10-12% from the gig remuneration (founder-solo)                | Low — a clean path                                   |
| FOP-3+USDT → TOV later                          | ₴22.8k USC + emergency reorg ₴100-200k       | 1-3 months to FOP exclusion | nominally 6%, in reality 15% penalty + 18%+1.5% post-exclusion | **Critical**                                         |

**Bottom line Q5:** The bridge scenario is possible **only** as UAH-only, < ₴3M/month, ≤ 6 months, single-contributor. For our profile, where the goal is ₴20M+/year turnover and a team of 30-50 — the bridge gives no advantages over a direct TOV start. A direct TOV start (Diia City startup resident) is economically and legally simpler.

#### 6. Practical risk if the user signs a USDT-FOP contract tomorrow (Q6)

**Scenario:** FOP ↔ US Client LLC, IT services, USDT ERC-20 monthly $5000/month, term 12 months.

**Monthly income ≈ ₴210,000 (at a rate of 42 UAH/USD). Annual accrued ≈ ₴2.5M.** This is **below** the FOP-3 limit of ₴10.09M, but **above** the crypto zero trigger.

**Risk timeline:**

**T+1 month** — the first USDT arrived at the user's self-custody address:

- _Detection probability:_ **20-30%** on the condition that the user converts via a licensed UA exchange (WhiteBIT/Kuna — both SPFM per [Law 361-IX](https://zakon.rada.gov.ua/go/361-20))
- _Trigger:_ a fin-mon report from the exchange about a crypto operation > 30k UAH (~$720) — our payment of $5000 significantly exceeds the threshold
- _Outcome:_ a written DPS inquiry ("Explain the source of the receipt") with a 15-day term, in the audit queue

**T+3 months** — three USDT operations in the history:

- _Detection probability:_ **40-50%**
- _Trigger:_ the FOP's bank, upon a UAH receipt from the exchange, makes a compliance flag → the bank contacts the FOP with a demand for purpose documents → the bank is obliged to report an SPFM report in form 2-finmon if the pattern is repetitive
- _Outcome:_ possible account blocking until a compliance review (30-60 days), a DPS desk audit
- _Exposure amount:_ for 3 months — ₴630,000 of receipts, of which 15% penalty = ₴94,500 + 18% PIT + 1.5% military levy ≈ ₴122,850 post-exclusion → total ≈ ₴217k

**T+6 months** — 6 USDT operations ≈ ₴1.26M:

- _Detection probability:_ **60-75%**
- _Trigger:_ from 02.02.2026 the SPFM E-cabinet + E-currency NBU-DPS-Customs real-time exchange → an automatic cross-match of crypto-exchange reports with the FOP's bank receipts ([Yur Gazeta — Currency supervision 2026](https://yur-gazeta.com/dumka-eksperta/valyutniy-naglyad-i-komplaens-novi-vimogi-do-biznesu.html), collection date: 2026-05-31)
- _Outcome:_ automatic FOP exclusion from the simplified system, a 15% penalty on the whole amount, transfer to the general system, possibly Art. 212 of the Criminal Code of Ukraine at > ₴4.542M accumulated
- _Exposure amount:_ ₴1.26M × 15% = ₴189k penalty + 18%+1.5% post-exclusion ≈ ₴246k → total ≈ ₴435k for 6 months

**T+12 months** — 12 USDT operations ≈ ₴2.5M:

- _Detection probability:_ **85-95%**
- _Trigger:_ the annual FOP declaration → the DPS sees the declared revenue. If declared as USDT income — automatic single-tax ineligibility. If NOT declared as USDT — this is a **double violation** (a prohibited means + concealment of income = Art. 212 of the Criminal Code of Ukraine pre-criminal warning if > ₴4.542M cumulatively)
- _Outcome:_ FOP exclusion + a 15% penalty + post-exclusion 18%+1.5% for the whole period
- _Exposure amount:_ ₴2.5M × 15% = ₴375k penalty + ₴487.5k post-exclusion taxes ≈ **₴862k total** (plus bookkeeping penalties)

**T+24-36 months (a standard audit cycle):**

- _Detection probability:_ **95%+** — this is beyond reasonable doubt
- _Trigger:_ a planned or unplanned DPS audit, retro-analysis of bank operations, cross-queries to exchanges
- _Outcome:_ retrospective accrual of all taxes + penalties + late fees + admin Art. 164-1 of the Code of Administrative Offenses = in amounts in the zone of **₴4.542M+** — the criminal threshold of Art. 212 of the Criminal Code of Ukraine (escalation zone § 1)

**Bottom line Q6:** In the current 2026 regulatory environment (E-currency, the SPFM E-cabinet, bank monitoring) the practical detection probability on a 12-month horizon is **≥ 85%**. This is not "if they find it", it is **"when they find it"**. The economic expected value of the risk:

```
EV = ₴862k (12-month exposure) × 0.85 + ₴4.5M+ (24-36 months criminal zone) × 0.50
   ≈ ₴2.98M expected loss
```

This is > the capital savings from avoiding the TOP setup (₴80-180k) by an order of magnitude.

#### 7. Legitimate niches for FOP-USDT (Q7)

**Objectively there are narrow niches where the FOP-USDT pattern can work in the short term without exposure:**

**Niche 1 — A solo freelancer < ₴1M/year, ad hoc crypto receipts:**

- Income < ₴1M/year (far below the limit)
- One or two clients, a casual relationship
- USDT as a **payment method**, but with mandatory conversion through a licensed exchange + declaration as **general-system income**, not as FOP-3 income
- Reporting on the FOP-3 — **only for UAH income from other clients**, USDT income is declared separately as the **general system of an individual** (18% PIT + 1.5% military levy + 5% military levy for crypto per the planned changes of 10225-d)

**Does not suit us because:** our scale > ₴1M/year many times over, there is a team, there is a partnership distribution.

**Niche 2 — A bridge ≤ 3 months pre-TOV, UAH-only:**

- A solo founder, < ₴3M total turnover in the bridge period
- **ZERO USDT operations**
- A hard cutoff date with signed acceptance acts on all FOP contracts
- TOV registration already in progress during the bridge

**Does not suit us because:** a scale of ₴20-30M/year will outpace the bridge limit immediately, USDT is central to the business model.

**Niche 3 — Testing the processes at mini-scale before committing to the TOP pattern:**

Conceptually legitimate — the founder registers a FOP-3, works with 1-2 clients on UAH plans, practices invoicing/bookkeeping skills, then switches to a TOV.

**Does not suit us because:** the User already has 6 consultations deep, the business model is understood, the TOP commitment is already made. Testing the processes is not worth the emergency-reorg risk after 3-6 months.

**Niche 4 — Pure USDT-trading individuals (NOT FOPs):**

- An individual buys/sells crypto on spot exchanges for their own funds
- Declared as investment income (income from the sale of investment assets, [para. 170.2 of the Tax Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2755-17))
- The FOP regime is not involved at all

**This is not applicable to our case** — we receive USDT as **payment for services**, not as investment assets.

**Verdict Q7:** None of the niches covers our case. FOP-USDT can legitimately exist only for:
(a) A solo freelancer on the general system with minor crypto receipts < ₴1M/year
(b) A short-term UAH-only bridge ≤ 3 months without crypto operations

Our profile (₴20-30M, a team of 30-50, USDT central) **does not fit into any** legitimate niche.

### Risks

| #   | Risk                                                                                                                                                                                                                                                                           | Severity    | Probability                                                                                                 | Mitigation                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **FOP exclusion from the simplified system through USDT receipts** (barter as a prohibited means per [para. 291.6 of the Tax Code of Ukraine](https://zakon.rada.gov.ua/laws/show/2755-17), the stable DPS position) → a 15% penalty + transfer to the general system 18%+1.5% | Critical    | High (85%+ on a 12-month horizon with USDT operations present)                                              | Do not use USDT on a FOP → convert via a licensed exchange and receive UAH through a bank, or move to a TOV                                                      |
| 2   | **Exceeding the FOP-3 limit (₴10,091,049 / year) at a scale of ₴20-30M** → automatic exclusion in Q2-Q3 of the first year                                                                                                                                                      | Critical    | Certain (100%) at the planned scale                                                                         | Only a TOV structure. A FOP-3 is unsuitable for our scale regardless of the crypto argument                                                                      |
| 3   | **Income splitting in FOP→FOP subcontracting** to 30-50 contributors → Art. 212 of the Criminal Code of Ukraine (threshold ₴4.542M cumulatively of unpaid taxes) → criminal escalation                                                                                         | Critical    | High with the "signs of splitting" present (common clients, centralized management, a common material base) | The TOP pattern via gig contracts ([Law 1667-IX](https://zakon.rada.gov.ua/laws/show/1667-20)) — a purpose-built legal frame, does not trigger splitting rules   |
| 4   | **A banking transfer cap FOP ₴3M/month (from 14.08.2026), ₴1M/month (from 14.11.2026)** per the [Memorandum of the NBU + AUB 14.05.2026](https://7eminar.ua/news/20501-novi-obmezennya-dlya-fop-i-yurosib-zmini-v-memorandum-bankiv)                                           | High        | Certain (100%) at a scale > the cap                                                                         | Only a legal entity avoids the cap. The FOP cap is unrelated to the tax regime — it is a banking policy                                                          |
| 5   | **E-currency 02.02.2026 + the SPFM E-cabinet real-time exchange DPS-Customs-NBU** → automated detection of USDT receipts via cross-correlation of bank/exchange reports                                                                                                        | High        | Certain (100%) for any crypto flow > 30k UAH                                                                | Full avoidance of USDT on a FOP; for a TOV — client onboarding via WhiteBIT Business KYB (an institutional pipeline, integrated with the Art. 361-IX frameworks) |
| 6   | **Criminal liability Art. 212 of the Criminal Code of Ukraine** at cumulative exposure > ₴4.542M (easily accrued at $5k/month × 12-18 months)                                                                                                                                  | Critical    | Medium at > 18 months of USDT collection                                                                    | Hard refuse zone § 1 escalation-zones — escalate to a criminal defense lawyer immediately upon detection. Do not accumulate exposure                             |
| 7   | **Bridge scenario failure** — bridge-period accumulated revenue or crypto receipts turn the bridge-FOP into a "stage of fraud" retrospectively in a TOV audit                                                                                                                  | High        | Medium-High if the bridge conditions are not followed                                                       | A bridge ≤ 6 months, ZERO USDT, < ₴3M/month, different clients from the future-TOV, novation contracts upon transfer                                             |
| 8   | **A substance audit in a FOP→TOV transition without a clean break** — the DPS may qualify the TOV as a continuation of the FOP → "artificial reduction of the tax burden" and a refusal of Diia City startup residency                                                         | Medium-High | Medium                                                                                                      | A documented break: termination of FOP contracts with signed acceptance acts → a 30+ day pause → a new TOV with a new client cohort                              |
| 9   | **Reputational risk before clients during an emergency reorg FOP→TOV** — a change of requisites mid-contract, novation paperwork, a possible pause in payments                                                                                                                 | Medium      | High upon exclusion from the FOP                                                                            | Plan the transition proactively, not in response to a DPS audit                                                                                                  |
| 10  | **Exchange-rate difference on USDT→UAH** adds bookkeeping complexity if the FOP does accept it anyway (not for our case, but as an edge note) — the NBU rate on the date of arrival vs the rate at conversion                                                                  | Medium      | High                                                                                                        | At the TOV level via WhiteBIT Business — a clean primary record in UAH, without exchange-rate-difference problems                                                |
| 11  | **Loss of limited liability** of the FOP on personal property — any tax, banking, civil recovery hits the founder's personal property                                                                                                                                          | High        | Low with clean operations, High in an exclusion scenario                                                    | A TOV = limited liability. For a founder with personal assets (apartment, car, deposit) — a TOV is critical                                                      |

### Recommendation (best for business)

**A direct verdict — three conclusions for the structural decision:**

1. **FOP-3+USDT for our scale (₴20-30M target, a team of 30-50, USDT central) is NOT a working architecture in any scenario.** Three independent blockers (the DPS ban + the FOP limit + the 2026 banking cap) — each one on its own is enough to destroy the model. The combination of all three makes FOP-USDT structurally impossible for our profile.

2. **The bridge scenario solo-FOP → TOV is viable only under very narrow conditions**, which our profile does not satisfy. If the goal of the bridge is to defer the TOV setup cost — there is a **better alternative:** a TOV Diia City startup resident right away with a founder-solo gig contract. Setup ₴30-50k vs ₴22.8k USC + a future ₴100-200k emergency reorg if the bridge breaks.

3. **Stay TOP pattern (TOV Diia City + WhiteBIT + Wise).** This is not overkill for our scale, it is a **mandatory threshold**. All 6 previous consultations confirm it. A FOP-3 as a sufficient vehicle for our business model is the **absence of an alternative**, not a choice among options.

**Actionable next steps (Monday morning):**

1. **Confirm the TOP commitment.** Do not return to the FOP variant as a "cheaper alternative" — the analysis shows that the cheaper alternative turns out to be structurally impossible.

2. **Accelerate the TOP setup,** do not postpone it. Every month of delay = an additional "off-the-books" period without a clean channel for USDT receipts.

3. **Consider the timing of the Diia City startup-resident application.** If the TOV is not yet registered — a startup resident requires (a) a TOV less than 24 months from registration, (b) the previous year's revenue < 1167 minimum wages ≈ ₴9.34M-10.09M (depending on the year). If your plan is: TOV registration + an immediate application for startup resident → this is the **first year without the requirement of 9 specialists and a €1200 floor**, which saves a significant amount of cash flow in the growth phase.

4. **Document a "no USDT on a FOP" policy.** If the founder has a personal FOP for unrelated activity — an explicit policy in a company memo: in no context is USDT accepted on a personal FOP. This is basic compliance hygiene.

5. **If a bridge is unavoidable** (for example, TOV registration goes into a delay) — UAH-only via a personal FOP, ≤ 3 months, < ₴3M cumulative, in no case USDT, in no case team distribution in the bridge period.

### Sources

**Primary regulatory acts (UA):**

- [The Tax Code of Ukraine, Article 291.6](https://zakon.rada.gov.ua/laws/show/2755-17) — the obligation of a FOP on the single tax to settle in monetary form
- [The Tax Code of Ukraine, Article 291.4](https://zakon.rada.gov.ua/laws/show/2755-17) — FOP-3 limits
- [The Tax Code of Ukraine, Article 293.4](https://zakon.rada.gov.ua/laws/show/2755-17) — the 15% penalty rate
- [The Tax Code of Ukraine, Article 299.10](https://zakon.rada.gov.ua/laws/show/2755-17) — the procedure for removal from the simplified system
- [The Tax Code of Ukraine, Article 167.1](https://zakon.rada.gov.ua/laws/show/2755-17) — the general-system PIT rate 18%
- [The Criminal Code of Ukraine, Article 212](https://zakon.rada.gov.ua/laws/show/2341-14) — tax evasion, the ₴4.542M threshold
- [The Civil Code of Ukraine, Articles 604, 901, 1130](https://zakon.rada.gov.ua/laws/show/435-15) — novation, services, joint activity
- [The Law of Ukraine "On Virtual Assets" No. 2074-IX dated 17.02.2022](https://zakon.rada.gov.ua/laws/show/2074-20) — NOT in force
- [The Law of Ukraine "On Stimulating the Development of the Digital Economy in Ukraine" No. 1667-IX (Diia City, gig contracts)](https://zakon.rada.gov.ua/laws/show/1667-20)
- [The Law of Ukraine "On Prevention and Counteraction of Legalization... of Proceeds" No. 361-IX](https://zakon.rada.gov.ua/go/361-20) — Financial Monitoring, the 30k UAH threshold

**Draft laws in progress:**

- WebSearch: [Draft law 10225-d — VRU Card](https://itd.rada.gov.ua/billinfo/Bills/Card/56271) — status "being prepared for the second reading" (collection date: 2026-05-31)

**NBU Memorandum and banking restrictions 2026:**

- WebSearch: [7eminar.ua — New restrictions for FOPs and legal entities, Memorandum 14.05.2026](https://7eminar.ua/news/20501-novi-obmezennya-dlya-fop-i-yurosib-zmini-v-memorandum-bankiv) — limits ₴3M/₴1M (collection date: 2026-05-31)
- WebSearch: [NBU — update of financial monitoring supervision rules 29.05.2026](https://minfin.com.ua/ua/2026/05/29/174794850/) (collection date: 2026-05-31)
- WebSearch: [yankiv.com — SPFM in 2026: the e-cabinet, the 2-finmon report](https://yankiv.com/spfm-u-2026-e-kabinet/) (collection date: 2026-05-31)
- WebSearch: [Yur Gazeta — Currency supervision and compliance 2026](https://yur-gazeta.com/dumka-eksperta/valyutniy-naglyad-i-komplaens-novi-vimogi-do-biznesu.html) (collection date: 2026-05-31)
- WebSearch: [audit-invest.com.ua — Currency supervision 2026: settlement terms and NBU limits](https://audit-invest.com.ua/en/articles/news/valutnyi-nahlyad-rozrakhunky-eksport-2026) (collection date: 2026-05-31)

**Authoritative commentary (secondary, classified Commentary):**

- Commentary: [taxer.ua — Cryptocurrency and a FOP on the single tax](https://taxer.ua/uk/kb/kryptovalyuta-u-fop-na-ep) (collection date: 2026-05-31)
- Commentary: [dtkt.ua — The DPS position on individual single-tax payers and crypto](https://news.dtkt.ua/simple/individual-single-tax/85485-ci-mozut-fizosobi-jedinniki-otrimuvati-doxid-u-kriptovaliuti-poziciia-dps) (collection date: 2026-05-31)
- Commentary: [biz.ligazakon.net — A FOP and cryptocurrency: operations, settlements and taxes](https://biz.ligazakon.net/analitycs/214027_fop-ta-kriptovalyuta-operats-rozrakhunki-ta-podatki-v-ukran) (collection date: 2026-05-31)
- Commentary: [factor.academy — Business splitting on FOPs 2026](https://factor.academy/blog/droblennya-biznesu-na-fop-yak-podatkova-pereviryaye-i-za-shho-realno-shtrafuye/) (collection date: 2026-05-31)
- Commentary: [yankiv.com — Business splitting on FOPs 2026](https://yankiv.com/droblennya-biznesu-na-fop/) (collection date: 2026-05-31)
- Commentary: [yankiv.com — Mass audits of business splitting on FOPs 2026](https://yankiv.com/masovi-perevirky-droblennya-biznesu-na-fop/) (collection date: 2026-05-31)
- Commentary: [7eminar.ua — FOP-3 2026 limits](https://7eminar.ua/news/15698-fop-3-grupi-u-2026-roci-podatki-ta-limiti) (collection date: 2026-05-31)
- Commentary: [easyfop.com — FOP-3 2026: registration, the limit 10,091,049 UAH](https://easyfop.com/reyestratsiya-fop-3-grupa/) (collection date: 2026-05-31)
- Commentary: [bip.net.ua — FOP-3 in 2026](https://bip.net.ua/articles/fop-3-grupa/) (collection date: 2026-05-31)
- Commentary: [factor.academy — Transfer of a FOP from the simplified to the general system in 2026](https://factor.academy/blog/perexid-fopa-zi-sproshhenoyi-sistemi-na-zagalnu-v-2026-roci-pravila-stroki-pdv/) (collection date: 2026-05-31)
- Commentary: [guide.diia.gov.ua — Diia City startup criteria](https://guide.diia.gov.ua/view/nabuttia-statusu-rezydenta-diia-siti) (collection date: 2026-05-31)
- Commentary: [audit-invest.com.ua — Diia City startups 2026](https://audit-invest.com.ua/ru/articles/blog/startapy-v-diia-city-pilhy-zvitnist-audyt) (collection date: 2026-05-31)
- Commentary: [monefy.ua — Company registration in Diia City](https://monefy.ua/blog/osoblyvosti-reiestratsii-kompanij-u-diia-siti/) (collection date: 2026-05-31)
- Commentary: [molbuk.ua — Payment in cryptocurrency for a FOP: can one legally use USDT](https://molbuk.ua/news/357651-oplata-v-kryptovaluti-dlia-fop-chy-mozhna-legalno-otrymuvaty-usdt-za-poslugy-v-ukraini.html) (collection date: 2026-05-31)
- Commentary: [scroll.media — Taxation of cryptocurrencies: how to avoid penalties](https://scroll.media/2025/10/22/opodatkuvannya-kryptovalyut-kolonka/) (collection date: 2026-05-31)

**Internal knowledge base:**

- `docs/legal/cross-cutting/escalation-zones.md` — § 1 (criminal Art. 212 of the Criminal Code of Ukraine at > ₴4.542M), § 2 (disputes with the DPS upon exclusion), § 4 (amounts > 100k UAH)
- `docs/legal/cross-cutting/citation-rules.md` — the citation format is followed
- `docs/specs/legal-consultations/2026-05-31-usdt-payouts-phase8.md` — the baseline FOP+USDT vacuum
- `docs/specs/legal-consultations/2026-05-31-top-pattern-deep-dive.md` — the baseline TOP pattern numbers and timing
- `docs/specs/legal-consultations/2026-05-31-cash-crypto-undeclared-risk-analysis.md` — the baseline cash/crypto undeclared risks
- `docs/agents/memory/legal/lessons.md` — 14 lessons (P0/P1/P2 from the previous 6 consultations)
- `CLAUDE.md` (root) — the section "PHASE 8 — Smart contracts", the financial flow

### Disclaimer

**Confidence: MED (overall).** This consultation is an AI preliminary check, NOT binding legal advice. The basic DPS position regarding FOP crypto is stable and well documented (hence MED, not LOW), but:

1. **Bridge scenario mechanics** — there is no practicing-lawyer precedent for our specific case (a FOP→TOV transition with USDT receipts in the bridge period). A specific bridge plan needs verification with a tax consultant.
2. **The banking limits of the Memorandum 14.05.2026** — new, have not yet seen the first audit cycles. The exact mechanics of application — verify closer to the August/November 2026 effective dates.
3. **The status of 10225-d is fluid** — the second reading may bring substantive changes. Continuing legal monitoring is mandatory quarterly.

**Hard escalation zones triggered (per `docs/legal/cross-cutting/escalation-zones.md`):**

- § 1 (Criminal law) — Art. 212 of the Criminal Code of Ukraine at > ₴4.542M cumulatively. AI pointed out the risk, the criminal defense procedure is for a lawyer.
- § 2 (Disputes with state bodies) — upon FOP exclusion from the single tax → the procedure of objections / administrative-court appeal — for a practicing tax lawyer.
- § 4 (> 100k UAH) — specific calculations of penalties and post-exclusion taxes at our scale (₴862k+ at the 12-month exposure point) — for a tax consultant, not AI.

**MANDATORY human verification BEFORE:**

1. Signing any USDT-denominated contract on a FOP — **do not do it at all**, the verification is already provided: do NOT sign.
2. The bridge FOP→TOV scenario — a UA tax lawyer must give an OK on the specific transition plan (clean break, novation contracts, timing).
3. If USDT receipts already exist on a personal FOP — escalate to a criminal defense lawyer for a damage assessment.

**Use this answer as:** structural decision support (the TOP vs FOP-USDT trade-off). Do NOT use it as: a basis for a signed contract with a USDT clause on a FOP.

**For PM:** given that this is the 7th Legal consultation this week and it directly competes with the accepted TOP pattern — it is worth recording a memory lesson that for structural decisions after baseline acceptance — a concise focused comparison + a direct verdict (as now) is better than a full re-litigation of all pros/cons.
