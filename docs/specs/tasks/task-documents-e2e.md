# task-documents-e2e

## Агент: autotest
## Приоритет: high
## Зависит от: task-documents-ui, task-finance-receipt-integration, task-avatars-logos-integration (все merged)
## Ветка: tests/documents-e2e (создать новую от main)

## Контекст

PHASE 6 (Документи) полностью merged в main:
- `task-documents-data-layer` (PR #44) — таблица `documents` + 6 категорий enum
- `task-infra-s3-minio` (PR #45) — MinIO dev + S3 prod scaffolding
- `task-documents-api` (PR #47) — NestJS DocumentsModule, presigned URLs, sharp/pdf-lib compression
- `task-documents-ui` (PR #48) — `/crm/documents` страница, табы RESUME/SCAN/CONTRACT/RECEIPT, hard delete (ADMIN), UI на русском
- `task-finance-receipt-integration` (PR #49) — `transactions.receiptDocId` FK, XOR check, soft cascade
- `task-avatars-logos-integration` (PR #50) — `users.avatarDocId` + `projects.logoDocId` FK через DocumentsModule

Финальная задача PHASE 6 — **E2E test coverage** для всей цепочки.

См. полный спек: [`docs/specs/pm-brief.md`](../pm-brief.md). Полная RBAC матрица: см. секцию «Видимость табов по ролям» в pm-brief.

## Конкретные изменения

### 1. `apps/e2e/tests/documents.spec.ts` — **новый файл**

Coverage:

**1.1. Загрузка флоу (по ролям)**
- `JUNIOR uploads own RESUME` — uploads PDF/JPEG, появляется в табе «Резюме»
- `SENIOR uploads CONTRACT for own project` — uploads PDF, появляется в табе «Договори»
- `HR uploads SCAN for senior in their team` — uploads JPEG, видно у владельца
- `ACCOUNTANT cannot upload` — кнопка «Загрузить» disabled или скрыта

**1.2. Видимость табов (RBAC matrix)**
- `ADMIN sees all 4 tabs + ADMIN toggles` — RESUME/SCAN/CONTRACT/RECEIPT + «Показать удалённые» + «Показать internal» (включает Аватары/Логотипы)
- `SENIOR sees RESUME/SCAN/CONTRACT(own)/RECEIPT(own)` — без ADMIN toggles
- `JUNIOR sees RESUME(own)/SCAN(own)` — 2 таба
- `HR sees RESUME/SCAN/CONTRACT(own teams)` — 3 таба
- `ACCOUNTANT sees SCAN(read)/RECEIPT(read all)` — 2 таба, read-only

**1.3. Validation**
- `file > 10 MB blocked client-side` — load 11 MB file, expect toast «Файл больше 10 MB»
- `non-whitelisted MIME blocked` — load `.exe` или `.txt`, expect toast «Недопустимый формат файла»

**1.4. Soft delete + Restore**
- `owner soft-deletes own RESUME` — клик «Удалить», document scрывается. Без `includeDeleted` не видно.
- `ADMIN toggles «Показать удалённые»` — видит soft-deleted с badge «Удалён»
- `ADMIN restores soft-deleted` — клик «Восстановить», document возвращается без badge

**1.5. Hard delete (ADMIN only, after soft delete)**
- `ADMIN cannot hard-delete document that is not soft-deleted` — кнопка «Удалить навсегда» скрыта
- `ADMIN hard-deletes soft-deleted document` — confirm dialog → клик → toast «Документ удалён навсегда» → document полностью пропадает (даже с includeDeleted)
- `non-ADMIN роли не видят кнопку «Удалить навсегда»` — даже на свои документы

**1.6. Download**
- `download generates valid presigned URL` — клик «Скачать» → новая вкладка/window.open с pre-signed S3 URL
- `pre-signed URL expires per TTL` — (опционально, может быть unit-тест) — проверить что URL содержит `X-Amz-Expires` ~ 24h

### 2. `apps/e2e/tests/receipts-integration.spec.ts` — **новый файл**

**2.1. Транзакция → чек документ**
- `SENIOR creates transaction with receipt` — открыть Finance, создать транзакцию с прикреплённым JPEG чеком, submit → проверить:
  - Транзакция создана со статусом PENDING
  - В Documents/«Чеки» табе появляется новая карточка RECEIPT
  - Карточка имеет link «К транзакции #...» (последние 8 символов tx.id)

**2.2. Receipt link → Transaction**
- `ADMIN clicks "К транзакции #..." link in receipt card` — открывается `/crm/finance?openTx=<id>` → TransactionDetailDialog открыт с этой транзакцией

**2.3. Receipt cannot be deleted standalone**
- `SENIOR tries to delete own receipt card` — кнопка «Удалить» disabled c tooltip «Чек удаляется вместе с транзакцией»

**2.4. Transaction cascade delete**
- `ADMIN deletes transaction with receipt` — transaction marked deleted → receipt document also soft-deleted (visible only with includeDeleted toggle)

### 3. `apps/e2e/tests/avatars-logos-integration.spec.ts` — **новый файл**

**3.1. Avatar upload via Profile**
- `user uploads avatar in /crm/profile` — открыть профиль, AvatarUploadDialog, выбрать JPEG → проверить:
  - `users.avatarDocId` обновлён (через GET /api/auth/me — `avatarUrl` теперь от documents endpoint)
  - Аватар отображается в шапке (Header), в Team list, Projects, везде
  - В Documents (ADMIN с toggle «Показать internal») — появляется в табе «Аватары»

**3.2. Avatar change replaces old**
- `user uploads new avatar` — old AVATAR document gets soft-deleted, new one becomes active
- `ADMIN sees old avatar in deleted list` — через includeDeleted + includeInternal

**3.3. Project logo upload**
- `ADMIN uploads logo in project edit` — открыть `/crm/projects/:id` → edit → upload PNG logo → проверить:
  - `projects.logoDocId` обновлён
  - Логотип отображается в ProjectRow, ProjectLogo компоненте, project detail
  - В Documents (ADMIN с toggle «Показать internal») — появляется в табе «Логотипы»

**3.4. Logo change replaces old**
- Same as 3.2 для projects.

### 4. `apps/e2e/tests/fixtures.ts` — **обновить**

Добавить helper'ы:
- `createTestDocument(category, ownerId, projectId?, file?)` — POST через API, возвращает Document
- `uploadFileViaUi(page, filePath, category)` — helper для UI upload flow
- `verifyDocumentVisibleInTab(page, docName, tabName)` — assertion

Тестовые файлы — в `apps/e2e/fixtures/`:
- `sample-receipt.jpg` (~50 KB)
- `sample-resume.pdf` (~100 KB)
- `sample-avatar.jpg` (~30 KB, square)
- `sample-logo.png` (~20 KB, square)
- `oversized.pdf` (11 MB — для test 1.3)
- `invalid.exe` (для MIME blocking — можно `.bin`)

### 5. CI integration

E2E job в `.github/workflows/ci.yml` уже запускает все `.spec.ts` файлы — новые тесты подхватятся автоматически. Никаких изменений в workflow не нужно.

**MinIO в CI:** Уже настроен в e2e.yml (PR #45). Тесты с upload должны работать против `http://localhost:9000` (MinIO dev).

## Acceptance criteria

- [ ] `apps/e2e/tests/documents.spec.ts` — все 6 групп (1.1-1.6) implemented
- [ ] `apps/e2e/tests/receipts-integration.spec.ts` — 4 группы (2.1-2.4) implemented
- [ ] `apps/e2e/tests/avatars-logos-integration.spec.ts` — 4 группы (3.1-3.4) implemented
- [ ] `apps/e2e/tests/fixtures.ts` — helpers + тестовые файлы в `apps/e2e/fixtures/`
- [ ] **Локально:** `pnpm --filter @crm/e2e test` — все новые тесты pass (запустить через `pnpm dev` локально + MinIO docker)
- [ ] **CI:** `git push origin tests/documents-e2e` → E2E Tests job зелёный
- [ ] **Unit tests + Typecheck не сломаны** — `pnpm test` + `pnpm typecheck` локально

## Запрещено трогать

- Product code (`apps/web`, `apps/api`, `packages/shared`) — только E2E spec'ы
- Существующие тесты (auth/team/projects/finance/etc.) — кроме `fixtures.ts` helpers (добавление, не модификация существующих fixtures)
- Migrations, schemas
- `.github/workflows/` — кроме крайнего случая (если нужен дополнительный fixture step)

## Verification (AutoTest перед push)

1. `pnpm --filter @crm/e2e test` локально — все 14+ новых test cases pass
2. `pnpm test` + `pnpm typecheck` — unit тесты + типы не сломаны
3. `git diff HEAD --stat` — diff в основном `apps/e2e/`
4. Commit: `test(documents): E2E coverage для PHASE 6 (documents/receipts/avatars/logos)` + `ac_verified: 1-7`
5. Open PR `tests/documents-e2e` → main
6. Notify PM что PR open + добавить `ai-review-ready` label

## Notes

После merge — **PHASE 6 завершена полностью**:
- Documents (RESUME/SCAN/CONTRACT)
- Receipts (4-я категория, linked к transactions)
- Avatars (5-я internal категория, через профили)
- Logos (6-я internal категория, через project edit)
- E2E coverage всей цепочки

Следующая фаза по плану — **PHASE 7 (полный профиль)** или **PHASE 8 (Smart contracts USDT)** — решает пользователь.
