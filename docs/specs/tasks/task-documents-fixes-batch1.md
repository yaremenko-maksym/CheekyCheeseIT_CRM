# task-documents-fixes-batch1

## Агент: coder
## Приоритет: high
## Зависит от: task-documents-ui (PR #48 — extends existing branch)
## Ветка: feature/documents-ui (extend; НЕ создавать новую)

## Контекст

User-testing fixes batch1 для PR #48 (`/crm/documents` UI). 6 связанных правок —
все в одном task для consistency (migrations + API + UI взаимозависимы).
PR #48 ещё OPEN; этот батч расширяет ту же ветку → Reviewer переревьюит.

## Конкретные изменения

### Fix 1 — «Договори» → «Договоры» (русский typo)
- `apps/web/app/routes/crm/documents.tsx` — `CATEGORY_LABELS_RU.CONTRACT` и
  ASCII-комментарий в шапке файла.

### Fix 2 — Шапка + controls в стиле Users/Projects
- Motion entrance (`framer-motion` — `initial`/`animate`/`transition`)
- Counter под заголовком: `«N документ(а|ов) [· в архиве | · все]»`
  (русская плюрализация)
- Primary action button: `<Plus /> Загрузить` справа
- `SegmentedToggle` tri-state (Все / Активные / Архив) — ADMIN видит все 3,
  не-ADMIN видит «Архив» disabled.

### Fix 3 — Grid карточек
- Оставлен (НЕ rows). Thumbnails визуально важны.

### Fix 4 — DocumentDetailDialog (modal viewer)
- Новый компонент `apps/web/app/components/documents/document-detail-dialog.tsx`
- Click по preview/filename → открывает с full-res preview + metadata
  (Загрузил / Дата / Размер / Формат / Имя файла / Проект)
- Действия: Закрыть · Скачать · Удалить · Восстановить · Удалить навсегда (RBAC)
- Deep-link: `?openDocId=<uuid>` (search-param через `validateSearch` +
  `Route.useSearch()`); открытие/закрытие синхронизирует URL.

### Fix 5 — Thumbnails MANDATORY
- Новая миграция `0011_documents_thumbnail_and_filename.sql` —
  добавляет `thumbnail_s3_key VARCHAR(512)` + `original_name VARCHAR(255)`.
- `DocumentsService.upload()` — теперь генерит thumbnail **синхронно**
  ДО S3 upload, persists в `thumbnail_s3_key`. PDF / non-image → NULL →
  UI fallback на icon.
- Новый endpoint `GET /api/documents/:id/thumbnail` →
  `{ url, expiresAt } | null` (presigned URL для миниатюры или null).
- Новый hook `useDocumentThumbnailUrl()` (`@/hooks/use-documents.ts`) —
  4h staleTime, как у `useDocumentDownloadUrl`.
- `DocumentImage` — теперь `variant: 'thumbnail' | 'full'` + `fallbackToParent`
  prop. Card grid использует thumbnail; DetailDialog — full.
- `hardDelete` — удаляет thumbnail из S3 используя реальный `doc.thumbnailS3Key`
  (а не вычисленный suffix).

### Fix 6 — Filename normalization (Variant 3 hybrid)
- DB: `documents.name` = sanitized ASCII (используется в `s3_key` + как
  download-as filename); `documents.original_name` = оригинал
  (cyrillic / unicode preserved). Backfill `original_name = name` в миграции.
- `documentSchema` (Zod): `name` + `originalName` (nullable для legacy) +
  `thumbnailS3Key` (nullable).
- `S3Service.getPresignedDownloadUrl(key, ttl, downloadAs?)` —
  RFC 5987 `Content-Disposition: attachment; filename="ascii"; filename*=UTF-8''<%enc>`
  чтобы браузер скачивал под оригинальным именем (cyrillic).
- `DocumentCard` + `DocumentDetailDialog` — показывают `doc.originalName ?? doc.name`.

## API endpoints

Новый:
- `GET /api/documents/:id/thumbnail` — `{ url, expiresAt } | null`

Существующие — без изменений (схема ответа `Document` расширилась полями
`originalName` / `thumbnailS3Key`).

## DB schema

Миграция 0011 (новая):
```sql
ALTER TABLE documents ADD COLUMN IF NOT EXISTS thumbnail_s3_key varchar(512);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS original_name varchar(255);
UPDATE documents SET original_name = name WHERE original_name IS NULL;
```

## RBAC — без изменений

Только перенесли «Показать удалённые» checkbox → tri-state SegmentedToggle
(`ARCHIVED` опция disabled для не-ADMIN). Semantics те же:
`includeDeleted = isAdmin && statusTab === 'ARCHIVED'`.

## Acceptance criteria

- [x] `pnpm --filter @crm/shared typecheck && test` — 88 tests passed
- [x] `pnpm --filter @crm/api typecheck && lint && test && build` — 211 tests passed
- [x] `pnpm --filter @crm/web typecheck && lint && test && build` — 79 tests passed
- [x] Migration 0011 applied to `_journal.json`
- [x] Нет строки «Договори» в `apps/web/app/` (grep returns 0)
- [x] `SegmentedToggle` импортирован в `documents.tsx`
- [x] `DocumentDetailDialog` создан и подключён в `documents.tsx`
- [x] `useDocumentThumbnailUrl` экспортирован из `use-documents.ts`
- [x] `S3Service.getPresignedDownloadUrl` принимает 3-й аргумент `downloadAs`
- [x] `s3.service.spec.ts` — 8 tests (2 новых: downloadAs + omits Content-Disposition)
- [x] `documents.spec.ts` (shared) — 23 tests (3 новых: thumbnail/originalName variants)
- [x] `documents.service.spec.ts` — 42 tests (1 новый: hardDelete без thumbnail)
- [ ] **Visual smoke** — PM прогонит после merge.

## Файлы — точный список

### API
- `apps/api/drizzle/migrations/0011_documents_thumbnail_and_filename.sql` (new)
- `apps/api/drizzle/migrations/meta/_journal.json` (append idx 11)
- `apps/api/src/database/schema.ts` (documents table: +originalName +thumbnailS3Key)
- `apps/api/src/documents/documents.service.ts` (sync thumb upload + originalName + downloadAs)
- `apps/api/src/documents/documents.controller.ts` (new GET /:id/thumbnail)
- `apps/api/src/documents/s3.service.ts` (getPresignedDownloadUrl + downloadAs RFC 5987)
- `apps/api/src/documents/documents.service.spec.ts` (DocRow type + hardDelete test)
- `apps/api/src/documents/s3.service.spec.ts` (+2 downloadAs tests)

### Shared
- `packages/shared/src/schemas/documents.ts` (documentSchema: originalName + thumbnailS3Key)
- `packages/shared/src/schemas/documents.spec.ts` (+3 cases)

### Web
- `apps/web/app/routes/crm/documents.tsx` (new layout — SegmentedToggle + motion + counter + deep-link)
- `apps/web/app/components/documents/document-card.tsx` (originalName + thumbnail variant + onOpen)
- `apps/web/app/components/documents/document-list.tsx` (forward onOpen)
- `apps/web/app/components/documents/document-image.tsx` (variant + fallbackToParent)
- `apps/web/app/components/documents/document-detail-dialog.tsx` (new)
- `apps/web/app/hooks/use-documents.ts` (+useDocumentThumbnailUrl)

### Docs
- `docs/specs/tasks/task-documents-fixes-batch1.md` (этот файл)

## Запрещено трогать

- ничего вне списка выше.
- `apps/web/app/routeTree.gen.ts` — он gitignored.

## Notes (anti-hang lesson)

Использовал 10 intent markers (`scripts/coder/coder-intent.sh`) между milestones:
M0 (start) → M1 (planning) → M2 (typo) → M3 (migration+thumb) → M4 (specs)
→ M5 (web hooks) → M6 (DetailDialog+Card) → M7 (documents.tsx) → M8 (validation)
→ M9 (task file + push). Каждый marker — отдельная `bash` команда чтобы
watchdog видел live progress.
