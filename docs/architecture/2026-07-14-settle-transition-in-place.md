# ADR 2026-07-14 — In-place transition обязательства «Ожидаемая выплата дропу/синьору» PENDING_PAYMENT → PAID

## Status

**Proposed** (реализация — ПОСЛЕ merge PR #374; см. §Конфликт-окно). Требует user-approval перед стартом.

---

## Context

### Симптом (репорт владельца с прода)

Закрытие обязательства «Ожидаемая выплата дропу» / «Доля синьора» (кнопка «Выплатить» на
`SENIOR_PENDING_PAYOUT` / `DROP_PENDING_PAYOUT` строке) **создаёт вторую транзакцию** вместо смены
статуса первой. Исходная IOU-строка при этом **навсегда висит** в статусе `PENDING_PAYMENT`
(«Ожидает выплаты»), а рядом появляется отдельная `SENIOR_INCOME` / `PAYOUT_DROP` (PAID).

Требование владельца: обязательство **не должно пропадать** и **не должно порождать вторую
транзакцию** — оно должно менять статус `PENDING_PAYMENT → PAID` **в месте (in-place)**.

### Как устроено сейчас (проверено по коду)

**Booking обязательства** — `TransactionsService.bookCompanyObligations`
(`apps/api/src/finance/transactions.service.ts:2702`). Вызывается из ДВУХ мест:

1. `declareUsdtProjectIncome` (`:1199`) — ADMIN декларирует USDT-приход → `ADMIN_INCOME`(PAID) +
   senior IOU (`SENIOR_PENDING_PAYOUT`) + drop IOU (`DROP_PENDING_PAYOUT`).
2. `applyPayoutPaidCascade`, drop-ветка (`:3115`) — оплата drop-payout → прямой `PAYOUT_DROP`
   (доля дропа) + senior IOU (`SENIOR_PENDING_PAYOUT`); drop-IOU здесь НЕ создаётся (`drop:null`).

Каждый IOU: `type ∈ {SENIOR_PENDING_PAYOUT, DROP_PENDING_PAYOUT}`, `status=PENDING_PAYMENT`,
`currency=USDT`, `senderLabel='COMPANY'`, `receiverId=creditor`, `fundingSource=null`, плюс строка
`pending_obligations` (`debtorType='COMPANY'`, `sourceTransactionId → IOU tx`, `status='PENDING'`).

**Settle** — `PendingSettlementService.settleByCompany`
(`apps/api/src/finance/pending-settlement.service.ts:246`):

1. **Conditional UPDATE** `pending_obligations` `PENDING → PAID` `WHERE status='PENDING'` `.returning()`
   — атомарный TOCTOU-guard от двойного клика (единственный источник истины против гонки; резерва
   в виде unique-index на этом переходе нет). **← инвариант, ломать нельзя.**
2. Если company-funded + COMPANY-долг: `pg_advisory_xact_lock` + re-read баланса + отказ уводить счёт
   в минус. **← инвариант.**
3. **INSERT новой транзакции**: `type = isDropObligation ? 'PAYOUT_DROP' : 'SENIOR_INCOME'`,
   `status=PAID`, `fundingSource = COMPANY_ACCOUNT`-маркер (если company-funded), sender/currency по
   выбору funding. **← это и есть «вторая строка».**
4. Backfill `pending_obligations.closingTransactionId → <id новой строки>`.
5. Post-commit (вне транзакции): `autoCreateForSeniorPayout(<SENIOR_INCOME id>)`.

Исходная `*_PENDING_PAYOUT` строка **не трогается** → фантом «Ожидает выплаты».

### Silo-потребители созданной строки (что именно надо не сломать)

| #   | Потребитель                       | Файл                                                                | На что завязан сегодня                                                                                                                                                                                                                                    |
| --- | --------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Леджер счёта компании             | `company-account-balance.ts:117`                                    | debit-термы `SENIOR_INCOME(PAID, fundingSource=COMPANY_ACCOUNT, USDT)` и `PAYOUT_DROP(PAID, COMPANY_ACCOUNT, USDT)`                                                                                                                                       |
| 2   | Баланс дропа                      | `computeDropAggregate` (`transactions.service.ts:561`)              | `received = Σ PAYOUT_DROP(PAID, receiverId=drop)`; `sent = Σ PAYOUT_DROP(PAID, senderId=drop)`. C6: senderId≠drop → не double-count                                                                                                                       |
| 3   | Инвойс синьору                    | `autoCreateForSeniorPayout` (`invoices.service.ts:142`)             | гейт `tx.type === 'SENIOR_INCOME'`                                                                                                                                                                                                                        |
| 4   | C4 totalIncome                    | `getSummary` (`transactions.service.ts:3315-3342`, monthly `:3463`) | `settlementTxIds = Set(pending_obligations.closingTransactionId)`; `SENIOR_INCOME` учитывается в доход **только если** `!settlementTxIds.has(id)`                                                                                                         |
| 5   | ADMIN_PERSONAL vs COMPANY_ACCOUNT | settle §3                                                           | COMPANY: `senderId=null`, `senderLabel='COMPANY'`, `currency=USDT`, marker=`COMPANY_ACCOUNT`. ADMIN_PERSONAL: `senderId=admin`, `senderLabel=admin.displayName`, `currency∈{USD,USDT}`, marker=`null` (списание ловится `adminBalances.sent` по senderId) |

**Ключевое наблюдение.** Все пять потребителей ключуются на **финальную форму** строки —
`(type=SENIOR_INCOME/PAYOUT_DROP) AND (status=PAID) AND (funding-маркеры)`. IOU-тип
(`*_PENDING_PAYOUT`) не участвует ни в одном money-терме: ни в леджере, ни в drop-агрегате, ни в
income-фильтре C4. Поэтому если **переименовать сам IOU-row в финальный тип при флипе**, вся
цепочка потребителей продолжает работать без единой правки.

### Схема / инварианты БД (проверено)

- `pending_obligations.sourceTransactionId` → `transactions.id`, **`onDelete: 'restrict'`**
  (нельзя удалить IOU-строку, пока на неё ссылается obligation).
- `pending_obligations.closingTransactionId` → `transactions.id`, `onDelete: 'set null'`.
- `uq_pending_obligations_source_pending` — partial-unique на `sourceTransactionId` `WHERE status='PENDING'`
  (одно PENDING-обязательство на исходную транзакцию; PAID/CANCELLED не затрагиваются).
- `transaction_type` — pgEnum без CHECK-ограничений на переходы: `UPDATE ... SET type=...` разрешён.

---

## Decision

### Рекомендуемая модель: **сменить `type` при флипе** (Option A), НЕ «type ∈ pending-set AND status=PAID» (Option B)

`settleByCompany` вместо `INSERT` новой строки делает **`UPDATE` той же IOU-транзакции**
(`sourceTransactionId`):

- `SENIOR_PENDING_PAYOUT → type='SENIOR_INCOME'`, `DROP_PENDING_PAYOUT → type='PAYOUT_DROP'`;
- `status: PENDING_PAYMENT → PAID`;
- стемпит funding-поля ровно как сегодня штампует «вторую строку»: `fundingSource` (маркер или null),
  `senderId`, `senderLabel`, `currency`, для senior — `validatedBy/validatedAt`;
- `closingTransactionId := sourceTransactionId` (self-reference — та же строка и есть «закрывающая»);
- **`payoutRequestId := null`** (сброс — см. ниже, критично);
- сохраняем существующий порядок: `resolveSource(...)` (чтение `sourceType`-дискриминатора) —
  ДО транзакции; TOCTOU-claim на `pending_obligations` — первым в транзакции; флип IOU-строки — после
  выигрыша claim.

**Confidence: HIGH.** Флипнутая строка становится **байт-в-байт эквивалентна** сегодняшней «второй
строке» (тот же `type` + `status` + funding-маркеры), отличаясь лишь тем, что переиспользует id
исходного IOU, а не аллоцирует новый. Поэтому §1-§5 потребителей не требуют правок.

#### Почему НЕ Option B (оставить `*_PENDING_PAYOUT`, завязать всё на `type ∈ pending-set AND status=PAID`)

| Критерий                                        | Option A (сменить type)                     | Option B (оставить type + дуальный предикат)                          |
| ----------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| Правки в леджере (`company-account-balance.ts`) | **0** (термы уже совпадают)                 | +2 новых терма `*_PENDING_PAYOUT(PAID,COMPANY_ACCOUNT)`               |
| Правки в `computeDropAggregate`                 | **0**                                       | +credit-терм `DROP_PENDING_PAYOUT(PAID,receiverId=drop)`              |
| Правки в `autoCreateForSeniorPayout`            | **0**                                       | расширить гейт на `SENIOR_PENDING_PAYOUT AND PAID`                    |
| Blast-radius (finance money-surface)            | 1 метод                                     | 3+ файла, новый инвариант «дуальный предикат везде консистентен»      |
| Рендер строки в UI                              | `Приход синьора / Оплачено` (= как сегодня) | `Ожидаемая выплата синьору / Оплачено` (странная пара, нужен relabel) |
| Риск ledger-drift от забытого потребителя       | низкий                                      | высокий (легко пропустить один silo → расхождение денег)              |

Option A побеждает по всем осям: минимальный blast-radius на финансовой поверхности, ноль нового
дублирующего инварианта, флипнутая строка визуально и семантически совпадает с сегодняшней
settle-строкой. Battle-tested инварианты (леджер-термы, C6, invoice-гейт, C4-дискриминатор)
остаются нетронутыми. **Рекомендация: Option A.**

#### Критично: сброс `payoutRequestId := null` при флипе (Confidence: HIGH)

IOU из cascade-ветки (`:3115`) несёт `payoutRequestId = requestId`. Если не сбросить, флипнутая
`SENIOR_INCOME` останется с этим `payoutRequestId` и:

- попадёт в выборку `autoCreateForPayout` (агрегация `SENIOR_INCOME/DROP_INCOME` по `payoutRequestId`);
- будет матчиться `findOne`-enrichment (`transactions.service.ts:938` — `SENIOR_INCOME AND payoutRequestId=X`
  для проброса `seniorSharePercent` в карточку PAYOUT).

Сегодняшняя settle-`SENIOR_INCOME` имеет `payoutRequestId=null` (settleByCompany его не ставит).
Сброс сохраняет байт-идентичность и исключает bleed в income-агрегацию/enrichment. Audit-связь не
теряется: `pending_obligations.sourceTransactionId`/`closingTransactionId` + `notes` («Выплата
senior IOU (obligation X)») + `projectId` остаются.

#### Осознанная косметическая дельта (не money)

Флипнутая строка **сохраняет** `seniorSharePercent`/`dropSharePercent`(+`...Source`) с IOU (сегодняшняя
settle-строка их не несёт). Money-потребителей у этих снапшотов на settle-строке нет
(`computeDropDistribution` читает долю с `DROP_INCOME`, не с settle-строки; enrichment отсечён сбросом
`payoutRequestId`). Эффект — только бейдж «Доля: X%». Рекомендация: **сохранить** (данные корректны);
задокументировать как намеренную дельту. Допустимо и обнулить — на выбор Coder'а, обосновать в PR.

### Ответы по каждому потребителю (Option A)

| #   | Потребитель                              | Как меняется при Option A                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Леджер**                               | **Без изменений.** Флипнутая строка — `SENIOR_INCOME`/`PAYOUT_DROP` с `fundingSource=COMPANY_ACCOUNT`,`currency=USDT` → её ловят СУЩЕСТВУЮЩИЕ термы `companySeniorPayouts`/`companyDropPayouts`. Credit-сторона (income `ADMIN_INCOME`/`PAYOUT` COMPANY_ACCOUNT) не трогается → netting идентичен. Новый терм НЕ нужен.                                          |
| 2   | **Баланс дропа**                         | **Без изменений.** Флип `DROP_PENDING_PAYOUT → PAYOUT_DROP` (receiverId=drop) → кредитуется `received`. C6 цел: COMPANY-funded `senderId=null`; ADMIN_PERSONAL `senderId=admin` — оба ≠ drop → не считаются `sent`. До флипа `DROP_PENDING_PAYOUT` невидим агрегату (все термы требуют `PAYOUT_DROP`) → нет double-count.                                        |
| 3   | **Инвойс синьору**                       | **Без изменений в invoice-сервисе.** Флипнутая строка имеет `type='SENIOR_INCOME'` → `autoCreateForSeniorPayout(<её id>)` проходит гейт. Триггерим по id флипнутой строки (= sourceTransactionId). Drop-флип (`PAYOUT_DROP`) инвойс не триггерит (Q6, как сегодня).                                                                                              |
| 4   | **C4 totalIncome**                       | **Без изменений в getSummary.** `closingTransactionId := sourceTransactionId` → id флипнутой `SENIOR_INCOME` ∈ `settlementTxIds` → исключён из `totalIncome` и месячной серии (её gross уже учтён как `DROP_INCOME`/`ADMIN_INCOME`). `PAYOUT_DROP` в income-фильтр не входит вовсе.                                                                              |
| 5   | **ADMIN_PERSONAL vs COMPANY_ACCOUNT**    | Флип штампует те же funding-поля, что сегодня «вторая строка». COMPANY_ACCOUNT → списание через леджер-терм. ADMIN_PERSONAL → `senderId=admin`, marker=null → списание ловится `adminBalances.sent` (senderId=admin) в getSummary — **как сегодня, байт-в-байт**. Валютный guard ADMIN_PERSONAL (только USD/USDT, BIZ-03) сохраняется.                           |
| 6   | **Тип vs статус**                        | Рекомендация — **сменить `type`** (обоснование выше).                                                                                                                                                                                                                                                                                                            |
| 7   | **closingTransactionId + оба источника** | `closingTransactionId := sourceTransactionId` (self). Фикс живёт в `settleByCompany`, а его вызывают ОБА источника IOU (declareUsdtProjectIncome `:1199` и applyPayoutPaidCascade `:3115`) через ту же `pending_obligations`-строку и тот же `settleByCompanySourceTransaction` → **автоматически покрыты оба**. `bookCompanyObligations` (booking) не меняется. |
| 8   | **Миграция прод-данных**                 | Нужна (UX-cleanup существующих «завешенных» пар), НЕ money-critical (леджер уже корректен). См. §Data-fix.                                                                                                                                                                                                                                                       |

### TOCTOU / идемпотентность (не ломаем)

- Единственный гейт гонки — conditional UPDATE `pending_obligations` `PENDING → PAID .returning()`.
  Остаётся первым в транзакции; проигравший получает 0 строк → `throw` → rollback (флип IOU не
  происходит). Двойной клик безопасен.
- Флип IOU-строки идёт ПОСЛЕ выигрыша claim → выполняется ровно один раз. Defense-in-depth (опц.):
  `UPDATE transactions ... WHERE id=sourceTx AND status='PENDING_PAYMENT'`.
- Advisory-lock компании (`lockCompanyAccount`) + balance-gate — без изменений, только для
  `debitsCompanyAccount`.
- `settleByCompanySourceTransaction` не меняется (делегирует в `settleByCompany`).

---

## Data-fix (прод) — §8

### Нужен ли: ДА (UX), но НЕ money-critical

На проде уже есть «завешенные» пары: фантом `*_PENDING_PAYOUT`(PENDING_PAYMENT) + settle-строка
`SENIOR_INCOME`/`PAYOUT_DROP`(PAID), `pending_obligations.status=PAID`,
`closingTransactionId` указывает на settle-строку.

**Леджер на проде уже корректен**: фантом `*_PENDING_PAYOUT` не участвует ни в одном money-терме,
а повторный settle заблокирован (obligation уже PAID → `settleByCompanySourceTransaction` находит
`WHERE status=PENDING` = null → 404). То есть data-fix — **косметика** (убрать фантомные «Ожидает
выплаты» строки + кнопку «Выплатить»), не деньги. Может выполняться **после** деплоя, без freeze.

### Целевые строки (идемпотентный предикат)

Пары, где `pending_obligations.status='PAID'` AND `closingTransactionId IS NOT NULL` AND
`closingTransactionId <> sourceTransactionId` AND строка `sourceTransactionId` имеет
`type ∈ {SENIOR_PENDING_PAYOUT, DROP_PENDING_PAYOUT}` AND `status='PENDING_PAYMENT'`.
(Уже схлопнутые новым кодом пары имеют `sourceTransactionId = closingTransactionId` → пропускаются →
идемпотентность.)

### Рекомендуемый скрипт: repoint + delete фантома (Confidence: MED)

Приводит старые пары к новой single-row-модели (`sourceTransactionId = closingTransactionId = единственная строка`):

```sql
-- Выполнять в ОДНОЙ транзакции. Прогнать сначала как SELECT (dry-run), сверить count.
BEGIN;

-- 0) DRY-RUN: сколько фантомов схлопнется (сверить с ожидаемым числом hung-пар).
SELECT o.id AS obligation_id, o.source_transaction_id AS phantom_id,
       o.closing_transaction_id AS settlement_id, src.type AS phantom_type
FROM pending_obligations o
JOIN transactions src ON src.id = o.source_transaction_id
WHERE o.status = 'PAID'
  AND o.closing_transaction_id IS NOT NULL
  AND o.closing_transaction_id <> o.source_transaction_id
  AND src.type IN ('SENIOR_PENDING_PAYOUT','DROP_PENDING_PAYOUT')
  AND src.status = 'PENDING_PAYMENT';

-- 1) Repoint: sourceTransactionId → settlement-строку (снимает FK restrict с фантома;
--    obligation уже PAID, поэтому uq_pending_obligations_source_pending (WHERE PENDING) не задет).
UPDATE pending_obligations o
SET source_transaction_id = o.closing_transaction_id, updated_at = now()
FROM transactions src
WHERE src.id = o.source_transaction_id
  AND o.status = 'PAID'
  AND o.closing_transaction_id IS NOT NULL
  AND o.closing_transaction_id <> o.source_transaction_id
  AND src.type IN ('SENIOR_PENDING_PAYOUT','DROP_PENDING_PAYOUT')
  AND src.status = 'PENDING_PAYMENT';

-- 2) Delete фантома (после repoint на него нет входящих FK: sourceTransactionId переставлен,
--    closingTransactionId никогда не указывал на фантом, инвойса/подписи у PENDING-IOU нет).
DELETE FROM transactions t
WHERE t.type IN ('SENIOR_PENDING_PAYOUT','DROP_PENDING_PAYOUT')
  AND t.status = 'PENDING_PAYMENT'
  AND NOT EXISTS (SELECT 1 FROM pending_obligations o WHERE o.source_transaction_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM pending_obligations o WHERE o.closing_transaction_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM invoice_signatures s WHERE s.transaction_id = t.id);

-- 3) Верификация ПЕРЕД COMMIT: 0 фантомных PENDING_PAYMENT IOU у закрытых обязательств.
SELECT count(*) AS remaining_phantoms
FROM pending_obligations o JOIN transactions src ON src.id = o.source_transaction_id
WHERE o.status='PAID' AND src.type IN ('SENIOR_PENDING_PAYOUT','DROP_PENDING_PAYOUT')
  AND src.status='PENDING_PAYMENT';  -- ожидаем 0

COMMIT;  -- только если count = 0 и dry-run совпал; иначе ROLLBACK.
```

### Fallback (zero-delete) — если prod-DELETE сочтут рискованным

Просто нейтрализовать статус фантома (без удаления/repoint):

```sql
UPDATE transactions t SET status='PAID', updated_at=now()
FROM pending_obligations o
WHERE o.source_transaction_id = t.id AND o.status='PAID'
  AND t.type IN ('SENIOR_PENDING_PAYOUT','DROP_PENDING_PAYOUT') AND t.status='PENDING_PAYMENT';
```

Убирает «Ожидает выплаты» + кнопку «Выплатить» (гейт требует `status=PENDING_PAYMENT`). Компромисс:
исторически остаются ДВЕ PAID-строки (фантом «Ожидаемая выплата.../Оплачено» + settle-строка).
Money-safe: `*_PENDING_PAYOUT(PAID)` не входит ни в один money-терм. **НЕ достигает single-row**, но
снимает острый симптом при нулевом риске удаления.

**Рекомендация:** primary = repoint+delete (даёт настоящую single-row-модель владельца); fallback =
status-neutralize при вето на DELETE. В обоих случаях: dry-run → сверка count → security-review →
исполнение Master'ом с прод-доступом (`docker exec psql`, как accounting-migration), НЕ агентом.

---

## Consequences

**Плюсы:** обязательство транзитится в PAID in-place, фантом «Ожидает выплаты» исчезает, второй
строки нет. Blast-radius — один метод `settleByCompany`; ноль правок в леджере / drop-агрегате /
invoice-сервисе / C4. Все инварианты (TOCTOU, advisory-lock, C6, invoice, C4) сохранены.

**Минусы / trade-offs:**

- `settleByCompany` меняет семантику с INSERT на UPDATE-in-place — ~26 spec'ов строят
  `new TransactionsService(...)`/мокируют settle; тесты settle нужно переписать под флип
  (проверять, что исходная строка сменила type+status и НЕ появилась вторая).
- `createdBy` флипнутой строки остаётся автором booking'а (не settler'а). Для senior settler
  фиксируется в `validatedBy`; для drop settler в поле не фиксируется — минорная audit-дельта,
  при желании писать settler в `notes`.
- Data-fix (primary) удаляет прод-строки — требует dry-run + security-review + ручное исполнение.

**Не-цели:** не меняем момент кредитования баланса дропа (owed-but-unpaid по-прежнему невидим до
settle); не трогаем credit-сторону леглера; не меняем `bookCompanyObligations`.

## Конфликт-окно (координация — Master)

PR **#374** (`feature/transaction-receipts`) активно правит те же файлы: `pending-settlement.service.ts`
(+30) и `transactions.service.ts` (+245/−123), плюс `SettleSeniorPayoutDialog`. **Реализация этого ADR
стартует ПОСЛЕ merge #374** (или ребейзом на него) — иначе гарантированный конфликт в `settleByCompany`.
Координацию порядка (merge #374 → старт) держит Master. `security-reviewer` на реализации — ОБЯЗАТЕЛЕН
(finance / company-account / RBAC money-path).

## Rollback

Изменение — docs-only (этот ADR). Откат ADR:

```bash
git revert <commit>            # откатить коммит ADR, ИЛИ
git checkout origin/main -- docs/architecture/2026-07-14-settle-transition-in-place.md
# закрыть PR docs/adr-settle-transition без merge
```

Expected state: `docs/architecture/` без файла `2026-07-14-settle-transition-in-place.md`; ветка
`main` не затронута. Verification: `git status` чист, `ls docs/architecture | grep settle-transition`
пусто.

Откат РЕАЛИЗАЦИИ (когда напишут код, отдельные PR):

- Backend-флип: `git revert` PR настройки settle — вернёт INSERT-семантику (фантом вернётся, но
  деньги корректны).
- Data-fix primary (delete): необратим построчно; поэтому dry-run + бэкап затронутых строк
  (`\copy (SELECT ...) TO ...`) ПЕРЕД COMMIT — восстановление из бэкапа при регрессе.

## Декомпозиция реализации (ревизия task-файлов)

| Task                         | Агент        | Зона                                   | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Модель                          |
| ---------------------------- | ------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `task-coder-settle-in-place` | Coder        | `apps/api/src/finance/**`              | Переписать `settleByCompany`: UPDATE-in-place исходной IOU-строки (type-флип + status + funding-поля + `closingTransactionId=self` + `payoutRequestId=null`); сохранить TOCTOU-claim, advisory-lock, gate, invoice-триггер по флипнутому id; порядок resolve→claim→flip. Unit+integration тесты: double-settle идемпотентность (404/rollback), ledger-нейтральность (баланс до/после = income − settle), drop-credit + C6 (senderId≠drop), C4-исключение (settlementTxIds), senior-invoice триггерится, оба funding (COMPANY_ACCOUNT/ADMIN_PERSONAL + BIZ-03 валютный guard), оба источника IOU (declare + cascade). | opus (finance расчётная логика) |
| `task-devops-settle-datafix` | DevOps/Coder | `apps/api/drizzle/manual/**` + runbook | Идемпотентный guarded SQL (repoint+delete primary; status-neutralize fallback) + dry-run SELECT + бэкап затронутых строк. Исполняет Master на проде (`docker exec psql`) — НЕ CI.                                                                                                                                                                                                                                                                                                                                                                                                                                    | —                               |
| `task-autotest-settle-e2e`   | AutoTest     | `apps/e2e/**`                          | E2E: ADMIN/ACCOUNTANT «Выплатить» на `*_PENDING_PAYOUT` → строка транзитится в PAID (одна строка, «Оплачено»), «Выплатить» исчезает, второй строки нет; баланс дропа/леджер компании корректны.                                                                                                                                                                                                                                                                                                                                                                                                                      | sonnet                          |

`security-reviewer` — MANDATORY на `task-coder-settle-in-place` и на data-fix. Design-gate не
применяется (UI визуально не меняется — та же строка, другой лейбл статуса; manual-qa проверяет в UT,
что рендер `Приход синьора/Доля дропа + Оплачено` когерентен и фантома нет).

## Sources

- `apps/api/src/finance/pending-settlement.service.ts:246-365` — `settleByCompany` (INSERT-вторая-строка + TOCTOU-claim + advisory-lock).
- `apps/api/src/finance/transactions.service.ts:2702-2795` — `bookCompanyObligations` (booking IOU); `:1199` (declare), `:3115` (cascade drop-ветка) — два источника.
- `apps/api/src/finance/company-account-balance.ts:117-219` — леджер-термы `SENIOR_INCOME`/`PAYOUT_DROP`(COMPANY_ACCOUNT).
- `apps/api/src/finance/transactions.service.ts:561-634` — `computeDropAggregate` (C6: received/sent по PAYOUT_DROP).
- `apps/api/src/invoices/invoices.service.ts:142-149` — `autoCreateForSeniorPayout` (гейт `type==='SENIOR_INCOME'`); `:176` autoCreateForPayout (агрегация по payoutRequestId — почему сброс).
- `apps/api/src/finance/transactions.service.ts:3315-3342,3463-3471` — C4 `settlementTxIds` дискриминатор (totalIncome + monthly); `:938` findOne enrichment.
- `apps/api/src/database/schema.ts:681-722` — `pending_obligations` FK (`sourceTransactionId` restrict, `closingTransactionId` set-null, `uq_..._source_pending`).
- `apps/web/.../finance/components/TransactionRow.tsx:330-333` — гейт «Выплатить» (`type∈pending-set AND PENDING_PAYMENT`); `constants.ts:27,43,49,51` — лейблы.
- PR #374 (`gh pr view 374`) — конфликт-окно: `pending-settlement.service.ts` +30, `transactions.service.ts` +245/−123.
