# task-invoice-e2e

## Агент: autotest

## Приоритет: high

## Зависит от: task-invoice-data-layer, task-invoice-pdf-gen, task-invoice-api, task-invoice-ui (все merged)

## Ветка: tests/invoice-e2e (создать новую от main)

## Контекст

E2E coverage всей invoice signing цепочки. Финальная таска эпика. См. [`docs/specs/pm-brief-invoice-signing.md`](../pm-brief-invoice-signing.md).

## Конкретные изменения

### 1. `apps/e2e/tests/invoices.spec.ts` — **новый файл**

**1.1. Auto-create инвойса**

- `SENIOR submits payment → invoice auto-created с COMPANY signature`:
  - Setup: создать SENIOR_INCOME transaction (через API helper), validate (как ACCOUNTANT)
  - Action: login as SENIOR → нажать «Оплатить» в transaction detail
  - Verify:
    - `GET /api/invoices/:txId` возвращает 200 со status=PENDING, 1 signature (COMPANY)
    - `transactions.invoice_document_id` НЕ NULL (через postgres MCP или API)
    - Колокольчик SENIOR показывает unread notification «Инвойс ожидает вашей подписи»

- `ADMIN creates SALARY → status=PAID → invoice auto-created`:
  - Setup: login as ADMIN → создать SALARY transaction
  - Move через workflow до status=PAID (или setup direct в DB для скорости)
  - Verify: invoice auto-created, notification employee получил

**1.2. Counterparty signing**

- `SENIOR signs own payout invoice`:
  - Setup: invoice PENDING, viewer=SENIOR (counterparty)
  - Action: open invoice detail → click «Подписать» → checkbox → submit
  - Verify:
    - Toast «Инвойс подписан»
    - Status badge меняется на «Подписано всеми»
    - 2 signatures в DB
    - Новый Document, старый soft-deleted (через postgres query)
    - ADMIN получает notification «{name} подписал инвойс»

- `Employee signs salary invoice`:
  - Аналогично для SALARY type

**1.3. RBAC**

- `JUNIOR cannot sign SENIOR's payout` — login as JUNIOR → try POST /sign → 403 Forbidden
- `ADMIN cannot sign as COUNTERPARTY` (ADMIN всегда COMPANY sign auto) — try → 403
- `JUNIOR sees only own invoices` — login → list shows только где JUNIOR == counterparty

**1.4. Immutability + double sign**

- `Cannot sign already-signed invoice` — повторный POST /sign → 409 Conflict

**1.5. Hash mismatch (защита от tampering)**

- Сложно симулировать в E2E без manual DB hack. Можно опустить (covered в unit tests на API уровне) или сделать integration через:
  - Создать invoice → подменить `invoice_signatures.pdf_hash` через postgres MCP → попытка sign → 409

**1.6. Public verify endpoint**

- `GET /api/invoices/:id/verify без auth cookie → 200`:
  - Запрос без cookies (новый context)
  - Verify: status, signatures (с signerName), отсутствуют ip/userAgent fields
- `Public verify page /invoice/v/:id работает в incognito`:
  - Открыть в новом browser context (без shared state)
  - Verify: страница загружается, показывает signatures, нет редиректа на login

**1.7. Колокольчик (notifications)**

- `Bell shows unread count`:
  - Create notification → reload → bell badge shows "1"
- `Click notification marks read + navigates`:
  - Click → mark read API called → navigate to link → bell badge decremented

- `«Прочитать всё» works`:
  - Multiple unread → click «Прочитать всё» → all marked → badge = 0

### 2. `apps/e2e/tests/fixtures.ts` — **обновить**

Добавить helpers:

- `createSeniorIncomeTransaction(senior, project, amount, currency)` — POST через API
- `validateTransaction(tx, accountant)` — move к VALIDATED
- `createSalaryTransaction(receiver, amount, currency)` — POST через API
- `forceTransactionStatus(txId, status)` — direct DB update (для скорости в setup)
- `createInvoiceViaAutoTrigger(tx)` — full flow setup
- `getInvoiceSignaturesFromDb(txId)` — postgres MCP query helper

Тестовые fixtures — НЕ нужны (PDF generated on-the-fly, файлы не загружаются).

### 3. CI

`e2e.yml` уже запускает все `.spec.ts` — новые тесты подхватятся автоматически. Verify что MinIO docker контейнер в CI работает (инвойсы пишутся в S3).

## Acceptance criteria

- [ ] `invoices.spec.ts` — все 7 групп (1.1-1.7) implemented
- [ ] `fixtures.ts` — расширен helpers
- [ ] **Локально:** `pnpm --filter @crm/e2e test invoices` — все pass
- [ ] **Unit + Typecheck не сломаны:** `pnpm test` + `pnpm typecheck`
- [ ] **CI green** после push: E2E Tests job zelёный
- [ ] **No regressions** в PHASE 6 documents tests (если merged) — все existing E2E проходят
- [ ] PR open с label `ai-review-ready`

## Запрещено трогать

- Product code (`apps/web`, `apps/api`, `packages/shared`) — только E2E
- Existing tests (только добавление helpers в `fixtures.ts`)
- Migrations / schemas / workflows

## Verification

1. `pnpm --filter @crm/e2e test` — все новые pass
2. Commit: `test(invoice): E2E coverage для invoice signing epic` + `ac_verified: 1-7`
3. Push → PR с label `ai-review-ready`
4. Notify PM что PR open

## Notes

После merge — **Invoice Signing Epic завершён**. Возможные следующие шаги:

- **PHASE 8 (Smart Contracts USDT)** — расширить flow: после подписи COUNTERPARTY → автоматическая отправка USDT через ethers.js + invoice прикрепляется к chain tx
- **КЭП через Diia.app** — апгрейд подписи до юр.значимой через украинскую электронную подпись
- **Email/Telegram notifications** — расширить notifications service
- **Amendments** — UI flow для отмены/изменения подписанного инвойса
