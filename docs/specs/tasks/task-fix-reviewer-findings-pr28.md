# task-fix-reviewer-findings-pr28

## Агент: coder
## Приоритет: critical
## Ветка: claude/youthful-hermann-8df1d5 (PR #28 — уже открыт)

## КРИТИЧЕСКИ ВАЖНО

- **Это fix-задача в существующую ветку** — НЕ создавай новую.
- `git fetch origin && git checkout claude/youthful-hermann-8df1d5 && git pull origin claude/youthful-hermann-8df1d5`
- Каждый critical → отдельный коммит. Push в эту же ветку → PR #28 обновится.
- `pnpm exec turbo typecheck lint --force` чистый перед каждым commit'ом.

## Контекст

Reviewer-агент сделал code review PR #28 (review URL: https://github.com/yaremenko-maksym/CheekyCheeseIT_CRM/pull/28) и нашёл **5 critical findings**, блокирующих merge. Дев-окружение работает только потому что миграции применены вручную через psql. Production deploy на main сломается.

## CRITICAL #1 — Drizzle journal collision (блокирует fresh deploy)

### Текущее состояние

**SQL файлы в `apps/api/drizzle/migrations/`:**
```
0000_fresh_emma_frost.sql
0001_add_tx_date.sql            ← collision на 0001
0001_sour_unicorn.sql           ← collision на 0001
0002_logo_url_text.sql
0003_interview_corp_tech.sql    ← collision на 0003
0003_payment_requisites_audit_log.sql  ← collision на 0003
0004_client_interview_stage.sql
0005_project_notes_fields.sql
0006_team_telegram_notes.sql
0007_salary_currency.sql
0008_avatar_override.sql
```

**Journal `apps/api/drizzle/migrations/meta/_journal.json` entries:**
```
idx 0 → 0000_fresh_emma_frost
idx 1 → 0001_sour_unicorn       (но какой 0001?)
idx 2 → 0006_team_telegram_notes (WRONG — должен быть 0002_logo_url_text)
idx 3 → 0003_payment_requisites_audit_log
idx 8 → 0008_avatar_override
MISSING: idx 4, 5, 6, 7
```

На fresh БД `drizzle-kit migrate` упадёт или применит неполный набор.

### Что сделать

Полностью пересобрать миграционную последовательность БЕЗ collision и БЕЗ потерь данных.

**Подход:**
1. Определи реальный порядок выполнения миграций по DB-структуре (через `mcp__postgres__query` — посмотри `SELECT * FROM __drizzle_migrations ORDER BY id;`).
2. Переименуй collision-файлы в свободные слоты:
   - `0001_add_tx_date.sql` → `0002a_add_tx_date.sql` (или сдвинуть на свободный idx)
   - `0003_interview_corp_tech.sql` → `0003a_interview_corp_tech.sql`
   ИЛИ полностью перенумеровать всё начиная с 0001 в правильном порядке (предпочтительно).
3. Перегенерируй journal через `pnpm --filter @crm/api drizzle-kit generate --custom` или вручную в правильном порядке: каждому SQL-файлу — entry в journal с уникальным `idx` и `when`-timestamp в реальном порядке создания.
4. Убедись что hash'и в `__drizzle_migrations` таблице соответствуют новым именам файлов — иначе drizzle-kit пересчитает и попробует применить заново → ошибки. Возможно нужно `UPDATE __drizzle_migrations SET hash = '<new_hash>' WHERE id = X;` или drop этой таблицы и reapply.

**Тест на acceptance:**
```bash
# Fresh DB simulation:
PGPASSWORD=password psql -h localhost -p 5432 -U crm_user -d crm_db -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO crm_user;"
pnpm --filter @crm/api drizzle-kit migrate
# Должно завершиться без ошибок и БД должна иметь все колонки (avatar_override включительно).
pnpm --filter @crm/api db:seed
# Seed должен сработать.
```

Если миграции не должны быть применены в порядке создания (например 0001_add_tx_date был добавлен позже но логически идёт раньше), уточни в коде / git log.

Commit-сообщение: `fix(api): rebuild drizzle migration journal — resolve 0001/0003 collisions and missing idx 4-7`

## CRITICAL #2 — `GET /users/:id/team` без RBAC (privilege escalation)

### Файл

`apps/api/src/users/users.controller.ts:100` (endpoint `getUserTeam`)

### Проблема

Любой залогиненный JUNIOR может через прямой API call получить состав чужой команды (даже не своей). UI guards через `permissions.tabs.includes('team')` обходимы.

### Что сделать

В endpoint:
```ts
@Get(':id/team')
async getUserTeam(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() viewer: SessionUser) {
  const viewerUser = await this.usersService.findById(viewer.id)
  const target = await this.usersService.findById(id)
  if (!viewerUser || !target) throw new ForbiddenException()
  const permissions = await this.accessService.getViewPermissions(viewerUser, target)
  if (!permissions.tabs.includes('team')) throw new ForbiddenException()
  return this.usersService.getTeamMembersForUser(id)
}
```

Нужен `UsersAccessService` инжектированный в controller (если ещё нет — добавь). Или используй существующий `buildProfileView` подход через `usersService.canViewTeam(viewer, target)` helper если хочешь чище.

**Unit test (создай в `users.controller.spec.ts` или новый `users.team-endpoint.spec.ts`):**
- JUNIOR viewer на другого JUNIOR (не в общей команде) → 403
- JUNIOR viewer на JUNIOR в общем проекте → 200 + members list
- HR viewer на JUNIOR из команды его SENIOR → 200
- HR viewer на JUNIOR не из их команд → 403
- ADMIN viewer на любого → 200

Commit: `fix(api): RBAC guard on GET /users/:id/team — reject viewers who cannot see team tab`

## CRITICAL #3 — `GET /users/:id/transactions` подменяет роль на ADMIN

### Файл

`apps/api/src/users/users.controller.ts:118-130`

### Проблема

```ts
return this.transactionsService.findAll(
  { ...currentUser, role: 'ADMIN' },  // ← spoof
  { seniorId: id },
)
```

Защищено только декоратором `@Roles('ADMIN', 'ACCOUNTANT')` — если кто-то снимет декоратор или нерпавильно настроит guard order — privilege escalation.

### Что сделать

Двойная защита: явная проверка роли внутри handler + правильная сигнатура `TransactionsService.findAll`. Если `TransactionsService.findAll` принимает viewer с ролью для фильтрации — оставить как есть, но добавить явную проверку:

```ts
@Get(':id/transactions')
@Roles('ADMIN', 'ACCOUNTANT')
async getUserTransactions(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() viewer: SessionUser) {
  if (viewer.role !== 'ADMIN' && viewer.role !== 'ACCOUNTANT') {
    throw new ForbiddenException()
  }
  if (!this.transactionsService) return []
  // Используем реальную роль вьюера, не подменяем
  return this.transactionsService.findAll(viewer, { seniorId: id })
}
```

Если `transactionsService.findAll` фильтрует по `viewer.role === SENIOR` (себе только) — то нужно либо новый метод `findAllForAdminAudit(targetSeniorId)`, либо whitelist через явную опцию.

Commit: `fix(api): drop role-spoof in GET /users/:id/transactions — rely on @Roles + explicit assert`

## CRITICAL #4 — avatarOverride accepts any blob (XSS surface)

### Файл

`packages/shared/src/schemas/users.ts` (updateProfileSchema / adminUpdateUserSchema) — поле `avatarOverride`

### Проблема

```ts
avatarOverride: z.string().max(1_500_000).nullable().optional()
```

Принимает `data:text/html,<script>...</script>`, `data:application/json,...`, обычный текст. Если где-то `<img src={avatar}>` заменится на iframe / object / link — XSS.

### Что сделать

Добавь регекс / refine для проверки:
- Допустимые форматы: `https://...` или `data:image/(png|jpeg|gif|webp|svg+xml);base64,...`
- SVG разрешать осторожно — оно может содержать `<script>`. Лучше **запретить SVG в data:** и разрешить только https URL для SVG.

```ts
const AVATAR_PATTERN = /^(https:\/\/.+|data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+)$/

avatarOverride: z.string()
  .max(1_500_000, 'Аватар слишком большой (макс ~1MB)')
  .regex(AVATAR_PATTERN, 'Аватар должен быть https URL или data:image/(png|jpeg|gif|webp) base64')
  .nullable()
  .optional()
```

Обнови frontend `AvatarUploadDialog.tsx` чтобы при загрузке файла отклонять не-allowed MIME types (PNG/JPEG/GIF/WebP only), и показывать ошибку.

**Unit test:** schema reject `data:text/html,...`, reject plain string, accept valid data:image/png;base64,...

Commit: `fix(security): tighten avatarOverride validation — allowlist image MIME, reject HTML/SVG`

## CRITICAL #5 — empty stubs `team_membership` / `project_reassign`

### Файлы

- `apps/api/src/users/users.controller.ts:178-194` (endpoints `manageTeam` и `reassignProject`)
- Frontend `AdminActionsMenu.tsx` — action items "Управление командой" / "Переназначить проект"

### Проблема

Эндпоинты возвращают `{ ok: true, ...dto }` без реальных DB-операций. Audit log тем не менее пишет event (через `@AuditLog` декоратор). Пользователь думает что действие применилось.

### Что сделать

Выбери один из подходов:

**Подход A (предпочтительно):** Возвращай `501 Not Implemented` и убери `@AuditLog`:
```ts
@Post(':id/team-membership')
@Roles('ADMIN')
async manageTeam(@Param('id', ParseUUIDPipe) _id: string, @Body() _body: unknown) {
  throw new NotImplementedException('Управление командой будет в следующей итерации')
}
```

Параллельно в UI:
- Кнопки "Управление командой" / "Переназначить проект" в `AdminActionsMenu.tsx` сделай disabled с tooltip "Скоро" или скрой совсем.

**Подход B:** Реализовать сейчас (большой объём — не входит в этот task).

Иди подходом A.

Commit: `fix(api): mark team-membership and project-reassign endpoints as Not Implemented (501)`

## ACCEPTANCE

После всех 5 коммитов:
1. `pnpm exec turbo typecheck lint --force` — clean
2. `cd apps/api && pnpm test` — все unit-тесты passed (включая новый guard test для CRITICAL #2)
3. CI на PR #28 `Typecheck · Lint · Unit Tests` — зелёный
4. Fresh DB simulation: `DROP SCHEMA + CREATE SCHEMA + drizzle-kit migrate` без ошибок (CRITICAL #1)
5. Smoke: API:3001 + Web:3000 — 200, профили открываются для всех ролей
6. Push в `claude/youthful-hermann-8df1d5`

## После завершения

Короткий summary (≤200 слов):
- 5 SHA коммитов с маппингом на findings
- Что проверено локально (fresh-DB migrate, новые unit tests)
- Что в CI status
- Blockers if any

Используй MCP-инструменты: postgres MCP для DB checks, ast-grep для поиска symbol references, context7 для drizzle-kit docs.
