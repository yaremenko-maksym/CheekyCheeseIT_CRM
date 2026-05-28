# task-payout-dev-simulate-toggle

## Агент: coder
## Приоритет: MEDIUM (UX enhancement для testing payout flow)
## Ветка: feature/invoice-ui (существующая, PR #56 — fix внутрь существующей ветки)

## Контекст

PR #56 содержит split SENIOR payout flow (commit 8da0a15):
- `PayoutDialog` — выбор VALIDATED транзакций → создание `payout_request` со stub `contract_address`
- `PayoutDetailDialog` — показывает адрес контракта + payable amount + список транзакций + поле для tx_hash → submit → backend etherscan stub auto-confirms in dev
- Backend cascade: PAID → autoCreateInvoiceForPayout → COMPANY auto-sign

**Юзер хочет в dev mode иметь возможность сабмитить выплату с явным выбором результата валидации:**
- «✅ Симулировать успех» — backend сразу возвращает success без etherscan call → транзакции PAID + инвойсы созданы
- «❌ Симулировать ошибку» — backend возвращает ошибку (например `400 "Transaction hash invalid"`) → пользователь видит error toast, payout остаётся PENDING_PAYMENT

**Зачем:** возможность быстро прогнать end-to-end payout flow на User Testing без необходимости делать реальную крипто-транзакцию или попадать в timing/race-condition etherscan stub'а. Также позволяет проверять error paths (что показывается юзеру при failed validation).

## AC

- [ ] **AC1: Backend поддерживает `simulateResult` в pay endpoint (только dev)**
  - В DTO для `POST /api/payout-requests/:id/pay` добавить optional поле `simulateResult: 'success' | 'error'` (Zod schema в `packages/shared/src/schemas/finance.ts`)
  - В handler/service: если `NODE_ENV !== 'production'` AND `simulateResult === 'success'` → пропустить etherscan check, сразу выполнить тот же cascade что и при successful real call
  - Если `simulateResult === 'error'` → throw `BadRequestException('Симуляция: транзакция не подтверждена')` (валидное Russian сообщение для UI toast)
  - Если `simulateResult` не передан ИЛИ NODE_ENV === 'production' → текущее поведение (real etherscan / stub auto-confirm)

- [ ] **AC2: Frontend UI toggle в PayoutDetailDialog (только dev)**
  - В `apps/web/app/routes/crm/finance/components/dialogs/PayoutDetailDialog.tsx` добавить UI элемент видимый только при `import.meta.env.DEV` (по аналогии с dev login UI в `crm_/login.tsx`)
  - Recommended UI: radio group или segmented control под полем hash input:
    - Label «🔧 Dev режим: результат валидации»
    - Опции: «✅ Симулировать успех» / «❌ Симулировать ошибку» / «🔗 Реальная проверка»
    - Default selection: «✅ Симулировать успех» (потому что без него etherscan stub работает unpredictably в локальной разработке)
  - Стейт `simulateMode` в компоненте, передаётся в `financeApi.payPayoutRequest(payoutId, { txHash, simulateResult: ... })`
  - В production build (`import.meta.env.DEV === false`) UI блок не рендерится → запрос идёт без `simulateResult` поля → backend ведёт себя как прежде

- [ ] **AC3: API client updated**
  - В `apps/web/app/routes/crm/finance/api.ts` (метод `payPayoutRequest`) добавить optional `simulateResult` в body type
  - Update `packages/shared/src/schemas/finance.ts` Zod schema accordingly

- [ ] **AC4: Error path работает**
  - При выборе «❌ Симулировать ошибку» и клике «Подтвердить оплату»:
    - Backend возвращает 400 с message
    - Frontend `payMutation.onError` показывает toast с message
    - Dialog НЕ закрывается (юзер может изменить выбор и попробовать снова)
    - Payout request остаётся в PENDING_PAYMENT
  - Проверка: после error можно перевыбрать «✅ Симулировать успех» и сабмит проходит

- [ ] **AC5: Success path работает идентично current flow**
  - При выборе «✅ Симулировать успех» и сабмите:
    - Backend без etherscan call → transactions → PAID, payout → PAID
    - Cascade: autoCreateInvoiceForPayout → инвойсы созданы → COMPANY auto-sign
    - Notification INVOICE_SIGN_REQUIRED для синьера (если уже работает в `notifications.service.ts`)
    - Frontend: dialog закрывается, toast «Оплата подтверждена», queries invalidated

## Файлы (ожидаемые изменения)

- `packages/shared/src/schemas/finance.ts` — submit schema + simulateResult enum
- `apps/api/src/finance/transactions.service.ts` (или wherever pay endpoint) — early return для simulate
- `apps/api/src/finance/transactions.controller.ts` (если controller-level body validation) — accept simulateResult
- `apps/web/app/routes/crm/finance/api.ts` — payPayoutRequest signature
- `apps/web/app/routes/crm/finance/components/dialogs/PayoutDetailDialog.tsx` — radio UI

## Definition of Done

- ac_verified: 1,2,3,4,5
- Manual smoke (локально, `pnpm dev`):
  1. Залогиниться как SENIOR (через dev login — task-fix-auth-localhost должен быть смержен first)
  2. Создать PayoutRequest из VALIDATED транзакций
  3. Открыть PayoutDetailDialog → видеть radio group «Dev режим»
  4. Выбрать «Симулировать ошибку» + вставить любой hash → клик «Подтвердить оплату» → toast с ошибкой, dialog open
  5. Выбрать «Симулировать успех» → клик → success toast, dialog закрыт, транзакции PAID, инвойсы созданы
  6. Проверить колокольчик уведомлений: должно появиться «Инвойс ожидает вашей подписи»
- Unit tests pass: `pnpm test`
- Typecheck pass: `pnpm typecheck`
- ESLint pass: `pnpm lint`
- E2E локально перед push: `pnpm --filter @crm/e2e test`

## Out of scope

- E2E test для simulate toggle (AutoTest сделает в отдельном task после merge)
- Изменения backend etherscan logic вне dev simulate (real flow в prod не трогаем)
- Persistence simulate choice (не сохраняем — каждый раз default «success»)
- UI для ADMIN-override simulate (только для SENIOR/самих пользователей)

## Заметки для Coder

- Target branch УЖЕ существует: `feature/invoice-ui` (PR #56 OPEN). Делать `git checkout feature/invoice-ui` (НЕ создавать новую ветку).
- Перед началом — `git pull origin feature/invoice-ui` чтобы быть на актуальной голове (8da0a15).
- Не трогать существующие AC из 8da0a15 — это additive фича.
- ВАЖНО: при добавлении в Zod schema используй `.optional()` для simulateResult чтобы не сломать существующие clients.
- Существующий etherscan stub: `apps/api/src/finance/etherscan.service.ts` (см. CLAUDE.md). Не модифицируй его — просто пропусти его вызов когда simulate.
