# task-archive-backend-foundation

## Агент: coder + devops (миграция) + autotest (unit)
## Приоритет: critical
## Зависит от: —
## Ветка: feature/archive-backend-foundation
## Blocks: task-users-page-refactor, task-archive-views-teams-projects

## Spec reference

Полная спецификация: `docs/specs/2026-05-21-users-archive-refactor-design.md`
Релевантные секции: **§5 (Cascade Rules)**, **§6 (PR 1 — Backend Archive Foundation)**, **§9.1 (unit tests)**, **§9.2 (integration tests)**.

## Контекст

Текущий BE использует HARD DELETE для teams и projects (нет archived state). У users есть `archivedAt`, но cascade-логики нет — архив SENIOR не архивирует его команду и проекты. Эту задачу нужно решить через soft archive + cascade-инфраструктуру + audit log mirror у teams/projects (как у users).

**Ключевой invariant:** `1 SENIOR = 1 team` — Archive SENIOR ≡ Archive team. Они неразделимая пара.

## Конкретные изменения

### 1. DB Schema + Migration (DevOps + Coder)

1. `apps/api/src/database/schema.ts`:
   - `teams`: добавить `archivedAt: timestamp('archived_at')`
   - `projects`: добавить `archivedAt: timestamp('archived_at')` (НЕ заменять `status` enum — он отдельный бизнес-факт)
   - `teamMembers`: добавить `leftAt: timestamp('left_at')`
   - Новые таблицы `teamAuditLog` и `projectAuditLog` — структура идентична `userAuditLog` (`id, actorId, targetId, action, changes JSONB, createdAt`). Индексы на `targetId` и `createdAt`.

2. `apps/api/drizzle/migrations/0012_team_project_archive.sql` — сгенерировать через `pnpm --filter @crm/api drizzle-kit generate` и проверить:
   - ALTER TABLE для teams/projects/team_members
   - CREATE TABLE team_audit_log, project_audit_log с FK на users(id) для actor_id и targetId per entity
   - CREATE INDEX на target_id + created_at

3. `apps/api/src/database/seed.ts` — если seed создаёт teams/projects, убедиться что `archivedAt = null` по умолчанию (Drizzle вернёт это сам). Не обязательно править.

### 2. Shared schemas (Coder)

`packages/shared/src/schemas/`:

1. `teams.ts` — расширить `teamSchema` полем `archivedAt: z.string().datetime().nullable()`. Расширить `teamMemberSchema` полем `leftAt: z.string().datetime().nullable()`.
2. `projects.ts` — расширить `projectSchema` полем `archivedAt: z.string().datetime().nullable()`.
3. `users.ts` — расширить `adminUpdateUserSchema`:
   ```ts
   .extend({
     hrIds: z.array(z.string().uuid()).optional(),
     accountantId: z.string().uuid().nullable().optional(),
   })
   ```
4. Создать новые экспорты:
   - `teamAuditLogEntrySchema` (id, actorId, targetId, action как enum, changes JSON, createdAt)
   - `projectAuditLogEntrySchema` (то же)
   - `archiveImpactSchema` — union: для user/team/project responses
   - `cascadeRequiredErrorSchema` — `{ requiresCascade: true, entities: [{ type, id, name }] }`

### 3. Audit Log Services (Coder)

`apps/api/src/teams/team-audit-log.service.ts` и `apps/api/src/projects/project-audit-log.service.ts`:

- Mirror существующего `apps/api/src/users/audit-log.service.ts`
- Методы: `record(params)`, `list(targetId, page, limit)`, `diff(before, after, excluded?)`
- Internal — НЕ controller endpoints. Используются из других services.
- Provider в соответствующих модулях `TeamsModule` и `ProjectsModule`.

### 4. UsersService cascade (Coder)

`apps/api/src/users/users.service.ts`:

1. **Полностью переписать `archive(userId, actorId)` (или соответствующий метод):**
   - Обернуть в `db.transaction()`
   - Проверка: user exists, не archived (иначе 400)
   - Для **SENIOR (pair-cascade):**
     - `users.archivedAt = now()`
     - Найти team (`teams.seniorId = userId`)
     - `teams.archivedAt = now()` + audit log в `team_audit_log` (action `team_archived`)
     - `team_members.leftAt = now()` **только** для HR/ACCOUNTANT (НЕ для самого senior — его team_member entry остаётся `leftAt=NULL`). Использовать `ne(teamMembers.userId, userId)` в WHERE.
     - Для каждого проекта где `seniorId = userId AND archivedAt IS NULL`:
       - `projects.archivedAt = now()` + audit log в `project_audit_log`
       - `project_members.leftAt = now()` для активных JUNIORов
   - Для **HR/ACCOUNTANT:** `users.archivedAt = now()` + `team_members.leftAt = now()` для всех команд где `userId = hr/accountantId`. Audit log: `team_audit_log` (`team_member_removed`) per команда.
   - Для **JUNIOR:** `users.archivedAt = now()` + `project_members.leftAt = now()` для активных. Audit log: `project_audit_log` (`project_member_removed`) per проект.
   - Для **ADMIN:** `users.archivedAt = now()`. Никаких dependencies.
   - В конце: `user_audit_log.record({ action: 'user_archived' })`

2. **Новый метод `unarchive(userId, actorId)`:**
   - Обернуть в `db.transaction()`
   - Проверка: user exists, IS archived
   - `users.archivedAt = NULL` + audit log `user_unarchived`
   - Для **SENIOR (pair):** также `teams.archivedAt = NULL` для его team + audit log `team_unarchived`. Projects остаются archived. `team_members.leftAt` НЕ восстанавливаем.
   - Для остальных ролей: только `users.archivedAt = NULL`.

3. **Новый метод `getArchiveImpact(userId)` → `ArchiveImpact`:**
   - Для SENIOR: `{ isPaired: true, teamName, projectsCount, juniorsAffected, hrAccountantsToBeRemoved }`
   - Для HR/ACCOUNTANT: `{ teamsCount }`
   - Для JUNIOR: `{ projectsCount }`
   - Для ADMIN: `{ noDependencies: true }`

4. **`PATCH /users/:id` (existing) — расширить:**
   - Принимать опциональные `hrIds: string[]`, `accountantId: string | null` (только для SENIOR)
   - Если переданы — diff с текущим состоянием `team_members`:
     - Добавить новых: `INSERT team_members ... ON CONFLICT ... DO UPDATE leftAt=NULL` (восстановление если был ушедший)
     - Убрать отсутствующих: `UPDATE team_members SET leftAt=now() WHERE userId IN (...)`
     - Каждое изменение → audit log в `team_audit_log` (`team_member_added` / `team_member_removed`)

5. **`findAll(filter)` — расширить:**
   - Принимать `archived?: boolean` (default `false`). 
   - `archived === true` → возвращает только archived
   - `archived === false` → возвращает только active (текущее по default)
   - Передавать query-param через DTO

### 5. TeamsService — alias delegation (Coder)

`apps/api/src/teams/teams.service.ts`:

1. **`archive(teamId, actorId)`:**
   - Найти team, проверить exists
   - Вернуть `usersService.archive(team.seniorId, actorId)` (pair logic уже в users)
   - Возвращает обновлённую team

2. **`unarchive(teamId, actorId)`:**
   - Найти team, проверить archived
   - Вернуть `usersService.unarchive(team.seniorId, actorId)` (pair logic)

3. **`getArchiveImpact(teamId)`:**
   - Делегирует в `usersService.getArchiveImpact(team.seniorId)` + переформатирование под team

4. **`findAll(filter)` — добавить `archived?: boolean` (как у users)**

### 6. ProjectsService — independent + cascade unarchive (Coder)

`apps/api/src/projects/projects.service.ts`:

1. **`archive(projectId, actorId)`:**
   - `db.transaction()`
   - `projects.archivedAt = now()` + audit `project_archived`
   - `project_members.leftAt = now()` для активных JUNIORов + audit `project_member_removed` per junior
   - НЕ трогает senior / team

2. **`unarchive(projectId, actorId, cascade = false)`:**
   - `db.transaction()`
   - Найти project + senior + team (через seniorId)
   - Если senior?.archivedAt || team?.archivedAt:
     - Если !cascade → `throw new ConflictException({ requiresCascade: true, entities: [...] })`
     - Если cascade=true → `usersService.unarchive(senior.id)` (пара) внутри той же transaction
   - `projects.archivedAt = NULL` + audit `project_unarchived`
   - `project_members.leftAt` **НЕ** восстанавливаем (admin re-adds через POST /projects/:id/members)

3. **`getArchiveImpact(projectId)`:** `{ activeMembersCount }`

4. **`findAll(filter)` — добавить `archived?`**

5. **`findOne(projectId)` — расширить response:**
   - `members` (project_members) — как сейчас
   - **NEW `effectiveTeam`:** computed `{senior, hrs: TeamMember[], accountants: TeamMember[], juniors: ProjectMember[]}` — HR/Acc подтягиваются динамически из senior's team_members where leftAt=NULL. Juniors — из project_members where leftAt=NULL.

### 7. Controllers (Coder)

1. `apps/api/src/users/users.controller.ts`:
   - `DELETE /users/:id` уже есть — проверить что использует новый archive с cascade
   - **NEW** `POST /users/:id/unarchive` — ADMIN
   - **NEW** `GET /users/:id/archive-impact` — ADMIN
   - `GET /users?archived=true|false` — параметр через DTO

2. `apps/api/src/teams/teams.controller.ts`:
   - `DELETE /teams/:id` — заменить на soft archive (вызов `teamsService.archive`)
   - **NEW** `POST /teams/:id/unarchive`
   - **NEW** `GET /teams/:id/archive-impact`
   - **NEW** `GET /teams/:id/audit-log?page=X&limit=Y`
   - `GET /teams?archived=true|false`

3. `apps/api/src/projects/projects.controller.ts`:
   - `DELETE /projects/:id` — soft archive
   - **NEW** `POST /projects/:id/unarchive` (no cascade by default)
   - **NEW** `POST /projects/:id/unarchive?cascade=true`
   - **NEW** `GET /projects/:id/archive-impact`
   - **NEW** `GET /projects/:id/audit-log?page=X&limit=Y`
   - `GET /projects?archived=true|false`

## RBAC

| Endpoint | ADMIN | SENIOR | HR | JUNIOR | ACCOUNTANT |
|---|---|---|---|---|---|
| DELETE /users/:id (archive) | ✓ | — | — | — | — |
| POST /users/:id/unarchive | ✓ | — | — | — | — |
| GET /users/:id/archive-impact | ✓ | — | — | — | — |
| DELETE /teams/:id (archive) | ✓ | — | — | — | — |
| POST /teams/:id/unarchive | ✓ | — | — | — | — |
| GET /teams/:id/audit-log | ✓ | — | — | — | — |
| DELETE /projects/:id (archive) | ✓ | — | — | — | — |
| POST /projects/:id/unarchive[?cascade] | ✓ | — | — | — | — |
| GET /projects/:id/audit-log | ✓ | — | — | — | — |
| GET /users\|/teams\|/projects?archived= | по существующим RBAC правилам | | | | |

## Acceptance criteria

Каждый пункт проверяется через grep / git diff / pnpm test:

- [ ] `apps/api/src/database/schema.ts` содержит `archivedAt` в teams + projects, `leftAt` в team_members, новые таблицы `teamAuditLog` + `projectAuditLog`. Grep: `grep -nE "archivedAt|teamAuditLog|projectAuditLog" apps/api/src/database/schema.ts`
- [ ] `apps/api/drizzle/migrations/0012_*.sql` существует и применяется. Команда: `pnpm --filter @crm/api drizzle-kit migrate` → no errors
- [ ] `apps/api/src/teams/team-audit-log.service.ts` и `apps/api/src/projects/project-audit-log.service.ts` существуют. Grep: `grep -l "TeamAuditLogService" apps/api/src/`
- [ ] `UsersService.archive(SENIOR)` устанавливает `teams.archivedAt`, `projects.archivedAt`, `team_members.leftAt` (НЕ для senior's own), `project_members.leftAt`. Unit test зелёный.
- [ ] `UsersService.unarchive(SENIOR)` восстанавливает team в paired режиме. Projects остаются archived. Unit test зелёный.
- [ ] `TeamsService.archive(teamId)` делегирует в `UsersService.archive(team.seniorId)`. Grep: `grep -n "usersService.archive" apps/api/src/teams/teams.service.ts`
- [ ] `ProjectsService.unarchive` без cascade возвращает 409 если senior archived. С cascade=true разархивирует pair. Unit test зелёный.
- [ ] `ProjectsService.findOne` возвращает `effectiveTeam` computed view (HR/Acc из senior's current team_members). Test: создать project, изменить team HR, GET project → effective team отражает new HR.
- [ ] `GET /users\|/teams\|/projects` по default НЕ возвращают archived. С `?archived=true` возвращают archived. Grep: `grep -n "archived" apps/api/src/users/users.controller.ts`
- [ ] `PATCH /users/:id` с `{ hrIds, accountantId }` обновляет `team_members` + audit log записан. Test зелёный.
- [ ] `GET /users\|/teams\|/projects/:id/archive-impact` возвращают правильные cascade counts. Manual API test.
- [ ] `GET /teams\|/projects/:id/audit-log` paginated и возвращают записи. Manual API test.
- [ ] Все unit tests `users.service.spec.ts`, `teams.service.spec.ts`, `projects.service.spec.ts` зелёные. Команда: `pnpm --filter @crm/api test`

## Unit tests (AutoTest)

Файлы для покрытия (autotest пишет в **отдельных** specs):

1. `apps/api/src/users/users.service.spec.ts` — расширить:
   - `archive(SENIOR)` — pair cascade, senior's own team_member untouched (assert leftAt=NULL after archive)
   - `archive(HR)`, `archive(ACCOUNTANT)`, `archive(JUNIOR)`, `archive(ADMIN)` — каждый сценарий
   - `unarchive(SENIOR)` — pair restore, projects stay archived, HR/Acc leftAt NOT restored
   - `unarchive(HR/ACC/JUNIOR/ADMIN)` — только user record
   - Idempotency: `archive` дважды → 400
   - Audit log written to correct tables

2. `apps/api/src/teams/teams.service.spec.ts`:
   - `archive(teamId)` — делегирует в users + pair effect (senior archived, projects archived)
   - `unarchive(teamId)` — pair restore
   - team not found → 404

3. `apps/api/src/projects/projects.service.spec.ts`:
   - `archive(projectId)` — `archivedAt` + `project_members.leftAt` для активных JUNIORов
   - `unarchive(projectId)` с активными senior+team → success без cascade
   - `unarchive(projectId)` с archived senior → 409 + entities list
   - `unarchive(projectId, cascade=true)` с archived pair → unarchive all
   - **Effective team dynamism test:** unarchive project → изменить senior's HR → GET project → effectiveTeam содержит new HR
   - Audit log per entity

4. Integration test через NestJS test app: full archive → unarchive flow с реальной БД.

## Interaction tests

N/A — backend-only, без UI взаимодействий.

## Запрещено трогать

- `apps/web/**` — UI работа в PR 2 + PR 3
- `apps/api/src/finance/**` — transactions/invoices не каскадируются (out of scope)
- `apps/api/src/interviews/**` — нет связи с архивом
- `packages/shared/src/schemas/finance.ts` — не трогать

## Verification (Coder перед `git push`)

1. `git diff HEAD --name-only` — только файлы из «Конкретные изменения»
2. `pnpm --filter @crm/api typecheck` — без ошибок
3. `pnpm --filter @crm/shared typecheck` — без ошибок
4. `pnpm --filter @crm/api test` — все unit tests зелёные
5. `pnpm --filter @crm/api drizzle-kit generate` → no diff (миграция применена)
6. Локально проверить API: запустить `pnpm dev`, через curl или Postman:
   - `DELETE /api/users/<senior-id>` → 200, team + projects тоже archived (`SELECT archivedAt FROM teams/projects`)
   - `POST /api/projects/<archived-project-id>/unarchive` → 409 с `requiresCascade`
   - `POST /api/projects/<archived-project-id>/unarchive?cascade=true` → 200, senior + team + project active
7. Commit message:
   ```
   feat(archive): add cascade archive + audit log mirror for teams/projects
   
   ac_verified: 1,2,3,4,5,6,7,8,9,10,11,12
   ```
