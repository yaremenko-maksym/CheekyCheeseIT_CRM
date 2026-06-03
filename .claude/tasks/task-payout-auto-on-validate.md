# task-payout-auto-on-validate

## Агент: coder

## Приоритет: HIGH (юзер блокирует merge PR #56)

## Ветка: feature/invoice-ui (EXISTING — PR #56 OPEN, добавить коммит)

## Контекст

User Testing на текущем HEAD (5a0575a) выявил bug в payout flow.

### Юзер verbatim

> «Это не правильная логика. После того как бухгалтер подтвердил приход админа должна создаваться НОВАЯ ТРАНЗАКЦИЯ типу ВЫПЛАТА. НОВАЯ. Не должно быть кнопки выплатить на транзакции прихода синьера!»

### Что сейчас (плохо)

На скриншоте видна строка «Приход синьора $1,000 — Подтверждено» + inline кнопка **«Выплатить»**. Юзер кликает «Выплатить» → открывается `PayoutDialog` (выбор tx для batch payout) → создаётся payout_request + PAYOUT row.

### Что должно быть (correct flow)

1. ACCOUNTANT кликает «Подтвердить» на SENIOR_INCOME (status: PENDING → VALIDATED)
2. **Backend АВТОМАТИЧЕСКИ** создаёт связанную **PAYOUT transaction** (1-to-1 с SENIOR_INCOME) со статусом PENDING_PAYMENT
3. **БЕЗ кнопки «Выплатить» на SENIOR_INCOME** (никогда, ни на каком статусе)
4. Юзер видит новую «Выплата» row → кнопка **«Оплатить»** на ней → открывается `PayoutDetailDialog` → submit hash → PAID

## AC

- [ ] **AC1: Backend auto-create PAYOUT при validate**
  - В `apps/api/src/finance/transactions.service.ts` метод `validateTransaction()` (или endpoint handler) после успешного UPDATE SENIOR_INCOME status→VALIDATED:
    - Сделать INSERT новой PAYOUT row:
      - `type='PAYOUT'`, `status='PENDING_PAYMENT'`
      - `senderId=senior_id` (receiver_id из SENIOR_INCOME → этот senior платит)
      - `receiverLabel='CheekyCheeseIT'`
      - `amount = senior_income.amount * (1 - senior_share_percent/100)` (74% к оплате)
      - `currency = senior_income.currency`
      - `projectId = senior_income.project_id`
      - `payoutRequestId` — создать связанный payout_request с contract address (можно reuse `crypto.randomBytes(20)` stub)
    - Также UPDATE SENIOR_INCOME → status='PENDING_PAYMENT' (вместо просто VALIDATED) — иначе SENIOR_INCOME остаётся VALIDATED но связан с Payout
    - **Атомарно через `db.transaction()`** (БД transaction для consistency)

- [ ] **AC2: Удалить старый batch payout flow**
  - В `TransactionRow.tsx`: НЕТ inline кнопки «Выплатить» на SENIOR_INCOME (ни на каком статусе)
  - В `finance/index.tsx`: УДАЛИТЬ header кнопку «Выплатить (N)» (была для batch)
  - УДАЛИТЬ или скрыть `PayoutDialog.tsx` mount в finance/index.tsx — больше не используется. Сам файл можно оставить для возможного будущего использования, но НЕ mount'ить
  - НЕ удалять backend endpoint `POST /api/payout-requests` — может пригодиться для future batch. Просто фронт его не вызывает.

- [ ] **AC3: «Оплатить» работает на новой PAYOUT row**
  - Существующая логика `TransactionRow.tsx` показа «Оплатить» pill на `type=PAYOUT + status=PENDING_PAYMENT + senderId === currentUserId` остаётся
  - Manual smoke: после validate → видна «Выплата» row → click «Оплатить» → `PayoutDetailDialog` открывается с contract address + hash input

- [ ] **AC4: Идемпотентность validate**
  - Если ACCOUNTANT случайно дважды кликнет «Подтвердить» — НЕ должно создаваться 2 PAYOUT row. Backend проверяет `tx.status === 'PENDING'` (early return если уже VALIDATED/PENDING_PAYMENT)

- [ ] **AC5: SENIOR_INCOME статус после validate**
  - Status SENIOR_INCOME при validate сразу → `PENDING_PAYMENT` (не VALIDATED). Это означает "validated AND payout создана".
  - Badge на SENIOR_INCOME row показывает «Ожидает выплаты» (как сейчас).
  - НЕ нужен промежуточный VALIDATED статус — он избыточен в новом flow.

## Файлы (ожидаемые изменения)

- `apps/api/src/finance/transactions.service.ts` — validateTransaction: auto-create PAYOUT + payout_request, db.transaction
- `apps/web/app/routes/crm/finance/components/TransactionRow.tsx` — убрать «Выплатить» pill полностью с SENIOR_INCOME
- `apps/web/app/routes/crm/finance/index.tsx` — убрать header «Выплатить (N)» button + PayoutDialog mount

## Definition of Done

- ac_verified: 1,2,3,4,5
- Manual smoke playwright (быстро):
  1. Login as Mykola (ACCOUNTANT)
  2. /crm/finance → найти PENDING SENIOR_INCOME (можно создать тестовую если нет)
  3. Click «Подтвердить»
  4. **Verify:** появилась новая Выплата row с статусом «Ожидает выплаты» + кнопка «Оплатить». SENIOR_INCOME row тоже сменил статус на «Ожидает выплаты», БЕЗ кнопки
  5. Logout / Login as SENIOR (Oleksiy)
  6. Click «Оплатить» на новой Выплата → PayoutDetailDialog открывается
- Unit tests: `pnpm test`
- Typecheck: `pnpm typecheck`
- ESLint: `pnpm lint`

## Out of scope

- Batch payout (несколько SENIOR_INCOME → одна Выплата) — юзер пока не просил, отложено
- Migration исторических row (юзер сказал он сам discard или re-validate если нужно)
- UI для бухгалтера для batch validation — не нужно
- Multi-senior share percent для одной Выплаты — N/A (1-to-1)

## Заметки для Coder

- Branch: `feature/invoice-ui` (PR #56 OPEN, HEAD 5a0575a)
- `git checkout feature/invoice-ui && git pull origin feature/invoice-ui`
- Получить task file: `git checkout claude/musing-jang-a12f39 -- docs/specs/tasks/task-payout-auto-on-validate.md`
- ВКЛЮЧИТЬ task file в commit
- Push на feature/invoice-ui (auto-update PR #56) — `--no-verify` OK если pre-push hook viset
- НЕ ставить labels

Commit message: `feat(finance): auto-create Выплата при validate SENIOR_INCOME`

ВНИМАНИЕ: предыдущий коммит 234c8d0 уже создавал PAYOUT при `createPayoutRequest()`. Эту logic НЕ удалять (endpoint остаётся), просто frontend больше не вызывает. **Новая логика** добавляется в `validateTransaction()` — не дублируй INSERT с тем что в createPayoutRequest.
