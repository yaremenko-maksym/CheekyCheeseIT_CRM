# task-documents-fixes-batch2

## Агент: coder

## Приоритет: high

## Зависит от: task-documents-fixes-batch1 (PR #48 — extends existing branch)

## Ветка: feature/documents-ui (extend; НЕ создавать новую)

## Контекст

User-testing fixes batch2 для PR #48. Smoke на туннеле выявил три проблемы:

1. **«Загрузил {uuid}»** — DocumentCard и DocumentDetailDialog рендерят
   raw `uploadedBy` UUID когда `uploaders` map не содержит displayName.
   Не-ADMIN/HR не имеют доступа к `/api/users`, поэтому map всегда пуст
   → юзер видит «Загрузил 53ad1c52». Нужно отдавать display name
   из API list и рендерить как `<Link>{displayName}</Link>` на
   `/crm/users/:id`.

2. **Seed.ts использует фейковые PDF** — `sample-resume.pdf`,
   `sample-contract.pdf` это синтетические zero-byte-ish заглушки.
   Юзер дал реальный PDF (`/Users/maksym/Downloads/Чек пример.pdf` —
   143 KB настоящий чек). Скопировать в
   `apps/api/src/database/seed-fixtures/sample-receipt-real.pdf` и
   использовать как образец для **всех PDF/scan категорий** в seed.

3. **SENIOR_INCOME / ADMIN_INCOME backwards sender/receiver** —
   сейчас в seed.ts: `senderId=senior.id` (или MAKSYM/KOSTYA), нет
   receiverId. UI показывает `→ —`. Правильная семантика INCOME =
   деньги от клиентской компании к юзеру: `senderLabel=project.companyName`,
   `receiverId=senior_or_admin`, `receiverLabel=null` (UI выведет displayName).

## Конкретные изменения

### Fix 1 — Display name uploader на API list + UI Link

#### Shared

- `packages/shared/src/schemas/documents.ts` — расширить `documentSchema`:
  ```ts
  /** Display name of the user who uploaded the document. Embedded via
   * LEFT JOIN users on the list endpoint to avoid a second /api/users
   * call (especially for JUNIOR/SENIOR/ACCOUNTANT who don't have access
   * to /api/users). Nullable: legacy rows + race conditions. */
  uploadedByDisplayName: z.string().min(1).max(255).nullable(),
  ```
- Тесты `packages/shared/src/schemas/documents.spec.ts` — добавить кейсы:
  uploadedByDisplayName present / null.

#### API

- `apps/api/src/documents/documents.service.ts`:
  - `list()` — LEFT JOIN на `users` чтобы получить `users.displayName`.
    Использовать `.select({ doc: documents, uploaderName: users.displayName })`
    - map в DTO с `uploadedByDisplayName`.
  - `mapDocument()` — принимать опциональный второй аргумент
    `uploaderName: string | null` (default null).
  - `upload()` / `restore()` — после insert/update заполнить
    `uploadedByDisplayName` из `actor.displayName` (он уже в SessionUser).
- Spec `documents.service.spec.ts` — обновить ожидания (list возвращает
  uploadedByDisplayName).

#### Web

- `apps/web/app/components/documents/document-card.tsx`:
  - Заменить `<span>{uploaderLabel}</span>` на `<Link to="/crm/users/$userId"
params={{ userId: doc.uploadedBy }}>{doc.uploadedByDisplayName ??
shortId(doc.uploadedBy)}</Link>` (стиль: ссылка с hover:underline).
  - Удалить props `uploaders` и `UploaderInfo` — больше не нужно.
- `apps/web/app/components/documents/document-detail-dialog.tsx`:
  - В DetailRow «Загрузил» — отрендерить `<Link>` вместо plain text.
  - Удалить props `uploaders`.
- `apps/web/app/components/documents/document-list.tsx` — убрать `uploaders`
  prop forward.
- `apps/web/app/routes/crm/documents.tsx` — удалить локальный `uploaders`
  map (no longer needed).

### Fix 2 — Real PDF в seed

- `apps/api/src/database/seed-fixtures/sample-receipt-real.pdf` (new) —
  copy from `/Users/maksym/Downloads/Чек пример.pdf` (143 KB настоящий
  чек). **Один файл = образец для всех PDF/scan категорий** в seed.
- `apps/api/src/database/seed.ts`:
  - Если seed создаёт document entries из fixtures (RESUME, CONTRACT,
    SCAN, RECEIPT) — использовать `sample-receipt-real.pdf` для PDF
    категорий. `sample-passport.jpg` и `sample-receipt.jpg` (image)
    могут остаться для image-категорий.
  - **Только если seed.ts уже грузит документы в S3/MinIO.** Если
    documents seeding ещё не реализован — пропустить fix2, оставить
    fixture файл на будущее.

### Fix 3 — SENIOR_INCOME / ADMIN_INCOME sender/receiver semantics

В seed.ts для каждой записи `type: 'SENIOR_INCOME'` или
`type: 'ADMIN_INCOME'`:

**Было:**

```ts
{ type: 'SENIOR_INCOME', senderId: senior.id, senderLabel: 'Maksym Yaremenko',
  projectId: project.id, ... }
```

**Стало:**

```ts
{ type: 'SENIOR_INCOME', senderId: null,
  senderLabel: project.companyName,
  receiverId: senior.id,
  receiverLabel: null,  // UI выведет displayName через receiverName join
  projectId: project.id, ... }
```

Аналогично для ADMIN_INCOME: `receiverId = MAKSYM_ID` или `KOSTYA_ID`
(вместо `senderId`), `senderLabel = project.companyName`.

**Note:** `created_by` остаётся = senior.id / MAKSYM_ID / KOSTYA_ID
(это аудит «кто внёс транзакцию», семантически независимо от sender/receiver).

## Acceptance criteria

- [ ] `pnpm --filter @crm/shared typecheck && test` — passes
- [ ] `pnpm --filter @crm/api typecheck && lint && test && build` — passes
- [ ] `pnpm --filter @crm/web typecheck && lint && test && build` — passes
- [ ] `documentSchema.uploadedByDisplayName` присутствует (shared)
- [ ] `DocumentsService.list()` отдаёт `uploadedByDisplayName` (api)
- [ ] DocumentCard рендерит `<Link>` на `/crm/users/:id` (web)
- [ ] DocumentDetailDialog рендерит `<Link>` на `/crm/users/:id` (web)
- [ ] `sample-receipt-real.pdf` существует в seed-fixtures
- [ ] Все SENIOR_INCOME/ADMIN_INCOME в seed.ts имеют `receiverId`
      (не `senderId`)
- [ ] Visual smoke — PM прогонит после merge.

## Файлы — точный список

### Shared

- `packages/shared/src/schemas/documents.ts` (+uploadedByDisplayName)
- `packages/shared/src/schemas/documents.spec.ts` (+тесты)

### API

- `apps/api/src/documents/documents.service.ts` (list join + mapDocument arg)
- `apps/api/src/documents/documents.service.spec.ts` (обновлённые expectations)
- `apps/api/src/database/seed.ts` (INCOME sender/receiver fix)
- `apps/api/src/database/seed-fixtures/sample-receipt-real.pdf` (new)

### Web

- `apps/web/app/components/documents/document-card.tsx` (Link instead of span)
- `apps/web/app/components/documents/document-detail-dialog.tsx` (Link in DetailRow)
- `apps/web/app/components/documents/document-list.tsx` (drop uploaders prop)
- `apps/web/app/routes/crm/documents.tsx` (drop uploaders memo)

### Docs

- `docs/specs/tasks/task-documents-fixes-batch2.md` (этот файл)

## Anti-hang lesson

Использую intent markers (`scripts/coder/coder-intent.sh`) между milestones:
M0 (start) → M1 (planning + fixture copy) → M2 (shared schema) →
M3 (API service+spec) → M4 (seed.ts) → M5 (web components) →
M6 (validation: typecheck/lint/test) → M7 (push).
