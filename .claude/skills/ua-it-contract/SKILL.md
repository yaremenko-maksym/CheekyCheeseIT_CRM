---
name: ua-it-contract
description: When the Legal agent advises on UA IT-contract structure (SENIOR/JUNIOR/HR contracts, NDA, services agreements, audit rights, IP) or reviews PRs touching contracts/templates. UA-specific risk patterns — recharacterization as an employment relationship, GDPR/2297-VI consent rules, missing non-circumvention enforceability, IT-corporate lawyer engagement strategy. Use in Mode A consultation + Mode C brief check.
when_to_use: "Use when Legal advises on a UA IT contract (SENIOR/JUNIOR/HR, NDA, services agreement, IP, audit rights) or reviews a PR touching contracts/templates. Examples: 'contract structure for a senior', 'NDA for a junior', 'risk of recharacterization as employment', 'non-circumvention clause', 'GDPR consent in the contract', 'PR touches contract_templates'."
allowed-tools:
  - Read
  - Grep
  - Glob
---

# UA IT-Contract (Legal knowledge primitive)

UA-specific IT-contract risk patterns. Lifted from `.claude/agents/memory/legal/lessons.md` (#it-contract items, 2026-05-31 consultation `templates-analysis-pack`).

**Disclaimer:** This skill gives structural risk patterns. The AI Legal agent **does NOT generate** ready-to-sign legal templates (recharacterization risk, missing clauses). Final text — **exclusively an IT-corporate lawyer**.

## When to invoke

- Before a Mode A consultation about contract structure
- Before a Mode C brief check on a contract/template
- Before a Mode B PR-review on:
  - Changes in users (role assignments, signing flows)
  - Changes in contracts/\*\* (templates, signed records)
  - Changes in the payment requisites flow
- When discussing SENIOR commission rates / post-termination clauses
- When discussing audit rights / bank statement requests

## Patterns

### 1. SENIOR commission contract — 6 structural risks

**Context:** The existing CRM SENIOR contract with 74-84% commission has 6 structural risks that combine into **potential ₴10M+ exposure** at a scale of 10 SENIORs.

**6 risks:**

1. **Recharacterization as an employment relationship** — a structure with fixed commission + ongoing supervision may be reclassified as employment. +18% personal income tax + penalties for 3 years.
2. **GDPR / 2297-VI breach in audit clauses** — the right to demand State Tax Service/bank data on third parties = "special" consent required.
3. **Unconscionability of 84% post-termination** — UA judicial practice may find a post-termination 84% a prohibition of competition without compensation.
4. **Missing non-circumvention enforceability** — a clause "not to work with the client for 2 years" without a damages formula = unenforceable.
5. **Missing failed-placement scenario** — what if the JUNIOR placement failed? Refund / partial commission / nothing? Not described.
6. **Banking-cap blocker from 14.08.2026** — the FOP-3 channel breaks at the cap of ₴3M/month (NBU Memorandum — see `ua-tax-compliance` §5).

**Decision rule:** The template as-is = **production-impossible** without an IT-corporate lawyer review.

### 2. State Tax Service data requests + the right to bank statements — three blockers at once

**Rule:** The right to query the State Tax Service about another's income (clause 2.1.6 of the SENIOR draft) + the right to demand bank statements (clause 3.2.6) = **three blockers at once**:

1. **Law 2297-VI** requires "special" consent (a blanket clause is invalid).
2. **Art. 17 of the Tax Code of Ukraine** limits the disclosure of tax info.
3. **GDPR Art.6** requires a lawful basis.

**Decision rule:** Remove entirely, replace with **narrow audit rights** (e.g., a payment screenshot from the IT company as an invoice for the commission calc).

**Do NOT accept** "consent in the contract" as sufficient — UA judicial practice finds such consent unfree.

### 3. Recharacterization risk — gig vs employment

**Rule:** The risk of recharacterizing gig contracts into an employment relationship = the most serious risk in transitions FOP-3 → TOV-Diia City.

**Red flags structure:**

- Fixed working hours / location
- Mandatory equipment provision by company
- Direct supervision / approval chain
- No real entrepreneurial risk on the contractor side
- Long-term exclusive engagement (>12 months)

**Decision rule:** An internet template for Diia City gig contracts = **+18% personal income tax + penalties for 3 years**. A specialized IT lawyer (₴15-30k one-time) is mandatory before launching Diia City.

### 4. IT-corporate lawyer engagement — prep-pack strategy

**Rule:** A prep-pack for an IT-corporate lawyer engagement reduces fees **~50% (₴80-130k savings)** on a full template bundle. Critical decisions the User must make **BEFORE the meeting** (15-item checklist) — without them the lawyer earns hours on discovery instead of draft work.

**UA IT-corporate lawyers ranking (for our profile):**

| Lawyer       | Tier     | Bundle cost | Best for                         |
| ------------ | -------- | ----------- | -------------------------------- |
| **Juscutum** | IT-focus | ₴80-150k    | Recommended (best balance)       |
| **EQUITY**   | Budget   | ₴60-110k    | Smaller scope / tight budget     |
| **Avellum**  | Premium  | ₴120-220k   | Full-service if budget allows    |
| **Sayenko**  | Overkill | —           | For a < ₴50M business — overkill |

**Decision rule:** AI Legal acceptable deliverables:

1. **Analysis** of existing drafts (gaps + risks + recommendations)
2. **Structured skeleton** + checklists for missing templates
3. **Lawyer-engagement prep pack** (decisions checklist + questions + deliverables expectations)

**Final text** — an IT-corporate lawyer. This is an economy of ~50% lawyer fees + does not replace the lawyer's signature.

### 5. Brand ownership verification — pre-contract due diligence

**Rule:** The brand "Cheeky Cheese" (UK trademark UK00003407857) is **NOT owned by Yaremenko** — the owner = Jallen Gourmet Ltd (UK food company, classes 29 cheese products + 30 sauces). The User incorrectly assumed ownership.

**The CheekyCheeseIT brand in a legal vacuum:**

1. No UA/UK/EU trademark under the User's name
2. Potential conflict in commercial use of "Cheeky Cheese" on UK territory
3. No priority protection — anyone can register first under class 35/42

**Action items for the founder:**

- Trademark search Mintsipo / EUIPO / UK IPO / USPTO classes 35/42/45
- Defensive registration UA Mintsipo ~₴3-5k state duty + ₴8-15k lawyer
- Decision on rebrand vs defend

**Lesson (cross-cutting):** **Verify brand ownership BEFORE assumption in consultations** — ask the owner-name from the WIPO record, do not assume from a link.

### 6. Mode B (PR-review) checklist — contracts triggers

**Trigger zones for contracts-related PRs:**

- `apps/web/app/routes/contracts/**` / `apps/api/src/contracts/**`
- `contracts/**` templates
- `users` schema changes (signing flow, payment requisites)
- `payouts` schema changes

**Mode B checklist (this skill activates):**

1. Commission rate change → recharacterization risk re-check
2. Audit rights change → GDPR/2297-VI re-check (consent + lawful basis)
3. Payment requisites change → banking caps + crypto rules (cross-ref `ua-tax-compliance` + `ua-crypto-compliance`)
4. Non-circumvention change → enforceability (damages formula + reasonable duration)
5. Termination clause change → post-termination compensation balance

## Anti-patterns

| ❌ Don't                                                               | ✅ Do                                                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| AI generates ready-to-sign legal templates                             | Analysis + structured skeleton + lawyer-engagement prep pack only                                       |
| Accept the blanket clause "consent in the contract" as sufficient      | Narrow audit rights with specific scope — UA judicial practice rejects blanket consent                  |
| Advise a SENIOR commission > 75% post-termination without compensation | Unconscionability risk — add a damages formula + reasonable duration                                    |
| Skip the recharacterization check for gig contracts                    | Verify 5 red flags (fixed hours / equipment / supervision / no risk / exclusive)                        |
| Engage an IT-corporate lawyer without a prep-pack                      | A 15-item decisions checklist + structured questions = ~50% fee reduction                               |
| Assume brand ownership from a WIPO link                                | Verify the owner-name from the WIPO record (UK trademark UK00003407857 = Jallen Gourmet, not Yaremenko) |
| An internet template for Diia City gig contracts                       | Juscutum / EQUITY / Avellum review mandatory                                                            |

## References

- Source lessons (lifted 2026-06-03):
  - `.claude/agents/memory/legal/lessons.md` (2026-05-31 — 6+ substantive items #it-contract #personal-data)
- Citations within patterns:
  - Law 2297-VI (personal data "special" consent)
  - Art. 17 of the Tax Code of Ukraine (tax info disclosure limits)
  - GDPR Art.6 (lawful basis)
  - UK trademark UK00003407857 / WIPO record
- Related skills:
  - `ua-tax-compliance` (recharacterization risk context + Diia City startup)
  - `ua-crypto-compliance` (wallet field changes + payment requisites)
  - `legal-escalation-patterns` (lawyer engagement strategy + escalation patterns)
- Related agent docs:
  - `.claude/agents/legal.md` Mode A / Mode B / Mode C
