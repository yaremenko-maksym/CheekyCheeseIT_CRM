# task-drop-phase1-backend

## Агент: coder

## Приоритет: high

## Ветка: feat/drop-role-phase1

## Зависит от: —

## Источник истины: [`docs/specs/drop-role-and-finance-spec.md`](../drop-role-and-finance-spec.md)

## Контекст

**Фаза 1** новой фичи «роль DROP + команды дропа». Цель — добавить полноценную роль `DROP` (финансовая прокладка), её команду, расширить создание синьора 2-мя опциями и реализовать каскады архива. **Принцип №1: не сломать текущую логику синьора — все изменения строго аддитивны.**

Это **backend-часть Фазы 1**. После твоего успешного push'а к этой же ветке будет диспетчен frontend-таск (`task-drop-phase1-frontend.md`) и затем E2E (`task-drop-phase1-e2e.md`). Один PR на всю Фазу 1.

Финансовое распределение drop-проекта и ручное подтверждение выплаты — **НЕ В ЭТОЙ ФАЗЕ** (Фазы 2 и 3). Поле `projects.drop_id` создаётся, но distribution-ветка ещё не пишется.

## Подготовка (обязательно ДО кода)

1. Прочитай спек: [`docs/specs/drop-role-and-finance-spec.md`](../drop-role-and-finance-spec.md).
2. Сними ast-grep карту всех мест в `apps/api/` и `apps/web/`, где встречается `'SENIOR'` (литерал) или `seniorId` — записать в комментарии PR `## Senior touch-point inventory` с пометкой какие места ты трогаешь и какие — нет.
3. Через postgres MCP проинспектируй текущие enum'ы:
   ```sql
   SELECT typname, e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE typname IN ('role','interview_stage','currency','project_status','expense_type');
   ```
4. Прочитай `docs/agents/coder.md`, `docs/agents/CLAUDE-coder.md`, `docs/agents/memory/coder/lessons.md`.

## Acceptance Criteria

### AC1. Schema + миграция 0020

- [ ] `apps/api/src/database/schema.ts`:
  - `roleEnum` += `'DROP'` (5 → 6 значений).
  - `users` += `dropSharePercent: integer('drop_share_percent').default(5)` (nullable).
  - Новый enum `teamTypeEnum = pgEnum('team_type', ['SENIOR','DROP'])`.
  - `teams` += `type: teamTypeEnum('type').notNull().default('SENIOR')`.
  - `projects` += `dropId: uuid('drop_id').references(() => users.id, { onDelete: 'restrict' })` (nullable).
- [ ] `pnpm --filter @crm/api drizzle-kit generate` создаёт **одну** миграцию `0020_drop_role_and_schema.sql` (если drizzle разобьёт — допустимо 0020/0021, но в одном PR).
- [ ] В миграции явный бэкфилл `UPDATE teams SET type = 'SENIOR' WHERE type IS NULL` (не нужен если default обрабатывается на ALTER, но проверь sgenerated SQL — если ALTER без USING, добавь UPDATE вручную в миграцию).
- [ ] Smoke: `docker-compose down -v && docker-compose up -d && pnpm --filter @crm/api db:migrate && pnpm --filter @crm/api db:seed` проходит без ошибок.

### AC2. Shared schemas (Zod v4)

- [ ] `packages/shared/src/schemas/users.ts`:
  - `roleSchema` += `'DROP'`.
  - Новый `createDropSchema` (зеркало `createSeniorSchema`, если он есть; иначе следуй текущему паттерну создания юзера через `/api/users` POST): идентичность + контакты + реквизиты + `dropSharePercent` (default 5, range 0-100) + секция `team: { hrIds: string[] (min 1), accountantId: string, telegram: string|null }`.
  - `userSchema` += `dropSharePercent: number|null`.
- [ ] `packages/shared/src/schemas/teams.ts`:
  - `teamTypeSchema = z.enum(['SENIOR','DROP'])`.
  - `teamSchema` += `type: teamTypeSchema`.
  - Новый `createDropTeamSchema` (если ты решишь сделать отдельный endpoint — см. AC3) или просто переиспользуй внутри `createDropSchema`.
  - Новый `rotateSeniorSchema = z.object({ newSeniorId: z.string().uuid() })`.
- [ ] `packages/shared/src/schemas/projects.ts`:
  - `projectSchema` += `dropId: z.string().uuid().nullable()`.
  - `createProjectSchema` НЕ менять (в этой фазе drop-проекты не создаются через UI; поле появится в Фазе 2).
- [ ] Все добавленные схемы экспортированы из `packages/shared/src/index.ts`.

### AC3. UsersService — НОВЫЕ методы

- [ ] **НЕ модифицировать** `createUser` (текущая auto-team creation для синьора живёт как есть — линии ~129-232 в `users.service.ts`).
- [ ] Новый метод `createDrop(input: CreateDropInput, actor: SessionUser): Promise<Drop>`:
  - Транзакционно: создаёт `users` row с `role='DROP'`, `dropSharePercent=input.dropSharePercent ?? 5`.
  - Затем создаёт команду дропа через `TeamsService.createDropTeam` (или inline в той же транзакции — на твоё усмотрение, главное atomic).
  - Возвращает созданный user + ID команды.
- [ ] **НЕ модифицировать** `archiveUser` (текущий каскад senior→team+projects неизменен).
- [ ] Новый метод `archiveDrop(dropId: string, actor: SessionUser): Promise<{ archivedProjects: number, detachedSeniorId: string|null }>`:
  - Проверка `role === 'DROP'` иначе 400.
  - Транзакционно:
    1. Найти команду дропа (`teams.type='DROP'` WHERE member.userId = dropId AND member.leftAt IS NULL).
    2. Архивировать команду через `TeamsService.archiveDropTeam` (см. AC4) — она каскадно архивит проекты и отцепляет синьора.
    3. Установить `users.archivedAt = now()` на самом дропе.
  - Возвращает счётчик архивированных проектов и ID отцеплённого синьора (если был).
- [ ] RBAC на новые методы: `createDrop` — только ADMIN; `archiveDrop` — только ADMIN.

### AC4. TeamsService — НОВЫЕ методы, аккуратное расширение `mapTeam`

- [ ] Новый метод `createDropTeam(dropId, hrIds, accountantId, telegram?, tx?)`:
  - Валидация: dropId.role === 'DROP', hrIds.length ≥ 1, каждый hrId.role === 'HR', accountantId.role === 'ACCOUNTANT'.
  - Создаёт `teams` row с `type='DROP'`, name = `'Команда ' + drop.displayName` (паттерн как у синьора).
  - Добавляет `team_members`: dropId + все hrIds + accountantId. Поле `telegram` пишется на teams (если такое поле уже есть; если нет — НЕ ДОБАВЛЯТЬ его в этой фазе, оставить на будущее).
  - Возвращает созданную команду.
- [ ] **НЕ модифицировать** `create()` (для синьора) — линии ~130 в `teams.service.ts`.
- [ ] Новый метод `archiveDropTeam(teamId, tx?)`:
  - Проверка `team.type === 'DROP'` иначе 400.
  - Транзакционно:
    1. Найти активного синьора в команде (`team_members.userId` WHERE `users.role='SENIOR'` AND `leftAt IS NULL`) — у каждой drop-team максимум 1.
    2. Если есть — поставить `leftAt = now()` на этом members-row. **Синьор НЕ архивируется**.
    3. Найти все drop-проекты этой команды (`projects.dropId = team's drop user.id` AND `status != 'CLOSED'`) — пометить `status='CLOSED', endDate=now(), archivedAt=now()`.
    4. Поставить `leftAt = now()` на HR/accountant members.
    5. Поставить `teams.archivedAt = now()`.
  - Возвращает счётчик архивированных проектов и ID отцеплённого синьора (или null).
- [ ] **НЕ модифицировать** `archive()` для senior-команды (если такой метод есть — иначе пропустить).
- [ ] Новый метод `rotateSenior(teamId, newSeniorId, actor)`:
  - Проверки: `team.type === 'DROP'`, новый senior существует и `role==='SENIOR'`, новый senior НЕ состоит уже в другой активной команде (`team_members.leftAt IS NULL` ⇒ либо ошибка 400 «синьор уже в команде», либо автоматически выйти из старой — **решение: ошибка 400** с понятным текстом, пусть UI сам обработает).
  - Транзакционно: найти текущего активного синьора в команде → `leftAt=now()`; создать новый member-row для нового синьора.
  - RBAC: ADMIN или HR этой команды.
- [ ] Новый метод `addSeniorToDropTeam(teamId, seniorId)` — для опции 2 при создании синьора:
  - Проверка: команда `type='DROP'`, не имеет активного синьора, senior `role='SENIOR'` без активной команды.
  - Добавляет member-row.
  - RBAC: ADMIN или HR этой команды или вызывается из `UsersService.createUser` под транзакцией.
- [ ] **`mapTeam()` — изменения МИНИМАЛЬНЫЕ**:
  - В начале функции: `if (team.type === 'DROP') { return mapDropTeam(team) }` — ранний return.
  - Существующая ветка для `type='SENIOR'` остаётся 1:1 (тот же код).
  - Новый приватный `mapDropTeam(team)`: возвращает `{ ...base, type: 'DROP', drop: drop user, senior: active senior or null, hrs: [...], accountant, projects: [] }`. JUNIORы НЕ пробрасываются через project_members.

### AC5. ProjectsService — visibility расширение

- [ ] В методе `findAll` (или эквиваленте) visibility-логика расширяется:
  - Существующие ветки для ADMIN/ACCOUNTANT/SENIOR/HR/JUNIOR — **без изменений**.
  - Новая ветка для `role === 'DROP'`: возвращает только `projects WHERE dropId = user.id AND archivedAt IS NULL`.
- [ ] Проект с `dropId != null` видят: ADMIN, ACCOUNTANT (как и раньше всё), сам DROP, синьор этой команды (если есть). HR drop-team — read.

### AC6. Создание синьора — 2 опции (расширение endpoint)

- [ ] В `createUser` (или соотв. POST /api/users endpoint для синьора) добавить опциональное поле `teamMode: 'CREATE_NEW' | 'JOIN_DROP_TEAM'` (default `'CREATE_NEW'`) и `dropTeamId?: string`.
  - `CREATE_NEW` → текущее поведение (auto-team) **без изменений**.
  - `JOIN_DROP_TEAM` → пропустить auto-team creation, вместо неё вызвать `TeamsService.addSeniorToDropTeam(dropTeamId, newSenior.id)` в той же транзакции.
- [ ] Валидация: `dropTeamId` обязателен если `teamMode='JOIN_DROP_TEAM'`. Команда должна существовать, `type='DROP'`, без активного синьора. Иначе 400.
- [ ] Shared schema `createSeniorSchema` (если есть отдельная) или `createUserSchema` для роли SENIOR — расширить, оставив поля nullable/optional, чтобы старые клиенты не сломались.

### AC7. Teamless senior edge — backend gates

- [ ] Helper `userHasActiveTeam(userId)` — `SELECT 1 FROM team_members WHERE userId=$1 AND leftAt IS NULL LIMIT 1`.
- [ ] В `InterviewsController` все endpoint'ы (GET/POST/PATCH): если caller — SENIOR и `!userHasActiveTeam(caller.id)` → 403 «У вас нет активной команды».
- [ ] В `ProjectsController.findAll`: если caller — SENIOR без активной команды → пустой массив (не 403, чтобы UI рендерил empty state).
- [ ] Новый endpoint `POST /api/users/me/rejoin-team` для синьора-сироты:
  - Body: `{ teamMode: 'CREATE_NEW' | 'JOIN_DROP_TEAM', dropTeamId?: string }`.
  - Проверка: caller — SENIOR без активной команды; иначе 400.
  - `CREATE_NEW` → создать новую senior-команду с этим синьором (переиспользовать существующий код создания senior-team).
  - `JOIN_DROP_TEAM` → `addSeniorToDropTeam(dropTeamId, caller.id)`.

### AC8. RBAC и sidebar matrix

- [ ] В shared/RBAC-конфиге (где определяются sidebar nav пункты по ролям) добавить `DROP`:
  - Видит: Профіль, Команда, Фінанси (read).
  - НЕ видит: Дашборд (пока выключен), Проекти (личной видимости нет), Співбесіди, Документи.
  - Если есть `app/lib/rbac.ts` или `apps/web/.../sidebar` константа — расширить.
- [ ] Все existing role-checks (`role === 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT'`) проинспектировать и **в комментариях PR указать**, какие из них нужно расширить под `DROP` (если есть финансовые/команды эндпоинты, где «`role !== 'JUNIOR'`» работает как «всё кроме джуна» — DROP туда попадёт автоматически; «`role === 'ADMIN' || 'SENIOR'`» нужно расширить только если по смыслу drop тоже должен видеть).

### AC9. Каскад при архиве команды СИНЬОРА (sanity check)

- [ ] Прочитай существующий код архива senior-team. Убедись, что он **НЕ затрагивает** drop-команды и drop-проекты — никаких изменений не нужно, только sanity-проверка с unit-тестом «архив senior-team не трогает drop entities».

### AC10. Тесты (UT)

- [ ] `apps/api/test/**` — unit-тесты на новые методы:
  - `createDrop` → создаёт user(DROP) + team(type=DROP) + всех members; default `dropSharePercent=5`.
  - `archiveDrop` → каскадит drop-team archive + drop-projects close; синьор `team_members.leftAt` set, его юзер не тронут.
  - `archiveDropTeam` → drop-проекты CLOSED, синьор отцеплён.
  - `rotateSenior` → старый `leftAt` set, новый member-row, дроп остаётся.
  - `addSeniorToDropTeam` → ошибка если синьор уже в команде, ошибка если команда уже имеет синьора.
  - `createUser({ role:'SENIOR', teamMode:'JOIN_DROP_TEAM', dropTeamId })` → НЕ создаёт senior-team, добавляет в drop-team.
  - `createUser({ role:'SENIOR', teamMode:'CREATE_NEW' })` (default) → текущее поведение (regression).
  - `archiveUser(senior)` — **regression** — каскад как раньше, drop entities не тронуты.
- [ ] Все существующие тесты проходят без правок их логики.

### AC11. Локальная проверка перед push

Обязательно (правило юзера):

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @crm/e2e test  # регрессия E2E — должна быть зелёной
```

E2E могут не проверять новые флоу (это AutoTest сделает), но **должны не упасть** на регрессии — текущие тесты синьора/команд/проектов проходят как есть.

## Что НЕ нужно в этом таске

- UI/frontend (`apps/web/**`) — следующий task.
- Drop-проект distribution (Фаза 2).
- Ручное подтверждение выплаты (Фаза 3).
- Реквизиты дропа (Bank UAH) в UI — backend поле уже есть (USDT/Bank UAH из памяти), убедись что endpoint обновления профиля принимает их для DROP; UI отдельно.
- Удаление UI-кнопки «Создать команду» со страницы команд — следующий task.

## PR

- Ветка: `feat/drop-role-phase1`.
- Title: `feat(drop): фаза 1 — схема, миграция, RBAC, новые сервисы (backend)`.
- Description: ссылка на спек + список AC + результат `pnpm test`/`typecheck`/`lint`/`e2e` (zelen).
- НЕ open PR пока не пройдены AC1-AC11 локально. Push в ветку → дождись отдельного frontend task'а от PM.

## Memory & lessons

- После работы — обнови `docs/agents/memory/coder/lessons.md` любыми non-trivial находками (особенно если найдёшь senior touch-points, не покрытые в этом таске).
- Поддерживай `docs/specs/tasks/task-drop-phase1-backend.progress.md` с milestone-маркерами для recovery при обрыве.

## Repo

`yaremenko-maksym/CheekyCheeseIT_CRM`
