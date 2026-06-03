---
name: ua-it-contract
description: When Legal-agent advises on UA IT-contract structure (SENIOR/JUNIOR/HR contracts, NDA, services agreements, audit rights, IP) или reviews PR-ы трогающие contracts/templates. UA-specific risk patterns — recharacterization трудовые отношения, GDPR/2297-VI consent rules, missing non-circumvention enforceability, IT-corporate lawyer engagement strategy. Использовать в Mode A consultation + Mode C brief check.
---

# UA IT-Contract (Legal knowledge primitive)

UA-specific IT-contract risk patterns. Лифтнуто из `.claude/agents/memory/legal/lessons.md` (#it-contract items, 2026-05-31 consultation `templates-analysis-pack`).

**Disclaimer:** Этот skill дает structural risk patterns. AI Legal-agent **НЕ генерує** ready-to-sign юридичні шаблони (recharacterization risk, missing clauses). Final text — **виключно IT-corporate lawyer**.

## When to invoke

- Перед Mode A consultation про contract structure
- Перед Mode C brief check на contract/template
- Перед Mode B PR-review на:
  - Changes в users (role assignments, signing flows)
  - Changes в contracts/\*\* (templates, signed records)
  - Changes в payment requisites flow
- При обсуждении SENIOR commission rates / post-termination clauses
- При обсуждении audit rights / банк-выписки запросов

## Patterns

### 1. SENIOR commission contract — 6 структурних ризиків

**Контекст:** Existing CRM SENIOR контракт з 74-84% commission має 6 структурних ризиків combine'ують до **potential ₴10M+ exposure** при scale 10 SENIORs.

**6 ризиків:**

1. **Recharacterization як трудові відносини** — структура з fixed commission + ongoing supervision може бути reclassified як employment. +18% ПДФО + штрафи за 3 года.
2. **GDPR / 2297-VI breach в audit-clauses** — право вимагати ДПС/банк дані по третіх осіб = "спеціальна" consent required.
3. **Unconscionability 84% post-termination** — UA judicial practice може знайти post-termination 84% забороной competition без compensation.
4. **Missing non-circumvention enforceability** — клауза "не работати з клієнтом 2 года" без damages formula = unenforceable.
5. **Missing failed-placement scenario** — що якщо JUNIOR placement не вдалось? Refund / partial commission / nothing? Не описано.
6. **Banking-cap blocker з 14.08.2026** — ФОП-3 каналу зламається на cap ₴3M/міс (Меморандум НБУ — див. `ua-tax-compliance` §5).

**Decision rule:** Шаблон as-is = **production-impossible** без IT-corporate lawyer review.

### 2. ДПС data requests + банк-виписки право — three blockers одночасно

**Правило:** Право запитувати ДПС про чужий income (п. 2.1.6 SENIOR draft) + право вимагати банк-виписки (п. 3.2.6) = **three blockers одночасно**:

1. **ЗУ 2297-VI** потребує «спеціальної» consent (blanket-clause invalid).
2. **ст. 17 ПКУ** обмежує disclosure tax info.
3. **GDPR Art.6** потребує lawful basis.

**Decision rule:** Видалити повністю, замінити на **narrow audit rights** (e.g., скрін платежу від ІТ-компанії як фактуру для commission calc).

**Не accept** «consent in contract» як sufficient — UA judicial practice знаходить такий consent unfree.

### 3. Recharacterization risk — gig vs employment

**Правило:** Risk recharacterization гіг-контрактов в трудові відносини = most serious risk при transitions ФОП-3 → ТОВ-Дія Сіті.

**Red flags structure:**

- Fixed working hours / location
- Mandatory equipment provision by company
- Direct supervision / approval chain
- No real entrepreneurial risk on contractor side
- Long-term exclusive engagement (>12 міс)

**Decision rule:** Шаблон з інтернету для Дія Сіті gig contracts = **+18% ПДФО + штрафи за 3 года**. Specialized IT-юрист (₴15-30k разово) обов'язковий перед запуском Дія Сіті.

### 4. IT-corporate lawyer engagement — prep-pack strategy

**Правило:** Prep-pack для IT-corporate lawyer engagement reduces fees **~50% (₴80-130k savings)** на full template bundle. Critical decisions User must make **ДО meeting** (15-item checklist) — без них lawyer заробляє hours на discovery замість draft work.

**UA IT-corporate lawyers ranking (для нашого профілю):**

| Lawyer       | Tier     | Bundle cost | Best for                       |
| ------------ | -------- | ----------- | ------------------------------ |
| **Juscutum** | IT-focus | ₴80-150k    | Recommended (best balance)     |
| **EQUITY**   | Budget   | ₴60-110k    | Smaller scope / tight budget   |
| **Avellum**  | Premium  | ₴120-220k   | Full-service if budget allows  |
| **Sayenko**  | Overkill | —           | Для < ₴50M business — overkill |

**Decision rule:** AI Legal acceptable deliverables:

1. **Analysis** existing drafts (gaps + risks + recommendations)
2. **Structured skeleton** + checklists для missing templates
3. **Lawyer-engagement prep pack** (decisions checklist + questions + deliverables expectations)

**Final text** — IT-corporate lawyer. Це economy ~50% lawyer fees + не replace lawyer signature.

### 5. Brand ownership verification — pre-contract due diligence

**Правило:** Brand «Cheeky Cheese» (UK trademark UK00003407857) **НЕ owned by Yaremenko** — owner = Jallen Gourmet Ltd (UK food company, classes 29 cheese products + 30 sauces). User incorrectly assumed ownership.

**CheekyCheeseIT brand в legal vacuum:**

1. No UA/UK/EU trademark під User-ім'я
2. Potential conflict при коммерческому використанні «Cheeky Cheese» on UK territory
3. No priority protection — будь-хто може зареєструвати first under class 35/42

**Action items для founder:**

- Trademark search Mintsipo / EUIPO / UK IPO / USPTO classes 35/42/45
- Defensive registration UA Mintsipo ~₴3-5k госмыта + ₴8-15k юрист
- Decision о rebrand vs defend

**PM-lesson (cross-cutting):** **Verify brand ownership ДО assumption в consultations** — спрашувати owner-name з WIPO record, не assume з link.

### 6. Mode B (PR-review) checklist — contracts triggers

**Trigger zones для contracts-related PRs:**

- `apps/web/app/routes/contracts/**` / `apps/api/src/contracts/**`
- `contracts/**` templates
- `users` schema changes (signing flow, payment requisites)
- `payouts` schema changes

**Mode B checklist (этот skill активируется):**

1. Зміна commission rate → recharacterization risk re-check
2. Зміна audit rights → GDPR/2297-VI re-check (consent + lawful basis)
3. Зміна payment requisites → banking caps + crypto rules (cross-ref `ua-tax-compliance` + `ua-crypto-compliance`)
4. Зміна non-circumvention → enforceability (damages formula + reasonable duration)
5. Зміна termination clause → post-termination compensation balance

## Anti-patterns

| ❌ Don't                                                         | ✅ Do                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| AI генерує ready-to-sign юридичні шаблони                        | Analysis + structured skeleton + lawyer-engagement prep pack only                           |
| Прийняти blanket-clause "consent in contract" як sufficient      | Narrow audit rights з specific scope — UA judicial practice rejects blanket consent         |
| Радити SENIOR commission > 75% post-termination без compensation | Unconscionability risk — додати damages formula + reasonable duration                       |
| Skip recharacterization check для gig contracts                  | Verify 5 red flags (fixed hours / equipment / supervision / no risk / exclusive)            |
| Engage IT-corporate lawyer без prep-pack                         | 15-item decisions checklist + structured questions = ~50% fee reduction                     |
| Assume brand ownership з WIPO link                               | Verify owner-name з WIPO record (UK trademark UK00003407857 = Jallen Gourmet, не Yaremenko) |
| Шаблон з інтернету для Дія Сіті gig contracts                    | Juscutum / EQUITY / Avellum review обов'язково                                              |

## References

- Source lessons (lifted 2026-06-03):
  - `.claude/agents/memory/legal/lessons.md` (2026-05-31 — 6+ substantive items #it-contract #personal-data)
- Citations within patterns:
  - ЗУ 2297-VI (personal data «спеціальна» consent)
  - ст. 17 ПКУ (tax info disclosure limits)
  - GDPR Art.6 (lawful basis)
  - UK trademark UK00003407857 / WIPO record
- Related skills:
  - `ua-tax-compliance` (recharacterization risk context + Дія Сіті startup)
  - `ua-crypto-compliance` (wallet field changes + payment requisites)
  - `legal-escalation-patterns` (lawyer engagement strategy + escalation patterns)
- Related agent docs:
  - `.claude/agents/legal.md` Mode A / Mode B / Mode C
