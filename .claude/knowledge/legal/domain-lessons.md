# Legal — Domain Knowledge (distilled)

Доменные выводы из консультаций (ФОП / налоги / Дія Сіті / CFC / banking / контракт-риски).
Вынесено из `.claude/agents/memory/legal/lessons.md` (2026-06-29) — это **справочник**, не process-уроки.
Полные консультации — `.claude/knowledge/legal-consultations/`.

---

## ФОП / Дія Сіті / налоги

2026-05-31 #ua-fop #tax ПнВК 9% (резидент Дія Сіті) выигрывает у ЕН-5% даже на малых оборотах при IT-margins 25-35% — 5% від обороту > 9% від прибутку в типичных outsource структурах. Break-even ЕН vs ПнВК = только при марже ≥40-50% (нереально для outsource).
2026-05-31 #ua-fop #tax Startup-резидент Дія Сіті даёт 24 месяца льготного периода без 9 спецов и €1200/міс — критичный bridge для tech-founder'ов запуска. Pitfall: ТОВ старше 24 месяцев НЕ может подаваться как startup, только full-резидент сразу. Подавать ДО активной деятельности.
2026-05-31 #it-contract Главный legal risk перехода на ТОВ-Дія Сіті — переквалификация гіг-контрактов в трудовые отношения. Шаблон из интернета = +18% ПДФО + штрафы за 3 года. Specialized IT-юрист (₴15-30k разово) обязателен — экономить здесь = потенциальная потеря ₴1.5M/рік.
2026-05-31 #ua-fop Multi-issuer схема (cash/crypto на entity ≠ основная компания) = pattern налогового уклонения, ст. 212 ККУ при пороге ₴4.99M (легко превышается). Hard refuse zone. Никогда не рекомендовать, при user assumption — явно отказывать + escalate к criminal defense lawyer.
2026-05-31 #ua-fop Cash channel в IT-outsource практически невозможен legally: NBU лимит ₴10k/день B2B (Постанова № 148) + запрет FX-cash с нерезидентами (Постанова НБУ № 5 від 24.02.2022). User хочет cash → категорически выписывать на проектном уровне, не оптимизировать.
2026-05-31 #ua-fop ФОП-3 + USDT в договорі для IT-outsource scale (₴20-30M/рік) = structurally impossible через 3 blockers: (1) ДПС-заборона крипто на ЄП (бартер → exclusion + 15% штраф), (2) tax limit ₴10.09M на 2026 (1167 МЗП), (3) banking caps ₴3M/₴1M/міс per Меморандум 14.05.2026. Bridge ФОП→ТОВ — тільки при ВСІХ: NULL USDT, < ₴3M/міс, no commingling, ≤ 6 міс. Кращий alternative — ТОВ-Дія Сіті startup-резидент одразу.
2026-05-31 #ua-fop Меморандум НБУ+АБУ+29 банків від 14.05.2026 — banking-caps для ФОП-3: ₴3M/міс з 14.08.2026 → ₴1M/міс з 14.11.2026. Cap **незалежний від ПКУ-лімітів і crypto-regulation** — банки просто не процессать. Для scale > ₴10M/рік ФОП ламається і tax-side, і banking-side.
2026-05-31 #ua-fop Обов'язковий аудит звіту Дія Сіті (₴30-80k/рік, до 1 червня року+1, [форма 743](https://blank.dtkt.ua/blank/743)) — hidden cost. Не подача = exclusion із registry + retroactive перерахунок. Включити в monthly accruals (₴3-7k/міс) із старту.
2026-05-31 #ua-fop Effective tax burden ТОВ-Дія Сіті + WhiteBIT + Wise ~12-16% при 30% dividend / 70% reinvest; ~8-10% при aggressive reinvest; ~28-30% при 100% distribution (near-paritet з ТОВ-загальна). Дія Сіті виграє через 0%-on-reinvest, не через nominal rates — для **scaling**, не cash-out.

## CFC / offshore / banking

2026-05-31 #ua-fop #tax CFC (ст. 39² ПКУ): offshore НЕ означає «не платити в Україну». Exemption з UA ПДФО 18%+1.5% тільки якщо (a) treaty Україна↔jurisdiction І (b) effective rate ≥13% АБО passive income ≤50%. IT-outsource active income test PASS, але потрібна documentation. Без exemption — controller платить 19.5% ПДФО на всю нерозподілену прибуток КІК. Tax-avoidance через offshore = міф.
2026-05-31 #ua-fop Cyprus 12.5% FAILS UA CFC 13% effective-rate test; UAE 0%/9% теж FAIL. Active income exemption — єдиний шлях (>50% IT services revenue + documentation). Не нести Cyprus як «tax savings» для UA-resident UBO.
2026-05-31 #personal-data Banking 2025-2026 для UA citizens — bottleneck: Estonia LHV face-to-face, Cyprus Eurobank 6-10 тижнів DD, HK закрите, Revolut закрив UA в грудні 2025. Реально: UAE Emirates NBD/Mashreq через IFZA, Georgia TBC, Delaware LLC через Mercury/Wise. Verify banking ПЕРЕД реєстрацією.
2026-05-31 #tax Substance requirements з 2025 жорсткіше (UAE MD 229/230, Cyprus IP Box DD, Estonia audits). Sham office/no employees = втрата benefits + sham accusation. Кожна tax-advantage юрисдикція вимагає real office/employees/decision-making locally.
2026-05-31 #tax Transfer Pricing обов'язковий для hybrid UA Diia City + offshore. Diia City НЕ звільняє від TP (ДПС 2025). 75% revenue criterion з 01.01.2025 робить prima facie related parties. TP documentation з початку — ₴30-50k/year.
2026-05-31 #ua-fop WhiteBIT Business KYB для UA ТОВ — official 5 днів, realistic 3-5 тижнів. Wise Business для UA — success rate variable (30-40% rejection); Phase A personal Wise founder → Phase B Wise Business після 3-6 міс; backup через UA bank USD subaccount.

## USDT / AML

2026-05-31 #usdt #aml Закон 2074-IX «Про віртуальні активи» прийнятий (17.02.2022) але НЕ введений — чекає ПКУ-змін (10225-д, перше читання 03.09.2025, plan 01.01.2026). Production crypto channel зараз = legal vacuum + ризик ДПС-корректировки. Crypto features = feature_flag false до активації 10225-д.
2026-05-31 #aml Финмоніторинг crypto threshold: 30k грн (~$720)/транзакцію триггерит screening per Закон 361-IX. Для IT-outsource виплат поріг превышается практично завжди → без KYC = AML ризик на кожній транзакції.

## Контракт-риски (SENIOR template)

2026-05-31 #it-contract #ua-fop Existing SENIOR контракт (74-84% commission) має 6 структурних ризиків (recharacterization як трудові, GDPR/2297-VI в audit-clauses, unconscionability 84%, missing non-circumvention enforceability, missing failed-placement, banking-cap 14.08.2026) → potential ₴10M+ exposure при 10 SENIORs. As-is — production-impossible без IT-corporate lawyer.
2026-05-31 #it-contract #personal-data Право запитувати ДПС про чужий income (п.2.1.6) + банк-виписки (п.3.2.6) = 3 blockers: ЗУ 2297-VI «спеціальна» consent (blanket invalid), ст.17 ПКУ disclosure limit, GDPR Art.6 lawful basis. Видалити, замінити на narrow audit (скрін платежу як фактуру). «Consent in contract» — UA practice знаходить unfree.
2026-05-31 #it-contract Prep-pack для IT-corporate lawyer reduces fees ~50% (₴80-130k savings). 15-item decisions checklist ДО meeting. UA lawyers: Juscutum (IT, ₴80-150k) > EQUITY (budget, ₴60-110k) > Avellum (premium) > Sayenko (overkill < ₴50M).
