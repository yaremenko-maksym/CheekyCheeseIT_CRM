# task-drop-company-debt-and-invoices

## Агент: coder

## Приоритет: high

## Ветка: feat/drop-company-debt-and-invoices

## Зависит от: PR #73 (merged в main — team senior share override)

## Контекст

Бизнес-модель уточнена: **дроп платит ТОЛЬКО компании**. Senior's share — это долг **КОМПАНИИ** перед синьором (не дропа). Дроп после оплаты ничего синьору не должен.

Текущая реализация (после refactor remove ТОВ):

- Crypto channel: drop отправляет USDT на 3 кошелька (senior + 2 admins). 3 транзакции immediately.
- Cash channel: ADMIN фиксирует «drop передал нал», выбирает админа → ADMIN_INCOME_CASH + SENIOR_PENDING_PAYOUT (debtor='DROP').
- Phase 4-C `settleByDrop`: дроп закрывает долг синьору (POST `/api/pending-settlements/:id/settle-drop`).

**Нужно изменить:**

1. Crypto: drop отправляет USDT ТОЛЬКО на админские кошельки (2 транзакции). Senior получает SENIOR_PENDING_PAYOUT (debtor=COMPANY) — компания должна синьору.
2. Cash: ADMIN_INCOME_CASH остаётся, но SENIOR_PENDING_PAYOUT теперь с debtor=COMPANY (не DROP).
3. `settleByDrop` → переименовать в `settleByCompany`. RBAC: ADMIN/ACCOUNTANT (DROP больше НЕ закрывает долги синьорам).
4. Когда company закрывает долг синьору — создаётся SENIOR_INCOME строка → PAID + **триггерится invoice** (как в Phase 2 `payPayoutRequest`).
5. UI: убрать «Долги перед синьорами» с DROP profile (дроп не платит синьорам). Убрать кнопку «Я заплатил синьору».

## Acceptance Criteria

### AC1. Backend — crypto channel refactor

- [ ] В `payment-channel.service.ts.confirmCryptoPayment`:
  - txHashes: теперь массив из 2 (вместо 3) — по одному на каждого админа.
  - Создаёт 2× `ADMIN_INCOME_CRYPTO` (Maksym, Kostya) + 1× `SENIOR_PENDING_PAYOUT` (debtor='COMPANY').
  - Удалить логику создания `SENIOR_INCOME_CRYPTO` для синьора.
- [ ] В `initiateCryptoPayment` — возвращать 2 wallets (admin addresses), без senior wallet.
- [ ] Расчёт сумм: total = admin share total ($amount × adminShare). Senior share остаётся как pending obligation.

### AC2. Backend — cash channel debtor

- [ ] В `payment-channel.service.ts.confirmCashPayment`:
  - SENIOR_PENDING_PAYOUT теперь создаётся с `debtor_type='COMPANY'` (вместо 'DROP').
  - Других изменений в cash flow не делать.

### AC3. Backend — обновить enum debtor_type

- [ ] Добавить 'COMPANY' в enum (миграция).
- [ ] Существующие записи с debtor_type='DROP' (legacy) — оставить как есть (backward compatible).
- [ ] Можно сразу backfill: convert все 'DROP' → 'COMPANY' если есть SENIOR_PENDING_PAYOUT в PENDING_PAYMENT (по решению Coder'а — но не deleting data).

### AC4. Backend — переименовать settleByDrop → settleByCompany

- [ ] В `pending-settlement.service.ts`:
  - `settleByDrop` → `settleByCompany`. RBAC: **только ACCOUNTANT / ADMIN** (DROP убрать).
  - Логика: создать SENIOR_INCOME (новый тип `SENIOR_INCOME_FROM_COMPANY` или использовать существующий `SENIOR_PAID` — решай по месту) → status=PAID. Закрыть SENIOR_PENDING_PAYOUT.
  - **Триггер invoice**: после создания SENIOR_INCOME_FROM_COMPANY → PAID — вызывать `safeAutoCreateInvoice('SENIOR_INCOME', txId)`.
- [ ] Удалить `listDropObligations` + endpoint `GET /api/pending-settlements/drop` (DROP больше не видит долги синьорам).
- [ ] Endpoint `POST /api/pending-settlements/:id/settle-drop` → переименовать в `/settle-company`.
- [ ] `listSeniorObligations` — оставить как есть.

### AC5. Backend — invoice triggers в логичных местах

Помимо текущих 3 триггеров (createSalary / payPayoutRequest / paySalary) — добавь:

- [ ] `settleByCompany` → invoice для SENIOR_INCOME_FROM_COMPANY.
- [ ] **Опционально** (на твоё решение): `confirmPayout` (Phase 3 manual) — стоит ли инвойсить PAYOUT_CONFIRMED? Если решишь нет — оставь комментарий почему. PAYOUT_CONFIRMED — это credit ADMIN, не external entity, скорее нет.
- [ ] **НЕ инвойсить**: `confirmCryptoPayment` / `confirmCashPayment` — это admin internal movements (`ADMIN_INCOME_*`).

### AC6. Frontend — убрать DROP UI для оплаты синьору

- [ ] `apps/web/app/components/user-profile/tabs/FinanceTab.tsx`:
  - Удалить секцию «Долги перед синьорами» для DROP role.
  - Удалить кнопку «Я заплатил синьору» и весь связанный flow.
- [ ] `PendingSettlementDropCard.tsx` — удалить компонент полностью (заменён на company-side flow).
- [ ] `apps/web/app/routes/crm/finance/api.ts` — удалить `listDropObligations`, `settleDropObligation`.

### AC7. Frontend — новая ACCOUNTANT/ADMIN UI

- [ ] Новый компонент `PendingSettlementCompanyCard.tsx` (или модифицировать existing PendingSettlement\*) для ADMIN/ACCOUNTANT:
  - Заголовок: «Долги компании перед синьорами»
  - Подсказка: «Senior-доля от дроп-проекта. Закройте оплатив синьору с кнопкой «Выплатить из компании».»
  - Список: проект, имя синьора, сумма, дата.
  - Кнопка «Выплатить синьору» → POST `/api/pending-settlements/:id/settle-company`. Toast «Выплата проведена».
- [ ] Встроить в `/crm/finance` для ADMIN/ACCOUNTANT.

### AC8. Frontend — SENIOR view остаётся

- [ ] `PendingSettlementSeniorCard` — синьор продолжает видеть pending. Только текст подсказки: «Senior-доля. Закроется когда бухгалтер обработает выплату.» (убрать упоминание дропа как должника).
- [ ] Должник теперь Company — в карточке писать «Должник: Компания · <проект>» вместо «Дроп · <имя>».

### AC9. Frontend — Cash flow на /crm/finance остаётся

- [ ] Кнопка «Cash передан» (admin action button на DROP_INCOME row) — без изменений.
- [ ] `LogCashPaymentDialog` — без изменений.

### AC10. UT обязательно

- [ ] `payment-channel.spec.ts`:
  - confirmCryptoPayment: 2 ADMIN_INCOME_CRYPTO + 1 SENIOR_PENDING_PAYOUT (debtor=COMPANY).
  - confirmCashPayment: ADMIN_INCOME_CASH + SENIOR_PENDING_PAYOUT (debtor=COMPANY).
- [ ] `pending-settlement.spec.ts`:
  - settleByCompany: создаёт SENIOR_INCOME_FROM_COMPANY → PAID + invoice triggered (mock InvoicesService).
  - settleByCompany RBAC: DROP → 403.
  - settleByDrop endpoint больше не существует — удалить тесты.
- [ ] `invoices.spec.ts`:
  - autoCreateForSeniorPayout вызывается на SENIOR_INCOME_FROM_COMPANY (если новый тип).

### AC11. Локально

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @crm/web build
pnpm --filter @crm/e2e test
docker compose down -v && docker compose up -d && pnpm db:migrate && pnpm db:seed
```

Все зелёные.

### AC12. E2E mocks

- [ ] В `apps/e2e/tests/fixtures.ts` — обновить моки: `/api/pending-settlements/drop` удалить, добавить `/api/pending-settlements/company` (если новый).

### AC13. Playwright (через MCP)

- [ ] DROP → /crm/profile?tab=finance → НЕТ секции «Долги перед синьорами».
- [ ] ADMIN → confirmCryptoPayment с 2 txHashes → 2 admin крипты + senior pending (debtor=COMPANY).
- [ ] ADMIN → /crm/finance → видит «Долги компании перед синьорами» card.
- [ ] Click «Выплатить синьору» → SENIOR_INCOME создан + invoice generated (проверь через DB: `invoice_document_id` не null).
- [ ] SENIOR → /crm/finance → видит «Ожидают зачисления» с debtor='Компания' (не Дроп).

### AC14. PR

- [ ] Ветка `feat/drop-company-debt-and-invoices`.
- [ ] Title: `feat(finance): drop платит только компании + invoice на settle-company + cleanup DROP→SENIOR UI`.
- [ ] Body — подробно: модель изменения, list of files changed, invoice triggers added, what's removed from DROP UI.

### AC15. Invoice PDF design refresh

- [ ] **Полностью убрать имена админов** из PDF: подпись только «CheekyCheeseIT» (компания), без «Maksym Yaremenko» / «Kostya». Если в COMPANY_INFO или signature renderer используется persona/имя — заменить на бренд.
- [ ] Использовать **новый brand-логотип** «Wedge Terminal» (см. `feedback_brand_icon` memory + `.claude/skills/logo-designer/` если есть):
  - Логотип сверху по центру (или left header).
  - Outline-стиль, dark=жёлтый / light=графит. Для PDF использовать тёмную версию (на белом фоне).
  - SVG / PNG ассет — если нет в репо, Coder создаёт минимальный (можно через скрипт `apps/api/src/invoices/assets/wedge-logo.{svg,png}`).
- [ ] Улучшить layout PDF:
  - Чистый header: логотип + название компании справа.
  - Метаданные (№ инвойса, дата) в отдельной секции.
  - Транзакция: сумма большим шрифтом, breakdown по проекту.
  - Signature block внизу: «CheekyCheeseIT» под подписью компании. Counterparty signature — имя контрагента.
- [ ] Подвал — короткий «© 2026 CheekyCheeseIT» + ссылка `/verify/<id>`.
- [ ] Если использовался Cyrillic font — оставить.

### AC16. Visual verification PDF

- [ ] Сгенерировать пример PDF локально через invoice trigger (создать тестовую транзакцию → invoice auto-generated → скачать PDF).
- [ ] Проверить:
  - Логотип отображается.
  - Нет упоминаний имён админов.
  - Подпись `CheekyCheeseIT` присутствует.
  - Layout читается.

## Что НЕ нужно

- Менять SALARY invoice flow (он уже работает, только PDF refresh применить).
- Менять payPayoutRequest (Phase 2 cascade) — он остаётся как есть.
- Менять confirmPayout (Phase 3) — оставь как есть (если решишь не добавлять invoice).
- Менять Phase 4-Refactor cash flow logic кроме debtor field.
- Smart contract integration.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
