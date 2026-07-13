# ADR — Тип оплаты проекта + маршрутизация admin-декларируемого USDT-прихода

## Status

**Proposed** — planning-стадия критичной финансовой фичи. Владелец: «реализация только
после того как все детали обговорены». Требует user-approval по открытым вопросам (§Открытые
вопросы) до dispatch кодеров.

Ветка: `feature/drop-share-override-and-receiver`. Модель: opus. Confidence проставлен на
ключевых пунктах Decision.

---

## Context

Контракт владельца (ЗАФИКСИРОВАН):

1. **Тип оплаты проекта** → enum ФОП / гіг-контракт / USDT (сейчас `projects.paymentType` —
   свободный `varchar(100)`, `schema.ts:299`). Меняют ADMIN + ACCOUNTANT (field-scoped RBAC как
   `seniorSharePercentOverride`). Data-миграция: все существующие → ФОП, GamingTec → USDT (dev + прод).
2. **Гейт декларирования по типу оплаты:** ФОП/гіг — SENIOR/DROP декларируют свои приходы как
   сейчас, без селектора получателя. USDT — декларируют ТОЛЬКО ADMIN'ы; обязательный получатель:
   любой ADMIN (динамически по роли) ИЛИ «счёт компании». Историю НЕ трогаем.
3. **Авто-обязательства после admin-декларации USDT-прихода:** (а) доля синьора = сумма × эфф.
   доля — только если синьор не ADMIN; (б) доля дропа = сумма × эфф. доля — только если дроп
   привязан. Гашение существующими механизмами выплат.
4. **Per-project доля дропа** (прошлый цикл, остаётся): `projects.dropSharePercentOverride`,
   RBAC ADMIN+ACCOUNTANT, резолвер override → `users.dropSharePercent` → 5, БЕЗ team-уровня;
   снапшот `transactions.drop_share_percent` + `drop_share_percent_source`.

Фича делится на **Part A** (per-project drop override — самостоятельная, feeds Part B) и
**Part B** (paymentType enum + admin-USDT income routing + obligations).

### Существующая денежная модель (проверено по коду — фундамент решений)

- **Company-account ledger** (`company-account-balance.ts:21-45`, единый SSOT баланса):
  `+ COMPANY_DEPOSIT(PAID,USDT)  + PAYOUT(PAID, funding=COMPANY_ACCOUNT)  + ADMIN_INCOME(PAID,
funding=COMPANY_ACCOUNT)  − DIVIDEND_TO_ADMIN  − SALARY(COMPANY_ACCOUNT)  − EXPENSE(COMPANY_ACCOUNT)
− SENIOR_INCOME(COMPANY_ACCOUNT)`. Все USDT. **`PAYOUT_DROP` в ledger отсутствует** (drop-slice
  никогда не был долгом компании).
- **`ADMIN_INCOME`** (`transactions.service.ts:961-1053`): создаётся сразу `PAID` (без validation),
  `fundingSource` роутит: `COMPANY_ACCOUNT` → кредит пула (USDT-forced, исключён из личного
  баланса админа в `getSummary:3056`); `null` → кредит receiverId-админа лично. `totalIncome`
  (`getSummary:2996`) считает ВСЕ `ADMIN_INCOME` как gross.
- **IOU «компания должна X»** — рождается в `applyPayoutPaidCascade` drop-ветке
  (`transactions.service.ts:2760-2804`): `SENIOR_PENDING_PAYOUT` (PENDING_PAYMENT, visible-row) +
  `pending_obligations` (creditor=senior, `debtorType='COMPANY'`, `sourceTransactionId`=IOU-row).
  `pending_obligations` **НЕ хранит роль кредитора** — тип IOU резолвится через source-транзакцию.
- **Settle** (`pending-settlement.service.ts:151-345`, `settleByCompany`): атомарный
  conditional-UPDATE PENDING→PAID (анти-double-settle, TOCTOU-safe), **хардкодит вставку
  `SENIOR_INCOME`(PAID)** + триггер `autoCreateForSeniorPayout` (gate `type==='SENIOR_INCOME'`,
  `invoices.service.ts:147`). Funding at pay-time: `COMPANY_ACCOUNT` (дебет пула, gate на баланс) |
  `ADMIN_PERSONAL` (sender=админ, пул не трогается; только USD/USDT — BIZ-03).
- **Drop balance** = `Σ PAYOUT_DROP received − sent` (`computeDropAggregate:593-598`). Единственный
  тип, кредитующий баланс дропа.
- **Резолвер доли синьора** (`senior-share-resolver.ts`): project override → single-team → user
  (26). У дропа team-уровня НЕТ (`projects.dropId` — прямая привязка, не через team).

---

## Decision

### D0. Сквозной money-flow admin-USDT-прихода (ядро) — **Confidence: HIGH на форме, MED на 2 узлах**

Пример: ADMIN декларирует **$1000 USDT** на USDT-проекте (senior=S не-админ 26%, drop=D 5%,
override-aware). Получатель — ADMIN X **или** «счёт компании».

```
1. Income-row (gross $1000)         → тип ADMIN_INCOME, status PAID (см. D3)
   ├ receiver = «счёт компании»     → fundingSource=COMPANY_ACCOUNT → +$1000 в пул
   └ receiver = ADMIN X             → fundingSource=null, receiverId=X → +$1000 личный баланс X
2. Атомарно (та же db.transaction) — обязательства компании (см. D4):
   ├ если S не ADMIN: SENIOR_PENDING_PAYOUT $260 + obligation(creditor=S, debtor=COMPANY)
   └ если D привязан: DROP_PENDING_PAYOUT   $50  + obligation(creditor=D, debtor=COMPANY)
3. Гашение (existing settle, см. D5), ACCOUNTANT/ADMIN выбирает funding:
   ├ senior → SENIOR_INCOME PAID (existing ветка, инвойс)
   └ drop   → PAYOUT_DROP  PAID (НОВАЯ ветка, кредит баланса дропа, без senior-инвойса)
   Residual $690 остаётся там, куда пришёл gross (пул / личный баланс X).
```

**Инвариант согласованности:** funding-выбор на settle привязан к тому, куда пришёл gross.
receiver=пул → settle из `COMPANY_ACCOUNT`; receiver=ADMIN X → settle `ADMIN_PERSONAL`(payer=X).
Это **не** энфорсится жёстко (mirror существующей ручной модели), но настраивает дефолт и
защищён gate-балансом (`settleByCompany:276` кидает «Недостаточно средств»). MED — см. Q3.

### D1. `paymentType` free-text → enum — **Confidence: HIGH**

- Shared Zod: `projectPaymentTypeSchema = z.enum(['FOP','GIG_CONTRACT','USDT'])`. Укр. лейблы на
  фронте: `FOP→'ФОП'`, `GIG_CONTRACT→'гіг-контракт'`, `USDT→'USDT'`.
- pgEnum `project_payment_type` в `schema.ts`; `projects.paymentType` → `project_payment_type
NOT NULL DEFAULT 'FOP'`.
- Field-scoped RBAC в `createProjectSchema`/`updateProjectSchema` + `projects.service.ts`
  create/update — паттерн 1:1 с `seniorSharePercentOverride` (`:610-618`, `:739-747`): только
  ADMIN/ACCOUNTANT могут прислать поле, иначе `ForbiddenException`; ACCOUNTANT `hasOnlyOverride`-ветку
  расширить на `paymentType`.
- `mapProject` (`:196-209`) отдаёт `paymentType` в DTO (не маскировать — не PII; но JUNIOR-маскировка
  по вкусу владельца — см. Q5).

### D2. Гейт декларирования по типу оплаты (двунаправленный) — **Confidence: HIGH**

- `createSeniorIncome` / `createDropIncome` (`:1069`, `:1151`): добавить проверку — если
  `project.paymentType === 'USDT'` → `ForbiddenException('На USDT-проекте приход декларирует
администратор')`. FOP/GIG lifecycle НЕ меняется.
- Новый admin-USDT метод (D3): reject если `project.paymentType !== 'USDT'`.
- Frontend `CreateTransactionDialog`: SENIOR/DROP при выборе USDT-проекта → тип
  SENIOR_INCOME/DROP_INCOME недоступен (hint). ADMIN получает новый тип-опцию только для
  USDT-проектов.
- **Историю не трогаем**: гейт только на НОВЫЕ декларации; старые DROP_INCOME на GamingTec живут.

### D3. Lifecycle admin-USDT-прихода: **переиспользуем `ADMIN_INCOME`, новый service-метод** — **Confidence: MED→HIGH**

**Тип income-строки = `ADMIN_INCOME` (НЕ новый enum).** Обоснование (adopt-before-extend):

- `fundingSource`-роутинг `ADMIN_INCOME` уже точно моделирует «пул vs личный баланс админа»,
  ledger + `getSummary` + `totalIncome` уже интегрированы → **ноль churn** по exhaustive-мапам /
  summary / ledger для income-строки.
- Новый enum-тип для income-строки дал бы огромный blast-radius (каждый ledger-терм, каждая
  сводка, `Record<TransactionType>` в `constants.ts:4,:67`, dialog ICON/DESC-мапы, инвойсы) без
  выигрыша — деньги-семантика идентична `ADMIN_INCOME`.

**Отдельный метод**, НЕ правка `createAdminIncome` (регресс-safe): `declareUsdtProjectIncome`
(рабочее имя) + endpoint `POST /api/finance/usdt-income`. Отличия от `createAdminIncome`:

- RBAC: **только ADMIN** (контракт «декларируют ТОЛЬКО ADMIN'ы»; ACCOUNTANT — см. Q4).
- Проект — ЛЮБОЙ USDT-проект (не «свой»), `paymentType==='USDT'`.
- `receiverId`: любой активный ADMIN → `receiverId=X, fundingSource=null`; «счёт компании» →
  `fundingSource=COMPANY_ACCOUNT, receiverId=каллер` (исключён из личного баланса как в
  `createAdminIncome`), currency forced `USDT`.
- Валидатор: не требует ACCOUNTANT-каскада — `ADMIN_INCOME` создаётся сразу `PAID` (доверенный
  админ), как сегодня. См. Q2 (нужна ли валидация).
- **Атомарно** в одной `db.transaction`: income-row + оба obligation-блока (D4). Никогда
  income-без-obligations.

### D4. Обязательства + резолвер доли дропа (Part A feeds Part B) — **Confidence: MED**

- **Новый резолвер `resolveDropShare`** (по образцу `senior-share-resolver.ts`, БЕЗ team-уровня):
  `project.dropSharePercentOverride ?? user.dropSharePercent ?? 5`, source `'PROJECT'|'USER_DEFAULT'`.
  Используется И в admin-USDT obligation-математике, И в снапшоте DROP_INCOME (Part A).
- **Экстракт shared-хелпера** `bookCompanyObligations(dbtx, {project, income, senior, drop})` из
  `applyPayoutPaidCascade:2760-2804` (senior-IOU) + добавить drop-ветку. Ре-юз в обоих
  call-site'ах (drop-payout cascade И admin-USDT) → нет ledger-дрейфа.
- Senior-share на GROSS через `resolveSeniorShareSnapshot` (project/team-aware), только если
  `senior.role !== 'ADMIN'`. Drop-share на GROSS через `resolveDropShare`, только если
  `project.dropId != null`. Снапшот долей+source на IOU-строки.
- **`DROP_PENDING_PAYOUT`** — новый enum-value (M1 уже заложил в Zod). В `schema.ts`
  `transactionTypeEnum` добавить ПОСЛЕДНИМ (после `COMPANY_DEPOSIT`) — чистый `ALTER TYPE ADD
VALUE`. Обязательные follow-up: `constants.ts` `TYPE_LABELS`(`:4`)+`TYPE_COLORS`(`:67`) —
  exhaustive `Record<TransactionType>` ломаются без записи (причина, по которой M1 не запушен).
- **Idempotency (анти-BIZ-02):** double-submit декларации = 2 разных income-row, каждый со своими
  obligations (не double-settle одной obligation) — та же посадка, что у `createAdminIncome`
  сегодня. Реальный double-settle-риск закрыт атомарным guard'ом `settleByCompany` (ре-юзим). Атомарность
  создания (income+obligations в одной tx) — обязательна.

### D5. Settle drop-обязательства (новая ветка) — **Confidence: MED (highest-risk узел)**

`pending_obligations` не различает роль кредитора → `settleByCompany` ветвит по типу
source-транзакции (`sourceTransactionId` → tx.type):

- `SENIOR_PENDING_PAYOUT` → существующая ветка: `SENIOR_INCOME` PAID + `autoCreateForSeniorPayout`.
  **Не сломать.**
- `DROP_PENDING_PAYOUT` → **новая ветка**: вставить `PAYOUT_DROP` PAID (`receiverId=drop`,
  `senderLabel='COMPANY'` при company-funded / `senderId=payerAdmin` при ADMIN_PERSONAL) — кредитует
  баланс дропа через `computeDropAggregate`. **НЕ** триггерить senior-инвойс.
- **Ledger-терм:** добавить `− Σ(PAYOUT_DROP PAID, funding=COMPANY_ACCOUNT, USDT)` в
  `company-account-balance.ts`. Существующие `PAYOUT_DROP` (drop-payout cascade) имеют
  `fundingSource=null` → не затронуты. ADMIN_PERSONAL-settle: `senderId=admin` → дебет ловит
  `adminBalances.sent` в `getSummary`, ledger-терм не нужен.
- Drop-инвойс: контракт не требует; по умолчанию не создаём (senior-инвойс — legal-тип). См. Q6.

### D6. Part A — per-project drop override (unchanged from prior cycle) — **Confidence: HIGH**

CRUD 1:1 c `seniorSharePercentOverride` в `projects.service.ts` create(`:604-725`)/update(`:732-804`):
field-scoped RBAC ADMIN/ACCOUNTANT, implicit-null-reset (value === эфф. drop-default → `null`),
`hasOnlyOverride`-ветка. **Отличия:** дефолт = `user.dropSharePercent ?? 5` (не 26); только для
drop-проектов (`dropId != null`); **нет** `project_finance_settings`-mirror (у senior есть legacy
mirror — дропу не нужен). DTO-поля (M1): `dropSharePercentOverride`, `dropSharePercentDefault`,
`effectiveDropSharePercent`, `effectiveDropShareSource`. Снапшот на DROP_INCOME:
`transactions.drop_share_percent` + `drop_share_percent_source` (новые колонки).

### D7. Судьба WIP M1 (`119e3f60`) — **Confidence: HIGH**

Cherry-pick частично:

- **Взять как есть:** `dropSharePercentSourceSchema`, `transactionSchema += dropSharePercent /
dropSharePercentSource`, `projectSchema += 4 drop-поля`, `create/updateProjectSchema +=
dropSharePercentOverride`, `DROP_PENDING_PAYOUT` в `transactionTypeSchema`.
- **ПЕРЕДЕЛАТЬ:** `createDropIncomeSchema += receiverId (REQUIRED)` — **НЕВЕРНО** под новый
  контракт. DROP на FOP/GIG декларирует свой приход БЕЗ получателя. `receiverId` — поле НОВОГО
  admin-USDT DTO (`createUsdtIncomeSchema`), НЕ `createDropIncomeSchema`. Также комментарий про
  «ADMIN caller на DROP_INCOME» из M1 — выкинуть.
- **Довесить (не было в M1):** `projectPaymentTypeSchema`, `createUsdtIncomeSchema`
  (`projectId, amount, currency='USDT', receiverId | 'COMPANY_ACCOUNT'`), обновить `constants.ts`
  exhaustive-мапы + dialog-мапы под `DROP_PENDING_PAYOUT` (M1 их ломает → поэтому и не запушен).

---

## Матрица конфликтов

Каждый пункт: конфликт есть/нет + решение.

| #   | Поверхность                                                                        | Конфликт?                | Решение                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **ACCOUNTANT-валидация** (`validateTransaction:1539`, `getAccountantSummary:3212`) | **Нет**                  | admin-USDT income = `ADMIN_INCOME` PAID сразу, НЕ проходит validate-каскад. `pendingValidation` фильтрует только `SENIOR_INCOME/DROP_INCOME` → admin-USDT не попадает. Корректно.                                                                                                                                                                                                                                                                                                                  |
| C2  | **Payout-bundling** (`createPayoutRequest:2061`)                                   | **Нет**                  | Бандлится только собственный `SENIOR_INCOME/DROP_INCOME` (receiverId=caller). admin-USDT не создаёт bundle-able income для synьора/дропа; их деньги идут через obligation-settle, не через payout. Развязано.                                                                                                                                                                                                                                                                                      |
| C3  | **salary-cron** (`createMonthlySalaries:3909`)                                     | **Нет**                  | Зарплаты не зависят от paymentType / admin-income. Не пересекается.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| C4  | **totalIncome double-count** (`getSummary:2991-3007`)                              | **ДА (MED)**             | receiver=ADMIN X + settle senior `ADMIN_PERSONAL` → `SENIOR_INCOME(funding=null)` **считается** в totalIncome (строка `:3003`), хотя это slice уже посчитанного `ADMIN_INCOME` gross. **Pre-existing** (task-senior-settle-owner), но эта фича УЧАЩАЕТ. Фикс: расширить исключение — settlement-`SENIOR_INCOME` (закрывающие obligation) НЕ считать в totalIncome независимо от funding. Нужен дискриминатор (напр. `closingTransactionId`-джойн ИЛИ marker-поле). **Regression-тест обязателен.** |
| C5  | **adminBalances / 50-50** (`getSummary:3039-3073`)                                 | **Нет (проверено)**      | receiver=X: `ADMIN_INCOME(null)` +X.received; settle `ADMIN_PERSONAL` → `PAYOUT_DROP/SENIOR_INCOME senderId=X` +X.sent. HOLDING-модель сходится (+gross −доли = +residual). receiver=пул: `funding=COMPANY_ACCOUNT` исключён из личного. Согласовано.                                                                                                                                                                                                                                              |
| C6  | **drop-aggregate** (`computeDropAggregate:553`)                                    | **ДА (низкий)**          | `pendingCount`/`debtToCompany` матчат `receiverId===drop.id` / `senderId===drop.id`. admin-USDT: income receiverId=admin (не дроп) → в pendingCount НЕ попадёт (корректно — дроп не декларирует). Settle-`PAYOUT_DROP` receiverId=drop → `balance.received` +=drop-доля (корректно). Нужен unit-тест что settle-`PAYOUT_DROP` не задваивается как `sent` (senderId≠drop).                                                                                                                          |
| C7  | **company-account ledger** (`company-account-balance.ts`)                          | **ДА (требует правки)**  | Добавить `− PAYOUT_DROP(COMPANY_ACCOUNT)` терм (D5). `ADMIN_INCOME(COMPANY_ACCOUNT)` кредит-терм уже есть → receiver=пул работает без правок. Integration-тест ledger-баланса.                                                                                                                                                                                                                                                                                                                     |
| C8  | **инвойсы/PDF** (`invoices.service.ts:147,197`)                                    | **Нет**                  | senior-settle → `SENIOR_INCOME` → `autoCreateForSeniorPayout` (существующий gate). drop-settle → `PAYOUT_DROP` → gate не срабатывает, инвойса нет (см. Q6). admin-`ADMIN_INCOME` инвойс не генерит (нет триггера на ADMIN_INCOME). Согласовано.                                                                                                                                                                                                                                                    |
| C9  | **RBAC-видимость транзакций** (`assertReadAccess:4071`, `mapTx:279`)               | **ДА (проверить)**       | Новый `DROP_PENDING_PAYOUT` visible-row + `ADMIN_INCOME` на чужом проекте. Проверить: дроп видит свой `DROP_PENDING_PAYOUT`/`PAYOUT_DROP`; синьор — свой `SENIOR_PENDING_PAYOUT`; JUNIOR не видит финансы. Нужен RBAC-integration-тест на новые строки (не mocked — урок mocked-guards).                                                                                                                                                                                                           |
| C10 | **seed / E2E-фикстуры** (`seed.ts`)                                                | **ДА**                   | Проекты seed не заполняют `paymentType` (→ миграция default 'FOP'). GamingTec НЕ в dev-seed. Добавить в seed минимум 1 USDT drop-проект-фикстуру (dev может гонять admin-USDT flow + obligations). `notesPaymentType` на interviews — не трогать (другое поле).                                                                                                                                                                                                                                    |
| C11 | **GamingTec-история**                                                              | **Нет**                  | Старые DROP_INCOME на GamingTec не трогаем (гейт только на новое). Миграция лишь ставит `paymentType='USDT'` проекту.                                                                                                                                                                                                                                                                                                                                                                              |
| C12 | **взаимодействие с per-project drop override** (Part A↔B)                          | **Coupling (by design)** | drop-obligation amount = income × `resolveDropShare` (project override → user → 5). Тот же резолвер снапшотит DROP_INCOME. Единый `resolveDropShare` — SSOT.                                                                                                                                                                                                                                                                                                                                       |
| C13 | **free-text `paymentType` UI-поля** (существующие прод-значения!)                  | **ДА (data-migration)**  | Прод `payment_type` — произвольный free-text. Миграция: нормализовать все → 'FOP', GamingTec → 'USDT', затем `ALTER COLUMN TYPE enum USING`. Ручной прод-DDL (`apps/api/drizzle/manual/`). Верифицировать прод-значения ДО конвертации (нет неожиданных строк, которые должны быть USDT/GIG).                                                                                                                                                                                                      |
| C14 | **createDropIncome M1 `receiverId REQUIRED`**                                      | **ДА (M1 баг)**          | Откатить (D7): FOP/GIG-дроп декларирует без получателя. receiverId — в admin-USDT DTO.                                                                                                                                                                                                                                                                                                                                                                                                             |

---

## Открытые вопросы владельцу (только меняющие деньги/UX)

**Q1 — «Счёт компании» получатель: прямой кредит vs on-chain tx-link верификация?**
Существует 2 пути зачисления в пул: (а) `ADMIN_INCOME(COMPANY_ACCOUNT)` — прямой кредит, без
верификации (доверенный админ, как сегодня); (б) `COMPANY_DEPOSIT` — Etherscan-верификация
tx-ссылки (Phase 8, `submitDeposit`). Рекомендация: **(а) прямой кредит** (консистентно с
`createAdminIncome`, tx-link остаётся как receipt-доказательство). Варианты: (а) прямой /
(б) требовать верифицированную tx-ссылку как у депозита / (в) прямой + опциональная ссылка.

**Q2 — Нужна ли ACCOUNTANT-валидация admin-USDT-прихода до создания обязательств?**
Рекомендация: **нет** (сразу PAID + obligations, как `ADMIN_INCOME`; admin доверен). Варианты:
(а) сразу PAID / (б) PENDING → ACCOUNTANT validate → тогда obligations (контрольный гейт, но
расходится с моделью ADMIN_INCOME).

**Q3 — Привязывать ли settle-funding к получателю gross (жёстко)?**
receiver=пул логично гасить из `COMPANY_ACCOUNT`, receiver=ADMIN X — `ADMIN_PERSONAL`(X). Сейчас
это ручной выбор ACCOUNTANT (mirror существующего). Рекомендация: **мягко** (дефолт по получателю,
gate-баланс защищает). Вариант: жёстко форсить funding по получателю (меньше свободы, меньше
ошибок).

**Q4 — Может ли ACCOUNTANT (не только ADMIN) декларировать USDT-приход?**
Контракт говорит «ТОЛЬКО ADMIN'ы», но ACCOUNTANT имеет create-parity для `ADMIN_INCOME` и ведёт
финансы. Рекомендация: **следовать контракту — только ADMIN**. Вариант: разрешить ACCOUNTANT
(как recorder, receiver всё равно ADMIN/пул).

**Q5 — Маскировать ли `paymentType` от JUNIOR?**
Тип оплаты — не PII, но финансовая конфигурация. Рекомендация: показывать всем не-JUNIOR (как
senior share). Вариант: скрывать от JUNIOR/HR.

**Q6 — Инвойс дропу при settle drop-доли?**
Senior получает signable `SENIOR_INCOME`-инвойс. Дропу контракт инвойс не оговаривает.
Рекомендация: **без инвойса** (drop-slice — internal payout). Вариант: генерить drop-инвойс
(нужен новый invoice-триггер на `PAYOUT_DROP`).

---

## Правки task-файлов (зона PM — предлагаю, не редактирую)

**Task-файлы `task-drop-share-{design,backend,frontend,e2e}.md` НЕ существуют** (ни на feature, ни
в main — проверено `git ls-tree`). Есть только дизайн-спека + WIP-схемы. PM должен **создать** 4
файла со следующим содержанием (расширенный scope Part A+B):

- **`task-drop-share-design.md`** (ui-ux-designer, Tier 2) — **addendum к
  `docs/design/drop-share-override-and-receiver.md`** (spec писался ДО контракта, Surface B устарел):
  1. Surface A (drop-share слайдер) — **без изменений**, корректен.
  2. Surface B (получатель) — **ПЕРЕНЕСТИ** из ветки `DROP_INCOME` в **новый admin-USDT
     declaration-флоу**. DROP_INCOME (FOP/GIG) — БЕЗ селектора получателя.
  3. Новый экран/секция: ADMIN на USDT-проекте выбирает получателя = группа «Админы» (динамич.) +
     «Счёт компании». Опции 2 групп + hint «gross уйдёт получателю; компания создаст обязательства
     синьору/дропу».
  4. Новое поле «Тип оплаты» (ФОП/гіг-контракт/USDT) в форме проекта — Select, RBAC ADMIN/ACCOUNTANT.
  5. Responsive + fidelity на всех классах (design-fidelity-review).

- **`task-drop-backend.md`** (Coder, model=opus — finance+migration; security-reviewer ОБЯЗАТЕЛЕН):
  AC на: paymentType enum+миграция (D1), гейт (D2), `resolveDropShare` (D4), per-project drop
  override CRUD (D6), `declareUsdtProjectIncome` + endpoint (D3), `bookCompanyObligations`
  shared-хелпер + `DROP_PENDING_PAYOUT` (D4), settle drop-ветка + ledger-терм (D5, C7), totalIncome
  fix (C4), DROP_INCOME snapshot-колонки (D6). Explicit AC: unit (resolveDropShare,
  computeDropDistribution с override, obligation-math), **integration против реальной БД** (RBAC
  403 на гейт, settle-drop атомарность/idempotency, ledger-баланс — C6/C7/C9), regression
  (senior-ветка settle не сломана, totalIncome).

- **`task-drop-frontend.md`** (Coder + design-gate) — по дизайн-addendum: paymentType Select,
  drop-share слайдер (Surface A), admin-USDT dialog (получатель), гейт-скрытие
  SENIOR_INCOME/DROP_INCOME на USDT-проектах, `constants.ts` exhaustive-мапы под
  `DROP_PENDING_PAYOUT`, dialog-мапы. НЕ вставлять receiverId в createDropIncome (C14).

- **`task-drop-e2e.md`** (AutoTest) — E2E: ADMIN декларирует USDT-приход (receiver=admin /
  receiver=пул) → obligations появляются → ACCOUNTANT гасит → баланс дропа/синьора двигается;
  гейт (SENIOR/DROP не могут декларировать на USDT-проекте); paymentType RBAC. testid'ы из
  дизайн-спеки + новые.

**Design tier** в каждом UI task-файле: Tier 2. **Модель** backend-таска: `opus` (Drizzle-миграция

- финансовая расчётная логика + company-account — по `model-routing.md` триггеру).

---

## Порядок реализации (incremental, working state на каждом шаге)

1. **M1-довод (shared)** — cherry-pick годного из `119e3f60` + `projectPaymentTypeSchema` +
   `createUsdtIncomeSchema`, откат `createDropIncome.receiverId`, обновление `constants.ts`
   exhaustive-мапов (`DROP_PENDING_PAYOUT`). → typecheck зелёный. **Rollback:** revert shared-commit.
2. **Миграция schema** — pgEnum `project_payment_type` + колонки drop-share snapshot +
   `DROP_PENDING_PAYOUT` enum-value. `db:push` dev. Ручной прод-DDL в `apps/api/drizzle/manual/
2026-07-13_payment_type_and_drop_pending_payout.sql` (ADD VALUE вне транзакции; конвертация
   varchar→enum с USING-маппингом FOP/GamingTec-USDT). **Rollback:** обратный DDL (enum→varchar; drop
   колонок; enum-value удалить нельзя — оставить unused).
3. **Part A backend** — `resolveDropShare` + override CRUD + DROP_INCOME snapshot + DTO. Unit-тесты.
   → изолированно рабочее (drop override без Part B). **Rollback:** revert.
4. **Part B backend** — гейт (D2) + `declareUsdtProjectIncome` + `bookCompanyObligations` (экстракт
   из cascade) + settle drop-ветка + ledger-терм + totalIncome fix. Integration против реальной БД.
   security-reviewer. **Rollback:** revert; гейт-снятие восстанавливает старый lifecycle.
5. **Frontend** (design-gate: designer ДО) — paymentType Select, Surface A слайдер, admin-USDT
   dialog. fidelity-review все классы. **Rollback:** revert.
6. **E2E + seed USDT-фикстура** (C10). Полный прогон локально перед push.
7. **User Testing** → «мерджим» → `merge-approved`. Прод-DDL применяется ДО деплоя (как хвост
   mega-audit) — GamingTec→USDT на проде.

---

## Rollback (feature-уровень)

- **Single-file:** `git checkout <file>`.
- **Phase-subset:** `git revert <range>` по шагам порядка выше (каждый шаг — рабочее состояние).
- **Full:** закрыть PR, вернуться на pre-change `feature/drop-share-override-and-receiver`.
- **Прод-DDL:** миграция обратима (enum→varchar сохраняет значения; drop snapshot-колонок; новый
  enum-value `DROP_PENDING_PAYOUT` в PG удалить нельзя — остаётся unused, безвреден). Гейт и
  admin-USDT-метод — чисто аддитивны: снятие возвращает FOP/GIG-lifecycle без потери данных.
- **Verification после rollback:** `pnpm typecheck && pnpm --filter @crm/api test` зелёные;
  `postgres query` — `payment_type` значения консистентны; company-account ledger баланс не сдвинут.

---

## Sources

- `apps/api/src/finance/transactions.service.ts`: `createAdminIncome:961`, `createSeniorIncome:1057`,
  `createDropIncome:1139`, `validateTransaction:1539`, `createPayoutRequest:2061`,
  `applyPayoutPaidCascade:2482` (SENIOR_PENDING_PAYOUT+obligation `:2760-2804`),
  `computeDropDistribution:480`, `computeDropAggregate:553`, `getSummary:2937` (totalIncome `:2991`,
  adminBalances `:3039`), `getAccountantSummary:3193`, `getSeniorSummary:3286`,
  `resolveSeniorShareSnapshot:351`.
- `apps/api/src/finance/pending-settlement.service.ts`: `settleByCompany:151`,
  `settleByCompanySourceTransaction:366`, `SettleFunding:75`.
- `apps/api/src/finance/senior-share-resolver.ts` (резолвер-образец для `resolveDropShare`).
- `apps/api/src/finance/company-account-balance.ts:21-45,130-186` (ledger SSOT).
- `apps/api/src/invoices/invoices.service.ts:142-202` (`autoCreateForSeniorPayout` gate `:147`).
- `apps/api/src/database/schema.ts`: `transactionTypeEnum:57-107`, `pendingObligationDebtorTypeEnum:115`,
  `projects.paymentType:299`, `dropId:284`, `seniorSharePercentOverride:309`, `users.dropSharePercent:202`.
- `apps/api/src/projects/projects.service.ts`: override CRUD create `:604-725` / update `:732-804`,
  `mapProject:120-209`.
- `apps/web/app/routes/_authenticated/finance/constants.ts:4,67` (exhaustive `Record<TransactionType>`).
- `apps/web/app/routes/_authenticated/finance/components/dialogs/CreateTransactionDialog.tsx`
  (`availableTypes:127-134`, receiver-Select SALARY `:572-634`, DROP_INCOME `:342`).
- `docs/design/drop-share-override-and-receiver.md` (spec — Surface B устарел под контракт).
- WIP `119e3f60` (M1 shared-схемы — частичный cherry-pick, D7).
- `apps/api/src/database/seed.ts:968+` (`notesPaymentType` — interviews, не projects; GamingTec не в seed).
- Правила: `.claude/rules/common/{version-pins,zone-of-write,git-policy,model-routing,design-gate,
design-fidelity-review}.md`. Память: `project_phase8_redefined_company_account`,
  `project_accounting_migration`, `project_drop_attach_2026_07_12`, `feedback_mocked_e2e_guards`,
  `project_mega_audit_2026_07_03` (BIZ-02 double-credit урок).
