# task-documents-ui

## Агент: coder
## Приоритет: high
## Зависит от: task-documents-data-layer, task-documents-api
## Ветка: feature/documents-ui

## Контекст

PHASE 6 (Документы) — frontend. Заменить заглушку `/crm/documents` на полнофункциональный модуль: 3 таба (Резюме / Сканы / Договори), upload dialog, list карточек, download/delete/restore с RBAC visibility. UI **полностью на русском**. См. полный спек: [`docs/specs/pm-brief.md`](../pm-brief.md). API + shared schemas уже готовы — импортировать `Document`, `documentCategorySchema`, `DOCUMENT_MAX_BYTES`, `DOCUMENT_MIME_WHITELIST` из `@crm/shared`.

## Конкретные изменения

1. `apps/web/app/routes/crm/documents.tsx` — **заменить заглушку**:
   - Tabs (shadcn `Tabs` component) с **4 видимыми значениями**: `RESUME` / `SCAN` / `CONTRACT` / `RECEIPT` + label на русском («Резюме» / «Сканы документов» / «Договори» / «Чеки»). `AVATAR` и `LOGO` — **internal categories**, в табах НЕ показываются (управляются из Profile/ProjectEdit, не отсюда).
   - **ADMIN-only тогл** «Показать internal» (вместе с «Показать удалённые») — включает `includeInternal=true` в API query. При включении — появляются ещё 2 таба: «Аватары» и «Логотипы» (только для audit/cleanup).
   - **Видимость табов RBAC** (см. pm-brief таблицу «Видимость табов по ролям»). Если у роли 0 видимых табов — показать empty state «У вас нет доступа к документам»
   - Фильтр по `ownerId` (Select со списком пользователей — для ADMIN/HR; для остальных скрыт)
   - Тогл «Показать удалённые» (только для ADMIN, заполняет `includeDeleted=true` в query)
   - Кнопка «Загрузить» — открывает `<UploadDocumentDialog>` с предзаполненной `category` из активного таба
   - **Исключение для таба «Чеки»:** кнопка «Загрузить» НЕ показывается (`category === 'RECEIPT'` → null). На empty state — `<Link to="/crm/finance">` с текстом «Чеки прикрепляются через раздел Финансы при создании транзакции».

2. `apps/web/app/components/documents/document-list.tsx` — **новый**:
   - Принимает: `documents: Document[]`, `loading: boolean`, `viewer: SessionUser` (для RBAC кнопок)
   - Рендерит grid карточек `<DocumentCard>` или empty state «Нет документов»

3. `apps/web/app/components/documents/document-card.tsx` — **новый**:
   - Thumbnail: для `image/*` — `<img>` с pre-signed URL (lazy load — `<img loading="lazy">`); для `application/pdf` — иконка `<FileText>` (lucide) + цветной badge «PDF»
   - Имя файла, размер (форматировать через `formatBytes` helper), дата (relative — «2 дня назад» через `date-fns/formatDistanceToNow` с locale ru), кто загрузил (имя)
   - Если `deletedAt !== null` — badge «Удалён», dim opacity-50
   - **Для RECEIPT карточек:** дополнительная строка-link «К транзакции #...» (последние 8 символов tx.id). При клике — `<Link to="/crm/finance" search={{ openTx: transactionId }}>`. Это deep-link открывает TransactionDetailDialog (опциональная feature — если Finance UI не поддерживает `openTx` search-param, добавить в search schema там же — но это уже scope finance-integration task, здесь только показать link).
   - Кнопки:
     - [Скачать] — onClick → `useDownloadDocument().mutate(doc.id)` → window.open(url)
     - [Удалить] (Trash icon) — onClick → confirm dialog → `useDeleteDocument().mutate(doc.id)`. Visible: `viewer.id === doc.ownerId || viewer.role === 'ADMIN'`. **Для RECEIPT карточек** — кнопка disabled с tooltip «Чек удаляется вместе с транзакцией» (нельзя удалить чек отдельно от транзакции — soft delete на транзакции каскадирует).
     - [Восстановить] (Undo icon) — onClick → `useRestoreDocument().mutate(doc.id)`. Visible: `viewer.role === 'ADMIN' && doc.deletedAt !== null`
     - **[Удалить навсегда]** (Trash2 red, destructive variant) — onClick → confirm dialog с warning «Файл будет удалён навсегда из S3 и базы. Действие необратимо. Продолжить?» → `useHardDeleteDocument().mutate(doc.id)`. Visible: `viewer.role === 'ADMIN' && doc.deletedAt !== null` (т.е. в режиме «корзины»). Toast после: «Документ удалён навсегда».

4. `apps/web/app/components/documents/upload-document-dialog.tsx` — **новый**:
   - shadcn `Dialog`. Открывается через `open`/`onOpenChange` props.
   - Поля:
     - File input (drag-and-drop area через `react-dropzone` либо `<input type="file">` + `onDragOver`/`onDrop` events — выбрать что компактнее)
     - `category` Select (предзаполнен из активного таба, можно сменить)
     - `projectId` Select (только если `category === 'CONTRACT'` — обязательно) — список активных проектов через `useProjects()`
     - `ownerId` Select (видимо только для ADMIN/HR/SENIOR — список пользователей, default = self)
   - **Client-side checks ДО submit:**
     - Size > `DOCUMENT_MAX_BYTES` → toast «Файл больше 10 MB» (red), block submit
     - MIME not в `DOCUMENT_MIME_WHITELIST` → toast «Недопустимый формат файла. Разрешены: PDF, JPG, PNG, WebP, HEIC»
   - Submit: `useUploadDocument().mutate({ file, category, projectId, ownerId })` — показывает прогресс (`<Progress>` из shadcn) на основе `onUploadProgress`. После success → toast «Документ загружен» + закрыть dialog + invalidate query.

5. `apps/web/app/hooks/use-documents.ts` — **новый**, TanStack Query hooks с **caching config**:
   - `useDocuments(filters: DocumentListFilters)` — `queryKey: ['documents', filters]`, `queryFn` через axios `GET /api/documents`. **`staleTime: 5 * 60 * 1000` (5 min)**, `gcTime: 30 * 60 * 1000` (30 min).
   - `useDocumentDownloadUrl(docId: string)` — **query, не mutation**, `queryKey: ['document-url', docId]`, `queryFn` GET `/:id/download` → `{ url, expiresAt }`. **`staleTime: 4 * 60 * 60 * 1000` (4 часа — под TTL 24h)**, `gcTime: 24 * 60 * 60 * 1000` (24 часа). Это значит presigned URL кешируется в TanStack — при повторном render Card → cached URL → browser cache → 0 S3 GETs.
   - `useUploadDocument()` — mutation, `FormData` с `file`, `category`, `projectId`, `ownerId`. `axios.post('/api/documents', formData, { onUploadProgress })`. Invalidates `['documents']`.
   - `useDeleteDocument()` — mutation, `DELETE /api/documents/:id`. Invalidates `['documents']`.
   - `useRestoreDocument()` — mutation, `POST /api/documents/:id/restore`. Invalidates.
   - **`useHardDeleteDocument()`** — mutation, `DELETE /api/documents/:id/hard`. Invalidates `['documents']` + `['document-url']` (removeQueries для конкретного docId).
   - **Image rendering helper** `<DocumentImage docId={...} />` — wrapper над `useDocumentDownloadUrl` + `<img src={data?.url}>` с error fallback на иконку. Используется в DocumentCard для thumbnail/preview.

6. `apps/web/app/lib/format-bytes.ts` — **новый helper** (если ещё нет): `formatBytes(n)` → `"2.3 MB"` (ru locale)

## API endpoints

Использует существующие из task-documents-api. Никаких новых endpoint'ов.

## DB schema

N/A.

## RBAC

См. pm-brief.md секция «Видимость табов по ролям». **4 видимых таба** (+ 2 internal под ADMIN тоглом):

| Роль | Резюме | Сканы | Договори | Чеки | (ADMIN-toggle) Аватары | (ADMIN-toggle) Логотипы | Может загружать (через /crm/documents) | Видит «Удалённые» |
|---|---|---|---|---|---|---|---|---|
| ADMIN | ✓ | ✓ | ✓ | ✓ (read) | ✓ (toggle) | ✓ (toggle) | RESUME, SCAN, CONTRACT (любого owner) | да + hard delete |
| SENIOR | ✓ | ✓ | ✓ (свои) | ✓ (свои, read) | — | — | RESUME, SCAN (любого), CONTRACT (self) | нет |
| JUNIOR | ✓ (свои) | ✓ (свои) | — | — | — | — | RESUME, SCAN (только self) | нет |
| HR | ✓ | ✓ | ✓ (свои команды) | — | — | — | RESUME, SCAN (любого) | нет |
| ACCOUNTANT | — | ✓ (read) | — | ✓ (все, read) | — | — | — (только просмотр) | нет |

- **Чеки** через `/crm/documents` НЕ загружаются — только через Finance dialogs. Кнопка «Загрузить» в табе «Чеки» скрыта.
- **Аватары/Логотипы** — internal: управляются из Profile / Project edit. ADMIN может включить toggle для audit.
- **Hard delete** — только ADMIN, только на soft-deleted документах (в режиме корзины). Confirm dialog обязателен.

## Acceptance criteria

- [ ] `pnpm --filter @crm/web typecheck` проходит
- [ ] `pnpm --filter @crm/web lint` проходит
- [ ] `pnpm --filter @crm/web build` проходит (production build)
- [ ] `apps/web/app/routes/crm/documents.tsx` НЕ содержит строку `'В разработке'` (заглушка заменена)
- [ ] `grep -n "Tabs" apps/web/app/routes/crm/documents.tsx` находит import shadcn Tabs
- [ ] `grep -rn "useUploadDocument" apps/web/app/` находит usage в upload dialog
- [ ] `grep -rn "DOCUMENT_MAX_BYTES" apps/web/app/components/documents/` находит client-side validation
- [ ] **Visual smoke (Playwright):** запустить `pnpm dev`, navigate to `http://localhost:3000/crm/documents` под ADMIN user (через dev-login), сделать скриншот. Должно быть видно: заголовок «Документы», **4 таба** (Резюме / Сканы документов / Договори / Чеки), кнопка «Загрузить» (на не-Чеки табах), empty state в активном табе.
- [ ] **Interaction smoke:** клик на «Загрузить» открывает dialog, есть file input + category select + кнопка Submit. Submit без файла — disabled.
- [ ] **Visual smoke (Чеки таб):** на табе «Чеки» под ADMIN — кнопка «Загрузить» отсутствует, на пустом state — link «Чеки прикрепляются через раздел Финансы…»
- [ ] **Visual smoke (RBAC):** под ACCOUNTANT — видны только табы «Сканы» и «Чеки» (2 из 4); под JUNIOR — только «Резюме» и «Сканы»; под HR — без «Чеки»
- [ ] **Hard delete UI:** под ADMIN: toggle «Показать удалённые» включает корзину → на soft-deleted card видны 2 кнопки [Восстановить] + [Удалить навсегда] (красная). Click на [Удалить навсегда] → confirm dialog с warning текстом → подтверждение → card исчезает + toast «Документ удалён навсегда».
- [ ] **AVATAR/LOGO hidden:** под любой ролью без ADMIN-toggle включения — табов «Аватары» и «Логотипы» НЕТ. Под ADMIN с включённым «Показать internal» — появляются 2 дополнительных таба.
- [ ] **Caching verification:** через Chrome DevTools Network tab открыть `/crm/documents` → tab Sources → запомнить количество запросов к `/api/documents/*/download`. F5 (reload) → запросов к этим URL = 0 (cached). Через 4 часа (или в DevTools clear cache) — запросы появятся снова.

## Interaction tests (ОБЯЗАТЕЛЬНО)

UI содержит Modal + Form + File upload — interaction matters:

- [ ] Upload Dialog: Escape закрывает dialog, focus restore на кнопку «Загрузить»
- [ ] Upload Dialog: Submit disabled пока нет файла
- [ ] Upload Dialog: drag-and-drop area меняет border color при `dragenter`/`dragleave`
- [ ] Upload Dialog: dropping файл > 10 MB → toast (red), submit не происходит
- [ ] Upload Dialog: dropping non-MIME файл → toast «Недопустимый формат»
- [ ] Document Card: клик «Удалить» открывает confirm — Escape отменяет, Enter подтверждает
- [ ] Document Card: tooltip на usercell с полным именем (если truncated)

## Запрещено трогать

- `apps/api/` — backend готов
- `packages/shared/` — schemas готовы
- Sidebar nav (`apps/web/app/components/crm/nav-sidebar.tsx`) — entry «Документы» уже есть
- Другие routes (teams, projects, finance, interviews, profile)
- Tailwind config

## Verification (Coder перед `git push`)

1. `git diff HEAD --name-only` → файлы только в `apps/web/app/routes/crm/documents.tsx`, `apps/web/app/components/documents/*`, `apps/web/app/hooks/use-documents.ts`, `apps/web/app/lib/format-bytes.ts`
2. `pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web build` — всё зелёное
3. Visual smoke через Playwright MCP — скриншот в commit description либо ссылка на attached image
4. Commit message: `ac_verified: 1-8`, `vision: ✓ /crm/documents`
