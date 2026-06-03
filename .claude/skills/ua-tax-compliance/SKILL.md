---
name: ua-tax-compliance
description: When Legal-agent отвечает на UA tax / company structure questions для CRM founder — ФОП режимы, ТОВ-Дія Сіті, CFC rules, hybrid offshore структуры, banking caps, обязательный аудит. UA-specific knowledge не покрытое ECC. Использовать в Mode A (consultation) перед любым company-structure advice + в Mode B (PR-review) когда PR трогает payment/tax-related fields в users/transactions.
---

# UA Tax Compliance (Legal knowledge primitive)

UA-specific tax / company structure знания. Лифтнуто из `.claude/agents/memory/legal/lessons.md` (2026-05-31 consultations). НЕ покрыто ECC — это jurisdictional knowledge.

**Disclaimer:** Этот skill — справочный материал для Legal-agent при формулировании консультаций. Каждая рекомендация на consultation выходе должна иметь stronger disclaimer + IT-corporate lawyer engagement для final sign-off (см. `legal-escalation-patterns` skill).

## When to invoke

- Перед Mode A consultation про company structure (ФОП vs ТОВ vs offshore)
- Перед Mode A consultation про tax optimization
- Перед Mode B PR-review когда PR трогает finance/transactions/wallets/payouts модули
- Когда user iterates по евазійним вариантам (отсылка на `legal-escalation-patterns`)
- Перед советами по banking setup

## Patterns

### 1. ПнВК 9% (резидент Дія Сіті) vs ЕН-5% — break-even анализ

**Правило:** ПнВК 9% (Податок на виведений капітал, Дія Сіті) выигрывает у ЕН-5% (Единий податок ФОП-3) даже на малых оборотах при IT-margins 25-35% — 5% від обороту > 9% від прибутку в типичных outsource структурах.

**Break-even ЕН vs ПнВК** = только при марже ≥40-50% (нереально для IT-outsource).

**Decision rule:**

- Outsource company с маржой 25-35% → ТОВ-Дія Сіті ПнВК выигрывает уже на mini-scale.
- Product company с маржой >50% → ФОП-3 может оставаться оптимальным (но banking cap 14.08.2026 blocker — см. §6).

### 2. Startup-резидент Дія Сіті (24-месячный bridge)

**Правило:** Startup-резидент Дія Сіті даёт 24 месяца льготного периода **без** требования 9 спецов / **без** €1200/міс зарплат — критичный bridge для tech-founder'ів запуска.

**Pitfall:** ТОВ старше 24 месяцев **НЕ может** подаватись як startup, только full-резидент сразу. Подавать ДО активної деятельності.

**Decision rule:** Новый ТОВ founder → startup-резидент Дія Сіті сразу при регистрации, не позже.

### 3. CFC (Controlled Foreign Company) — ст. 39² ПКУ

**Правило:** CFC fundamentals — game-changer для UA-resident'ів: offshore структура **НЕ означає** «не платити в Україну».

**UA ПДФО 18%+1.5% exemption з CFC profit** можлива тільки якщо:

- **(a)** є treaty Україна↔jurisdiction
- **І (b)** effective rate ≥13% АБО passive income ≤50%

**Для IT-outsource** active income test PASS, але потрібна documentation. Без exemption — controller платить 19.5% ПДФО на всю нерозподілену прибуток КІК навіть якщо distribution не відбувся.

**Decision rule:** Tax-avoidance через offshore = міф для UA-residents. Реальна цель offshore = client preferences / brand / FX hedging, **не** tax arbitrage.

### 4. Cyprus / UAE — FAIL на CFC effective rate test

**Правило:** Cyprus 12.5% corp tax FAILS UA CFC 13% effective rate test → controller завжди буде платити ПДФО на UA рівні навіть з Cyprus entity. UAE 0%/9% теж FAIL по ставці.

**Active income exemption** — єдиний шлях, потребує >50% IT services revenue + documentation. Не нести Cyprus як «надасть tax savings» — це не так для UA-resident UBO.

### 5. ФОП-3 banking caps (Меморандум НБУ 14.05.2026)

**Правило:** Меморандум НБУ + АБУ + 29 банков від 14.05.2026 — structural banking-caps для ФОП-3 **независимый от ПКУ-лімітів і crypto-regulation**:

| Дата       | Cap     |
| ---------- | ------- |
| 14.08.2026 | ₴3M/міс |
| 14.11.2026 | ₴1M/міс |

Це cap — банки просто не процессать. Для scale > ₴10M/рік ФОП vehicle ламається не тільки tax-side, але й banking-side.

### 6. ФОП-3 + USDT — structurally impossible

**Правило:** ФОП-3 + USDT в договорі для IT-outsource scale (₴20-30M/рік, команда) = **structurally impossible** через 3 independent blockers:

1. **ДПС-заборона крипто на ЄП** (бартер → exclusion + 15% штраф)
2. **Tax limit ₴10.09M на 2026** (1167 МЗП)
3. **Banking caps ₴3M/₴1M/міс per Меморандум 14.05.2026** (§5)

**Decision rule (bridge ФОП → ТОВ):** Bridge виноситься тільки при ВСІХ умовах: NULL USDT, < ₴3M/міс, no commingling з ТОВ, ≤ 6 міс hard cutoff. Якщо одна не виконується — bridge ламається.

**Recommended alternative:** ТОВ-Дія Сіті startup-резидент сразу на mini-scale (₴30-50k setup) замість bridge ФОП-USDT detour.

### 7. Обов'язковий аудит звіту Дія Сіті

**Правило:** Обов'язковий аудит звіту Дія Сіті — **hidden cost** часто пропускається в planning:

- Cost: ₴30-80k/рік
- Deadline: до 1 червня року+1
- Форма: [blank.dtkt.ua форма 743](https://blank.dtkt.ua/blank/743)
- Не подача = exclusion із Дія Сіті registry + retroactive перерахунок на загальну систему.

**Decision rule:** Включити в monthly accruals (₴3-7k/міс) із самого старту, не як edge cost.

### 8. ТОВ-Дія Сіті + WhiteBIT/Wise — effective tax / banking realities

**Effective consolidated tax burden ТОВ-Дія Сіті + WhiteBIT + Wise:**

- ~12-16% при 30% dividend / 70% reinvest
- ~8-10% при aggressive reinvest
- ~28-30% при 100% distribution (near-paritet з ТОВ-загальна)

**Architecture виграє** через 0%-on-reinvest mechanic, **не** через nominally низькі rates. Дія Сіті ефективна для **scaling companies**, не для cash-out.

**WhiteBIT Business KYB:** Official 5 робочих днів, **realistic 3-5 тижнів** (RFI rounds + institutional onboarding).

**Wise Business для UA legal entity:** Success rate variable (30-40% rejection). **Strategy:**

- Phase A: personal Wise founder
- Phase B: Wise Business після 3-6 міс ТОВ operations history

**Не all-eggs на Wise** — backup через direct UA bank USD subaccount обов'язково.

### 9. Transfer Pricing для hybrid Дія Сіті + offshore

**Правило:** TP обов'язковий для будь-якої hybrid UA Diia City + offshore структури. Дія Сіті **НЕ** звільняє від TP rules (підтверджено ДПС 2025). 75% revenue criterion з 1 січня 2025 робить нас prima facie related parties.

**Decision rule:** TP documentation з початку — бюджетувати ₴30-50k/year fees.

### 10. Banking 2025-2026 для UA citizens — bottleneck

**Правило:** Banking відкриття — критичний bottleneck. Verify banking **ПЕРЕД** реєстрацією company, не після.

**Realistic options (2025-2026):**

| Jurisdiction    | Bank                            | Реальність                         |
| --------------- | ------------------------------- | ---------------------------------- |
| Estonia LHV     | —                               | Вимагає face-to-face visit         |
| Cyprus Eurobank | —                               | 6-10 тижнів enhanced DD            |
| Hong Kong       | —                               | Практично закрите з 2020           |
| UAE             | Emirates NBD / Mashreq via IFZA | Реалистично відкривається          |
| Georgia         | TBC                             | Реалистично відкривається          |
| Delaware LLC    | Mercury / Wise                  | Реалистично відкривається          |
| —               | Revolut                         | Закрив весь UA ринок в грудні 2025 |

### 11. Substance requirements — жорсткіше з 2025

**Правило:** Substance requirements з 2025 жорсткіше скрізь (UAE MD 229/230, Cyprus IP Box DD, Estonia substance audits). Sham office / no employees = втрата всіх benefits + sham accusation risk.

**Decision rule:** Кожна юрисдикція з tax advantages вимагає real office, real employees, real decision-making locally. Дистанційна офшорка з UA в 2025-2026 — **не working** для більших юрисдикцій.

### 12. Recharacterization risk — гіг-контракти → трудові відносини

**Правило:** Главный legal risk перехода на ТОВ-Дія Сіті — **переквалификация гіг-контрактов в трудовые отношения**. Шаблон з інтернету = +18% ПДФО + штрафи за 3 года.

**Decision rule:** Specialized IT-юрист (₴15-30k разово) обов'язковий перед запуском Дія Сіті. Економити на legal review = потенциальна потеря ₴1.5M/рік.

## Anti-patterns

| ❌ Don't                                                 | ✅ Do                                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Радити Cyprus 12.5% / UAE 9% як «tax savings» для UA UBO | Поясняти CFC effective rate test → Cyprus/UAE FAIL без active income exemption     |
| Skip аудит Дія Сіті у monthly accruals plan              | Включити ₴3-7k/міс із day-1 (обов'язковий)                                         |
| Радити ФОП-3 + USDT для team scale > ₴10M/рік            | Hard refuse → ТОВ-Дія Сіті startup-резидент                                        |
| Радити bridge ФОП → ТОВ без 4 conditions check           | Verify NULL USDT + < ₴3M/міс + no commingling + ≤ 6 міс hard cutoff                |
| Радити offshore без TP documentation budget              | Включити ₴30-50k/рік TP fees + lawyer engagement                                   |
| Радити open-bank ПОСЛЕ company registration              | Verify banking ПЕРЕД registration (KYC bottleneck)                                 |
| Радити дистанційну офшорку (без substance)               | Substance requirements 2025 — real office + real employees + local decision-making |
| Брати шаблон з інтернету для Дія Сіті gig contracts      | IT-corporate lawyer (Juscutum / EQUITY / Avellum) review обов'язково               |

## References

- Source lessons (lifted 2026-06-03):
  - `.claude/agents/memory/legal/lessons.md` (2026-05-31 — 12+ substantive items #ua-fop #tax)
- Citations within patterns:
  - ст. 39² ПКУ (CFC rules)
  - Меморандум НБУ + АБУ 14.05.2026 (banking caps)
  - Форма 743 / blank.dtkt.ua (audit form)
  - UAE MD 229/230 (substance)
- Related agent docs:
  - `.claude/agents/legal.md` Mode A (consultation)
- Related skills:
  - `ua-crypto-compliance` (related crypto/AML restrictions)
  - `ua-it-contract` (gig contracts recharacterization)
  - `legal-escalation-patterns` (hard refuse for evasion variants)
