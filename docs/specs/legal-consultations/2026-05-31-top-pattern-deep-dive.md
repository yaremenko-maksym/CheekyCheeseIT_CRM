# Legal Consultation: TOP Pattern Deep Dive — UA Дія Сіті ТОВ + WhiteBIT Business + Wise Multi-currency

## Mode: strategic

## Дата: 2026-05-31

## Запросил: User direct → PM

## Контекст

User получил 5 предыдущих strategic консультаций. После полного risk analysis off-the-books схемы User pivoted на legitimate path и попросил **полное объяснение TOP-рекомендации** (Pattern #1):

- **UA Дія Сіті ТОВ** — основная entity, ПнВК 9%
- **WhiteBIT Business** — crypto bridge (USDT → UAH → ТОВ счёт)
- **Wise Multi-currency** — FX bridge (USD/EUR → UAH/USD subaccount)

User хочет понять **как именно эти 3 инструмента работают вместе end-to-end**, и **что конкретно делать**.

## Главный вопрос

**Полная схема работы Pattern #1 от A до Z:**

1. Как клиент платит каждым из 3 каналов (USDT / USD / UAH)
2. Как деньги попадают на счёт ТОВ (с цифрами комиссий и сроков)
3. Как ТОВ распределяет деньги дальше (на гіг-контракторов, на partner, на ADMIN)
4. Что декларируется и какие налоги платятся на каждом шаге
5. Полная стоимость setup'а и ongoing операций (с разбивкой по инструментам)
6. Как настроить каждый инструмент (роадмап + требования)
7. Какие практические risk'и есть у этой комбинации (technical, regulatory, operational)

## Sub-questions

### Q1 — End-to-end flow scenarios (3 типичных)

**Scenario A — US/EU клиент платит в USDT (10,000 USDT за месяц):**

1. Куда клиент шлёт USDT (какой адрес — личный кошелёк ТОВ-сотрудника? кошелёк WhiteBIT Business?)
2. Что происходит на WhiteBIT (commission %, settlement time, KYC/KYB обязанности)
3. Как USDT попадает на UAH-счёт ТОВ (curency rate, какой НБУ курс используется для bookkeeping)
4. Какой документ выставляется клиенту (invoice от ТОВ с какими реквизитами)
5. Какие налоги срабатывают на этом этапе

**Scenario B — US/EU клиент платит USD wire (10,000 USD):**

1. Куда клиент шлёт wire (Wise account ТОВ? UA bank USD subaccount?)
2. Wise commission, settlement time
3. Конвертация USD → UAH (Wise rate vs banks)
4. Когда возникает доход ТОВ (на дату invoice или дату получения?)
5. Валютный контроль для нерезидентов (паспорт сделки если > €400k/quarter)

**Scenario C — UA клиент платит UAH (300k грн):**

1. Прямой банк wire на ТОВ счёт
2. Invoice + ПДВ обов'язки если ТОВ — VAT payer (Дія Сіті — освобождает?)
3. Сроки получения

### Q2 — WhiteBIT Business detail

- **Status 2026:** MiCA license (EU), US entry дата, VASP status в UA
- **KYB requirements** для UA ТОВ — what documents, timing, success rate
- **Pricing structure** — deposit fee USDT, conversion USDT→UAH spread, withdrawal fee на bank, monthly minimums
- **Bank settlement** — какие UA банки поддерживают (ПриватБанк / monobank Business / Райффайзен?), сроки 1-3 дня
- **Tax reporting** — что WhiteBIT отдаёт ДПС автоматически, что ТОВ должен подавать самостоятельно
- **Limits** — daily/monthly limits на ТОВ-account
- **Risks** — что произойдёт если WhiteBIT теряет лицензию / выходит из UA / freezes account

### Q3 — Wise Business detail

- **Acceptance criteria 2026** — Wise приняла UA citizens businesses? Какие states (Wise закрыл RU полностью; UA после декабря 2025 — статус?)
- **Multi-currency subaccounts** — какие валюты доступны для ТОВ (USD/EUR/GBP/PLN)
- **Pricing** — wire receive, conversion spread, withdrawal на UA bank
- **Integration с UA banking** — какие UA banks принимают Wise inbound
- **Limits** — для ТОВ
- **Tax reporting** — UA tax обязанности при received via Wise
- **Risks** — Wise UA policy changes, account freeze scenarios

### Q4 — ТОВ Дія Сіті — distribution flow

Деньги пришли на ТОВ счёт (через WhiteBIT / Wise / direct). Распределение:

1. **На гіг-контракторов (SENIOR/JUNIOR работают по гіг-договорам):**
   - Wire on UAH account ФОП-исполнителя? или на personal card физлица-гіг?
   - 5% ПДФО + 5% ВЗ удерживается у источника (ТОВ как податковий агент)?
   - ЄСВ 22% від мінзарплати = ₴1902/міс — кто платит (ТОВ или сам гіг-фахівець)?
   - Конкретный wire instruction + accounting entries

2. **На partner (co-founder):**
   - Какой правовой статус — ФОП subcontractor? other shareholder ТОВ? dividend recipient?
   - Если ТОВ-shareholder с долей — ПнВК 9% срабатывает при distribution
   - Если ФОП-contractor — 5% ЕН + 1.5% ВЗ у partner-ФОПа
   - Best practice для нашей структуры

3. **На ADMIN (founder, тоже UBO):**
   - Same options как с partner
   - Зарплата vs ПнВК-дивідент vs ФОП-distribution
   - Tax-optimal split

### Q5 — Effective tax burden consolidated

На условном примере: 5M грн годового оборота через mix (60% Wire USD, 30% USDT, 10% UAH). Net прибуток после операционных расходов: 2M грн.

Полный налоговый calculation:

- На стороне ТОВ: ПнВК 9% (когда distribution)
- На стороне гіг-контракторов: 5% + 1.5% + ЄСВ
- На стороне ADMIN+partner: ПнВК 9% + дивідентний дохід?

**Total effective tax %** от оборота и от прибыли.

Сравни с UA average для IT outsource (ФОП 3-я group + ТОВ-вычет схема).

### Q6 — Setup roadmap (ДО запуска)

Конкретный пошаговый план запуска всех 3 инструментов:

**Phase 0 (Pre-work, week -1):**

- Что приготовить: документы, decisions, partner agreement template

**Phase 1 (week 1-2): ТОВ registration**

- usr.minjust.gov.ua workflow
- КЕП setup
- Founders' Agreement
- Стоимость

**Phase 2 (week 2-3): Банковский счёт UA**

- ПриватБанк Business / monobank Business / Райффайзен — что выбрать
- KYB documents
- Timing

**Phase 3 (week 3-4): Wise Business application**

- Application process
- Documents
- Success criteria

**Phase 4 (week 4-5): WhiteBIT Business KYB**

- Application
- Документы
- Sandbox / pilot transaction

**Phase 5 (week 5-6): Дія Сіті startup-резидент application**

- city.diia.gov.ua workflow
- Eligibility check
- Documents

**Phase 6 (week 6-8): Гіг-контракти + Services Agreement template'и**

- IT corporate lawyer engagement
- Templates готовы
- First contract signed

**Phase 7 (week 8+): Operations начало**

- First client wire test
- Bookkeeping cycle
- Quarterly reporting first iteration

### Q7 — Operational details

- **Monthly bookkeeping flow** — что бухгалтер делает каждый месяц
- **Quarterly reporting** — что подаётся в ДПС (декларація з ПнВК, ЄСВ, ПДФО за гіг-фахівців)
- **Annual reporting** — фінансова звітність ТОВ, річна декларація Дія Сіті
- **FX rate fixing** — какой курс для bookkeeping (НБУ на дату операції)
- **Currency control** — паспорт сделки для FX > €400k/quarter
- **Audit** — обязательный для Дія Сіті резидентов?

### Q8 — Risks of this combined setup

| Risk type   | Risk                                    | Probability | Mitigation |
| ----------- | --------------------------------------- | ----------- | ---------- |
| Regulatory  | MiCA changes для WhiteBIT EU operations | MED         | ...        |
| Regulatory  | Wise UA policy reversal                 | MED         | ...        |
| Regulatory  | Дія Сіті threshold/rule changes         | LOW         | ...        |
| Operational | WhiteBIT/Wise account freeze            | MED         | ...        |
| Tax         | Transfer pricing scrutiny если scale up | MED         | ...        |
| Banking     | UA bank refuses crypto-related deposits | MED         | ...        |

Plus mitigation plans для каждого.

## Что важно для решения

- **Concrete numbers** — комиссии, сроки, стоимости
- **Step-by-step** roadmap который user может dropну в Google Tasks
- **Acknowledge unknowns** — где точные ставки/процедуры могут меняться, явно сказать
- **Practical pitfalls** — то что обычно ломает setup
- **Verification points** — где обязательно нужен accountant / lawyer перед action

## Что НЕ обсуждать (уже covered предыдущими консультациями)

- Базовая Дія Сіті теория и tax math (уже в roadmap consultation)
- CFC implications (уже в offshore consultation)
- Why off-books не работает (уже в risk analysis)
- Crypto в general (уже в USDT consultation)

---

<!-- Legal-агент добавит секцию `## Ответ юриста` ниже -->

## Ответ юриста

**Confidence (overall):** MED

**Per-section breakdown:**

- End-to-end flows (Q1, Scenarios A/B/C) — **MED** (механіка зрозуміла, конкретні комісії дрейфують ±20-30% від місяця до місяця, **обов'язкова verification на момент action**)
- WhiteBIT Business detail (Q2) — **MED** ([MiCA license підтверджений 29 квітня 2026 через HANFA](https://blog.whitebit.com/en/w-group-advances-european-expansion-as-white-tech-obtains-mica-authorization/), KYB у 5 робочих днів — офіційний термін, але pricing для UA ТОВ — individual negotiation per [WhiteBIT institutional](https://docs.whitebit.com/institutional/compliance))
- Wise Business detail (Q3) — **LOW** (Wise officially supports UA-owned companies per [Wise blog 2026 для UA](https://buh.ua/en/how-to-open-wise-and-withdraw-funds-in-ukraine), але **success rate для UA ТОВ rezident Ukraine — варіативний**, banking policy динамічна, recommend test application з мінімальним setup ризиком)
- ТОВ Дія Сіті distribution mechanics (Q4) — **MED** (legislation чітко покрите [Законом 1667-IX](https://zakon.rada.gov.ua/laws/show/1667-20), [ст. 170.14 ПКУ](https://zakon.rada.gov.ua/laws/show/2755-17), tax-optimal split залежить від річного profile)
- Effective tax burden (Q5) — **MED** (математика однозначна, але припущення про distribution policy впливають на ±2-3%)
- Setup roadmap (Q6) — **MED** (фазы і документи чіткі; timing залежить від навантаження органів, банків, WhiteBIT compliance team)
- Operational obligations (Q7) — **MED** (бухгалтерські процедури стандартні, але **аудит звіту Дія Сіті обов'язковий** ([blank.dtkt.ua форма 743](https://blank.dtkt.ua/blank/743) + [Kreston Ukraine](https://kreston.ua/zvitnist-rezydentiv-diia-siti-vidnovleno-shcho-peredbachaie-zaznachena-protsedura/)) — це нюанс який часто пропускають)
- Risks (Q8) — **MED** (ranking ризиків objective; ймовірності — professional estimates)

**Mode:** strategic
**Дата:** 2026-05-31

### TL;DR

**Pattern #1 — ТОВ-Дія Сіті + WhiteBIT Business + Wise Business — є робочою архітектурою з effective consolidated tax burden ~12-16% при reasonable distribution policy і ~5-8% при reinvest mode.** Setup займає **8-12 тижнів** (паралелізовано), **бюджет setup ₴80-180k**, **ongoing ₴35-65k/місяць** (бухгалтерія + audit accruals + Дія Сіті compliance + Wise/WhiteBIT fees). На прикладі обороту 5M грн → 2M грн чистої прибутку — реальна consolidated tax burden **≈ ₴280-360k = 14-18% від прибутку** (vs ₴524k = 26% на загальній 18%+5%+5% системі).

**Найбільший hidden cost** не податки, а compliance: **обов'язковий аудит звіту Дія Сіті** (₴30-80k/рік per [Kreston/BP-audit](https://bp-audit.com.ua/service/audyt-zvitu-pro-vidpovidnist-rezydenta-diia-siti)) + **9 спеціалістів × €1200 floor після 31 грудня року+1** (це ваш hard constraint після startup-period).

**Найбільший regulatory risk** — переквалифікація гіг-контрактів в трудові ([cases.media gig-vyrok analysis](https://cases.media/en/article/diya-siti-podatki-ta-riziki-koli-gig-kontrakt-staye-trudovim-virokom)) — це **обов'язково** потребує specialized IT-lawyer (₴15-30k разово per minimum), не template з інтернету.

**Що робити в понеділок:** (1) КЕП через [ca.diia.gov.ua](https://ca.diia.gov.ua/) — 30 хвилин, безкоштовно; (2) запит cost-estimate в 2-3 IT-corporate lawyers (Sayenko Kharenko / Asters / Avellum / Juscutum) на договір про надання послуг ТОВ + гіг-контракт template + Дія Сіті application supervision — це foundation, без якої решта валиться; (3) подати на KYB у WhiteBIT Business паралельно з реєстрацією ТОВ — це довгий тред (5 робочих днів official, але реально 2-4 тижні на UA ТОВ).

### Анализ

#### 1. End-to-end picture — три канали

```
                           КЛІЄНТИ
        ┌──────────────┬──────────────┬──────────────┐
        │              │              │              │
        ▼              ▼              ▼              │
   USDT (US/EU)    USD/EUR wire    UAH (UA)         │
   client wallet   (SWIFT)         (банк UA)        │
        │              │              │              │
        ▼              ▼              ▼              │
┌──────────────┐ ┌──────────────┐                   │
│  WhiteBIT    │ │  Wise        │                   │
│  Business    │ │  Business    │                   │
│  KYB UA ТОВ  │ │  USD/EUR     │                   │
│  ┌────────┐  │ │  subaccount  │                   │
│  │USDT→UAH│  │ └──────┬───────┘                   │
│  │ P2P    │  │        │                            │
│  │ Express│  │        │ wire payout                │
│  └────────┘  │        │ на UA bank ТОВ             │
└──────┬───────┘        │ (USD/EUR/UAH)              │
       │ Card Transfer  │                            │
       │ на банк ТОВ    │                            │
       │ (UAH)          │                            │
       ▼                ▼                            ▼
┌────────────────────────────────────────────────────────┐
│   ТОВ-резидент Дія Сіті (UAH + USD/EUR subaccount)      │
│   • UAH рахунок ПриватБанк/monobank/Sense Business      │
│   • USD/EUR subaccount (для FX flexibility)             │
│   • EDRPOU + IBAN + SWIFT                                │
│   ─────────────────────────────────────────────────     │
│   Революція: ПнВК 9% спрацьовує ТІЛЬКИ на distribution. │
│   Поки гроші всередині ТОВ — 0% податку на прибуток.    │
└────────────────────────────────────────────────────────┘
                          │
       ┌──────────────────┼──────────────────┐
       │                  │                  │
       ▼                  ▼                  ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Гіг-команда  │  │ ADMIN/partner│  │ Reinvest     │
│ (SENIOR/JUN/ │  │ розподіл     │  │ (0% tax)     │
│  HR)         │  │              │  │              │
│              │  │ Варіанти:    │  │ - O&M cash   │
│ 5% ПДФО      │  │ • Гіг-винаг. │  │ - Capex      │
│ +5% ВЗ       │  │   (5%+5%+ЄСВ)│  │ - Резерви    │
│ +ЄСВ ₴1902/  │  │ • Дивіденди  │  │              │
│   міс        │  │   (9% ПнВК + │  │              │
│              │  │    5%+5%)    │  │              │
│ effective    │  │ • Hybrid     │  │              │
│ ~10-12%      │  │              │  │              │
└──────────────┘  └──────────────┘  └──────────────┘
```

**Ключова teзa:** Pattern має **3 окремі independent channels** (USDT / USD-wire / UAH), які **всі** сходяться в один точковий entity (ТОВ-Дія Сіті). **WhiteBIT і Wise — це інструменти**, ТОВ — entity. Не плутати.

**Що цей pattern НЕ робить:**

- Не дає 0% effective burden — реальна consolidated burden ~12-16%, але це **прозоро legally і безпечно довгостроково**
- Не покриває cash-flow off-the-books — після [попередньої консультації про risk analysis](2026-05-31-cash-crypto-undeclared-risk-analysis.md) це закрите питання
- Не позбавляє від обов'язку аудиту, гіг-документації, currency control compliance

#### 2. Scenario A — US/EU клієнт платить 10,000 USDT (ERC-20) за місяць

**Day 0 (контрактний рівень):**

ТОВ виставляє клієнту invoice на $10,000 USD за services rendered в межах MSA + Statement of Work за конкретний місяць. Invoice містить:

- ТОВ name + EDRPOU + юр.адресу + IBAN UAH (як primary)
- **Альтернативний платіжний реквізит:** USDT-адреса WhiteBIT Business account ТОВ (ERC-20)
- VAT не виділяється (Дія Сіті резидент — VAT-non-payer за загальним правилом, або payer за окремим вибором)
- Sum: $10,000 USD = X UAH за курсом НБУ на дату invoice (для bookkeeping primary record — UAH)

**Day 0-1 (transfer):**

Клієнт переказує **10,000 USDT (ERC-20)** на USDT-адресу ТОВ на WhiteBIT Business.

- **Gas fee на стороні клієнта:** ~$2-15 USD (Ethereum gas, volatile)
- **Confirmation Ethereum:** 1-3 хвилини (12 block confirmations)
- **Зарахування на WhiteBIT balance:** instant після confirmation. **Deposit fee USDT:** WhiteBIT не стягує fee за crypto deposit на Business account (per [WhiteBIT help — Trading, deposit and withdrawal fees](https://help.whitebit.com/hc/en-gb/articles/25029308319005-Trading-deposit-and-withdrawal-fees), дата сбора 2026-05-31). Для institutional/Business можуть бути окремо погоджені terms — verify в KYB negotiation.

**Day 1 (USDT → UAH conversion via P2P Express або spot):**

Two options:

| Метод                               | Commission                                                                                                                                                                                                            | Speed                     | Volume cap                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------- |
| **P2P Express USDT→UAH**            | No separate commission, але spread ~1-3% від ринкового курсу залежно від liquidity ([WhiteBIT help — P2P Express](https://help.whitebit.com/hc/en-gb/articles/19401002086045-Deposit-and-withdrawal-via-P2P-Express)) | Хвилини-години (matching) | Залежить від KYB рівня       |
| **Spot exchange USDT/UAH** на біржі | Trading fee 0.1% maker/taker                                                                                                                                                                                          | Instant                   | Залежить від orderbook depth |

**Realistic estimate для 10k USDT:** ~₴418,000 - ₴425,000 на дату операції (НБУ курс на 2026-05-31 ≈ ₴42.0/USD, мінус 1-2% spread). Точна сума підтверджується через **виписку на WhiteBIT** яка стає primary document для bookkeeping.

**Day 1-2 (виведення UAH на банк ТОВ):**

WhiteBIT → банківський рахунок ТОВ через **Card Transfer** або **Bank Transfer**:

- **Card Transfer (на корпоративну карту ТОВ, прив'язану до основного рахунку):** commission зазвичай 1-4% від суми за UAH withdrawal (за історичною акцією — 3% замість 4%, per [WhiteBIT help — Card Transfer Withdrawal](https://help.whitebit.com/hc/en-gb/articles/20716216959005-Withdrawal-of-funds-using-Card-Transfer-on-WhiteBIT))
- **Speed:** 1-2 години до зарахування на банк
- **NB:** для UA ТОВ withdrawal на бізнес-рахунок зазвичай потребує окремої settlement procedure — clarify в KYB conversation з WhiteBIT institutional team

**Real-world numbers для 10k USDT (sample):**

| Step                               | Sum                 | Loss (%)                |
| ---------------------------------- | ------------------- | ----------------------- |
| 10,000 USDT отримано на WhiteBIT   | $10,000 = ~₴420,000 | 0%                      |
| USDT→UAH conversion (~1.5% spread) | ~₴413,700           | -1.5%                   |
| Card Transfer withdrawal (~3% fee) | ~₴401,300           | -3% від ₴413k = -₴12.4k |
| **На UAH банк ТОВ**                | **~₴401,000**       | **-4.5% total**         |

**Альтернатива: direct USDT receive на банк через WhiteBIT institutional fiat gateway** — для KYB Business можлива direct UAH settlement з narrowing від 1-2% за окремою угодою. Verify в institutional negotiation.

**Day 2-3 (bookkeeping moment):**

- **Дата визнання доходу ТОВ:** дата отримання UAH на банківський рахунок ТОВ (cash basis для Дія Сіті ПнВК; альтернативно accrual з invoice date — обговорюється з бухгалтером, **рекомендую accrual** для cleaner books)
- **Курс bookkeeping:** **НБУ курс на дату операції** ([ПКУ ст. 153.1.3](https://zakon.rada.gov.ua/laws/show/2755-17)) — це primary anchor. WhiteBIT statement використовується як supporting document
- **Реєстрація в бух.обліку:**
  - Dt 311 (UAH рахунок) — ₴401,000
  - Kt 703 (Дохід від реалізації послуг) — ₴420,000 (за НБУ курсом на дату invoice)
  - Dt 949 (Інші витрати операційної діяльності) — ₴19,000 (комісії WhiteBIT як operational expense)

**Day 2-3 (документи для архіву):**

1. Invoice ТОВ (підписаний КЕП директора) — primary
2. SoW / Acceptance Act (підписаний обома сторонами)
3. WhiteBIT statement за період (показує deposit + conversion + withdrawal)
4. Bank statement UAH рахунку ТОВ (підтверджує зарахування ₴401k)
5. Blockchain transaction hash (Etherscan link — не обов'язково для bookkeeping, але корисно для AML inquiry якщо буде)

**Day 30+ (декларація і податки):**

- **Дохід ТОВ (₴420,000) → реєструється в журналі господарських операцій + квартальна декларація ПнВК**
- **ПнВК спрацьовує ТІЛЬКИ на виплати dividend/спорадичних операцій, не на чистий дохід.** Якщо ці гроші: (a) йдуть на гіг-винагороду команді — ПнВК = 0% на цю частину, бо це operating expense, (b) йдуть на reinvest/O&M — ПнВК = 0%, (c) виплачуються as dividend власнику — **ПнВК 9% від суми dividend**
- **VAT:** Дія Сіті резидент може бути non-VAT payer (загальна форма) або обрати VAT registration. Для типового outsource — non-VAT (під поріг ₴1M обороту з [ст. 181 ПКУ](https://zakon.rada.gov.ua/laws/show/2755-17), або через Дія Сіті exception — verify з consultant)

**Total taxes triggered на этом этапе:** **₴0 одразу** (тільки облік income). Податки виникають далі при distribution.

#### 3. Scenario B — US/EU клієнт платить 10,000 USD wire (SWIFT)

**Day 0 (контрактний рівень):**

ТОВ виставляє invoice — same як в Scenario A, але primary payment method = USD wire на Wise Business USD subaccount **або** на USD subaccount ТОВ в українському банку.

**Two real sub-scenarios:**

##### B1 — Wise Business посередник

**Day 0-2 (wire receive):**

Клієнт надсилає $10,000 USD на Wise Business USD subaccount ТОВ:

- **Wise local USD details:** надаються при відкритті — ACH (US-domestic) або SWIFT (international)
- **ACH speed:** 1-3 business days (free для receiving per Wise local details policy)
- **SWIFT speed:** 1-5 business days; receive fee депонує банк-відправник, Wise зазвичай не стягує за SWIFT receive
- **Wise hidden FX spread (для USD → UAH):** 0.43-0.6% згідно з [Wise Business — international payments](https://wise.com/gb/business/), дата сбора 2026-05-31

**NB про UA acceptance:** [Wise має guide для UA freelancers/sole proprietors](https://buh.ua/en/how-to-open-wise-and-withdraw-funds-in-ukraine) (дата сбора 2026-05-31). Wise acceptance для **UA ТОВ legal entity** менш чітка — більшість UA users відкривають **personal Wise** або **ФОП Wise** (легше); **Wise Business для UA-registered legal entity** проходить individual review, **success rate variable**. **Strongly recommend**: спочатку open personal/sole-proprietor Wise (як founder) для пробного flow, потім приймайте application для Wise Business на ТОВ після того як ТОВ має operational history. **Verify в момент action.**

**Day 2-4 (Wise → UA bank ТОВ):**

Withdrawal Wise → UAH-рахунок ТОВ через SWIFT:

- **Wise outbound fee USD→UAH:** ~0.43-0.6% (значно нижче банків)
- **Real conversion rate:** mid-market (Reuters/Google rate), що означає 2-3% economy vs стандартний UA bank conversion
- **Settlement to UA bank:** 1-2 business days

**Real-world numbers для 10k USD через Wise:**

| Step                    | Sum                 | Loss            |
| ----------------------- | ------------------- | --------------- |
| Client wire $10,000 USD | $10,000 = ~₴420,000 | 0%              |
| Wise FX spread 0.5%     | ~₴418,000           | -0.5% (~₴2,000) |
| Wise outbound fee       | -$4-10              | ~₴200-400       |
| UA bank receive (free)  | —                   | 0               |
| **На UAH банк ТОВ**     | **~₴417,600**       | **-0.6% total** |

##### B2 — Direct USD subaccount UA bank (без Wise)

**Day 0-3 (direct wire):**

Клієнт надсилає $10,000 USD на USD-subaccount ТОВ в українському банку (ПриватБанк / monobank / Sense Business):

- **monobank Business USD subaccount:** open online за 10-15 хв за [monobank business — currency account](https://monobank.ua/en/business/currency-account), дата сбора 2026-05-31. **Incoming SWIFT — free** (per [monobank rates](https://monobank.ua/taryfy)). **Outgoing SWIFT:** 0.5% + $12 (cap $90).
- **ПриватБанк Business:** через [Приват24 для бізнесу — ЗЕД](https://privatbank.ua/business/zed). KYB process включає upload контракту та реєстрацію валютного контракту. **NB:** з січня 2026 SWIFT залишається єдиним каналом outbound currency transfer за межі України.

**Day 3-5 (валютний контроль — реєстрація контракту):**

[Закон про валюту 2473-VIII + Постанова НБУ № 5 від 02.01.2019 + поточні post-war restrictions](https://zakon.rada.gov.ua/laws/show/2473-19) встановлюють:

- При **отриманні валютної виручки** з-за кордону за послуги — потрібно зареєструвати **зовнішньоекономічний контракт** в системі банку (одноразово на контракт)
- **Граничні строки розрахунків:** для експорту послуг — **180 днів** з дати інвойсу до отримання виручки (war-time restriction)
- **Обов'язковий продаж валюти:** **СКАСОВАНО** [НБУ Постанова 2021-2024](https://bank.gov.ua/en/news/all/obovyazkoviy-prodaj-valyutnih-nadhodjen-biznesom-skasovano), дата сбора 2026-05-31. У 2026 році **обов'язковий продаж не діє** — ТОВ може залишити USD на subaccount як FX reserve.
- **Currency control threshold для покупки валюти:** ТОВ дозволяється купити валюту тільки якщо доступна сума UAH < ₴400,000 еквівалент (NBU restriction). Для нашого pattern це менш релевантно, бо ми **отримуємо** валюту, а не купуємо.

**Day 5+ (FX conversion на дату необхідності):**

ТОВ конвертує USD → UAH на **Торговій платформі ПриватБанк / monobank МВРУ** на дату коли треба робити UAH-виплати. Spread проти interbank ~0.5-1.5%.

**Real-world numbers для 10k USD direct через UA bank:**

| Step                                | Sum                                        | Loss          |
| ----------------------------------- | ------------------------------------------ | ------------- |
| Client wire $10,000 USD             | $10,000 = ~₴420,000                        | 0%            |
| Sender bank correspondent fee       | -$15-50 (deducted by sender)               | $0 для ТОВ    |
| UA bank receive                     | $10,000 (free incoming SWIFT для monobank) | 0%            |
| USD subaccount hold (no conversion) | $10,000                                    | —             |
| Conversion коли треба (~1% spread)  | ~₴415,800                                  | -1%           |
| **На UAH рахунок ТОВ**              | **~₴415,800**                              | **-1% total** |

**Verdict B1 vs B2:**

- **B1 (Wise):** кращий FX rate (~0.6% total loss), AЛЕ **acceptance for UA ТОВ uncertain**
- **B2 (Direct UA bank):** трохи дорожче (~1%), AЛЕ **guaranteed**, native UA banking, simpler bookkeeping
- **Hybrid:** Wise для US/EU клієнтів (FX optimization), UA bank для UA клієнтів (instant settlement)

**Bookkeeping:**

- Same як Scenario A — дохід реєструється за НБУ курсом на дату invoice/acceptance, виписка банку = primary supporting document
- USD-subaccount у балансі ТОВ — окремий sub-account 312 (валютний рахунок)

**Currency control passport (паспорт зовнішньоекономічної операції):**

- Поточні правила (war-time): окремий passport sdelky **скасований** після [НБУ постанови 18 / 24.02.2022](https://zakon.rada.gov.ua/laws/show/v0018500-22) і подальших liberalizations
- Замість passport — **реєстрація контракту в банку** + **щомісячна звітність ЗЕД** в банк (стандартизована форма)
- **Для оборотів > €400k/quarter** банк може запросити додаткову documentation (proof of services performed, end-client identification) під AML — це **не gateway block**, а compliance check

#### 4. Scenario C — UA клієнт платить 300,000 грн (direct wire)

**Day 0 (контрактний рівень):**

ТОВ підписує договір з UA-клієнтом (комерційне товариство). Invoice виставляється з повними реквізитами ТОВ + UAH IBAN.

**Day 0-1 (wire receive):**

Клієнт переказує **₴300,000** з свого банку на UAH-рахунок ТОВ:

- **Speed:** мінути-години через систему миттєвих міжбанківських розрахунків ([СЕП НБУ + СПОТ](https://bank.gov.ua/)). Internal transfer (в межах одного банку) — інстант.
- **Fee для ТОВ-отримувача:** $0 (incoming UAH wire — безкоштовно)
- **Fee для відправника:** залежить від банку відправника (зазвичай 0.1-0.5% або flat 50-200 грн)

**Day 1 (bookkeeping):**

Same як Scenario A/B — реєструється дохід у момент отримання UAH на рахунок або в момент акту виконаних робіт.

**ПДВ (VAT) питання:**

| Сценарій                    | ПДВ                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Оборот ТОВ < ₴1M/12 місяців | НЕ obligatory ПДВ-payer. Не виставляє ПК, не приймає ПК.                                                                      |
| Оборот ≥ ₴1M/12 місяців     | Обов'язкова реєстрація ПДВ-payer (опціонально раніше) ([ст. 181 ПКУ](https://zakon.rada.gov.ua/laws/show/2755-17))            |
| Дія Сіті резидент           | **ПДВ-режим не змінюється**. Дія Сіті регулює тільки ПнВК і гіг-оподаткування. Якщо ТОВ-Дія Сіті оборот ≥ ₴1M → ПДВ-payer 20% |

**Critical:** Якщо ТОВ-Дія Сіті оборот вище ₴1M (highly likely в outsource), ТОВ — ПДВ-payer 20% на UA-domestic operations. **Експорт послуг за межі України = 0% ПДВ** ([ст. 195.1.3 ПКУ](https://zakon.rada.gov.ua/laws/show/2755-17)), тобто:

- Wire від US/EU клієнта = 0% ПДВ
- Wire від UA клієнта = 20% ПДВ → з invoice ₴300k потрібно виділити **₴50,000 як ПДВ зобов'язання** (₴300k включає ПДВ; net revenue ₴250k, ПДВ ₴50k до сплати)
- **Tax credit input ПДВ:** ТОВ зменшує ПДВ-обов'язки на input ПДВ від UA-постачальників (оренда офісу, comm services тощо)

**Реальна реалізація для UA-клієнта на 300k:**

| Step                                    | Sum                         | Tax effect    |
| --------------------------------------- | --------------------------- | ------------- |
| Клієнт wire ₴300,000 (включаючи ПДВ)    | ₴300,000                    | —             |
| ПДВ-зобов'язання ТОВ (20%)              | -₴50,000                    | До сплати ДПС |
| **Net revenue ТОВ**                     | **₴250,000**                | —             |
| Якщо тих самий період input ПДВ ₴10,000 | ПДВ нетто до сплати ₴40,000 | —             |

**Verdict Scenario C:** UA-клієнт через ПДВ-зобов'язання — найдорожчий канал з perspective ТОВ-economics, але **operationally найпростіший** (instant settlement, native banking).

#### 5. WhiteBIT Business — detailed deep-dive

##### 5.1 Регуляторний статус (2026)

- **MiCA license (EU):** White Tech (частина W Group, majority-owned WhiteBIT CEO V. Nosov) отримав MiCA CASP-license через [HANFA (Croatian FSSA), 29 квітня 2026](https://blog.whitebit.com/en/w-group-advances-european-expansion-as-white-tech-obtains-mica-authorization/), дата сбора 2026-05-31
- **Coverage:** EU/EEA market через single MiCA passport — exchange crypto↔fiat, crypto↔crypto, transfer services, custody
- **UA status:** WhiteBIT все ще headquartered ефективно operates з Lithuania + 15-country office network (UA included). UA VASP-license специфічна — **очікує імплементації Закону 2074-IX** (status описано в [USDT payouts консультації](2026-05-31-usdt-payouts-phase8.md))
- **US entry:** [WhiteBIT увійшов на US ринок 1 грудня 2025](https://scroll.media/en/2025/12/01/whitebit-enters-us-market/) (per попередня консультація risk analysis) — це не впливає на UA-business path, але показує regulatory maturity exchange
- **Reputation flag:** [випадок з KIT Group AML investigation (ANTIKOR articles 2024-2025)](https://antikor.info/en/articles/826030-kriptobirha_whitebit_figuriruet_v_sheme_otmyvanija_millionov_ot_onlajn-narkomarketov_cherez_setj_tenevyh_obmennikov_kit_group_pojavilisj_ekskljuzivnye_dokumenty), дата сбора 2026-05-31 — ANTIKOR публікація про схему через KIT Group. WhiteBIT denied involvement. **Practical implication:** WhiteBIT як institution має moderate AML risk profile в media; в KYB вас можуть запитувати додаткові documents через elevated DD requirements. **Це НЕ disqualifier**, але вимагає clean documentation.

##### 5.2 KYB requirements для UA ТОВ

Згідно з [WhiteBIT What is KYB](https://help.whitebit.com/hc/en-gb/articles/17350938784285-What-is-KYB) і [How to Open Corporate Account](https://blog.whitebit.com/en/how-to-open-a-corporate-account-on-whitebit/), дата сбора 2026-05-31:

**Documents required (typical для UA ТОВ):**

1. **Реєстраційні документи ТОВ:** виписка з ЄДР (англійською + перекладом якщо потрібно), Statut/Charter, Founders' Agreement
2. **Beneficial Ownership disclosure:** identification всіх UBO (>25% ownership) — passport + proof of address для кожного
3. **Director / signatory:** KYC verification кожного directors/представників (passport, selfie, proof of address)
4. **Source of funds declaration:** опис походження стартового капіталу + ongoing revenue source
5. **Business model description:** description of services ТОВ надає, типи клієнтів, обороти expected, geographic coverage
6. **Bank statement / proof of operations:** виписка з банку ТОВ за 3-6 місяців (якщо new ТОВ — financial projections + Founders' equity proof)
7. **Website / online presence:** corporate website з відображенням team, services, contact info
8. **Compliance docs:** AML/KYC policy ТОВ (template OK для small companies, full policy для larger entities)

**KYB timing (official vs realistic):**

| Phase                                           | Official timeline          | Realistic для UA ТОВ          |
| ----------------------------------------------- | -------------------------- | ----------------------------- |
| Submit application                              | Day 0                      | Day 0                         |
| Initial review + RFI (request for information)  | 1-5 робочих днів           | 5-10 робочих днів             |
| Additional documentation rounds                 | n/a                        | 1-3 round'и × 3-7 днів each   |
| Final approval                                  | до 5 робочих днів official | **2-4 тижні total** realistic |
| Onboarding (limits setup, API keys, settlement) | 1-2 дні                    | 3-7 днів                      |

**Total expected timeline для UA ТОВ:** **3-5 тижнів** від submit до first transaction capability. Не плануй на 1 тиждень.

**Approval probability:** HIGH для clean UA ТОВ з legitimate IT-business model. KYB rejections trapical для shell companies, missing UBO disclosure, або high-risk industries (gambling, adult content, sanctioned jurisdictions).

##### 5.3 Pricing structure (institutional)

- **Spot trading fees:** 0.1% maker/taker default, 0.02% для futures ([CryptoSlate WhiteBIT review](https://cryptoslate.com/crypto-exchanges/whitebit-exchange-review/), дата сбора 2026-05-31)
- **Crypto deposit:** generally free для major networks (USDT ERC-20, USDT TRC-20, BTC, ETH)
- **Crypto withdrawal:** varies by network (USDT ERC-20: $3-15 depending on gas, USDT TRC-20: $1 flat)
- **UAH deposit/withdrawal:**
  - **Card Transfer:** ~3-4% fee depending on promotion period (verify at action time)
  - **Bank Transfer (для Business KYB):** individually negotiated rates per [WhiteBIT institutional](https://docs.whitebit.com/institutional/compliance) — typically 0.5-1.5%
- **P2P Express USDT↔UAH:** no separate commission, spread 1-2% від ринкового
- **Institutional Business:** EUR 5 fixed fees для deposits/withdrawals, custom limits per KYB level
- **Monthly minimum:** не фіксовано для Business per public info; для institutional negotiation typical

**Real-world budget для нашого pattern:**

- 30k USDT/month volume через WhiteBIT → conversion + withdrawal fees ~₴30,000-50,000/month operational cost
- Annual ~₴360-600k operational fees якщо crypto = 30% revenue mix

##### 5.4 Bank settlement partners

З 2024-2025 WhiteBIT має working settlement через:

- **Card Transfer:** на UAH-карти Visa/Mastercard будь-якого UA банку (зокрема ПриватБанк, monobank, Sense Bank, Райффайзен Bank Aval)
- **Bank Transfer (для Business):** SWIFT/SEPA через banking partners, settlement на корпоративний рахунок ТОВ
- **NB:** для **direct UAH credit на corporate IBAN ТОВ** WhiteBIT використовує settlement через **Лiцензовані фінансові установи (Reseller / Payment Institution agreements)**. Specific provider tied до agreement в KYB onboarding. Verify в onboarding doc-pack.

##### 5.5 Limits для Business accounts

- **Default daily limit після KYB:** $10,000-50,000 equivalent
- **Standard Business tier:** $100,000-500,000/day після додаткової DD
- **Institutional tier:** $1M+/day per individual negotiation
- **Annual volume:** no formal cap, але > $10M/year тригерує enhanced DD review

Для нашого scale (₴5M/year ≈ $120k/year) — стандартний Business KYB достатній.

##### 5.6 Tax reporting (що WhiteBIT відає ДПС)

**Currently (2026-05-31):** WhiteBIT operationally базується в Lithuania (W Group); **automatic reporting в ДПС України НЕ діє** (UA crypto regulation не введена в дію — Закон 2074-IX чекає 10225-д активації).

**Що означає для вас practically:**

- WhiteBIT **не передає** автоматично транзакційні дані в ДПС
- AЛЕ після CRS exchange (з 2024) UA tax-resident ТОВ з accounts в EU-licensed VASP (а MiCA-licensed Wave Tech — це EU VASP) **підпадає під CRS reporting** через jurisdiction де VASP licensed
- **MiCA license HANFA (Croatia)** → у 2026-2027 buduutь CRS-link між Croatia tax authority і ДПС → транзакційні data **доступні** для ДПС за запитом, а в 2027+ — автоматично

**Practical:** ваші транзакції на WhiteBIT як ТОВ-Business — **traceable і будуть в полі зору ДПС**. Це **підтверджує** що pattern має бути **повністю declared** в обліку ТОВ.

##### 5.7 Risks WhiteBIT

| Risk                                                      | Severity | Probability                        | Mitigation                                                                                  |
| --------------------------------------------------------- | -------- | ---------------------------------- | ------------------------------------------------------------------------------------------- |
| WhiteBIT втрачає MiCA license через regulatory action     | High     | Low (5-10%)                        | Backup KYB на іншу MiCA-licensed exchange (Binance EU, Bitstamp EU, Bitvavo) для redundancy |
| Account freeze через AML risk score (raised KYC question) | High     | Medium (15-25%)                    | Clean documentation, conservative volumes; не perform unusual patterns                      |
| KYB rejection при відсутності clear business model        | Med      | Low-Med (15%)                      | Clear MSA + sample invoices в KYB pack                                                      |
| Settlement затримка (banking partner issues)              | Med      | Medium (20%)                       | Backup withdrawal channel (Card Transfer + Wise)                                            |
| Fee changes (особливо на UAH withdrawal)                  | Low-Med  | High (60%) — fees change quarterly | Monitor fee page monthly, adjust pricing in client contracts                                |
| Reputation drag (KIT Group case) → bank partner issues    | Med      | Low-Med (15%)                      | Якщо UA bank partner відмовляється — alternative settlement                                 |

#### 6. Wise Business — detailed deep-dive

##### 6.1 Acceptance for UA-registered entities

**Reality check** (per public info on 2026-05-31):

- Wise officially **підтримує UA citizens** для personal accounts (refugee-friendly policy)
- Wise **Business для UA ТОВ** — **case-by-case approval**, **not guaranteed**
- [Buh.ua guide для UA freelancers / sole proprietors](https://buh.ua/en/how-to-open-wise-and-withdraw-funds-in-ukraine), дата сбора 2026-05-31, описує процес для ФОП/freelancers, **не для full UA ТОВ legal entity**
- Wise has [Wise for displaced Ukrainians](https://wise.com/gb/blog/wise-for-displaced-ukrainians) policy — це personal, не business

**Strategic recommendation:**

1. **Phase A (швидкий start):** Open **personal Wise account** для founder як індивідуала (works для UA citizens, fast onboarding, full multi-currency access). Use як FX bridge для small/medium volumes initially.
2. **Phase B (після ТОВ operations 3-6 місяців):** Submit **Wise Business application** для UA ТОВ. До цього часу ТОВ має operational history, banking history, sample invoices — це значно покращує success rate.
3. **Phase C (alternative):** Якщо Wise Business rejected — **Revolut Business closed UA market in December 2025** (per попередня offshore консультація). Альтернативи: **Payoneer Business** (UA freelancer-friendly), **TransferGo Business** (UA bridge), **direct UA bank multi-currency** (B2 above).

##### 6.2 Multi-currency capabilities

Wise Business Multi-currency Account provides ([Wise — international business payments](https://wise.com/ua/send-money/international-business-payments), дата сбора 2026-05-31):

- **Local account details:** USD (US ACH), EUR (SEPA + IBAN), GBP, AUD, SGD, CAD, NZD, RON, HUF, TRY, ...
- **Receive payments як local:** клієнт із US робить ACH-transfer на US-local Wise USD account — для нього як internal US wire (free, instant), для вас — credit на USD subaccount
- **FX between subaccounts:** mid-market rate + 0.43-0.6% spread for major pairs (USD/EUR/GBP)

##### 6.3 Pricing для Business

- **Receive payment (incoming):** **Free** для most local-currency receives (USD ACH, EUR SEPA, GBP Faster Payments)
- **SWIFT incoming:** sometimes $4-7 для cross-border SWIFT (depends on sender's bank)
- **FX conversion:** mid-market rate + transparent 0.43-0.6% fee
- **Outbound (Wise → external bank):**
  - To UA bank UAH: ~$5-15 USD-equivalent + 0.5-1% FX
  - To EU bank EUR: ~€0.50 SEPA fee
- **Card (Wise Business Card):** physical/virtual debit card linked до multi-currency balance; 1.75% fee на ATM withdrawal > monthly limit
- **Account opening:** **Free** для personal, **One-time setup fee $50-100 USD** для Business (verify on application)

##### 6.4 Integration with UA banking

- **Wise → ПриватБанк / monobank / Sense Bank ТОВ UAH account:** працює через standard SWIFT
- **Timing:** 1-2 business days
- **NB:** Receiving USD/EUR з Wise на USD/EUR subaccount UA bank — теж SWIFT, тобто **повністю compliant з war-time currency controls** (registered contract, ZED reporting)

##### 6.5 Limits

- **Personal Wise (UA citizen):** до £50,000/year cumulative typically, з progressively higher tiers after KYC enhancement
- **Wise Business:** £200,000+/transaction для verified Business accounts; annual limits negotiable

##### 6.6 Risks Wise

| Risk                                                        | Severity | Probability       | Mitigation                                                                  |
| ----------------------------------------------------------- | -------- | ----------------- | --------------------------------------------------------------------------- |
| Wise Business application rejected для UA ТОВ               | High     | Med-High (30-40%) | Plan B з personal Wise + direct UA bank USD subaccount                      |
| Wise UA citizens policy reversal (як Revolut в грудні 2025) | Critical | Low-Med (15%)     | Diversify через UA bank + WhiteBIT (не all-eggs Wise)                       |
| Account freeze через AML                                    | High     | Low-Med (10-15%)  | Clean transaction patterns; не використовувати для personal-business mixing |
| FX rate spread changes                                      | Low      | Med (40%)         | Monitor monthly, switch to direct UA bank if spread > 1%                    |

#### 7. ТОВ Дія Сіті — distribution mechanics

Гроші пришли на UAH-рахунок ТОВ. Як їх розподілити **tax-optimally** між трьома receiver groups?

##### 7.1 Distribution на гіг-контракторів (команда SENIOR/JUNIOR/HR)

**Legal framework:** [Закон 1667-IX «Про стимулювання розвитку цифрової економіки»](https://zakon.rada.gov.ua/laws/show/1667-20) + [ст. 170.14¹ ПКУ — оподаткування гіг-винагороди](https://zakon.rada.gov.ua/laws/show/2755-17).

**Tax structure для гіг-винагороди в Дія Сіті ТОВ:**

| Компонент                | Ставка                                                                                                                                         | Хто платить                                    | База                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------- |
| **ПДФО**                 | **5%** ([ст. 170.14¹ ПКУ](https://zakon.rada.gov.ua/laws/show/2755-17))                                                                        | ТОВ як податковий агент (утримує з виплати)    | Вся гіг-винагорода                        |
| **ВЗ (військовий збір)** | **5%** ([ст. 161 ПКУ — підвищено з 1.5% до 5% з 01.01.2024](https://zakon.rada.gov.ua/laws/show/2755-17))                                      | ТОВ як податковий агент                        | Вся гіг-винагорода                        |
| **ЄСВ**                  | **22% від мінзарплати** = **₴1 902,34/міс** ([ДПС dn.tax.gov.ua](https://dn.tax.gov.ua/media-ark/news-ark/962430.html), дата сбора 2026-05-31) | **ТОВ** (за свій рахунок, не з гіг-винагороди) | Мінзарплата ₴8 647 (а не реальна виплата) |

**Cap на 5% ПДФО:** річна виплата гіг-спеціалісту не може перевищувати **€240,000 еквівалент** на рік (за курсом НБУ на 1 січня року). Перевищення → 18% ПДФО на excess.

**Real flow для гіг-спеціаліста з ₴100,000/міс гіг-винагородою:**

| Шаг                                          | Сума         | Примітка                         |
| -------------------------------------------- | ------------ | -------------------------------- |
| Брутто гіг-винагорода                        | ₴100,000     | Записано в гіг-контракті         |
| ПДФО 5% (утримано ТОВ)                       | -₴5,000      | До ДПС від імені spec            |
| ВЗ 5% (утримано ТОВ)                         | -₴5,000      | До ДПС від імені spec            |
| **Чиста виплата на карту spec**              | **₴90,000**  |                                  |
| **ЄСВ 22% від мінзарплати (за рахунок ТОВ)** | **+₴1,902**  | До ПФУ, окрема стаття витрат ТОВ |
| **Total cost ТОВ**                           | **₴101,902** | (₴100,000 брутто + ₴1,902 ЄСВ)   |
| **Effective tax burden на гіг-винагороду**   | **~11.7%**   | (₴5k + ₴5k + ₴1.9k) / ₴100k      |

**Wire instruction:**

- ТОВ виплачує на UAH-картку гіг-спеціаліста (особисту, як фізособи)
- ПДФО + ВЗ → ДПС через стандартні платіжки (паралельно з виплатою, до 30 числа наступного місяця)
- ЄСВ → ПФУ окремо до 20 числа наступного місяця ([ст. 9 Закону про ЄСВ 2464-VI](https://zakon.rada.gov.ua/laws/show/2464-17))

**Документація для compliance:**

- Гіг-контракт (підписаний КЕП обох сторін) — template **обов'язково** через IT-corporate lawyer
- Звіт про обсяг наданих послуг (щомісячний / квартальний)
- Акт виконаних робіт (опціональний для гіг, але recommended)
- **Не плутати з трудовим договором** — гіг-контракт **не повинен** містити характерних ознак трудових відносин (фіксований робочий час, місце роботи, підпорядкованість трудовому розпорядку, оплачувана відпустка в звичайному форматі). Цей **критичний risk recharacterization** обговорюватимемо в Risks секції.

**ЄСВ floor — важлива нюанс для startup-резидента:**

Per [Audit-invest.com.ua — стартапи Дія Сіті критерії](https://audit-invest.com.ua/ru/articles/blog/startapy-v-diia-city-pilhy-zvitnist-audyt) і [7eminar — стартап без 20k євро](https://7eminar.ua/news/19105-startap-u-diya-siti-ci-mozna-podavatisya-na-kriticnist-bez), дата сбора 2026-05-31:

- **Startup-резидент** has **виняток** на вимогу 9 спеціалістів + €1200 average — це **дозволено** не виконувати протягом startup-period (до 31 грудня року+1)
- AЛЕ **ЄСВ minimum 1902 грн/міс** все одно нараховується на кожного гіг-фахівця незалежно від startup status — це **обов'язкова мінімальна база**
- **Average remuneration не нижче €1200/міс** має досягатись пропорційно — тобто є **дві окремі вимоги**: (a) кількість спеціалістів і (b) рівень compensation

##### 7.2 Distribution на partner (co-founder)

User згадав про co-founder partner. Tax-optimal patterns:

##### Option A: Partner — гіг-спеціаліст ТОВ (recommended for small role / specialist contributor)

**Structure:** Partner — full-time гіг-contractor ТОВ. Виплачується через гіг-винагороду same як команда.

**Tax burden:** ~11.7% (ПДФО 5% + ВЗ 5% + ЄСВ ₴1902/міс).

**Pros:** simplest, lowest immediate tax burden, monthly cash flow клейна.
**Cons:** partner не отримує equity/dividend mechanics — він **employee-like**, не co-owner у tax sense.

##### Option B: Partner — co-shareholder ТОВ з дивідендами (recommended for true ownership partner)

**Structure:** Partner володіє X% ТОВ (e.g., 30%). Виплати йому = dividends, **спрацьовує ПнВК 9%** + **5% ПДФО + 5% ВЗ** на дивіденди.

**Tax burden на дивіденди (на прикладі ₴1M дивіденда):**

| Шаг                                                                                                                                                                                                                                                                  | Розрахунок                        | Сума                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------- |
| ТОВ виплачує дивіденд                                                                                                                                                                                                                                                | —                                 | ₴1,000,000 (грос ТОВ) |
| **ПнВК 9% ТОВ** ([ст. 134 ПКУ Дія Сіті clause](https://zakon.rada.gov.ua/laws/show/2755-17))                                                                                                                                                                         | 1,000,000 × 9%                    | -₴90,000 (ТОВ→ДПС)    |
| Розподілений дивіденд (gross на фіза)                                                                                                                                                                                                                                | 1,000,000 - 90,000                | ₴910,000              |
| **ПДФО 5% на дивіденди** Дія Сіті ([ст. 170.5 ПКУ — preferential 5% для Дія Сіті payors](https://zakon.rada.gov.ua/laws/show/2755-17), commentary [factor.ua](https://i.factor.ua/ukr/journals/nibu/2026/march/issue-21/article-136682.html), дата сбора 2026-05-31) | 910,000 × 5%                      | -₴45,500              |
| **ВЗ 5%** ([ст. 161 ПКУ](https://zakon.rada.gov.ua/laws/show/2755-17))                                                                                                                                                                                               | 910,000 × 5%                      | -₴45,500              |
| **На руки partner**                                                                                                                                                                                                                                                  |                                   | **₴819,000**          |
| **Effective tax rate**                                                                                                                                                                                                                                               | (1,000,000 - 819,000) / 1,000,000 | **18.1%**             |

**Pros:** real ownership, defendable position у regulatory inspection, dividend timing flexibility.
**Cons:** higher tax burden than гіг (18.1% vs 11.7%), bookkeeping складніше.

##### Option C: Partner — separately registered ФОП-subcontractor (для true business partnership)

**Structure:** Partner має свій ФОП 3-я група (5% ЄП). ТОВ платить partner-ФОПу за послуги subcontracting через інвойс.

**Tax burden на стороні ФОП partner:**

- 5% ЄП на суму invoice
- 1% ВЗ ЄП (з 2024)
- ЄСВ partner-ФОП за свій рахунок: **₴1,902/міс мінімум**
- Effective ~6-7% на ФОП-стороні

**Cons:** **CRITICAL recharacterization risk** ([cases.media gig-vyrok](https://cases.media/en/article/diya-siti-podatki-ta-riziki-koli-gig-kontrakt-staye-trudovim-virokom), [yankiv.com дроблення FOP risks](https://yankiv.com/droblennya-biznesu-na-fop/), дата сбора 2026-05-31):

- Якщо partner-ФОП обслуговує ТОВ як **єдиного клієнта** (single-client revenue) + загальні IT-системи з ТОВ → **класична ознака дроблення бізнесу**
- BEB-практика 2024-2026 активна на таких patterns — [MarketOpt case](https://biz.liga.net/ua/all/fmcg/novosti/beb-merezha-mahazyniv-z-400-torhovymy-tochkamy-pratsiuvala-pid-vyhliadom-3500-fopiv-foto) із 3500 ФОП — приклад
- **Mitigation:** partner-ФОП має мати **real other clients** (хоча б 20-30% revenue від інших counterparties), окремі workspaces, separately tracked IP

**Verdict для partner:** **Option B (co-shareholder + dividends)** найбільш defensible long-term. Option C можливо тільки якщо partner має **реальну separately-existing business**.

##### 7.3 Distribution на ADMIN (founder, User)

User як founder ТОВ — same options. Optimal split typically:

**Recommended hybrid:**

- **Гіг-контракт ТОВ на User (founder-як-spec):** ₴80-150k/міс (depending на скільки він active producing role). Tax ~11.7%.
- **Дивіденди періодично (quarterly або annually):** для distribution accumulated profit beyond operational salary. Tax 18.1%.
- **Reinvest balance:** 0% tax поки не вийшло як дивіденд

**Tax-optimal rationale:**

- Гіг-винагорода (~11.7%) **значно дешевше** ніж дивіденди (18.1%) для базової operational compensation
- АЛЕ гіг **обмежено €240k/рік per spec** (5% ставка cap)
- Дивіденди потрібні щоб виводити "true profit" — те що не виходить через operational expenses
- Reinvest найкращий якщо є legitimate use case (capex, R&D, marketing) — 0% tax

##### 7.4 Tax-optimal split — конкретний рецепт для нашого scale

Припустимо ТОВ генерує 5M грн revenue, 2M грн чистого operating profit (User + partner — 2 UBO, 50/50 split).

| Розподіл                                                         | Сума                                                       | Tax effect                | На руки за 12 міс          |
| ---------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------- | -------------------------- |
| **User гіг-зарплата**                                            | ₴1,500,000/year (~₴125k/міс)                               | 11.7% (~₴175.5k)          | ₴1,324,500                 |
| **Partner гіг-зарплата**                                         | ₴1,500,000/year                                            | 11.7% (~₴175.5k)          | ₴1,324,500                 |
| **(гіг pay subtotal = operating expense, не chargeable з ПнВК)** | ₴3,000,000                                                 | —                         | —                          |
| **ЄСВ ТОВ за обох гіг**                                          | ₴1,902 × 12 × 2 = ₴45,648                                  | —                         | (commercial)               |
| **Залишок прибутку ТОВ після гіг pay і ЄСВ**                     | 5M − 3M − ₴45.6k − operational expenses (припустимо ₴500k) | = ₴1,454,352              | —                          |
| **Виплата dividend (1M, 50/50)**                                 | ₴1,000,000                                                 | 9% ПнВК + 5% ПДФО + 5% ВЗ | ₴819,000 (₴409.5k кожному) |
| **Reinvest**                                                     | ₴454,352                                                   | 0% поки в ТОВ             | (commercial)               |

**Підсумок per User:**

- Гіг pay net: ₴1,324,500
- Dividend net (50% з ₴819k): ₴409,500
- **Total cash to User: ₴1,734,000/year**

Same для partner.

**Total tax paid державі:** ₴351k (гіг ПДФО+ВЗ обох) + ₴45.6k (ЄСВ) + ₴90k (ПнВК) + ₴91k (дивідендні ПДФО+ВЗ) = **₴577.6k**

**Effective consolidated tax burden на 2M прибутку:** **₴577.6k / ₴2M = 28.9%**

**Hmm, чому 28.9%?** Бо ми **вибрали виплатити дивіденд** на 1M. Якщо все reinvest — burden дропає до ~10% (тільки гіг tax). Якщо виплачуємо весь прибуток — burden піднімається до ~30%. **Это лежить нижче типичної ТОВ-загальна 18+5+5 ≈ 26.2% на тих же припущеннях** (per [Дія Сіті roadmap консультація](2026-05-31-diia-city-implementation-roadmap.md)).

**TRUE optimization (more aggressive):**

- Більше через гіг-pay (cap €240k/спец/рік ≈ ₴10M/спец — far above наших volumes)
- Менше через дивіденди
- Reinvest agressively (R&D, marketing, equipment, training, conferences)

**З максимальним гіг + мінімальним dividend:**

- Гіг pay 2M user + 1.5M partner = ₴3.5M (tax ~₴410k)
- Тільки ₴500k dividend (tax ~₴91k)
- Reinvest ₴1.5M (0% tax)
- **Total tax: ~₴500k / ₴3.5M operating pay = 14.3%**

#### 8. Effective tax burden consolidated — повний приклад на 5M обороті

Сценарій: 5,000,000 грн річний оборот, mix каналів (60% USD wire = $71k, 30% USDT = $36k, 10% UAH = ₴500k). Net прибуток після всіх operating expenses (включно з гіг-зарплатою команди 5 SENIOR'ів) = 2,000,000 грн. Власники: User + partner, 50/50. Розподіл прибутку: 50% on distribution (1M dividend), 50% reinvest (1M).

**Цей сценарій — на МЕЖІ оборотів, де Дія Сіті стартап-резидент ще viable (потрібно 9 спеціалістів + €1200 average BUT in startup-period перші 24 місяці є пільга).** Для post-startup phase — припускаємо 9 спеціалістів (5 SENIOR + 3 JUNIOR + 1 HR).

##### 8.1 Канали — incoming side

| Канал                            | Volume     | Comm/loss                                    | Net до ТОВ                                       |
| -------------------------------- | ---------- | -------------------------------------------- | ------------------------------------------------ |
| USD wire 60% ($71k = ₴3M)        | ₴3,000,000 | -1% (~₴30k UA bank conversion + Wise hybrid) | ₴2,970,000                                       |
| USDT 30% ($36k = ₴1.5M)          | ₴1,500,000 | -4.5% (WhiteBIT conversion + withdrawal)     | ₴1,432,500                                       |
| UAH 10% (₴500k)                  | ₴500,000   | -16.7% (ПДВ якщо payer)                      | ₴417k net OR ₴500k якщо ПДВ-non-payer            |
| **Total revenue ТОВ (declared)** |            |                                              | **~₴4,820,000** (assuming ПДВ payer для UA-part) |

**NB про ПДВ:** Якщо ТОВ оборот ≥ ₴1M на рік — обов'язковий ПДВ payer. Експорт послуг (USD/USDT від нерезидентів) = **0% ПДВ**. UA-domestic клієнти платять з ПДВ 20%. Для нашого split (10% UA, 90% export) ПДВ-impact мінімальний.

##### 8.2 Operating expenses (припущення)

| Категорія                                       | Сума/рік                                           |
| ----------------------------------------------- | -------------------------------------------------- |
| Гіг-зарплата 9 спеціалістів × €1200/міс × ₴42/€ | ₴5,443,200 (це **operating expense** — не податок) |
| ЄСВ ТОВ за 9 гіг × ₴1,902/міс × 12              | ₴205,416                                           |
| Bookkeeping (~₴15k/міс)                         | ₴180,000                                           |
| Audit Дія Сіті (annual)                         | ₴50,000                                            |
| WhiteBIT fees (~₴40k/міс × 12)                  | ₴480,000                                           |
| Wise fees (~₴15k/міс × 12)                      | ₴180,000                                           |
| Office rent + utilities                         | ₴240,000                                           |
| Software / SaaS                                 | ₴120,000                                           |
| Marketing / SaaS                                | ₴100,000                                           |
| Legal / consulting buffers                      | ₴100,000                                           |
| **Total OpEx**                                  | **~₴7,098,616**                                    |

**Аномалия:** Якщо припустимо ₴5M revenue і ₴7M OpEx — ТОВ **збиткове**. Це **typical для startup-фази Дія Сіті**: 9 спеціалістів × €1200 = €10,800/міс = ₴540k/міс ≈ ₴6.5M/рік **тільки на зарплати команди**.

**Це показує що нашу 5M-сценарій нерелевантний для **post-startup** Дія Сіті structure.** Для post-startup потрібно мінімум ₴8-10M+ revenue, інакше Дія Сіті structure збиткова.

**Дві альтернативи:**

##### 8.3 Alternative A — Startup-резидент Дія Сіті фаза (перші 24 місяці)

Startup-period дає виняток на 9 спеціалістів. Припустимо команда 3-5 гіг-спеціалістів (User + partner + 2-3 SENIOR). Average remuneration ≥ €1200/міс.

| Категорія                                                                                                                                          | Сума/рік                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Revenue (declared)                                                                                                                                 | ₴4,820,000 (net of FX losses)         |
| Гіг-зарплата 4 спеціалістів × €1200/міс × ₴42 (average; реально SENIOR'и можуть отримувати більше) — припустимо average €2000 (₴84k/міс) × 4 спеці | ₴4,032,000                            |
| ЄСВ ТОВ × 4 спеціалістів                                                                                                                           | ₴91,296                               |
| Bookkeeping                                                                                                                                        | ₴180,000                              |
| Audit Дія Сіті startup                                                                                                                             | ₴30,000 (lower complexity)            |
| WhiteBIT fees                                                                                                                                      | ₴480,000                              |
| Wise fees                                                                                                                                          | ₴180,000                              |
| Office + SaaS                                                                                                                                      | ₴300,000                              |
| Buffer                                                                                                                                             | ₴100,000                              |
| **Total OpEx**                                                                                                                                     | **~₴5,393,296**                       |
| **Чистий прибуток ТОВ**                                                                                                                            | **₴-573,296** (still **slight loss**) |

Це показує: при ₴5M обороті навіть startup-резидент Дія Сіті з 4 гіг-спеціалістами на market-rate (€2000+) знаходиться в **negative profit zone**. **Patternу потрібно ≥ ₴8M revenue** щоб бути profitable.

##### 8.4 Alternative B — Realistic profitable scenario (₴10M revenue, 4 spec team)

Reframe: 10M грн revenue, 4 гіг-спеціалістів @ €2000/міс average:

| Категорія                                                                | Сума/рік                                                                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Revenue (declared)                                                       | ₴10,000,000                                                                                                              |
| Гіг-зарплата 4 × €2000 × ₴42 × 12                                        | ₴4,032,000                                                                                                               |
| ЄСВ ТОВ × 4                                                              | ₴91,296                                                                                                                  |
| Гіг tax compliance (ПДФО 5% + ВЗ 5% utримано з зарплати, переказано ДПС) | ₴403,200 (commercial passthrough, not ТОВ expense сам по собі)                                                           |
| Bookkeeping                                                              | ₴180,000                                                                                                                 |
| Audit Дія Сіті startup                                                   | ₴50,000                                                                                                                  |
| WhiteBIT + Wise fees                                                     | ₴660,000                                                                                                                 |
| Office + SaaS                                                            | ₴300,000                                                                                                                 |
| Marketing/legal                                                          | ₴200,000                                                                                                                 |
| **OpEx (real cash out)**                                                 | **~₴5,313,296** (включно з ЄСВ, без гіг pay tax який пройде через ТОВ як податковий агент і не cash impact для прибутку) |
| **Чистий operating profit ТОВ**                                          | ₴10,000,000 - ₴5,313,296 = **₴4,686,704**                                                                                |

##### 8.5 Distribution на 4.7M прибутку (post-OpEx)

User + partner 50/50. Реалістична distribution policy: 30% dividend, 70% reinvest.

| Component                    | Сума                              | Tax                             |
| ---------------------------- | --------------------------------- | ------------------------------- |
| Dividend (30% × 4.7M)        | ₴1,406,011                        | ПнВК 9% (ТОВ) + 5% ПДФО + 5% ВЗ |
| ПнВК                         | ₴1,406,011 × 9% = **₴126,541**    | ТОВ→ДПС                         |
| Чистий dividend (після ПнВК) | ₴1,279,470                        | для розподілу між фізами        |
| ПДФО 5% (фіза)               | ₴1,279,470 × 5% = **₴63,974**     | ТОВ→ДПС via tax agent           |
| ВЗ 5% (фіза)                 | ₴1,279,470 × 5% = **₴63,974**     | ТОВ→ДПС via tax agent           |
| **Net dividend в руках фіз** | **₴1,151,523** (₴575,761 кожному) |                                 |
| Reinvest (70% × 4.7M)        | ₴3,280,693                        | 0% tax (поки в ТОВ)             |

##### 8.6 Consolidated annual tax burden — total picture

| Tax category                         | Сума         | Залежно від                     |
| ------------------------------------ | ------------ | ------------------------------- |
| ПнВК ТОВ                             | ₴126,541     | dividend policy (на 30%)        |
| ПДФО гіг (4 × €2000 × ₴42 × 12 × 5%) | ₴201,600     | гіг-зарплати                    |
| ВЗ гіг (4 × €2000 × ₴42 × 12 × 5%)   | ₴201,600     | гіг-зарплати                    |
| ЄСВ ТОВ (4 × ₴1,902 × 12)            | ₴91,296      | мінімум, незалежно від зарплати |
| ПДФО дивіденд                        | ₴63,974      | dividend                        |
| ВЗ дивіденд                          | ₴63,974      | dividend                        |
| **TOTAL taxes**                      | **₴748,985** |                                 |

**Effective consolidated tax burden:**

- На **revenue** (₴10M): 748,985 / 10,000,000 = **7.5%**
- На **operating profit** (₴4.69M): 748,985 / 4,686,704 = **16%**
- На **distributed wealth** (гіг salary + net dividend = ₴4,032,000 + ₴1,151,523 = ₴5,183,523): 748,985 / 5,183,523 = **14.5%**

**Comparison vs alternatives на same scale:**

| Структура                                          | Effective tax / wealth received   |
| -------------------------------------------------- | --------------------------------- |
| **ТОВ-Дія Сіті ПнВК + гіг (recommended pattern)**  | **~14.5%**                        |
| ТОВ-загальна (18%+5%+5%) + дивіденди               | ~26-28%                           |
| ТОВ-ЕН-3 group (5% + 1% ВЗ) + дивіденди (9%+5%+5%) | ~17-20% (similar)                 |
| Multiple ФОП-3 (5% + 1% ВЗ)                        | ~6-7% (АЛЕ дроблення ризик)       |
| Estonia OÜ 0% reinvest + 20% distribution          | ~20% (плюс CFC UA)                |
| UAE Free Zone (0% corp) + CFC UA                   | ~18-20% (CFC negates UAE benefit) |

**Дія Сіті — sweet spot для нашого профілю.** ФОП-3 multiple дає краще, але з реальним risk recharacterization (per попередня tov-multi-channel консультація).

**Key insight:** **При aggressive reinvest mode (5-10% dividend, 90-95% reinvest)** consolidated tax burden дропає до **~8-10%** — це **near-optimal** для tech-companies. Це причина чому Дія Сіті — ефективна structure для **scaling companies**, а не cash-out companies.

#### 9. Setup roadmap — 7 фаз (Phase 0 → Phase 6)

**Total realistic timeline: 8-12 тижнів** (паралельні треки). **Total budget setup: ₴80-180k**.

##### Phase 0 — Pre-work (Week 0, ~₴0)

**Завдання:**

1. Decision making — name ТОВ (3 candidates), юр.адреса, partner equity split, KVED codes
2. Готування scanned documents: passport, ІПН для всіх founders і UBOs
3. **КЕП** (кваліфікований електронний підпис) — реєстрація через [Дія app](https://ca.diia.gov.ua/) — **30 хвилин, безкоштовно**
4. Запит cost-estimate в 2-3 IT-corporate lawyers
5. Запит cost-estimate в 2-3 bookkeeping firms (досвід з Дія Сіті)
6. Опціонально: pre-check Wise personal application для founder (clean record, 7-14 днів)

**Documents to prepare:**

- Passport scan (full) для founders, partners, key personnel
- ІПН (НДФЛ номери)
- Proof of address (комуналка / банк виписка)
- Future business model docs (1-page summary)

**Cost:** ₴0-5k (буфер на documents, переклады)

##### Phase 1 — ТОВ registration (Week 1-2, ₴15-25k)

**Завдання:**

1. Reservation назви ТОВ через [usr.minjust.gov.ua](https://usr.minjust.gov.ua/) — 1-3 робочі дні
2. **Founders' Agreement** (рішення про створення) — підписане в нотаріус OR через КЕП (online через Дія, [diia.gov.ua services](https://diia.gov.ua/services/reyestraciya-tov-na-pidstavi-modelnogo-statutu))
3. **Статут ТОВ** — модельний (online через Дія, безкоштовний, валідний для більшості сценаріїв) OR custom (потрібен lawyer, ₴10-20k)
4. Підписання Statut КЕП всіх founders
5. Подача в реєстратора — через Дія online (рекомендую) OR fizичний реєстратор. **Timing:** 24-48 год через Дія
6. Отримання витяг з ЄДР — instant after registration
7. Отримання EDRPOU code + IBAN reservation

**Цей шлях через Дія — найшвидший і найдешевший.** Custom Statut через юриста потрібен якщо:

- Складна структура власників (>2 founders, vesting schedules, drag-along/tag-along rights)
- Special voting rights
- IP-ownership clauses про future product

**Documents:**

- Passport scans + ІПН всіх founders
- Юр.адреса proof (lease agreement OR consent від owner)
- КЕП всіх founders для signing Statut

**Cost:** ₴3,000-5,000 держмито (Дія online може бути безкоштовно) + ₴10-20k юриста якщо custom Statut + ₴500-2k нотаріальні (якщо not via Дія)

**Output:** EDRPOU code, виписка ЄДР, готовий Statut

##### Phase 2 — Bank account UA (Week 2-3, паралельно з Phase 1, ₴0-3k)

**Завдання:**

1. Choice bank: **monobank Business** (швидко, online, 10-15 хв на open per [monobank.ua/en/business-account](https://monobank.ua/en/business-account)) OR **ПриватБанк Business** (більше corporate features, in-person для KYB) OR **Sense Bank Business** (good для IT)
2. KYB documents upload (більшість банків — online + 1-2 in-person visits)
3. Open UAH primary account
4. **Open USD subaccount** (для Wise alternative / direct receive)
5. **Open EUR subaccount** (опц.)
6. Налаштування internet banking + corporate cards
7. Реєстрація як ПДВ-payer (опц., обов'язково при обороті ≥ ₴1M)

**Choice rationale:**

- **monobank Business:** найшвидший setup, best для IT-стартапів. Cons: менше corporate features
- **ПриватБанк Business:** найбільше FX опцій (Торгова платформа MVRU), in-house compliance team familiar з ЗЕД, але slower
- **Sense Bank Business:** IT-focused, conditions friendly, але smaller

**Recommendation:** **monobank як primary** (швидкість, low fees) + **ПриватБанк як backup і primary для FX operations** (better Trade Platform).

**KYB documents:**

- Statut + EDRPOU витяг
- Passport scans founders/UBO
- Proof of business model (sample contract drafts)
- Source of initial capital

**Cost:** ₴0 для basic monobank Business; ₴1-3k для cards activation і initial fees

**Output:** Functional UAH-rахунок, USD/EUR subaccount-и, internet banking, corporate cards

##### Phase 3 — Wise + WhiteBIT applications (Week 2-5, паралельно з Phase 1-2, ₴0)

**Двух-track strategy:**

###### Track 3A — Wise (uncertain success, plan для fallback)

1. **Day +5 (після ТОВ registration):** Open **Wise personal** для founder як індивідуала (works за UA citizen status) — **1-3 days approval**
2. **Day +15:** Submit **Wise Business application для ТОВ** — wait 7-14 днів для review
3. **If approved:** onboarding 3-7 днів (KYB, setup multi-currency subaccounts)
4. **If rejected:** Plan B = continue з personal Wise OR direct UA bank USD subaccount

**Documents для Wise Business:**

- ЄДР витяг (англ. перекладений)
- Statut translation
- UBO identification
- Bank statement ТОВ за 1-3 місяці
- Description business (1-page)
- Website / online presence

**Realistic timeline:** 3-5 тижнів total

**Cost:** **Free apply**, **~$50-100 USD** setup fee при approval, **0% receive USD**

###### Track 3B — WhiteBIT Business KYB

1. **Day +5:** Submit institutional account application via [WhiteBIT institutional form](https://docs.whitebit.com/institutional/compliance)
2. **Day +7-12:** Initial review + RFI rounds
3. **Day +12-20:** Final approval + onboarding + custom limits setup
4. **Day +20-25:** First test transaction (small amount)

**Documents для WhiteBIT KYB:**

- ЄДР витяг + Statut (translated)
- UBO list з KYC verification each
- Business model description
- Compliance policy ТОВ (basic — recommend lawyer for proper docs)
- Source of funds / wealth
- Banking proof (active UAH account)

**Realistic timeline:** 3-5 тижнів total

**Cost:** Free apply, conversion/withdrawal fees apply on usage (~3-5% blended на UAH withdrawal as discussed)

##### Phase 4 — Дія Сіті application (Week 3-5, ₴0-5k)

**Завдання:**

1. **Eligibility self-check:**
   - КВЕД 62.01 (computer programming) — основний? OK
   - 90% revenue from qualifying activities (verify your contracts)
   - Розмір команди: для **startup-резидент** виняток до 9 спеціалістів — можна start з 1-3 спец
   - Average remuneration ≥ €1200/міс — applies навіть до startup
2. **Submit application через [city.diia.gov.ua](https://city.diia.gov.ua/)** — online через КЕП директора
3. **Documents to attach:**
   - Витяг ЄДР
   - Statut
   - Initial business plan (1-2 сторінки)
   - List of activities (КВЕД-based)
   - Founders' identification
   - Опціонально: sample contract з клієнтом (proves real activity)
4. **Review timing:** **до 10 робочих днів** (per [Дія Сіті backend docs DC_start_kit.pdf](https://city-backend.diia.gov.ua/storage/uploads/DC_start_kit.pdf))
5. **After approval:** реєстрація в Дія Сіті registry, право застосовувати spec режим ПнВК + гіг

**Startup-резидент vs Full-резидент при подачі:**

| Aspect                       | Startup-резидент                                            | Full-резидент              |
| ---------------------------- | ----------------------------------------------------------- | -------------------------- |
| Команда вимога               | Не зобов'язана 9 спец перші 24 міс                          | 9+ спеціалістів з 1 місяця |
| Average pay ≥ €1200          | Обов'язково з 1 місяця                                      | Обов'язково з 1 місяця     |
| Tax benefits                 | Same ПнВК 9% + гіг 5%+5%+ЄСВ                                | Same                       |
| Тривалість                   | 24 місяці (до 31 грудня року+1), потім treба перейти у full | Постійно                   |
| Дозволено новим ТОВ < 24 міс | Так                                                         | Так (якщо одразу 9 спец)   |
| Загроза втрати               | Після 24 міс — обов'язково 9 спец + €1200 average           | Continuous compliance      |

**Recommendation:** **подавати як startup-резидент** одразу. Це купує **24 місяці часу** для скейлю team до 9 спеціалістів. **CRITICAL:** ТОВ старше **24 місяців** НЕ може подаватись як startup — тільки full-резидент (per [memory lesson 2026-05-31](memory/legal/lessons.md)). Тому **submit при перших операціях ТОВ**, не пізніше.

**Cost:** **₴0** держмито Дія Сіті membership; **₴3-5k** буфер за lawyer review application (recommended).

**Output:** Дія Сіті статус резидент в registry. Effect з місяця наступного після присвоєння статусу.

##### Phase 5 — Гіг-контракти + Services Agreement templates (Week 5-7, ₴15-30k)

**Це найкритичніша phase з legal perspective.** Потрібен **specialized IT-corporate lawyer**.

**Завдання:**

1. **Engage IT-corporate lawyer** (Sayenko Kharenko / Avellum / Asters / Juscutum / EQUITY / inhouse boutiques). Cost: ₴15-30k разово per minimum.
2. **Lawyer drafts:**
   - **Master Services Agreement (MSA) template** з клієнтами (US/EU/UA versions, IP rights, NDA, payment terms, currency clauses)
   - **Statement of Work (SoW) template** для periodic engagements
   - **Гіг-контракт template** (під Закон 1667-IX, без recharacterization risk) — **це найважливіший document**
   - **NDA templates** для employees, contractors, clients
   - **Founders' Agreement / Shareholders' Agreement** якщо partner-co-founder
   - **Dividend distribution policy** template
3. **Review existing contracts** з поточними клієнтами / спеціалістами — migrate to new templates
4. **Compliance docs:**
   - AML/KYC policy ТОВ (для WhiteBIT KYB)
   - Data protection policy (GDPR if EU clients)
   - Code of conduct для гіг-команди (опц.)

**Critical нюанси гіг-контракту (recharacterization risk):**

- **Don't:** fix working hours, mandatory office presence, integration з team management hierarchy, paid vacation у standard form, mandatory KPI з employment-like structure
- **Do:** project-based deliverables, milestone-based payment, autonomous execution, opportunity for other engagements (specialist can work з іншими клієнтами теоретично)
- **Documentation:** every payment supported by Statement of Work + Acceptance Act
- **Per [cases.media gig-vyrok analysis](https://cases.media/en/article/diya-siti-podatki-ta-riziki-koli-gig-kontrakt-staye-trudovim-virokom), дата сбора 2026-05-31** — ДПС практика 2024-2025 показала recharacterization цілих груп гіг-спеціалістів у трудові з retroactive tax adjustments на 18% ПДФО + штрафи

**Cost:** **₴15-30k** lawyer engagement (one-time) + **₴3-5k/month** ongoing legal advisory якщо потрібно

**Output:** Готовий template-pack для contracts, гіг-team can be formally onboarded

##### Phase 6 — Operations launch (Week 7-12+, ₴25-40k)

**Завдання:**

1. **Hire bookkeeping firm** (досвід з Дія Сіті) — ₴15-25k/місяць ongoing
2. **First client contract signing** + invoice generation + payment receive (через будь-який з 3 каналів)
3. **First bookkeeping cycle** (місяць 1):
   - Реєстрація доходу (виписки банку + WhiteBIT)
   - Виплата гіг-винагороди команді + tax withholding
   - Перерахування ПДФО/ВЗ/ЄСВ в ДПС/ПФУ до 30 числа наступного місяця
4. **First quarterly reporting** (квартал 1):
   - **Декларація з ПнВК** (Дія Сіті) — quarterly, до 40 днів після кінця кварталу
   - **ПДВ декларація** (якщо ПДВ-payer) — monthly, до 20 числа наступного місяця
   - **Звіт про ЄСВ** — ([Об'єднана звітність 1ДФ + ЄСВ](https://tax.gov.ua)) — щомісяця
5. **Initial Дія Сіті compliance report** ([Звіт про відповідність](https://blank.dtkt.ua/blank/743)) — submit перший раз через 6 місяців після отримання статусу (verify актуальні правила з Дія Сіті legal team)

**Cost setup launch:**

- Bookkeeping setup (chart of accounts, integration with banks, KEPs): ₴5-10k
- First-month bookkeeping + reporting: ₴15-25k
- ПК (програмне забезпечення) — M.E.Doc / Артзвіт / Соната — ₴500-1500/міс ([medoc.ua](https://medoc.ua/))
- Buffer для unexpected: ₴10k

**Output:** Live operations, перший cycle compliance closed

##### 9.x — Сумарний setup budget і timeline

| Phase                                                     | Тривалість             | Cost range                                       |
| --------------------------------------------------------- | ---------------------- | ------------------------------------------------ |
| 0 — Pre-work                                              | Week 0                 | ₴0-5k                                            |
| 1 — ТОВ registration                                      | Week 1-2               | ₴3-25k                                           |
| 2 — Bank account                                          | Week 2-3 (параллельно) | ₴0-3k                                            |
| 3 — Wise + WhiteBIT KYB                                   | Week 2-5 (параллельно) | ₴0                                               |
| 4 — Дія Сіті application                                  | Week 3-5 (параллельно) | ₴0-5k                                            |
| 5 — Lawyer + templates                                    | Week 5-7               | ₴15-30k                                          |
| 6 — Operations launch                                     | Week 7-12+             | ₴25-40k (включно з первими місяцями bookkeeping) |
| **Total Setup**                                           | **8-12 тижнів**        | **₴43-108k** initial spending                    |
| **Plus buffer 30-50%** (delays, additional consultations) |                        | **₴60-150k+ realistic**                          |

**Ongoing monthly burden:**

| Категорія                                 | Сума/місяць       |
| ----------------------------------------- | ----------------- |
| Bookkeeping firm                          | ₴15-25k           |
| Software (M.E.Doc / Артзвіт)              | ₴0.5-1.5k         |
| WhiteBIT + Wise fees (залежно від volume) | ₴20-50k           |
| Дія Сіті annual audit (accrued monthly)   | ₴3-7k accrued     |
| Legal advisory buffer                     | ₴3-5k             |
| **Total ongoing**                         | **₴42-89k/month** |

#### 10. Operational obligations — monthly / quarterly / annual checklist

##### 10.1 Щомісяця

**До 20 числа наступного місяця:**

- **ЄСВ** за гіг-спеціалістів і employees → ПФУ ([ст. 9 Закону 2464-VI](https://zakon.rada.gov.ua/laws/show/2464-17))
- **ПДФО + ВЗ** за гіг-винагороди (utримано з виплат) → ДПС
- **Об'єднана звітність 1ДФ + ЄСВ** (форма) — за минулий місяць

**До 30 числа:**

- **ПДВ декларація** (якщо ПДВ-payer) + **ПК (податкова накладна)** для UA клієнтів — за минулий місяць

**Внутрішнє щомісяця:**

- Реconciliация bank statements vs CRM/accounting
- WhiteBIT/Wise statement download → bookkeeping
- Перевірка гіг-винагород vs contracts
- Курсові різниці на USD/EUR subaccount-ах

##### 10.2 Щоквартально

**До 40 днів після кінця кварталу:**

- **Декларація з ПнВК** (Дія Сіті) ([decларация з податку на виведений капітал](https://city-backend.diia.gov.ua/storage/uploads/DC_start_kit.pdf)) — quarterly. Перший раз — за квартал в якому отримано статус резидента.
- **Декларація з податку на прибуток** (стандартна) — якщо ТОВ продовжує common system на якусь частину operations
- **Авансові внески ПДВ** (квартальний consolidated paperwork)

**Quarterly review:**

- Перевірка достатності reserves для річного audit
- Update гіг-контрактів якщо змінились rates/spec lists
- Verify Дія Сіті criteria — 9 спеціалістів + €1200 average compliance progress (для startup-residence — track readiness до кінця 24-month period)

##### 10.3 Щорічно

**До 1 червня (за рік минулий):**

- **Звіт про відповідність резидента Дія Сіті** (форма [blank.dtkt.ua/blank/743](https://blank.dtkt.ua/blank/743)) + **незалежний висновок аудитора** ([Kreston Ukraine — Дія Сіті compliance](https://kreston.ua/en/audit-and-related-services/diia-city-resident-s-compliance-report-audit/)) — **mandatory** для всіх Дія Сіті резидентів (включно startup після першого року)
- **Аудит компанії**: per [BP-Audit Дія Сіті](https://bp-audit.com.ua/service/audyt-zvitu-pro-vidpovidnist-rezydenta-diia-siti) — coverage не повноцінний аудит, а review compliance criteria; cost ₴30-80k залежно від complexity і audit firm

**До 1 травня (за рік минулий):**

- **Фінансова звітність ТОВ** ([Закон 996-IV](https://zakon.rada.gov.ua/laws/show/996-14)) — submit ДПС + публікація в ЄДР
- **Декларація з податку на прибуток / ПнВК річна** — final adjustments

**Annually internal:**

- Renewal Wise/WhiteBIT KYB (typically не потрібно але можуть запитувати updates)
- Update гіг-контрактів rates на initial year
- Renew lawyer/accountant engagement terms
- Review dividend policy with partner

##### 10.4 Currency control / FX обов'язки

- **Реєстрація ЗЕД-контракту в банку** — once per contract, на момент перших operations
- **Щомісячна звітність ЗЕД** — банк автоматично подає; ТОВ може запросити summary
- **180-денний строк** для отримання валютної виручки після інвойсу ([WoBorders 2026 limit summary](https://woborders.agency/en/blog/which-payment-system-choose-in-2026/), дата сбора 2026-05-31) — clip operationally important
- **При обороті > €400k/quarter (~$430k)** — банк може запросити additional documentation (proof of services, end-client identification); це **AML compliance not block**

##### 10.5 Tax payment calendar (швидкий reference)

| Що                          | Період               | Deadline               |
| --------------------------- | -------------------- | ---------------------- |
| ЄСВ                         | місяць               | 20 число наступного    |
| ПДФО гіг + ВЗ гіг           | місяць               | 30 число наступного    |
| 1ДФ + ЄСВ звіт              | місяць               | 30 число наступного    |
| ПДВ декларація              | місяць               | 30 число наступного    |
| ПК (податкові накладні)     | відразу при операції | 15 днів                |
| ПнВК Дія Сіті               | квартал              | 40 днів після кварталу |
| Дія Сіті compliance + аудит | рік                  | 1 червня               |
| Фінансова звітність ТОВ     | рік                  | 1 травня               |

### Риски

| #   | Risk                                                                                                                                                                                                                                                                            | Severity                                       | Probability (12-36mo)                                                                                                                         | Mitigation                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Гіг-контракт recharacterization у трудовий** — ДПС визнає гіг як employment, retroactive ПДФО 18% + штрафи 25-75% + ЄСВ 22% від реальної зарплати [cases.media analysis](https://cases.media/en/article/diya-siti-podatki-ta-riziki-koli-gig-kontrakt-staye-trudovim-virokom) | **CRITICAL**                                   | **Med-High (35-45%)** на pattern з template з інтернету; **Low-Med (10-15%)** з properly drafted lawyer template + clean operational practice | Engage IT-corporate lawyer для template (₴15-30k); document project-based deliverables; зберігати separateness від employment   |
| 2   | **Втрата startup-резидент статусу після 24 міс** (не досягнуто 9 спец × €1200 average) — auto exclusion + retroactive recalculation tax burden                                                                                                                                  | High                                           | Med (25%) for typical startup growth                                                                                                          | Hire plan: 9 спеціалістів обов'язково до Dec 31 року+1; alternative — accept loss of status + перейти на ТОВ-ЕН-3 group         |
| 3   | **Wise Business rejection** для UA ТОВ                                                                                                                                                                                                                                          | High (для FX channel)                          | Med-High (30-40%)                                                                                                                             | Plan B: personal Wise + direct UA bank USD subaccount; не all-eggs на Wise channel                                              |
| 4   | **WhiteBIT account freeze** через AML risk score (unusual transaction patterns, KIT Group reputation drag)                                                                                                                                                                      | High                                           | Low-Med (15-20%)                                                                                                                              | Conservative transaction volumes, clean KYB documentation, backup MiCA-licensed exchange (Bitstamp EU, Bitvavo)                 |
| 5   | **Дія Сіті threshold changes** з 2026-2027 (потенційний підйом €1200 → €1500 або вимоги збільшення кількості спец)                                                                                                                                                              | Med                                            | Low-Med (20%)                                                                                                                                 | Monitor [city.diia.gov.ua](https://city.diia.gov.ua/) updates monthly; build team на 9+ спец asap                               |
| 6   | **ПДВ-зобов'язання на UA-клієнтську частину revenue** (20% ПДВ при оборот ≥ ₴1M) — додатковий cash flow cost не обчислений в TL;DR                                                                                                                                              | Med                                            | Certain (100%) при > ₴1M                                                                                                                      | Бухгалтерія input ПДВ tracking; optimize для max export revenue (0% ПДВ)                                                        |
| 7   | **Обов'язковий аудит звіту Дія Сіті (₴30-80k/рік)** — hidden cost часто пропущений в planning                                                                                                                                                                                   | Med                                            | Certain (100%)                                                                                                                                | Будуджувати ₴3-7k/місяць accrued; choice an affordable competent audit firm early                                               |
| 8   | **Currency control додаткова DD** при оборотах > €400k/quarter (~₴18M/quarter, ~₴72M/рік) — банк requesting documentation про end-client identification                                                                                                                         | Med                                            | Med (40%) при scale up                                                                                                                        | Maintain clean MSA + invoice trails; engaged bookkeeper для bank correspondence                                                 |
| 9   | **CRS data exchange** — ваша WhiteBIT (MiCA-licensed Croatia) активність буде звітуватись в ДПС автоматично у 2027+ → guarantees that pattern must be fully declared                                                                                                            | High (if не declared); negligible if compliant | Certain (100%) post-2027                                                                                                                      | Pattern базується на full declaration — no risk if compliance kept                                                              |
| 10  | **Дроблення бізнесу accusation** якщо partner-ФОП-subcontractor pattern використовується (Option C для partner)                                                                                                                                                                 | Critical                                       | Med (25%) при single-client revenue partner                                                                                                   | Avoid Option C; use Option B (co-shareholder) для partner                                                                       |
| 11  | **Втрата bank account** через AML pattern detection в банку (especially при USDT-related transactions)                                                                                                                                                                          | High                                           | Low-Med (15%)                                                                                                                                 | Multiple bank accounts (monobank + ПриватБанк + Sense) для redundancy; clean transaction descriptions з контрактними references |
| 12  | **Reputation drag** від WhiteBIT KIT Group case впливає на наш bank relationships                                                                                                                                                                                               | Low-Med                                        | Low (10%)                                                                                                                                     | Маємо альтернативу через Wise / direct USD subaccount для non-crypto revenue                                                    |
| 13  | **9-specialist threshold** не досягнуто навіть в full-резидент phase — exclusion із registry                                                                                                                                                                                    | Critical                                       | Med (20%) для slow-growth startup                                                                                                             | Plan hire ramp; if not achievable — pivot до ТОВ-ЕН-3 group або close startup-резидент status before exclusion                  |
| 14  | **MiCA WhiteBIT регуляторні зміни** в ЕС впливають на UA ТОВ KYB conditions                                                                                                                                                                                                     | Med                                            | Low (10%)                                                                                                                                     | Backup KYB на іншу MiCA-licensed exchange                                                                                       |
| 15  | **Зміни ПКУ Дія Сіті clause** (потенційний підйом 9% ПнВК або зниження 5% ПДФО на гіг) — політична воля може змінитись                                                                                                                                                          | Med                                            | Low (10%) у короткий час; Med (30%) на 3-5 років                                                                                              | Track law changes; build optionality в structure (можливість швидкого pivot до ЕН-3 group)                                      |
| 16  | **BEB scrutiny на multi-ФОП subcontract patterns** (якщо partner Option C обраний) — ст. 212 + ст. 209 risk per попередня [risk analysis консультація](2026-05-31-cash-crypto-undeclared-risk-analysis.md)                                                                      | Critical                                       | Med (25%) для multi-ФОП pattern, Low (5%) для clean partner Option B                                                                          | Stay на Option B; не намагатися дрibити для tax savings                                                                         |
| 17  | **Hidden cost escalation** — bookkeeping (₴15-25k), audit (₴30-80k), legal advisory (₴3-5k/міс), software (₴1-2k/міс) — total ongoing до ₴80-100k/міс перетворює structure economics                                                                                            | Med (operational drag)                         | Certain (100%)                                                                                                                                | Включити в budget planning; не намагатися "do без bookkeeper" — пропустити compliance = lose Дія Сіті                           |
| 18  | **180-денний строк отримання валютної виручки** (war-time currency control) — at scale потенційний breach при затримках клієнтів                                                                                                                                                | Med                                            | Low (10%)                                                                                                                                     | Monitor invoice→payment gap; include penalty clauses в client contracts                                                         |
| 19  | **Transfer pricing applicability** якщо є affiliated entities (partner-ФОП, affiliated holding) — ₴30-50k/рік documentation cost (per попередня [offshore консультація](2026-05-31-offshore-alternatives.md))                                                                   | Med                                            | Low-Med (15%) at this scale, high if scale до cross-border affiliates                                                                         | Avoid affiliated structures until scale >> ₴20M/year                                                                            |
| 20  | **GDPR exposure** на EU clients (наша CRM зберігає Telegram / phone / scans) — fine до 4% revenue                                                                                                                                                                               | High                                           | Low (10%) at small scale, Med (30%) at EU client scale                                                                                        | Implement GDPR consent flow + data retention policy (separate task для Coder)                                                   |

### Рекомендація (best for business)

#### Top-3 actions для цього тижня (Monday morning checklist)

1. **Зробити КЕП через [Дія app](https://ca.diia.gov.ua/)** — це foundation для всього іншого. 30 хвилин, безкоштовно. **Дзвонити в Дія contact-центр якщо щось не виходить — 1545.**
2. **Запросити cost-estimate в 3 IT-corporate lawyers** (Sayenko Kharenko / Avellum / Asters / Juscutum / EQUITY) на пакет: MSA template + гіг-контракт template + Дія Сіті application supervision + Founders' Agreement. Сформулювати запит specifically: «**ТОВ-новий, plan stать резидентом Дія Сіті як startup, потрібен compliant гіг-контракт template без recharacterization risk + MSA з US/EU клієнтами**». Це **критичний** етап — economy на lawyer = catastrophic risk per [risk analysis](2026-05-31-cash-crypto-undeclared-risk-analysis.md) і [memory lesson 2026-05-31 P0](memory/legal/lessons.md).
3. **Reserve назву ТОВ на [usr.minjust.gov.ua](https://usr.minjust.gov.ua/)** + draft Founders' Agreement з partner. Approve 3 candidates назви, готувати юр.адресу (можна homely address за згодою власника, або coworking).

#### Top-5 actions для першого місяця

1. **Register ТОВ через [Дія online портал](https://diia.gov.ua/services/reyestraciya-tov-na-pidstavi-modelnogo-statutu)** — модельний Statut OK для початку, спрощує процес. Cost ₴3-5k максимум.
2. **Open monobank Business UAH** + USD subaccount як primary banking channel (10-15 хв online setup).
3. **Submit Дія Сіті application** через [city.diia.gov.ua](https://city.diia.gov.ua/) **ОДРАЗУ** після ТОВ registration — щоб **не пропустити startup-window** (ТОВ старше 24 міс не може застосовувати startup).
4. **Submit Wise personal application** для founder як індивідуала (paralel track для FX testing). Submit Wise Business application для ТОВ після першої місячної operations.
5. **Submit WhiteBIT Business KYB** з повним documentation pack (Statut + ЄДР + UBO disclosure + business model + AML policy).

#### Verification checkpoints на кожному етапі

| Checkpoint                          | Когда                       | What to verify                                                                                                          |
| ----------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Після Phase 1 (ТОВ registered)**  | Week 2                      | EDRPOU code присвоєний, виписка ЄДР отримана, КЕП директора works в [city.diia.gov.ua](https://city.diia.gov.ua/) login |
| **Після Phase 2 (bank)**            | Week 3                      | UAH-рахунок active, USD subaccount opened, internet banking working, corporate cards activated                          |
| **Після Phase 3 (Wise + WhiteBIT)** | Week 5                      | Принаймні 1 з 2 active (Plan A success). Plan B identified якщо обоє rejected.                                          |
| **Після Phase 4 (Дія Сіті)**        | Week 5                      | Статус резидент в registry, спецрежим діє з місяця +1                                                                   |
| **Після Phase 5 (lawyer)**          | Week 7                      | Гіг-контракт template на руках, MSA template, перший гіг-спец signed                                                    |
| **Після Phase 6 (operations)**      | Week 12                     | Перший client payment received, перший гіг payout зроблений з повним tax withholding, bookkeeping cycle закритий        |
| **Initial Дія Сіті compliance**     | Month 7                     | Перший звіт про відповідність подано                                                                                    |
| **First annual audit**              | Year 1 (до 1 червня року+1) | Аудиторський висновок + повний annual звіт submitted                                                                    |
| **9-spec / €1200 milestone**        | Before Dec 31 року+1        | Команда expanded до 9 спеціалістів з average remuneration ≥ €1200                                                       |

#### Не плутати — анти-recommendations

| Не робити                                                                 | Чому                                                                                               |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Не починати operations до lawyer engagement**                           | Recharacterization risk catastrophic. ₴15-30k разово < ₴1.5M/year recharacterization cost          |
| **Не використовувати template з інтернету для гіг-контракту**             | Default templates fail recharacterization stress-test                                              |
| **Не plani-fy 0% effective tax**                                          | Реалістично 8-16% залежно від reinvest policy                                                      |
| **Не ігнорувати обов'язковий аудит Дія Сіті**                             | Failure to submit = exclusion з resident registry → retroactive загальна system                    |
| **Не використовувати partner Option C (single-client ФОП-subcontractor)** | Дроблення бізнесу risk per [BEB practice 2024-2026](https://yankiv.com/droblennya-biznesu-na-fop/) |
| **Не плутати Wise personal vs Wise Business**                             | Mixing призведе до AML issues                                                                      |
| **Не пропускати ЕСВ ₴1902/міс**                                           | Це floor, незалежний від виплат; missing = personal liability директора                            |
| **Не пропускати CRS implications**                                        | All accounts будуть visible ДПС у 2027+; pattern має бути declared from day 1                      |

#### Якщо partner decision не finalized

User згадав partner. **Перед Phase 1 (ТОВ registration)** обов'язково:

1. Decide equity split (50/50 vs 60/40 vs 70/30)
2. **Founders' Agreement з vesting** (4-year vest, 1-year cliff — standard) — discusss з lawyer
3. **Decision making rights** (unanimity vs majority для key decisions)
4. **Exit clauses** (drag-along, tag-along, ROFR)
5. **Dividend policy** (фіксована частка чи дискреційна)

**Without partner agreement = future expensive corporate dispute risk.** Engage lawyer на цей draft.

### Источники

#### Кодекси і Закони України

- [Податковий кодекс України — ст. 134 (ПнВК Дія Сіті)](https://zakon.rada.gov.ua/laws/show/2755-17#n3299)
- [ПКУ ст. 161 (Військовий збір 5%)](https://zakon.rada.gov.ua/laws/show/2755-17)
- [ПКУ ст. 167.5 (ПДФО ставки дивіденд)](https://zakon.rada.gov.ua/laws/show/2755-17)
- [ПКУ ст. 170.5 (preferential ПДФО на дивіденди Дія Сіті)](https://zakon.rada.gov.ua/laws/show/2755-17)
- [ПКУ ст. 170.14¹ (Оподаткування гіг-винагороди)](https://zakon.rada.gov.ua/laws/show/2755-17)
- [ПКУ ст. 181 (ПДВ-реєстрація поріг ₴1M)](https://zakon.rada.gov.ua/laws/show/2755-17)
- [ПКУ ст. 195.1.3 (Експорт послуг — 0% ПДВ)](https://zakon.rada.gov.ua/laws/show/2755-17)
- [ПКУ ст. 293.3 (ЄП ставки 3-я група)](https://zakon.rada.gov.ua/laws/show/2755-17)
- [Закон 1667-IX «Про стимулювання розвитку цифрової економіки» (Дія Сіті)](https://zakon.rada.gov.ua/laws/show/1667-20)
- [Закон 2464-VI «Про збір та облік єдиного внеску»](https://zakon.rada.gov.ua/laws/show/2464-17)
- [Закон 996-IV «Про бухгалтерський облік та фінансову звітність»](https://zakon.rada.gov.ua/laws/show/996-14)
- [Закон 2473-VIII «Про валюту і валютні операції»](https://zakon.rada.gov.ua/laws/show/2473-19)
- [Закон 361-IX «Про запобігання та протидію легалізації доходів»](https://zakon.rada.gov.ua/go/361-20)
- [Закон 2074-IX «Про віртуальні активи» (Status: чекає ПКУ адаптації, 10225-д)](https://zakon.rada.gov.ua/laws/show/2074-20)
- [Постанова НБУ № 18 від 24.02.2022 (war-time валютні обмеження)](https://zakon.rada.gov.ua/laws/show/v0018500-22)
- [Постанова НБУ № 148 від 29.12.2017 (обмеження готівкових розрахунків)](https://zakon.rada.gov.ua/laws/show/v0148500-17)

#### WebSearch — дата сбора 2026-05-31

**WhiteBIT:**

- [WhiteBIT — Trading, deposit and withdrawal fees](https://help.whitebit.com/hc/en-gb/articles/25029308319005-Trading-deposit-and-withdrawal-fees) (дата сбора 2026-05-31)
- [WhiteBIT — How to Withdraw UAH on WhiteBIT](https://help.whitebit.com/hc/en-gb/articles/27220802740509-How-to-Withdraw-UAH-on-WhiteBIT) (дата сбора 2026-05-31)
- [WhiteBIT — Deposit and withdrawal via P2P Express](https://help.whitebit.com/hc/en-gb/articles/19401002086045-Deposit-and-withdrawal-via-P2P-Express) (дата сбора 2026-05-31)
- [WhiteBIT — Withdrawal of funds using Card Transfer](https://help.whitebit.com/hc/en-gb/articles/20716216959005-Withdrawal-of-funds-using-Card-Transfer-on-WhiteBIT) (дата сбора 2026-05-31)
- [WhiteBIT — What is KYB?](https://help.whitebit.com/hc/en-gb/articles/17350938784285-What-is-KYB) (дата сбора 2026-05-31)
- [WhiteBIT Blog — How to Open a Corporate Account](https://blog.whitebit.com/en/how-to-open-a-corporate-account-on-whitebit/) (дата сбора 2026-05-31)
- [WhiteBIT institutional / Regulatory Compliance](https://docs.whitebit.com/institutional/compliance) (дата сбора 2026-05-31)
- [WhiteBIT Blog — W Group MiCA HANFA Authorization (29 April 2026)](https://blog.whitebit.com/en/w-group-advances-european-expansion-as-white-tech-obtains-mica-authorization/) (дата сбора 2026-05-31)
- [CryptoSlate — WhiteBit Exchange Review 2026](https://cryptoslate.com/crypto-exchanges/whitebit-exchange-review/) (дата сбора 2026-05-31)
- [Bitstamp — Chainalysis tax agencies usage](https://www.bitstamp.net/learn/company-profiles/chainalysis/) (дата сбора 2026-05-31)
- [ANTIKOR portal — WhiteBIT KIT Group AML investigation](https://antikor.info/en/articles/826030-kriptobirha_whitebit_figuriruet_v_sheme_otmyvanija_millionov_ot_onlajn-narkomarketov_cherez_setj_tenevyh_obmennikov_kit_group_pojavilisj_ekskljuzivnye_dokumenty) (дата сбора 2026-05-31)

**Wise:**

- [Wise — How to open Wise and withdraw funds in Ukraine 2026](https://buh.ua/en/how-to-open-wise-and-withdraw-funds-in-ukraine) (дата сбора 2026-05-31)
- [Wise Business — International business account](https://wise.com/gb/business/) (дата сбора 2026-05-31)
- [Wise — International business payments](https://wise.com/ua/send-money/international-business-payments) (дата сбора 2026-05-31)
- [Wise — Multi-Currency Account 2026](https://wealthvieu.com/banking/wise/multi-currency-account/) (дата сбора 2026-05-31)
- [Wise — для displaced Ukrainians](https://wise.com/gb/blog/wise-for-displaced-ukrainians) (дата сбора 2026-05-31)

**Дія Сіті / Diia City:**

- [Diia.City registry — резиденти](https://city.diia.gov.ua/registry/resident) (дата сбора 2026-05-31)
- [Diia.City — official portal](https://city.diia.gov.ua/) (дата сбора 2026-05-31)
- [Diia.City — Start Kit PDF](https://city-backend.diia.gov.ua/storage/uploads/DC_start_kit.pdf) (дата сбора 2026-05-31)
- [Diia.City — main info PDF](https://city-backend.diia.gov.ua/storage/uploads/files/page/home/diia.city.pdf) (дата сбора 2026-05-31)
- [Audit-invest.com.ua — Стартапи Дія Сіті: критерії, податки та звіти 2026](https://audit-invest.com.ua/ru/articles/blog/startapy-v-diia-city-pilhy-zvitnist-audyt) (дата сбора 2026-05-31)
- [7eminar — Стартап у Дія Сіті без 20k євро](https://7eminar.ua/news/19105-startap-u-diya-siti-ci-mozna-podavatisya-na-kriticnist-bez) (дата сбора 2026-05-31)
- [Factor — Зміни для резидентів Дія Сіті 2026](https://i.factor.ua/ukr/journals/nibu/2026/february/issue-12/article-136109.html) (дата сбора 2026-05-31)
- [Bires.com.ua — Дія Сіті startup conditions](https://bires.com.ua/yurydychnyj-suprovid-biznesu/dotrymannya-umov-diya-siti-dlya-startapiv-yak-ne-vtratyty-rezydentstvo-pid-chas-diyi-voyennogo-stanu/) (дата сбора 2026-05-31)
- [Egolovbuh — startup-резидент Дія Сіті обов'язки](https://egolovbuh.expertus.com.ua/10018957) (дата сбора 2026-05-31)
- [Mind.ua — startup vs full-резидент Дія Сіті](https://mind.ua/openmind/20291564-startap-chi-povnocinnij-rezident-diya-city-perevagi-ta-vimogi) (дата сбора 2026-05-31)
- [Factor — ПДФО і ВЗ на дивіденди Дія Сіті 2026](https://i.factor.ua/ukr/journals/nibu/2026/march/issue-21/article-136682.html) (дата сбора 2026-05-31)
- [Kreston Ukraine — Дія Сіті startup tax benefits 2025](https://kreston.ua/en/diia-city-for-startups-how-to-legally-save-on-taxes-and-grow-a-unicorn/) (дата сбора 2026-05-31)
- [Kreston Ukraine — Дія Сіті compliance report restored](https://kreston.ua/zvitnist-rezydentiv-diia-siti-vidnovleno-shcho-peredbachaie-zaznachena-protsedura/) (дата сбора 2026-05-31)
- [Kreston Ukraine — Дія Сіті audit](https://kreston.ua/en/audit-and-related-services/diia-city-resident-s-compliance-report-audit/) (дата сбора 2026-05-31)
- [BP-Audit — Дія Сіті compliance audit](https://bp-audit.com.ua/service/audyt-zvitu-pro-vidpovidnist-rezydenta-diia-siti) (дата сбора 2026-05-31)
- [Blank.dtkt.ua форма 743 — Звіт про відповідність Дія Сіті](https://blank.dtkt.ua/blank/743) (дата сбора 2026-05-31)
- [Cases.media — Дія Сіті ризики переквалификації гіг → трудовий](https://cases.media/en/article/diya-siti-podatki-ta-riziki-koli-gig-kontrakt-staye-trudovim-virokom) (дата сбора 2026-05-31)
- [Garnet.team — облік гіг-контрактів у BAS УТП](https://garnet.team/articles/vedennya-obliku-organizatsiyami-rezidentami-diya-siti-u-t-ch-obliku-gig-kontraktiv-v-bas-utp/) (дата сбора 2026-05-31)
- [Juscutum — Оподаткування в Дія.City 2025](https://www.juscutum.com/news/osoblivosti-opodatkuvannya-rezidentiv-diya-city-u-2025-roci) (дата сбора 2026-05-31)
- [DKU.in.ua — Дія Сіті 2026 загальний overview](https://dku.in.ua/DiiaCity) (дата сбора 2026-05-31)
- [7eminar — Гіг-спеціалісти резидента Дія Сіті](https://7eminar.ua/news/5620-rezident-diya-siti-vinagoroda-likarnyani-oplacuvana-pererva-gig-specialistam-ta) (дата сбора 2026-05-31)
- [7eminar — Працівники Дія Сіті: зарплата](https://7eminar.ua/news/5565-rezident-diya-siti-zarobitna-plata-likarnyani-vidpuskni-statnim-pracivnikam-ta) (дата сбора 2026-05-31)
- [News.dtkt.ua — Втрата статусу Дія Сіті](https://news.dtkt.ua/taxation/profits-tax/83767-za-iakix-umov-rezident-diia-siti-vtracaje-svii-status) (дата сбора 2026-05-31)
- [Biz.ligazakon.net — Зміни визначення критично важливих для Дія Сіті](https://biz.ligazakon.net/news/240342_viznachennya-kritichno-vazhlivikh-pdprimstv-zmni-dlya-rezidentv-dya-st) (дата сбора 2026-05-31)
- [TAX.gov.ua — Дія Сіті адміністрування](https://dp.tax.gov.ua/media-ark/news-ark/975476.html) (дата сбора 2026-05-31)
- [ZP.tax.gov.ua — ПДФО Дія Сіті не-гіг](https://zp.tax.gov.ua/media-ark/news-ark/877751.html) (дата сбора 2026-05-31)
- [News.dtkt.ua — ЄСВ зовнішніх сумісників Дія Сіті](https://news.dtkt.ua/labor/social-protection/103864-iak-naraxovuvati-jesv-na-zarplatu-zovnisnyogo-sumisnika-rezidenta-diia-siti-dps-zminila-dumku) (дата сбора 2026-05-31)
- [Bip.net.ua — Режим Дія Сіті 2026](https://bip.net.ua/articles/diya-siti-umovi-vimogi-perevagi-j-nedoliki/) (дата сбора 2026-05-31)

**Мінзарплата і ЄСВ 2026:**

- [Smartfin.ua — Мінімальна зарплата 2026](https://smartfin.ua/page/minimalna-zarplata-u-2026-rotsi) (дата сбора 2026-05-31)
- [Minfin.com.ua — Мінімальна зарплата Україна](https://index.minfin.com.ua/en/labour/salary/min/) (дата сбора 2026-05-31)
- [DN.tax.gov.ua — Мінзарплата 2026 ЄСВ](https://dn.tax.gov.ua/media-ark/news-ark/962430.html) (дата сбора 2026-05-31)
- [7eminar — Мінімальна заробітна плата 2026](https://7eminar.ua/news/8965-minimalna-zarobitna-plata-u-2026-roci) (дата сбора 2026-05-31)
- [Factor Academy — Держбюджет 2026](https://factor.academy/blog/derzhavnij-byudzhet-2026-minimalna-zarplata-prozhitkovij-minimum-indeksaciya-yesv/) (дата сбора 2026-05-31)
- [Buhplatforma — Мінімальна зарплата 2026 вплив](https://buhplatforma.com.ua/article/18422-minimalna-zarplata-2026-skilky-platytymut-iak-zminiatsia-podatky-i-chysti-vyplaty) (дата сбора 2026-05-31)
- [Factor Academy — Ставка ВЗ Дія Сіті 2025](https://factor.academy/blog/stavka-vijskovogo-zboru-v-diya-siti-2025/) (дата сбора 2026-05-31)
- [DP.tax.gov.ua — ЄСВ Дія Сіті адміністрування](https://dp.tax.gov.ua/media-ark/news-ark/976447.html) (дата сбора 2026-05-31)
- [7eminar — ЄСВ для Дія Сіті при виплаті зарплати](https://7eminar.ua/news/13417-jesv-dlya-diya-siti-pri-viplati-zarplati-ta-vinagorodi-rozyasnennya) (дата сбора 2026-05-31)

**Banking UA:**

- [ПриватБанк — SWIFT для бізнесу](https://privatbank.ua/perekazy-swift) (дата сбора 2026-05-31)
- [ПриватБанк — ЗЕД](https://privatbank.ua/business/zed) (дата сбора 2026-05-31)
- [ПриватБанк — IT-clients services](https://privatbank.ua/business/poslugi-dlya-it-clientiv-compainii) (дата сбора 2026-05-31)
- [ПриватБанк — Trading platform для юр.осіб](https://privatbank.ua/business/trading-platform) (дата сбора 2026-05-31)
- [monobank — currency account](https://monobank.ua/en/business/currency-account) (дата сбора 2026-05-31)
- [monobank — tariffs](https://monobank.ua/taryfy) (дата сбора 2026-05-31)
- [monobank — business account](https://monobank.ua/en/business-account) (дата сбора 2026-05-31)
- [monobank — SWIFT incoming](https://bankchart.com.ua/groshovi_perekazi/novini/yak_otrimati_swift_perekaz_u_monobank) (дата сбора 2026-05-31)
- [Sense Bank — валютні операції під час воєнного стану](https://help-biz.sensebank.com.ua/hc/uk/articles/4881724088594) (дата сбора 2026-05-31)
- [Bank.gov.ua — обов'язковий продаж валюти скасовано](https://bank.gov.ua/en/news/all/obovyazkoviy-prodaj-valyutnih-nadhodjen-biznesom-skasovano) (дата сбора 2026-05-31)
- [Bank.gov.ua — Уточнення валютних обмежень](https://bank.gov.ua/en/news/all/natsionalniy-bank-utochniv-nizku-valyutnih-obmejen) (дата сбора 2026-05-31)
- [Lexology — Валютні обмеження 2024](https://www.lexology.com/library/detail.aspx?g=9d4700f5-ea0a-424c-b41c-4752ac957da6) (дата сбора 2026-05-31)
- [Nova Poshta Business School — Валютний контроль 2026](https://online.novaposhta.education/blog/valyutnij-kontrol-granichni-stroki-rozrahunkiv-za-operaciyami-z-eksportu-ta-importu-tovariv) (дата сбора 2026-05-31)
- [WoBorders — Payment system choice 2026](https://woborders.agency/en/blog/which-payment-system-choose-in-2026/) (дата сбора 2026-05-31)
- [Medoc.ua — готівкові розрахунки обмеження 2026](https://medoc.ua/blog/gotivkovi-rozrahunki-na-jaki-ne-poshirjutsja-obmezhennja-shhodo-granichnih-sum-) (дата сбора 2026-05-31)

**Other:**

- [Yankiv — Дроблення бізнесу 2026](https://yankiv.com/droblennya-biznesu-na-fop/) (дата сбора 2026-05-31)
- [Diia.gov.ua — реєстрація ТОВ](https://diia.gov.ua/services/reyestraciya-tov-na-pidstavi-modelnogo-statutu) (дата сбора 2026-05-31)
- [Diia.gov.ua — Звіт про відповідність Дія Сіті](https://diia.gov.ua/services/zvit-pro-vidpovidnist-rezidenta-diyacity-ta-nezalezhnij-visnovok) (дата сбора 2026-05-31)
- [CA.diia.gov.ua — КЕП](https://ca.diia.gov.ua/) (дата сбора 2026-05-31)
- [USR.minjust.gov.ua — реєстр юр.осіб](https://usr.minjust.gov.ua/) (дата сбора 2026-05-31)

#### Внутрішня knowledge base

- `docs/agents/memory/legal/lessons.md` — попередні 12 уроків, особливо P0 на recharacterization risk + дроблення бізнесу
- `docs/legal/cross-cutting/escalation-zones.md` — § 4 на суми податків > 100k грн (наша scale підпадає)
- `docs/legal/cross-cutting/citation-rules.md` — формат citation rules
- Попередні консультації серії:
  - [USDT payouts PHASE 8](2026-05-31-usdt-payouts-phase8.md)
  - [ТОВ multi-channel revenue](2026-05-31-tov-multi-channel-revenue.md)
  - [Дія Сіті roadmap](2026-05-31-diia-city-implementation-roadmap.md)
  - [Offshore alternatives](2026-05-31-offshore-alternatives.md)
  - [Cash/crypto undeclared risk analysis](2026-05-31-cash-crypto-undeclared-risk-analysis.md)

### Disclaimer

**MED overall Confidence** означає що **architecture is sound**, але:

1. **§ 4 escalation-zones (суми податків > 100k грн)** — наш scenario сягає ₴700k+ annual tax burden, що **обов'язково** вимагає human tax-advisor review **перед** financial action. Цей документ — **planning framework**, не **execution-ready calculation**.

2. **§ 2 (soft escalation zones)** — major change в employment структурі (масовий перевід на гіг-контракти) + регістрація new legal entity (ТОВ + Дія Сіті application) + Vendor contracts з high data sensitivity (WhiteBIT, Wise KYB) — кожен з них **action-критичний**.

3. **Конкретні human profesіонали обов'язкові** ДО запуску:
   - **Specialized IT-corporate lawyer** (Sayenko Kharenko / Avellum / Asters / Juscutum / EQUITY / inhouse boutiques) — ₴15-30k разово для template-pack + Дія Сіті application supervision. **Не template з інтернету.**
   - **Bookkeeping firm з Дія Сіті experience** — ₴15-25k/місяць ongoing, **engage до Phase 6 launch**
   - **Audit firm з обов'язковим аудитом досвідом** — ₴30-80k/рік annual; choose в Q4 першого року operations
   - **Specialized tax advisor** (consultation) — ₴5-15k разово для validation tax math на ваших реальних numbers (не на conditional 5M-сценарію)

4. **Banking lawyer для FX > €400k/quarter:** якщо в перший рік operations підете в quarterly volume > €400k (~₴18M/quarter, ~₴72M/year revenue) — engage banking-spec lawyer для compliance review currency control documentation.

5. **WebSearch верифікації обов'язкові на момент дії:** WhiteBIT fees, Wise acceptance policy, Дія Сіті legislation, мінзарплата ставки — **усі змінюються щоквартально**. **Re-verify** перед кожним важливим decision. Цей документ accurate станом на **2026-05-31**; станом на ваш момент дії — verify.

6. **Не binding legal advice.** AI-юрист дає preliminary framework. Implementation requires human professional supervision. Для критичних decision (>₴100k annual tax impact) — обов'язкова human review.

7. **Прив'язано до user-specific facts:** numbers calibrated на ₴5-10M обороту з 50/50 partner split. Реальні numbers вашого бізнесу можуть змінити math suttantly (>10% deviation в effective rate). Calibrate на реальні numbers з tax-advisor після Phase 6 launch.

**Дата завершення консультації:** 2026-05-31
**Status:** Implementation-grade guide; ready для User'а почати в понеділок з Top-3 actions.
