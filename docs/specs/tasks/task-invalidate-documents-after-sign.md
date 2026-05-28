# task-invalidate-documents-after-sign

## Агент: coder
## Приоритет: MEDIUM (UX bug в PR #56)
## Ветка: feature/invoice-ui (PR #56 OPEN, HEAD 947b85c)

## Контекст

После подписания инвойса (`POST /api/invoices/:id/sign`) backend создаёт новый PDF (`invoice-XXX-signed.pdf`) и soft-delete'ит старый. Но фронт-список `/crm/documents?category=INVOICE` НЕ обновляется — старый + новый показаны вместе. После full page reload — корректно.

Root cause: после `signInvoice` mutation в `useSignInvoice` (или similar в `use-invoices.ts`) не вызывается `queryClient.invalidateQueries({ queryKey: ['documents'] })`. Только invoice/notifications queries invalidated.

## AC

- [ ] **AC1: invalidate documents query после signInvoice**
  - В `apps/web/app/hooks/use-invoices.ts` (или wherever signInvoice mutation определён) в `onSuccess`:
    ```ts
    void qc.invalidateQueries({ queryKey: ['documents'] })  // ← добавить
    void qc.invalidateQueries({ queryKey: ['invoices'] })   // (если уже есть)
    void qc.invalidateQueries({ queryKey: ['transactions'] })  // (если уже)
    ```
- [ ] **AC2: Verify через playwright** — sign инвойс → список /crm/documents auto-refresh без reload, показывает только signed (старый -1 видимый, новый видимый)
- [ ] **AC3: Не делать regression** — другие invalidate'ы должны остаться

## Файлы

- `apps/web/app/hooks/use-invoices.ts` — добавить invalidate documents в signInvoice mutation onSuccess

## Definition of Done

- ac_verified: 1,2,3
- Manual playwright smoke БЫСТРО (1-2 navigate, не loops)
- Typecheck + lint pass
- НЕ полный E2E (фикс крошечный)

## Заметки для Coder

- Branch: feature/invoice-ui (HEAD 947b85c) — добавить commit в PR #56
- Получить task: `git checkout claude/musing-jang-a12f39 -- docs/specs/tasks/task-invalidate-documents-after-sign.md`
- Commit message: `fix(documents): invalidate documents query после signInvoice`
- Push --no-verify OK если pre-push hook viset
- НЕ создавать новый PR, НЕ ставить labels

Estimate: ~5-10 min. Тривиальный фикс — 1-2 строки.
