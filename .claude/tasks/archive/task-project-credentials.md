# task-project-credentials

## Агент: coder

## Приоритет: high

## Модель: opus — триггер model-routing: Drizzle-миграция + cross-module рефактор (HrAccessService) + криптография/секреты (цена ошибки = утечка паролей)

## Зависит от: task-fix-junior-ut-round1 (общий файл apps/web/app/routes/crm/project.tsx — диспатч только после merge PR раунда 1)

## Ветка: feature/project-credentials

## Контекст

UT-запрос юзера: джун должен хранить пароли рабочих аккаунтов проекта прямо на «Мой проект»;
HR и ADMIN тоже могут смотреть и редактировать. Хранение — безопасное (шифрование at-rest,
plaintext только по явному reveal). Это новая security-поверхность — security-reviewer на PR обязателен.
Дизайн-спека от ui-ux-designer: `docs/design/project-credentials.md` (если файла нет к моменту
старта — реализуй по этому task-файлу, спека уточняет только визуал).

## Конкретные изменения

### DB + crypto

1. Миграция: таблица `project_credentials` (см. DB schema ниже) — `pnpm --filter @crm/api db:generate`.
2. `apps/api/src/config/env.ts` — env `CREDENTIALS_ENC_KEY`: zod `z.string().min(32)` +
   refine на production (не дефолт); добавить в `apps/api/.env.example` с комментарием
   (генерация: `openssl rand -hex 32`). Паттерн — как JWT_SECRET там же.
3. `apps/api/src/credentials/credentials-crypto.service.ts` — AES-256-GCM через `node:crypto`:
   `encrypt(plaintext) → "v1:<iv b64>:<tag b64>:<ciphertext b64>"`, `decrypt(token)`.
   Ключ derive из CREDENTIALS_ENC_KEY (sha256 → 32 bytes). Unit-тест roundtrip + tamper (битый tag → throw).

### API-модуль `apps/api/src/credentials/`

4. module + controller `@Controller('projects')` + service по образцу legends-модуля
   (apps/api/src/legends/\* — свежий референс):
   - `GET    /projects/:projectId/credentials` — список БЕЗ plaintext (id, label, login, url, notes, updatedAt; пароль НЕ возвращается вообще, даже маской).
   - `POST   /projects/:projectId/credentials` — создать {label, login?, password, url?, notes?}; password шифруется, plaintext не логируется.
   - `PATCH  /projects/:projectId/credentials/:id` — обновить (password опционален — если пришёл, перешифровать).
   - `DELETE /projects/:projectId/credentials/:id`.
   - `GET    /projects/:projectId/credentials/:id/reveal` — `{password: plaintext}`; `@Throttle({limit: 30, ttl: 60_000})`; `Cache-Control: no-store` (паттерн — signed-contracts.controller.ts:74).
   - Все ответы через zod-схемы из shared; body парсить `.parse()` в контроллере (паттерн legends.controller).
5. RBAC в сервисе (relationship-based, как legends.canAccess): ADMIN — все проекты;
   HR — через **HrAccessService** (см. п.6); JUNIOR — активный `project_members` этого проекта;
   SENIOR / DROP / ACCOUNTANT — 403 всегда. Один helper `assertAccess(viewer, projectId)` на все 5 endpoints.

### Cross-module рефактор (забукмарченный follow-up — это ТРЕТЬЯ копия HR-хелпера)

6. `apps/api/src/common/` (или `users/`) — `HrAccessService.hrSharesActiveTeamWith(hrId, userId): Promise<boolean>`
   (логика = legends.service.ts:hrCanAccess: active team_members обоих, left_at IS NULL).
   Перевести на него: legends.service.ts (hrCanAccess), hr-contact эндпоинт (apps/api/src/projects/ — найди через ast-grep), новый credentials.service.
   Существующие unit/integration-тесты этих модулей должны остаться зелёными БЕЗ ослабления ассертов.

### Shared

7. `packages/shared/src/schemas/credentials.ts` — `projectCredentialSchema` (без password!),
   `createCredentialSchema`, `updateCredentialSchema`, `revealResponseSchema`; export в index.ts.

### Web

8. `apps/web/app/components/projects/ProjectCredentialsSection.tsx` (образец — ProjectLegendSection.tsx):
   список (label, login, url; пароль = «••••••••» + кнопка-глаз → fetch reveal → показать/скопировать
   в буфер + авто-скрытие через ~30с), добавление/редактирование (Dialog), удаление с confirm.
   Русские тексты. Хук `use-credentials.ts` по образцу use-legend.ts, все ответы `.parse()`.
9. Junior-хаб `apps/web/app/routes/crm/project.tsx` — карточка «Пароли проекта» (рендер ProjectCredentialsSection с projectId активного проекта).
10. `apps/web/app/routes/crm/projects/$projectId.tsx` — секция в табе overview для ADMIN/HR (рядом с ProjectLegendSection; для HR — рендерить, бек сам даст 403/пустоту если нет доступа → скрыть секцию по 403, паттерн useHrContact в project.tsx:129-144).

## DB schema

```sql
CREATE TABLE project_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label text NOT NULL,                 -- «GitHub», «Jira»...
  login text,
  password_ciphertext text NOT NULL,   -- v1:<iv>:<tag>:<data>, AES-256-GCM
  url text,
  notes text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_credentials_project_idx ON project_credentials(project_id);
```

## RBAC (кто смотрит → чьи пароли)

| Viewer                                       | Доступ к /projects/:id/credentials                     |
| -------------------------------------------- | ------------------------------------------------------ |
| JUNIOR — активный member проекта :id         | list/create/edit/delete/reveal                         |
| HR — шарит активную команду с senior проекта | list/create/edit/delete/reveal                         |
| ADMIN                                        | full                                                   |
| JUNIOR чужого проекта, HR чужой команды      | **403**                                                |
| SENIOR, DROP, ACCOUNTANT                     | **403** (allowlist: junior+hr+admin, по заданию юзера) |

## Acceptance criteria

- [ ] 1. Миграция project_credentials применяется идемпотентно (db:migrate на чистой БД ок); plaintext-пароль НИГДЕ не пишется в БД/логи (grep по сервису: нет log(password), insert только ciphertext).
- [ ] 2. CredentialsCrypto: unit-тесты roundtrip + tamper-detection зелёные; env CREDENTIALS_ENC_KEY валидируется на старте, есть в .env.example.
- [ ] 3. List-эндпоинт не содержит ни password, ни ciphertext в ответе (integration-тест проверяет отсутствие ключей).
- [ ] 4. Integration RBAC-матрица на РЕАЛЬНОЙ БД (scratch): свой JUNIOR 200; чужой JUNIOR 403; HR своей команды 200; HR чужой 403; SENIOR 403; DROP 403; ACCOUNTANT 403; ADMIN 200 — для list И для reveal.
- [ ] 5. Reveal: возвращает расшифрованный пароль только при праве доступа; Throttle настроен; Cache-Control: no-store.
- [ ] 6. HrAccessService: legends + hr-contact + credentials используют ОДИН helper (ast-grep: старые приватные копии удалены); их существующие тесты зелёные.
- [ ] 7. UI: на хабе джуна карточка «Пароли проекта» (add → в списке маской → глаз → plaintext+копировать → авто-скрытие); та же секция на /crm/projects/$projectId для ADMIN/HR.
- [ ] 8. Все web-ответы через .parse() (схемы credentials.ts); typecheck + eslint MCP чистые.
- [ ] 9. Playwright-скриншоты в PR: junior-хаб с карточкой, диалог добавления, reveal-состояние; ADMIN project-detail с секцией.

## Interaction tests

- [ ] Dialog добавления: Escape закрывает без сохранения, focus restore на trigger; submit по Enter в текстовом поле НЕ отправляет форму случайно (textarea notes).
- [ ] Reveal: повторный клик глаза скрывает; кнопка «копировать» кладёт пароль в clipboard (проверить через playwright clipboard permissions или graceful-фоллбек).

## Запрещено трогать

- `apps/e2e/**/*.spec.ts` — зона AutoTest.
- `users.service.ts buildProfileView`, junior mapProject allowlist — не расширять.
- finance/transactions, contracts — вне задачи.
- `.claude/**` кроме своего progress-файла, `.github/**`.

## Verification (Coder перед `git push`)

1. `git diff HEAD --name-only` — только файлы задачи (+ миграция + routeTree не коммитить, он gitignored).
2. AC по grep/тестам; integration — на scratch-БД (НЕ на crm_db!).
3. Playwright скриншоты (AC 9).
4. Финальный коммит: `ac_verified: 1,...,9` + `vision: ✓ /crm/project, /crm/projects/$projectId`.
