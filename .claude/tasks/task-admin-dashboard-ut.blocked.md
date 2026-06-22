# BLOCKER (partial): receipt field in dashboard pay form — PR #280 UT-feedback #4

## Агент: coder

## Задача: UT-feedback PR #280 (ADMIN dashboard), пункт #4 — подпункт «чек»

## Статус задачи

НЕ полный блокер. Основная часть #1 и #4 СДЕЛАНА и запушена в `feature/admin-dashboard`:

- #1 — KPI-карточки равной высоты (`items-stretch` + `KpiCard h-full flex-col`).
- #4 — экшн-кнопки строки открывают ТУ ЖЕ модалку оплаты на дашборде
  (переиспользованы `SettleSeniorPayoutDialog` / `ConfirmPayoutDialog` /
  `PaySalaryDialog`, та же мутация), + инвалидация admin-summary после оплаты.

Этот файл — про ОДИН подпункт #4: «в форме оплаты должна быть возможность
добавить чек (ссылка ИЛИ файл)».

## Проблема

ТЗ: «ПЕРЕИСПОЛЬЗУЙ уже существующее поле/компонент чека… Если в переиспользуемом
диалоге поле чека уже есть — ничего не добавляй, просто убедись что оно доступно.»

Факт: в переиспользуемых pay-диалогах поля чека НЕТ.

- `ReceiptInput` (file/url, `receiptDocumentId` / `receiptExternalUrl`) существует
  и используется только в Create/Edit/AdminEdit диалогах (создание/правка
  транзакции), НЕ в pay-time диалогах.
- `SettleSeniorPayoutDialog`, `PaySalaryDialog`, `ConfirmPayoutDialog` несут
  только free-form `txHash`-поле — это НЕ receipt-файл/ссылка.
- Pay-time Zod-DTO (`paySalarySchema`, `settleSeniorPayoutSchema`,
  `confirmPayoutSchema`, `manualConfirmPayoutSchema`) НЕ содержат `receiptFields`.
  Backend на settle/pay/confirm пишет только `txHash`, receipt НЕ персистит.

Добавить «чек (ссылка ИЛИ файл)» в pay-форму = РАСШИРЕНИЕ money-path:

1. `receiptFields` + `receiptXor` на 3-4 pay-time DTO (`packages/shared`).
2. Персист `receiptDocumentId` / `receiptExternalUrl` на закрывающих/settled
   строках в `transactions.service` (3 метода, money-cascade, advisory-lock).
3. `assertReceiptDocumentBindable` (RBAC чек на чужой documentId) для pay-flow.
4. Security-review (money action) + правка ОБЩИХ диалогов страницы Финансы.

Это отдельная задача с security-review, а НЕ «переиспользуй существующее поле»
во фронт-фиксе по UT-фидбеку. Угадывать money-path запрещено (golden rules #7/#9).

## Затронутый код (если решим делать)

- `packages/shared/src/schemas/finance.ts:464,505,539,782` — pay-time DTO.
- `apps/api/src/finance/transactions.service.ts` — `paySalary` (3383),
  `confirmPayout` (1498), `manualConfirmPayout` (2168), settle-by-source.
- `apps/web/.../dialogs/{PaySalaryDialog,SettleSeniorPayoutDialog}.tsx`,
  `apps/web/app/components/finance/ConfirmPayoutDialog.tsx` — добавить
  `ReceiptInput` (он УЖЕ есть, переиспользуется как в Create/Edit).

## Вопрос к PM / владельцу

Подтвердить scope подпункта «чек» в pay-форме:

- (A) Делать отдельной задачей с backend money-path + security-review — добавить
  receipt (file/url) во ВСЕ три pay-диалога Финансов (и они же на дашборде
  получат поле автоматически, т.к. переиспользуются). Рекомендуемый вариант.
- (B) На этом этапе достаточно существующего `txHash`-поля как «подтверждения»;
  отдельный чек-файл/ссылку не добавлять.

## Что сделано до блокера

- `apps/web/app/routes/_authenticated/index.tsx` — KPI equal-height + mount pay dialogs.
- `apps/web/app/routes/_authenticated/finance/components/KpiCards.tsx` — `KpiCard` h-full.
- `apps/web/app/routes/_authenticated/finance/components/ActiveTransactionsTable.tsx` — per-action handlers + payoutRequestId.
- `packages/shared/src/schemas/admin.ts` + `apps/api/src/admin/admin-summary.service.ts` — projected payoutRequestId.
- Тесты: `ActiveTransactionsTable.test.tsx` (5) + admin-summary spec assertion.
