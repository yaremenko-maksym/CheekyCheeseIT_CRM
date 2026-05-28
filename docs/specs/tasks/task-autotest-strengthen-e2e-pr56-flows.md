# task-autotest-strengthen-e2e-pr56-flows

## Агент: autotest
## Приоритет: HIGH (закрепляем новую архитектуру)
## Ветка: tests/strengthen-pr56-flows (НОВАЯ, base = main ПОСЛЕ merge PR #56)
## Repo: yaremenko-maksym/CheekyCheeseIT_CRM

## Контекст — что изменилось в PR #56 (для понимания scope)

PR #56 (Invoice Signing Epic + payout refactor) — большой бандл из 6 rounds reviews. Утверждено в main. Архитектура:

### 1. Payout flow (полностью переработан)

**Старое поведение (УБРАНО):**
- Юзер вручную нажимал «Выплатить» на VALIDATED SENIOR_INCOME → PayoutDialog batch-выбор
- Header кнопка «Выплатить (N)» для batch
- inline pill «Оплатить» на PENDING_PAYMENT SENIOR_INCOME

**Новое поведение:**
- ACCOUNTANT кликает «Подтвердить» на PENDING SENIOR_INCOME
- Backend `validateTransaction()` в `db.transaction()` atomically:
  - SENIOR_INCOME → `status='VALIDATED'` (финал, badge «Подтверждено» зелёный)
  - INSERT `payout_request` с stub contract address (`0x` + crypto.randomBytes(20))
  - INSERT новая PAYOUT row (status=PENDING_PAYMENT, senderId=senior, amount=income*(1-share/100), payoutRequestId linked)
- Frontend: inline pill «Оплатить» ТОЛЬКО на PAYOUT row (PENDING_PAYMENT + senderId === currentUser)
- Idempotency: validateTransaction guard на `tx.status !== 'PENDING'`
- PayoutDetailDialog: открывается с payoutRequestId, показывает contract address (label «Адрес кошелька»), payable amount, список SENIOR_INCOME (count из filter SENIOR_INCOME only)
- При submit (success/PAID) → SENIOR_INCOME статус → PAID + autoCreateInvoice cascade

### 2. Dev simulate toggle (PayoutDetailDialog)
- 3 radio (vertical stack, full text): «✅ Симулировать успех» / «❌ Симулировать ошибку» / «🔗 Реальная проверка (недоступно в dev)»
- Default = `'real'` (submit disabled)
- При simulate (success/error) — hash optional (Zod superRefine min(10) только для real OR prod)
- Backend `payPayoutRequest` принимает optional `simulateResult`, gated на `process.env['NODE_ENV'] !== 'production'`
- Simulate=success → синтезирует `0xSIM...` stub txHash, пропускает etherscan, completes cascade
- Simulate=error → throws BadRequestException('Симуляция: транзакция не подтверждена')

### 3. Invoice signing (новый эпик)
- При PAYOUT PAID — auto-sign COMPANY (Maksym ADMIN) + notification INVOICE_SIGN_REQUIRED для SENIOR
- SENIOR open invoice detail → click «Подписать инвойс» → confirm checkbox → submit
- Backend re-gen PDF с обеими подписями → upload Document → soft-delete old → update transactions.invoice_document_id
- Frontend на sign onSuccess: invalidates `documents`, `invoices`, `notifications`, `transactions` queries
- Public verify page `/invoice/v/:transactionId` без auth — показывает signers + hashes

### 4. Invoice detail dialog UI
- Старая table подписей с 5 колонками (включая «Хэш») → новый card-per-signature list
- Method labels: «Авто» / «Ручная» (с tooltip detalей)
- PDF iframe: removed sandbox="allow-same-origin", useRef-based fallback (no stale closure), 3s timeout → «Открыть PDF» button

### 5. Document preview dialog
- Layout 2-column: metadata left, image preview right
- Удалено поле «Имя файла» (избыточно)
- max-w-4xl + image max-h-[560px] object-contain

### 6. Transaction list sort + receipt frame
- Frontend sort всегда по `createdAt` DESC (txDate игнорируется в sort, остаётся для отображения)
- Backend resolveTxDate (helper для today midnight picks → fills current time-of-day)
- Receipt preview в TransactionDetailDialog: 60vh max-h-[520px] min-h-[320px] + object-contain

### 7. Auth (localhost)
- Vite dev server proxy `/api` → :3001
- FRONTEND_URL default http://localhost:3000 (production gate в env.ts)
- NestJS Logger в googleCallback catch

### 8. UI fixes
- UserAvatar обернут в React.forwardRef → DropdownMenuTrigger asChild работает
- VALIDATED status badge зелёный (emerald-300)

## Цель task

Закрепить новую архитектуру в E2E тестах чтобы:
1. Старые E2E на удалённый flow (PayoutDialog batch, inline «Выплатить» на SENIOR_INCOME) удалены/обновлены
2. Новые ключевые flow покрыты тестами
3. Регрессии на старом flow обнаружены fast

## Ключевые flow для покрытия

### Flow A — Auto-create Выплата при validate
- [ ] **A1:** ACCOUNTANT logs in → /crm/finance → видит PENDING SENIOR_INCOME → click «Подтвердить»
  - Verify: SENIOR_INCOME badge → «Подтверждено» (зелёный)
  - Verify: появилась новая Выплата row (type=PAYOUT, status=PENDING_PAYMENT) с тем же projectId
  - Verify: SENIOR_INCOME row БЕЗ inline кнопки «Оплатить»
  - Verify: Выплата row С inline кнопкой «Оплатить» (testid `row-pay-payout-{id}`)
- [ ] **A2:** Idempotency — двойной POST `/transactions/:id/validate` → 400/409 (early return), НЕТ дубликата PAYOUT
- [ ] **A3:** Atomicity rollback — moc backend failure mid-transaction (если возможно через test) → SENIOR_INCOME остаётся PENDING

### Flow B — Payout payment с simulate
- [ ] **B1:** SENIOR logs in → click «Оплатить» на PENDING_PAYMENT PAYOUT → PayoutDetailDialog открывается
  - Verify: contract address (42 chars, начинается с `0x`)
  - Verify: label «Адрес кошелька» (НЕ «Адрес смарт-контракта (USDT ERC-20)»)
  - Verify: count «Транзакции в выплате (1)» (соответствует кол-ву SENIOR_INCOME)
  - Verify: default radio = «Реальная проверка», submit disabled
- [ ] **B2:** Click «Симулировать ошибку» → submit enabled (hash optional) → submit → error toast/inline «Симуляция: транзакция не подтверждена», dialog остаётся открыт
- [ ] **B3:** Click «Симулировать успех» → submit → dialog закрылся, cascade:
  - PAYOUT status → PAID
  - SENIOR_INCOME status → PAID
  - Invoice сгенерирован (PDF), auto-sign COMPANY (Maksym)
  - Notification INVOICE_SIGN_REQUIRED для SENIOR появилась в колокольчике
- [ ] **B4:** Real mode в dev → submit disabled (даже с hash), backend payPayoutRequest без simulateResult требует hash min(10)

### Flow C — Invoice signing
- [ ] **C1:** SENIOR (counterparty) после B3 → колокольчик → notification → click → /crm/finance/invoices или TransactionDetailDialog
- [ ] **C2:** Click «Подписать инвойс» → confirm dialog → checkbox → submit
  - Verify: PDF re-gen с обеими подписями
  - Verify: список /crm/documents?category=INVOICE автоматически обновляется (без reload) — старый `invoice-XXX.pdf` исчезает, новый `invoice-XXX-signed.pdf` появляется
  - Verify: status badge invoice → «Подписано»
- [ ] **C3:** Public verify /invoice/v/:transactionId без auth → показывает обе подписи + статус

### Flow D — Transaction list sort
- [ ] **D1:** Create новую SENIOR_INCOME сегодняшней датой → она #1 в таблице (sort по createdAt DESC)
- [ ] **D2:** Mix tx (income midnight txDate + payouts с null txDate) — sort by createdAt → правильный порядок (regression coverage для bug bf5dc2e UT)

### Flow E — UI invariants
- [ ] **E1:** Avatar dropdown open/close на click (header) — пункты «Профиль», «Выйти», role badge
- [ ] **E2:** TransactionDetailDialog с receipt — image height limit (max-h-[520px]), не растягивается
- [ ] **E3:** DocumentDetailDialog (open standalone) — 2-column layout, нет «Имя файла» row
- [ ] **E4:** Invoice detail dialog — no horizontal scroll, no «Хэш» column в card list

### Flow F — Auth (localhost)
- [ ] **F1:** Dev login через UI (POST /api/auth/dev-login через Vite proxy) — выбор юзера → JWT cookie set → редирект /crm

## Подход

1. **Найти существующие specs** которые тестят УБРАННЫЙ flow:
   - `finance-senior-flow.spec.ts` — батч PayoutDialog (Coder #6 уже частично обновил, но проверь)
   - `finance-senior-payment-flow.spec.ts` — inline pills на SENIOR_INCOME (тоже Coder #6 трогал)
2. **Удалить obsolete tests** (orphan на старую PayoutDialog batch logic)
3. **Расширить** existing specs с новыми expectations
4. **Добавить новые specs** для C (invoice signing), F (auth proxy)
5. **Использовать data-testid attrs** из кода (Coder сохранил existing testids — verify)

## Definition of Done

- Все 6 flow (A-F) покрыты E2E тестами
- `pnpm --filter @crm/e2e test` локально pass (или identifies new failures)
- PR `tests/strengthen-pr56-flows` создан против main
- НЕ ставить labels (PM сделает)

## Заметки для AutoTest

- Base branch: **main** ПОСЛЕ merge PR #56. Сначала fetch main → checkout.
- `git checkout main && git pull origin main && git checkout -b tests/strengthen-pr56-flows`
- `git checkout claude/musing-jang-a12f39 -- docs/specs/tasks/task-autotest-strengthen-e2e-pr56-flows.md`
- Включить task file в commit
- ESTIMATE: ~1-2 часа (6 flows, multiple sub-cases)
- Если падает >2 раза на конкретном flow — фиксируй issue + продолжай остальные

Commit messages: по flow (A/B/C/D/E/F) ИЛИ один общий:
- `test(e2e): strengthen flows after PR #56 — payout + invoice + sort + ui`
