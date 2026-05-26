# task-invoice-ui

## Агент: coder
## Приоритет: high
## Зависит от: task-invoice-api (merged)
## Ветка: feature/invoice-ui (создать новую от main, после merge api)

## Контекст

Frontend для invoice signing + notifications enhancement. Полный спек — [`docs/specs/pm-brief-invoice-signing.md`](../pm-brief-invoice-signing.md) секция «UI».

## Конкретные изменения

### 1. Новая страница `/crm/finance/invoices`

`apps/web/app/routes/crm/finance/invoices.tsx` — **новый**:
- Заголовок «Инвойсы» (Header style как на других finance pages)
- Tabs (shadcn): «Ожидает подписи» (с badge unread count) / «Подписано всеми» / «Все»
- Filter: тип (Senior payout / Salary / Все) — Select
- Filter: период — DateRangePicker (опционально, можно отложить)
- List: grid of cards (responsive)
- TanStack Query `useInvoices(filters)` с `staleTime: 60s`

### 2. `apps/web/app/components/invoices/invoice-card.tsx` — **новый**
- Badge: тип (SENIOR_PAYOUT — синий, SALARY — зелёный)
- Сумма + currency (large font)
- Контрагент: ФИО + аватар
- Дата создания (relative — «3 часа назад»)
- Статус badge: «Ожидает подписи» (yellow) / «Подписано всеми» (green)
- Click → opens `<InvoiceDetailDialog>`

### 3. `apps/web/app/components/invoices/invoice-detail-dialog.tsx` — **новый**

shadcn Dialog (large size, 800px):
- Header: тип + сумма + currency + status badge
- PDF preview (iframe src=presigned URL — through DocumentsService presigned)
- Signature table:
```
| Сторона      | Подписант     | Дата                | Метод       | Hash      |
|--------------|---------------|---------------------|-------------|-----------|
| Компания     | Maksym Y.     | 26.05.2026 14:00:00 | Авто        | a1b2c3d4  |
| Заказчик     | Иван Иванов   | ⏳ Ожидает          | —           | —         |
```
- Если viewer == counterparty AND нет COUNTERPARTY signature:
  - Кнопка «Подписать инвойс» (primary)
  - Click → opens nested confirm dialog:
    - Текст: «Подписывая этот документ, вы подтверждаете согласие с его содержимым. После подписи документ нельзя отменить.»
    - Checkbox: «Я ознакомлен и согласен» (required)
    - Кнопки: «Отмена» / «Подписать»
  - Submit → POST `/api/invoices/:txId/sign` → spinner → success toast → close both dialogs → invalidate `['invoices']` + `['notifications']`

### 4. `apps/web/app/hooks/use-invoices.ts` — **новый**

```typescript
useInvoices(filters: InvoiceFilters)         // queryKey: ['invoices', filters], staleTime 60s
useInvoice(transactionId: string)             // queryKey: ['invoice', txId], staleTime 30s
useSignInvoice()                              // mutation, invalidates ['invoices'] + ['invoice', id]
```

### 5. Колокольчик (Header enhancement)

`apps/web/app/components/layout/notifications-bell.tsx` — **новый или расширить existing**.

PHASE 1 NotificationsContext был front-end stub. Заменить на API integration:

```typescript
const useNotifications = () => useQuery({
  queryKey: ['notifications', 'unread'],
  queryFn: () => api.get('/notifications?limit=10').then(r => r.data),
  refetchInterval: 30_000,  // polling 30s
  staleTime: 30_000,
});

const useMarkRead = () => useMutation({
  mutationFn: (id) => api.patch(`/notifications/${id}/read`),
  onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
});
```

**UI:**
- Bell icon + Badge (показывает unread count, max display "99+")
- Click → DropdownMenu (shadcn):
  - Header: «Уведомления» + кнопка «Прочитать всё»
  - Items (max 10): icon + title + body preview + relative time
  - Click on item → mark read + navigate to `link`
  - Footer: «Все уведомления» → `/crm/notifications` (опционально, можно отложить)

### 6. Public verification page `/invoice/v/:id`

`apps/web/app/routes/invoice.v.$transactionId.tsx` — **новый** (note: вне `/crm/` префикса, доступна без login).

- Не использует `AuthContext`, не редиректит на login
- `useQuery` к `/api/invoices/:id/verify` (public endpoint, no auth)
- Loading skeleton
- Error state: «Документ не найден» если 404
- Success state:
  - Большой зелёный bg + checkmark icon + «Документ верифицирован»
  - Карточка с деталями: тип, сумма, currency, дата
  - Таблица signatures (signer name, signed at, role, short hash)
  - Footer: «Проверено системой CheekyCheese IT CRM» + дата проверки

### 7. Добавить link на «Инвойсы» в navigation

`apps/web/app/components/layout/sidebar.tsx` — добавить под пунктом «Финансы»:
- «Инвойсы» (icon: FileSignature lucide) → `/crm/finance/invoices`
- RBAC: все 5 ролей видят (ACCOUNTANT тоже)

Или альтернатива — добавить таб в `/crm/finance` (если там tabs structure).

### 8. Tests (unit + integration)

`apps/web/app/components/invoices/__tests__/invoice-card.test.tsx`:
- Renders type badge correctly
- Click opens detail dialog

`apps/web/app/components/invoices/__tests__/invoice-detail-dialog.test.tsx`:
- Shows «Подписать» button only when viewer == counterparty AND no existing signature
- Confirm flow: checkbox required, submit calls mutation

`apps/web/app/hooks/__tests__/use-invoices.test.ts`:
- queryKey structure правильный
- staleTime config

## RBAC visibility

- **Sidebar link «Инвойсы»:** видят все (но контент filtered backend)
- **Page list:**
  - ADMIN/ACCOUNTANT — все invoices
  - SENIOR/JUNIOR/HR — только где они counterparty
- **«Подписать» кнопка:** только если viewer == counterparty AND нет SIGNATURE COUNTERPARTY

## Acceptance criteria

- [ ] `/crm/finance/invoices` route + страница работает
- [ ] InvoiceCard рендерится правильно (тип, сумма, статус, контрагент)
- [ ] InvoiceDetailDialog показывает PDF preview через iframe
- [ ] «Подписать» flow: confirm dialog → submit → success toast → invalidate queries
- [ ] Колокольчик с polling 30s — badge unread count, dropdown с deep links
- [ ] Public `/invoice/v/:id` page работает без login
- [ ] Все Unit tests pass (`pnpm --filter @crm/web test`)
- [ ] Typecheck + Lint pass
- [ ] **Manual test:** 
  1. Login as ADMIN → создать SALARY transaction → status PAID
  2. Logout → login as employee (counterparty) → колокольчик показывает unread
  3. Click notification → редирект на invoice detail → подписать
  4. После подписи статус SIGNED, кнопка скрыта
  5. Открыть `/invoice/v/<txId>` в incognito → должен работать без login
- [ ] CI green после push
- [ ] **Скриншоты через playwright MCP:** все ключевые экраны (invoices list, detail, dialog, public verify) — приложить к PR description

## Запрещено трогать

- API endpoints — должны быть уже на main из api task
- Migrations / schemas
- Existing finance pages (`/crm/finance` корневая) — только добавить link на invoices
- PDF generation — это backend
- Documents UI (`/crm/documents`) — не трогать

## Verification

1. `pnpm --filter @crm/web typecheck` + `lint` + `test` локально pass
2. Playwright screenshot всех ключевых UI flows
3. Manual test (см. AC)
4. Commit: `feat(invoice): /crm/finance/invoices UI + bell enhancement + public verify page` + `ac_verified: 1-11`
5. Push → PR с label `ai-review-ready`. PR description содержит скриншоты.
