# task-drop-phase4b-payment-channels

## Агент: coder

## Приоритет: high

## Ветка: feat/drop-role-phase4b-channels

## Зависит от: Phase 4-A (merged в main: PR #69 — балансы + типы транзакций + pending_obligations)

## Контекст

**Phase 4-B** — реализация трёх каналов оплаты дропом + UI «Платить компании» + TOВ balance card в `/crm/stats`.

Phase 4-A в main даёт инфраструктуру: новые типы транзакций, `BalanceService`, endpoints `/api/balances/*`. Phase 4-B построит **бизнес-логику** трёх каналов и UI вокруг них.

## Модель из спека владельца

### Канал 1 — Crypto USDT (drop → wallets directly, без смарт-контракта пока)

Drop отправляет USDT с своего кошелька на 3 wallets (senior + Maksym + Kostya).
**Создаётся 3 транзакции** (после ручного подтверждения drop'ом или etherscan watch):

- `SENIOR_INCOME_CRYPTO` $560 (16%) → senior wallet
- `ADMIN_INCOME_CRYPTO` $1295 (37%) → Maksym wallet
- `ADMIN_INCOME_CRYPTO` $1295 (37%) → Kostya wallet

Drop оставляет себе 10% ($350) — НЕ фигурирует.

### Канал 2 — Bank transfer на ТОВ

Drop переводит на ТОВ-счёт. Создаются **2 транзакции**:

- `TOV_INCOME` $3150 (вся партнёрская сумма + senior portion) → TOВ balance +$3150
- `SENIOR_PENDING_PAYOUT` $560 (TOВ owes senior) → запись в `pending_obligations` (debtor_type='TOV')

Senior payment closing — отдельный flow (Phase 4-C).

### Канал 3 — Cash дропа админу

Drop физически отдаёт нал одному из админов. По выбору владельца — **$2590** (вся партнёрская доля) идёт одному админу.
Создаются **2 транзакции**:

- `ADMIN_INCOME_CASH` $2590 → выбранный admin balance
- `SENIOR_PENDING_PAYOUT` $560 → запись в `pending_obligations` (debtor_type='DROP', debtor_user=drop.id)

## Подготовка

1. Прочитай docs/agents/coder.md, docs/agents/CLAUDE-coder.md, docs/agents/memory/coder/lessons.md.
2. Прочитай **Phase 4-A** реализацию (BalanceService, новые типы, pending_obligations table) — она уже в main.
3. Через ast-grep сними карту: где `payPayoutRequest`, `confirmPayout` (Phase 2 и 3 пути), `DROP_INCOME`. Чтобы понять, как новый flow подключается.

## Acceptance Criteria

### AC1. Backend — `PaymentChannelService`

`apps/api/src/finance/payment-channel.service.ts`:

- [ ] `initiateCryptoPayment(incomeId, actor)`:
  - RBAC: caller = drop owner OR ACCOUNTANT/ADMIN.
  - Проверка: tx is DROP_INCOME, status = VALIDATED, нет ещё payment cascade.
  - Возвращает: `{ contractAddress?: string, recipients: [{ userId, address, amount, currency }] }`. На этом этапе contract = null (без смарт-контракта). Recipients — senior + 2 admins с их wallet адресами и долями.
- [ ] `confirmCryptoPayment(incomeId, txHashes: string[], actor)`:
  - txHashes — массив подтверждений из MetaMask (по одному на каждого получателя ИЛИ один если через контракт).
  - Создаёт 3 транзакции (SENIOR_INCOME_CRYPTO + 2× ADMIN_INCOME_CRYPTO) с `payment_method = 'CRYPTO_DIRECT'`, `channel = 'CRYPTO_PERSONAL'`.
  - Закрывает PAYOUT (PENDING_PAYMENT → PAID).
- [ ] `initiateBankPayment(incomeId, actor)`:
  - Возвращает: `{ tovBankDetails: { iban, recipient, reference: 'INV-INC-<id>' }, amount, currency }`.
  - Reference = unique для этой транзакции (для будущего auto-detection).
- [ ] `confirmBankPayment(incomeId, actor)`:
  - RBAC: ACCOUNTANT/ADMIN.
  - Создаёт:
    - `TOV_INCOME` на ТОВ balance, amount = totalAmount (drop отправил $3150).
    - `SENIOR_PENDING_PAYOUT` с debtor_type='TOV', creditor=seniorId, amount = senior's share.
  - Закрывает PAYOUT (PENDING_PAYMENT → PAID).
- [ ] `initiateCashPayment(incomeId, recipientAdminId, actor)`:
  - RBAC: caller = drop owner.
  - Проверка: recipientAdminId — ADMIN, не archived.
  - Создаёт **немедленно** (no etherscan/bank проверки):
    - `ADMIN_INCOME_CASH` amount = partner share total ($2590 в примере = (income − drop share − senior share)), recipient = recipientAdminId.
    - `SENIOR_PENDING_PAYOUT` debtor_type='DROP', debtor_user=dropId, creditor=seniorId, amount = senior share.
  - Закрывает PAYOUT.

### AC2. Endpoints

`apps/api/src/finance/payment-channel.controller.ts`:

- [ ] `POST /api/payments/initiate-crypto` — body `{ incomeId }`. RBAC: DROP (only own) / ACCOUNTANT / ADMIN. Возвращает recipients.
- [ ] `POST /api/payments/confirm-crypto` — body `{ incomeId, txHashes: string[] }`. RBAC: DROP (own) / ACCOUNTANT.
- [ ] `POST /api/payments/initiate-bank` — body `{ incomeId }`. RBAC: DROP (own) / ACCOUNTANT / ADMIN. Возвращает TOВ banking details.
- [ ] `POST /api/payments/confirm-bank` — body `{ incomeId }`. RBAC: ACCOUNTANT / ADMIN (drop сам не подтверждает, бухгалтер видит на счёте).
- [ ] `POST /api/payments/initiate-cash` — body `{ incomeId, recipientAdminId }`. RBAC: DROP (own) / ACCOUNTANT / ADMIN. Создаёт транзакции сразу.

### AC3. Frontend — страница «Платить компании»

`apps/web/app/routes/crm/payments/initiate.$incomeId.tsx`:

- [ ] Доступ: DROP (только если он creditor DROP_INCOME) / ACCOUNTANT / ADMIN. Иначе redirect.
- [ ] Layout:
  - Header: сумма поступления + проект + дата.
  - «Ваша доля» (drop): $350 (или $0 для senior project — но Phase 4-B только drop проекты).
  - «Оплатить компании»: $3150 (90%).
  - **3 карточки каналов**:
    1. 💎 **USDT (crypto)**: показывает wallets + amounts + газ estimate. Кнопка «Подключить MetaMask» (placeholder для Phase 5).
    2. 🏦 **Bank UAH на ТОВ**: показывает IBAN + сумму UAH (через NBU) + reference. Кнопки «Скопировать реквизиты» + «Я перевёл».
    3. 💵 **Cash админу**: Select админа (Maksym/Kostya). Кнопка «Передал нал, подтвердить».

- [ ] При клике на канал:
  - Crypto: пока MetaMask интеграции нет — показать инструкцию «отправьте amount X на адрес Y» + поле для ввода txHash + кнопка «Подтвердить отправку». Submit → POST `/api/payments/confirm-crypto`.
  - Bank: «Я перевёл» → toast «Спасибо. Бухгалтер подтвердит зачисление». Backend: не создаёт транзакций сразу. Накопляется в pending. Бухгалтер позже подтверждает через ACCOUNTANT UI.
  - Cash: «Передал нал, подтвердить» → POST `/api/payments/initiate-cash` с recipientAdminId. Транзакции создаются сразу.

### AC4. Frontend — кнопка «Платить компании» на профиле дропа

- [ ] `apps/web/app/components/user-profile/tabs/FinanceTab.tsx`:
  - Для drop user: в списке транзакций (там где раньше «Добавить приход») — теперь рядом с каждым DROP_INCOME (статус VALIDATED, без cascade-payouts) кнопка **«Платить компании»**.
  - Click → navigate to `/crm/payments/initiate/<incomeId>`.

### AC5. Frontend — TOВ balance card на /crm/stats

- [ ] `apps/web/app/routes/crm/stats.tsx` (если такая страница, иначе создать):
  - Карточка **«Баланс ТОВ»** вверху, видна только ADMIN/ACCOUNTANT (RBAC через `useRoleGuard`).
  - Контент:
    - Главное число: current TOВ balance в USD (большим шрифтом).
    - Breakdown под ним:
      - Income: $X
      - Dividends paid: $Y
      - Expenses: $Z
      - Tax: $W
  - Loading skeleton пока fetch идёт.
- [ ] Запрос через `useTOVBalance()` hook → `GET /api/balances/tov`.

### AC6. Frontend — список балансов участников на /crm/stats (для ADMIN/ACCOUNTANT)

- [ ] Под TOВ card — секция «Балансы участников»:
  - Список admin'ов с их balances (Maksym/Kostya).
  - Список senior'ов с их balances.
  - Компактные строки: name + role + balance.

### AC7. Regression — Phase 2/3 пути не сломаны

- [ ] Если drop вызывает `payPayoutRequest` (Phase 2) — auto-50/50 cascade всё ещё работает.
- [ ] Если ACCOUNTANT вызывает `confirmPayout` (Phase 3) — manual confirm работает.
- [ ] Phase 4-B каналы — **четвёртый альтернативный путь**, не заменяет существующие.

### AC8. UT обязательно

- [ ] `apps/api/src/finance/payment-channel.spec.ts`:
  - Crypto path: 3 транзакции созданы с правильными amounts + types + channels.
  - Bank path: TOV_INCOME + SENIOR_PENDING_PAYOUT (debtor_type=TOV).
  - Cash path: ADMIN_INCOME_CASH + SENIOR_PENDING_PAYOUT (debtor_type=DROP).
  - RBAC: SENIOR/JUNIOR/HR → 403 на initiate\*. DROP — only own income.
  - Edge: уже-paid DROP_INCOME → 400.

### AC9. Локально

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @crm/web build
pnpm --filter @crm/e2e test
docker compose down -v && docker compose up -d && pnpm db:migrate && pnpm db:seed
```

Все зелёные.

### AC10. Playwright проверка (через MCP)

Скриншоты `/tmp/drop-phase4b-*.png`:

- [ ] DROP видит «Платить компании» кнопку на /crm/profile FinanceTab.
- [ ] Открыть страницу — 3 канала видимы.
- [ ] Cash channel: выбрать Maksym → submit → транзакции созданы.
- [ ] Bank channel: показать IBAN + копировать.
- [ ] ADMIN видит TOВ balance card на /crm/stats.
- [ ] SENIOR не видит TOВ card.

### AC11. PR

- [ ] Ветка `feat/drop-role-phase4b-channels`.
- [ ] Title: `feat(drop): фаза 4b — payment channels + UI (crypto/bank/cash + TOВ balance card)`.

## Что НЕ нужно

- Smart contract integration — Phase 5.
- Bank auto-detection — Phase 4-Bb (опционально, позже).
- Pending senior settlement UI — Phase 4-C.
- Dividends withdrawal UI — Phase 4-D.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
