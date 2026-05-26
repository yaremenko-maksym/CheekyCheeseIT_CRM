# task-avatars-logos-integration

## Агент: coder
## Приоритет: high
## Зависит от: task-documents-data-layer, task-documents-api, task-documents-ui
## Ветка: feature/avatars-logos-integration

## Контекст

PHASE 6 (Документы) — integration этап для AVATAR и LOGO категорий.

**Avatar:**
- Сейчас: `users.avatar` (varchar 1000) — содержит **Google/dicebear URLs** для 11 юзеров. Дополнительная колонка `users.avatar_override` (text) — placeholder (никогда не использовалась meaningfully).
- Цель: Переименовать `avatar` → `avatar_url` (semantic) + добавить `avatar_document_id` (FK → documents с category=AVATAR) + удалить `avatar_override` (legacy). Render priority: `avatar_document_id` > `avatar_url` > initials.
- UI: ProfileEditDialog (`/crm/profile`) — добавить avatar upload (file picker + preview). Custom upload через documents API. AdminEditUserDialog — тоже.

**Logo:**
- Сейчас: `projects.logo_url` (text) — пусто (0/6 проектов). Подключён к `ReceiptField` компоненту, который сохраняет файл как **base64 в БД** (broken design — теперь убираем).
- Цель: Заменить `logo_url` на 2 колонки `logo_document_id` (FK → documents с category=LOGO) + `logo_external_url` (text, для https://company.com/logo.svg случаев). XOR check.
- UI: ProjectEditDialog (создание/редактирование проекта) — заменить `<ReceiptField>` на новый `<ImageUploadField>` (использует documents API). CreateProjectFromHiredDialog (interviews) — то же.
- **Удалить `ReceiptField` компонент** полностью (если больше не используется нигде после этого task'а).

См. pm-brief.md секции «DB схема → миграции 0012, 0013» и «RBAC матрица для GET/Upload» (AVATAR, LOGO строки).

## Конкретные изменения

### Backend

1. `apps/api/drizzle/migrations/0014_users_avatar_doc_fk.sql`:
   ```sql
   ALTER TABLE users RENAME COLUMN avatar TO avatar_url;
   ALTER TABLE users ADD COLUMN avatar_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;
   ALTER TABLE users DROP COLUMN avatar_override;
   CREATE INDEX idx_users_avatar_doc ON users(avatar_document_id) WHERE avatar_document_id IS NOT NULL;
   ```

2. `apps/api/drizzle/migrations/0015_projects_logo_doc_fk.sql`:
   ```sql
   ALTER TABLE projects
     DROP COLUMN logo_url,
     ADD COLUMN logo_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
     ADD COLUMN logo_external_url TEXT,
     ADD CONSTRAINT chk_logo_xor CHECK (
       logo_document_id IS NULL OR logo_external_url IS NULL
     );
   CREATE INDEX idx_projects_logo_doc ON projects(logo_document_id) WHERE logo_document_id IS NOT NULL;
   ```

3. `apps/api/src/database/schema.ts`:
   - `users` table: rename `avatar` → `avatarUrl`, добавить `avatarDocumentId: uuid('avatar_document_id').references(() => documentsTable.id, { onDelete: 'set null' })`, удалить `avatarOverride`
   - `projects` table: удалить `logoUrl`, добавить `logoDocumentId: uuid(...).references(...)` + `logoExternalUrl: text('logo_external_url')`

4. `packages/shared/src/schemas/users.ts` + `payment-requisites.ts` (где определены SessionUser/User schemas):
   - Заменить `avatar: z.string().nullable()` → `avatarUrl: z.string().nullable(), avatarDocumentId: z.string().uuid().nullable()`
   - Удалить `avatarOverride`
   - При update — добавить refinement что юзер может менять `avatarDocumentId` только для self (или ADMIN для любого)

5. `packages/shared/src/schemas/projects.ts`:
   - Заменить `logoUrl: z.string().nullable()` → `logoDocumentId: z.string().uuid().nullable(), logoExternalUrl: z.string().url().nullable()`
   - Refinement: XOR между этими двумя

6. `apps/api/src/users/users.service.ts` + `apps/api/src/projects/projects.service.ts`:
   - Обновить все queries (SELECT clauses) — новые колонки
   - Update flows: при `PATCH /api/users/:id` или `PATCH /api/projects/:id` валидировать `avatarDocumentId` / `logoDocumentId` ссылается на существующий documents row с правильной `category` (`AVATAR` для users, `LOGO` для projects). Иначе 400.
   - Логика: при смене avatar — старый document не удаляется автоматически (orphan), юзер может через /crm/documents (ADMIN с internal toggle) очистить вручную через soft delete + hard delete. Если автоудаление — добавить TODO для cron.

### Seed

7. `apps/api/src/database/seed.ts` — добавить AVATAR и LOGO документы:
   - **11 AVATAR rows** (по одной на каждого seeded user, `ownerId = userId`, fake s3_key `documents/avatars/<userId>/<docId>.jpg`). 
   - Записать `users.avatar_document_id = <doc.id>` для ~6 из 11 (остальные используют Google avatar URL).
   - **6 LOGO rows** (по одной на каждый seeded project, `ownerId = adminId` или senior'а проекта, fake s3_key `documents/logos/<projectId>/<docId>.png`).
   - Записать `projects.logo_document_id = <doc.id>` для ~3 из 6 проектов. ~1-2 проекта получают `logo_external_url = 'https://example.com/logo.svg'`. Остальные — оба null.

### Frontend — Avatar upload

8. `apps/web/app/routes/crm/profile.tsx` (или эквивалент — найти через ast-grep `pattern="'/crm/profile'"`):
   - В существующий ProfileEditDialog добавить секцию «Аватар»:
     - Preview текущего (priority: avatar_document_id → avatar_url → initials)
     - Кнопка «Загрузить новый» → file picker (accept: image/*) → `useUploadDocument({ category: 'AVATAR', ownerId: self.id }).mutateAsync(file)` → set `avatarDocumentId` в form state → submit профиль обновляет users.avatar_document_id
     - Кнопка «Удалить custom» (если `avatar_document_id !== null`) → soft delete document + clear `avatar_document_id` → откатывается на `avatar_url` (Google)

9. `apps/web/app/components/user-profile/UserProfileShell.tsx` (и др. где рендерится avatar):
   - Update Avatar render logic — приоритет `avatar_document_id` (через `useDocumentDownloadUrl(...)`)→ `avatar_url` → initials через `<AvatarFallback>` от shadcn
   - Использовать новый `<DocumentImage docId={...} fallback={avatarUrl}>` helper (если создан в task-documents-ui) ИЛИ inline через `useDocumentDownloadUrl`

10. `apps/web/app/routes/crm/users` (AdminEditUserDialog или эквивалент): то же что в Profile — ADMIN может загружать avatar для любого user.

### Frontend — Logo upload

11. `apps/web/app/components/ui/image-upload-field.tsx` — **новый компонент** на замену `ReceiptField`:
    - Props: `value: { documentId: string | null, externalUrl: string | null }`, `onChange(v)`, `category: 'LOGO' | 'AVATAR'`, `ownerId?: string`, `projectId?: string`
    - 2 mode tabs (file / url) как в ReceiptField, но:
      - file mode → upload через `useUploadDocument` → set `documentId`, clear `externalUrl`
      - url mode → set `externalUrl`, clear `documentId`
    - Preview: если `documentId` — `<DocumentImage>`; если `externalUrl` — `<img src={externalUrl}>`; иначе placeholder

12. `apps/web/app/routes/crm/projects/` (ProjectEditDialog, CreateProjectDialog, $projectId.tsx):
    - Заменить `<ReceiptField value={logoUrl} onChange={setLogoUrl}>` → `<ImageUploadField value={{documentId: logoDocumentId, externalUrl: logoExternalUrl}} onChange={...} category="LOGO" projectId={...}>`
    - Form state: `logoDocumentId`, `logoExternalUrl` вместо `logoUrl`

13. `apps/web/app/routes/crm/interviews/components/CreateProjectFromHiredDialog.tsx`:
    - То же — заменить `<ReceiptField>` на `<ImageUploadField>` для project logo

14. **Удалить `apps/web/app/components/ui/receipt-field.tsx`** если grep не находит других usages (run final check `grep -rn "ReceiptField" apps/web/`). NB: `ReceiptInput` (в finance) — это другой файл, его не трогать.

15. Везде где рендерится project — обновить отображение logo: priority `logo_document_id` → `logo_external_url` → placeholder (первая буква company_name в кружке).

## API endpoints

Никаких новых — переиспользует `POST /api/documents` с `category: 'AVATAR' | 'LOGO'` + обновляет users/projects через существующие PATCH endpoints.

## DB schema

Миграции 0012 и 0013 — см. pm-brief.md.

## RBAC

См. pm-brief.md секция «RBAC матрица для GET/Upload» строки AVATAR, LOGO.

## Acceptance criteria

- [ ] `pnpm typecheck` (все 3 пакета) проходит
- [ ] `pnpm lint` проходит
- [ ] `grep -rn "avatarOverride" apps/ packages/ --include="*.ts" --include="*.tsx"` возвращает **0 hits**
- [ ] `grep -rn "logoUrl" apps/ packages/ --include="*.ts" --include="*.tsx"` возвращает **0 hits** (только `logoDocumentId`, `logoExternalUrl`)
- [ ] `grep -rn "ReceiptField" apps/ packages/ --include="*.ts" --include="*.tsx"` возвращает **0 hits** (компонент удалён)
- [ ] **Fresh DB smoke:** `docker-compose down -v && docker-compose up -d && pnpm --filter @crm/api db:migrate && pnpm --filter @crm/api db:seed` проходит без ошибок
- [ ] `psql -d crm_db -c "\d users"` показывает `avatar_url` (renamed) + `avatar_document_id` (FK), нет `avatar` и `avatar_override`
- [ ] `psql -d crm_db -c "\d projects"` показывает `logo_document_id` + `logo_external_url`, нет `logo_url`
- [ ] `psql -d crm_db -c "SELECT COUNT(*) FROM users WHERE avatar_document_id IS NOT NULL"` ≥ 5 (seed)
- [ ] `psql -d crm_db -c "SELECT COUNT(*) FROM projects WHERE logo_document_id IS NOT NULL"` ≥ 3 (seed)
- [ ] **Manual smoke (browser):**
  - Login as SENIOR1 → `/crm/profile` → upload avatar.jpg → submit → avatar отображается в header после reload
  - Login as ADMIN → `/crm/users` → edit Maria → upload avatar для Maria → submit → видно в её карточке
  - Login as ADMIN → `/crm/projects` → edit any project → upload logo → submit → logo отображается в projects list
- [ ] Unit test users.service: `updateUser({ avatarDocumentId: <id_of_RESUME_doc> })` → 400 «Категория документа должна быть AVATAR» (нельзя поставить SCAN как avatar)
- [ ] Unit test projects.service: то же для logo (нельзя поставить RECEIPT как logo)

## Interaction tests (ОБЯЗАТЕЛЬНО)

- [ ] `ImageUploadField`: file mode → upload → preview обновляется → switch на url mode → preview из url; switch обратно — preview из file mode
- [ ] `ImageUploadField`: Escape закрывает любой modal содержащий компонент
- [ ] ProfileEditDialog avatar upload — прогресс bar viewable, success toast «Аватар обновлён»

## Запрещено трогать

- `apps/web/app/routes/crm/finance/components/ReceiptInput.tsx` (другой компонент для receipts — мигрирован в task-finance-receipt-integration)
- `apps/web/app/routes/crm/documents.tsx` (это task-documents-ui)
- `apps/api/src/documents/` (это task-documents-api)
- Не объединять с task-finance-receipt-integration — они разные модули, параллельный dispatch

## Verification (Coder перед `git push`)

1. `git diff HEAD --name-only` → файлы только в: api/src/database/ + api/src/users/ + api/src/projects/ + drizzle/migrations/0012+0013 + shared/src/schemas/users.ts+projects.ts + web/app/routes/crm/profile.tsx + web/app/routes/crm/users/* + web/app/routes/crm/projects/* + web/app/routes/crm/interviews/components/CreateProjectFromHiredDialog.tsx + web/app/components/ui/image-upload-field.tsx (new) + delete web/app/components/ui/receipt-field.tsx
2. Все type/lint зелёные
3. Fresh DB smoke + manual browser smoke (см. AC)
4. E2E локально: `pnpm --filter @crm/e2e test` зелёный (особенно tests касающиеся Profile / Projects — могут потребовать обновления селекторов; если упадут — пометить в blocked для AutoTest)
5. Commit message: `ac_verified: 1-13` + `feat: migrate avatar+logo storage to S3 via DocumentsModule (0012, 0013)`
