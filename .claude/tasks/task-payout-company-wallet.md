# Task: Payout → company wallet + on-chain validation (Phase 8 v2, backend)

## Модель: opus

(Money + on-chain валидация + RBAC + Drizzle/финансовая логика → opus per model-routing.)

## Зона: Coder — `apps/api/**`, `packages/shared/**`, `.github/workflows/guard-test-gate.yml` (allowlist). Прогресс — `.claude/tasks/task-payout-company-wallet.progress.md`.

## Контекст (направление владельца 2026-06-20)

Приход на счёт компании идёт ЧЕРЕЗ существующий **payout-флоу** («выплата»), НЕ через отдельную страницу (та удалена в #251). Счёт компании = **только USDT**. Синьоры/дропы рассчитываются с компанией криптой.

Изучи через codegraph ПЕРЕД правкой (verbatim source, не Read те же файлы):

- `transactions.service.ts`: `createPayoutRequest` (~1818), `payPayoutRequest` (~1940), `computeDropAggregate`, `mapTx`.
- `company-account.service.ts` (computeBalance, getRow), `etherscan.service.ts` (`verifyDeposit(txHash, expectedTo, threshold)` — уже проверяет получателя+confirmations+amount).
- `nbu-currency.service.ts` (курсы USD/EUR/UAH).
- `packages/shared/src/schemas/finance.ts`: `payPayoutRequestSchema`, `createPayoutRequestSchema`, `payoutRequestSchema`.
- `company_account` таблица (walletAddress, confirmationThreshold).

## Текущее состояние (что меняем)

- `createPayoutRequest`: получатель = СТАБ `contractAddress = '0x'+randomBytes(20)`; **mixed-currency guard** (`currencies.size>1 → BadRequest`); payableAmount = company-share (100−seniorSharePercent%) в валюте дохода.
- `payPayoutRequest`: подтверждение по `txHash`, но **симуляция** (`simulateResult: 'success'|'error'`), НЕ реальная блокчейн-проверка.

## Design (реализуй так)

### 1. createPayoutRequest — получатель = кошелёк компании + USDT-конверсия

- `contractAddress` → **адрес кошелька компании** (из `company_account.walletAddress`). Если кошелёк не настроен → BadRequest «Кошелёк компании не настроен». (Поле `contract_address` переиспользуем как recipient — схему НЕ ломаем.)
- **Снять mixed-currency guard.** Вместо: конвертировать company-share КАЖДОГО дохода в USDT (USDT/USD = 1:1; EUR/UAH через `nbu-currency.service`), суммировать → `payableAmount` в USDT. `incomeAmount` тоже в USDT (или оставить per-source — но payable обязательно USDT). Валюта payout = **USDT**.
- Зафиксировать курс/расчёт детерминированно (целочисленная арифметика как сейчас, SCALE=1e6).

### 2. payPayoutRequest — реальная Etherscan-валидация + зачисление

- Убрать `simulateResult`-симуляцию (или оставить ТОЛЬКО под NODE_ENV!=='production' + явный dev-флаг — не в проде).
- Реальная проверка: `etherscan.verifyDeposit(txHash, companyWallet, threshold)` → инвариант: `toMatches && confirmed && amount ≈ payableAmount` (допуск ~1% на курс/округление; задокументируй). Не PAID если получатель != кошелёк компании ИЛИ не confirmed ИЛИ сумма мимо допуска.
- На валид → payout PAID + связанные income-tx → PAID + **зачисление на счёт компании**. Избегай ДВОЙНОГО учёта: расширь `company-account computeBalance` чтобы включать Σ(payout_requests PAID payableAmount) ЛИБО вставляй один служебный credit-row — выбери одно, задокументируй, чтобы баланс не задваивался.
- Idempotency: повторный confirm того же payout/txHash не задваивает (UNIQUE/проверка).

### 3. Manual-confirm endpoint (ADMIN/ACCOUNTANT)

- Новый endpoint: ADMIN/ACCOUNTANT вручную подтверждает что выплата оплачена иначе. DTO: `method: 'CASH' | 'ADMIN_USDT' | 'COMPANY_ACCOUNT'` (+ опц. note/txHash).
- RBAC: только ADMIN/ACCOUNTANT (не SENIOR/DROP). Real backend 403-тест (FM-5).
- Маркирует payout PAID. Зачисление: если `COMPANY_ACCOUNT` → кредит счёта компании; если `ADMIN_USDT`/`CASH` → НЕ кредитует счёт компании (деньги ушли мимо). Запиши method (audit).

### 4. Shared schemas

Обнови `payPayoutRequestSchema` (txHash обязателен для on-chain пути), новый `manualConfirmPayoutSchema` (method enum), `payoutRequestSchema` (currency=USDT, recipient). Все API через `.parse()`.

### 5. FM-5 guard-test gate

Если новый контроллер/endpoint в sensitive-дире — попадает под allowlist (`finance`/`transactions` уже покрыты). Проверь.

## Acceptance Criteria (каждый — с тестом, integration против РЕАЛЬНОЙ scratch-DB `crm_qa`, НЕ `crm_db`)

1. createPayoutRequest: recipient = кошелёк компании; кошелёк не настроен → BadRequest. typecheck зелёный.
2. **USDT-конверсия:** смешанные валюты (USD+USDT, как баг фото-1) → один USDT payout, payableAmount = Σ(company-share в USDT). НЕ BadRequest. (unit + integration).
3. **On-chain confirm (integration, mock Etherscan):** valid (to=wallet, confirmed, amount-match) → PAID + счёт компании +payable. wrong-recipient / not-confirmed / amount-mismatch → НЕ PAID, баланс не растёт.
4. **Зачисление без двойного учёта:** баланс компании растёт ровно на payableAmount подтверждённого payout (unit).
5. **Manual-confirm RBAC (integration 403):** SENIOR/DROP → 403; ADMIN/ACCOUNTANT → PAID. COMPANY_ACCOUNT кредитует, ADMIN_USDT/CASH — нет.
6. Idempotency: повторный confirm не задваивает баланс.
7. eslint чистый (mcp**eslint**lint-files); все unit+integration зелёные на crm_qa; полный api typecheck.

## Тестовая дисциплина

Integration RBAC/on-chain против `crm_qa` (guard #233), ассерты 403 + баланс-дельты. Mock Etherscan для valid/invalid веток (НЕ ходить в реальный блокчейн). Real-controller (через `@Inject`, НЕ sentinel-зеркало — урок #227/#251). `DATABASE_URL= git push`.

## Worktree (FM-2)

Твой worktree: `/Users/maksym/Desktop/programming/CheekyCheeseIT_CRM/.claude/worktrees/payout-rework`. ВСЕ Edit/Write — ВНУТРИ него (абс. пути с `/.claude/worktrees/payout-rework/`). НЕ писать по main-repo путям. После первого edit `git -C <wt> status`. `pnpm -C <wt> install --frozen-lockfile` если нет node_modules.

## Git

Ветка `feature/payout-company-wallet` (создана). Chunked `wip:`; финальный `ac_verified: 1,2,3,4,5,6,7`. `DATABASE_URL= git push`. PR на main. НЕ мержить.
ВАЖНО: фронт payout-диалогов (получатель-кошелёк + on-chain статус + manual-confirm кнопка) — ОТДЕЛЬНАЯ задача, НЕ трогай apps/web (кроме exhaustive-stub если вынудит enum).
