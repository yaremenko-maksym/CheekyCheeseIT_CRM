# Users Page Refactor + Archive System — Design Spec

**Date:** 2026-05-21
**Branch:** `claude/epic-greider-8bdbde`
**Scope:** Epic, 3 PRs
**Status:** Draft — awaiting user review

## 1. Background

Текущее состояние:

- `/crm/users` — единственный 1323-строчный файл (`apps/web/app/routes/crm/users/index.tsx`), ADMIN-only, табличная админка управления пользователями
- Users archive уже реализован частично: колонка `users.archivedAt`, endpoint `DELETE /users/:id` → soft archive, `AuditLogService` + UI tab `AuditLogTab` для истории действий
- Teams и Projects используют **HARD DELETE** — нет soft archive, нет audit log
- `project_members.leftAt` есть (soft delete членства); `team_members` — только hard delete
- Archive юзера **не каскадирует** — архивируем SENIOR, его team и projects остаются активными (баг по бизнес-логике)
- В UI нет фильтра архивных юзеров (`findAll()` возвращает всех без различия)
- В CRUD-диалогах `/crm/users` есть асимметрия Create vs Edit: HR + Accountant editable только при создании SENIOR

Эпик закрывает эти пробелы и одновременно делает визуальный рефакторинг страницы `/crm/users`.

## 2. Goals

1. Полноценная archive-инфраструктура для teams и projects (как уже есть у users)
2. Каскадная архивация по бизнес-правилам ролей (см. §5)
3. Modal-confirmation для cascade unarchive с явным списком сущностей
4. Audit log для всех archive-операций (teams, projects, members)
5. UI рефакторинг `/crm/users`: новая структура строки таблицы + sectioned диалоги + симметрия Create/Edit
6. Архив-вьюхи в `/crm/team` и `/crm/projects` (toggle архивных + unarchive)

## 3. Scope

### In scope

- Backend: archive колонки + endpoints + cascade logic + audit logs для teams/projects/members
- Frontend: `/crm/users` table + dialogs refactor
- Frontend: archive views в `/crm/team` и `/crm/projects`
- Warnings + name-confirmation для archive всех ролей
- Toggle «Показать архивных» в трёх местах

### Out of scope

- Soft delete / archive для finance entities (transactions, expenses, invoices, payouts) — остаются как есть
- Hard delete из архива (admin удаляет окончательно) — будет отдельной фичей в будущем
- Bulk archive (выбрать несколько и архивировать)
- Self-service unarchive — только ADMIN может разархивировать
- Расширенные фильтры / pagination / поиск на `/crm/users`
- Доступ к `/crm/users` вне ADMIN (страница остаётся ADMIN-only)
- Code DRY рефакторинг 1323-строчного `users/index.tsx` (split на компоненты) — Coder может сделать в рамках работы, но не обязательно
- Расширенные фильтры на `/crm/team` и `/crm/projects` (только toggle архивных)

## 4. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ PR 1 — Backend Archive Foundation                                │
│ ├─ Drizzle migration: teams.archivedAt, projects.archivedAt,    │
│ │  team_members.leftAt                                          │
│ ├─ Drizzle migration: team_audit_log, project_audit_log         │
│ ├─ UsersService.archive(id) — cascade per role                  │
│ ├─ TeamsService.archive(id) + .unarchive(id)                    │
│ ├─ ProjectsService.archive(id) + .unarchive(id, cascade?)       │
│ └─ UsersService.unarchive(id) — без cascade                     │
└─────────────────────────────────────────────────────────────────┘
                          │
                          │ (blocking)
                          ▼
        ┌─────────────────────────────────┬─────────────────────┐
        ▼                                 ▼                     ▼
┌────────────────────┐         ┌────────────────────┐    (parallel)
│ PR 2 — /crm/users  │         │ PR 3 — Archive UI  │
│ UI refactor        │         │ для /crm/team +    │
│                    │         │ /crm/projects      │
└────────────────────┘         └────────────────────┘
```

PR 2 и PR 3 могут идти параллельно после merge PR 1.

## 5. Cascade Rules (бизнес-логика)

**Ключевой инвариант системы:** 1 SENIOR = 1 team. Они неразделимы — не может быть SENIOR без команды или команды без SENIOR. Архив SENIOR ≡ архив его team — это **одна операция**, две точки входа в UI (`/crm/users` и `/crm/team`).

### 5.1 Archive

| Action                                                                | Что происходит                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Archive SENIOR ≡ Archive его team** (одна транзакция, два UI-входа) | `users.archivedAt = now()` для SENIOR + `teams.archivedAt = now()` для его team + `projects.archivedAt = now()` для всех его активных проектов + `team_members.leftAt = now()` для HR/ACCOUNTANT в его team (SENIOR's own `team_member` entry — НЕ трогаем, он постоянный участник своей команды) + `project_members.leftAt = now()` для всех активных JUNIORов в его проектах. Audit log: 1 запись в `user_audit_log` + 1 в `team_audit_log` + N в `project_audit_log`, все с одним `actorId` и timestamp. |
| **Archive HR**                                                        | `users.archivedAt = now()` + `team_members.leftAt = now()` для всех команд где `userId = hrId`. Project-members не трогаются (HR не member проекта напрямую). Audit log: `user_audit_log` + `team_audit_log` (per команда — `team_member_removed`).                                                                                                                                                                                                                                                         |
| **Archive ACCOUNTANT**                                                | Аналогично HR: `users.archivedAt = now()` + `team_members.leftAt = now()`.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Archive JUNIOR**                                                    | `users.archivedAt = now()` + `project_members.leftAt = now()` для всех активных проектных-членств. JUNIOR не хранится в `team_members` (производное состояние из project membership), поэтому team_members не трогаем. Audit: `user_audit_log` + `project_audit_log`.                                                                                                                                                                                                                                       |
| **Archive ADMIN**                                                     | `users.archivedAt = now()` — никаких dependencies. Audit: `user_audit_log`.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Archive PROJECT** (independent — не трогает senior/team)            | `projects.archivedAt = now()` + `project_members.leftAt = now()` для всех активных JUNIORов. SENIOR и team **не трогаются**. Audit: `project_audit_log`.                                                                                                                                                                                                                                                                                                                                                    |

### 5.2 Unarchive

| Action                                                                    | Поведение                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unarchive SENIOR ≡ Unarchive его team** (одна транзакция, два UI-входа) | `users.archivedAt = NULL` для SENIOR + `teams.archivedAt = NULL` для его team. Projects **остаются archived** (для возврата проекта в активное состояние — отдельный unarchive проекта). HR/ACCOUNTANT `team_members.leftAt` **НЕ восстанавливается** — нужно re-add через Teams page. SENIOR's `team_member` entry уже активен (leftAt=NULL, не трогали на archive). Итого: команда после unarchive **пустая, только SENIOR**. |
| **Unarchive HR / ACCOUNTANT / JUNIOR / ADMIN**                            | `users.archivedAt = NULL`. `team_members.leftAt` и `project_members.leftAt` **НЕ восстанавливаются** — re-add через UI.                                                                                                                                                                                                                                                                                                         |
| **Unarchive PROJECT** (senior+team активны)                               | `projects.archivedAt = NULL`. `project_members.leftAt` НЕ восстанавливается — JUNIORов нужно re-add. **Effective team проекта** (HR/ACCOUNTANT) подтягивается **динамически из текущего состояния** `team_members` senior's team — то есть из тех HR/Acc, что сейчас активны в команде синьора (НЕ snapshot момента архивации). Если за время архива у синьора сменился HR — после unarchive проект увидит нового HR.           |
| **Unarchive PROJECT** (senior или team архивированы)                      | Endpoint возвращает 409 с `{ requiresCascade: true, entities: [{type: 'user', id, name}, {type: 'team', id, name}] }`. Клиент показывает modal со списком. ADMIN подтверждает → запрос с `?cascade=true` → unarchive **пары senior+team** + unarchive project — всё в одной транзакции.                                                                                                                                         |

**Принципы поведения `leftAt` при unarchive:**

1. **Никогда не восстанавливаем `leftAt` обратно в NULL** при unarchive любой сущности (USER / TEAM / PROJECT). Membership — отдельное от entity состояние.
2. **SENIOR's own `team_member` entry** — постоянный (`leftAt = NULL` всегда, пока команда существует). На archive senior мы его не трогаем, поэтому на unarchive ничего восстанавливать не надо — он уже активен.
3. **HR / ACCOUNTANT после unarchive команды** — нужно re-add через `POST /teams/:id/members`.
4. **JUNIOR после unarchive проекта** — нужно re-add через `POST /projects/:id/members`.

UI явно сообщает на unarchive: «Восстановление команды НЕ восстанавливает её HR/Бухгалтеров — добавьте их заново.»

**Effective team проекта (computed view):** для активного проекта рассчитывается на лету как `{senior} ∪ {team_members of senior's team where leftAt IS NULL AND role IN (HR, ACCOUNTANT)} ∪ {project_members where leftAt IS NULL}`. Этот view используется backend-ом при ответе `GET /projects/:id` и frontend-ом для отображения. После unarchive проекта view автоматически отражает текущее состояние команды синьора.

### 5.3 Audit log — зеркало users для teams и projects

User requested: «сделай похожий [audit log] как у пользователей только для проектов и команд». То есть team и project получают **полный аналог** того, что есть у users:

| Что у users (существует)                      | Аналог у teams (новое)                 | Аналог у projects (новое)                  |
| --------------------------------------------- | -------------------------------------- | ------------------------------------------ |
| Таблица `user_audit_log`                      | `team_audit_log`                       | `project_audit_log`                        |
| Сервис `AuditLogService.record/list/diff`     | `TeamAuditLogService`                  | `ProjectAuditLogService`                   |
| Endpoint `GET /users/:id/audit-log`           | `GET /teams/:id/audit-log`             | `GET /projects/:id/audit-log`              |
| Frontend tab `AuditLogTab` в profile-странице | `AuditLogTab` в `/crm/team/:id` detail | `AuditLogTab` в `/crm/projects/:id` detail |
| `AdminActionsMenu` на profile                 | `AdminActionsMenu` на team detail      | `AdminActionsMenu` на project detail       |

Структура `team_audit_log` / `project_audit_log` идентична `user_audit_log`:

```ts
{ id, actorId, targetId, action, changes (JSONB before/after), createdAt }
```

Actions (расширенный список):

- `user_audit_log`: existing + `user_unarchived`
- `team_audit_log`: `team_created`, `team_renamed`, `team_archived`, `team_unarchived`, `team_member_added`, `team_member_removed`
- `project_audit_log`: `project_created`, `project_edited`, `project_status_changed`, `project_archived`, `project_unarchived`, `project_member_added`, `project_member_removed`

При cascade-операции (archive SENIOR pair с N проектами) пишутся **несколько связанных записей** в одной transaction, у всех один `actorId` и одинаковый timestamp:

- 1 в `user_audit_log` (`user_archived`)
- 1 в `team_audit_log` (`team_archived` + N `team_member_removed`)
- N в `project_audit_log` (`project_archived` + M `project_member_removed` per project)

## 6. PR 1 — Backend Archive Foundation

### 6.1 Schema changes

```ts
// schema.ts changes
export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 100 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  archivedAt: timestamp('archived_at'), // NEW
})

export const projects = pgTable('projects', {
  // ... existing fields
  archivedAt: timestamp('archived_at'), // NEW (DON'T remove status enum — ACTIVE/CLOSED is business state, ARCHIVED is admin state)
})

export const teamMembers = pgTable('team_members', {
  // ... existing fields
  leftAt: timestamp('left_at'), // NEW (soft delete, как у project_members)
})

export const teamAuditLog = pgTable('team_audit_log', {
  // ... same shape как user_audit_log
})

export const projectAuditLog = pgTable('project_audit_log', {
  // ... same shape как user_audit_log
})
```

**Важно:** оставляем `projects.status` (`ACTIVE | CLOSED`) — это бизнес-статус (закрытие договора с клиентом), не админский archive. Archive — отдельная орт. концепция. UI показывает оба: closed badge + archived overlay.

### 6.2 Endpoints

| Method   | Path                                     | Role    | Behaviour                                                                                                                                                                                 |
| -------- | ---------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DELETE` | `/users/:id` (любая роль)                | ADMIN   | Soft archive с cascade per role (§5.1). Для SENIOR — pair-archive (см. ниже). Возвращает обновлённого юзера.                                                                              |
| `POST`   | `/users/:id/unarchive`                   | ADMIN   | `archivedAt = NULL`. Для SENIOR — pair-unarchive (восстанавливает team). 400 если уже активен.                                                                                            |
| `DELETE` | `/teams/:id`                             | ADMIN   | **Pair-archive:** alias для `DELETE /users/:seniorId`. Делегирует в `UsersService.archive(team.seniorId)`. Возвращает обновлённую team. Audit log как pair.                               |
| `POST`   | `/teams/:id/unarchive`                   | ADMIN   | **Pair-unarchive:** alias для `POST /users/:seniorId/unarchive`. Восстанавливает senior + team в одной транзакции. Проекты остаются archived.                                             |
| `DELETE` | `/projects/:id`                          | ADMIN   | Soft archive: `projects.archivedAt = now()` + `project_members.leftAt = now()` для активных JUNIORов. Не трогает senior/team.                                                             |
| `POST`   | `/projects/:id/unarchive`                | ADMIN   | Если senior+team активны → разархивирует project (effective team подтянется из current state senior's team_members). Если senior/team архивированы → 409 `{ requiresCascade, entities }`. |
| `POST`   | `/projects/:id/unarchive?cascade=true`   | ADMIN   | Pair-unarchive senior+team + unarchive project в одной транзакции.                                                                                                                        |
| `GET`    | `/users?archived=true`                   | ADMIN   | Возвращает архивных. По умолчанию `archived=false` (только активные).                                                                                                                     |
| `GET`    | `/teams?archived=true`                   | по RBAC | Аналогично.                                                                                                                                                                               |
| `GET`    | `/projects?archived=true`                | по RBAC | Аналогично.                                                                                                                                                                               |
| `GET`    | `/users/:id/archive-impact`              | ADMIN   | Возвращает `{ teamsCount, projectsCount, membersAffected, isPaired: boolean }`. Для SENIOR `isPaired=true` + полные cascade counts. Используется UI для warning текстов.                  |
| `GET`    | `/teams/:id/archive-impact`              | ADMIN   | Возвращает `{ isPaired: true, seniorName, projectsCount, membersAffected }`. UI показывает «архивируется синьор {N} + N проектов».                                                        |
| `GET`    | `/projects/:id/archive-impact`           | ADMIN   | Возвращает `{ activeMembersCount }`. UI показывает «убирается N активных участников».                                                                                                     |
| `GET`    | `/teams/:id/audit-log?page=X&limit=Y`    | ADMIN   | Список actions из `team_audit_log`. Mirror users endpoint.                                                                                                                                |
| `GET`    | `/projects/:id/audit-log?page=X&limit=Y` | ADMIN   | Список actions из `project_audit_log`. Mirror users endpoint.                                                                                                                             |

`AdminUpdateUserDto` расширяется опциональными полями `hrIds?` и `accountantId?` для SENIOR — `PATCH /users/:id` обновляет `team_members` для команды этого SENIOR (соответствует фиксу асимметрии Edit-диалога). Diff в audit log: `team_member_added` для новых, `team_member_removed` (set leftAt) для исключённых.

### 6.3 Service-level cascade

Псевдо-код для `UsersService.archive`:

```ts
async archive(userId: string, actorId: string): Promise<User> {
  return this.db.transaction(async (tx) => {
    const user = await tx.query.users.findFirst({ where: eq(users.id, userId) })
    if (!user) throw new NotFoundException()
    if (user.archivedAt) throw new BadRequestException('Already archived')

    const now = new Date()
    const updates = []

    // Always archive the user
    updates.push(tx.update(users).set({ archivedAt: now }).where(eq(users.id, userId)))

    if (user.role === 'SENIOR') {
      // Pair-archive: team + projects + HR/Accountant team_members (SENIOR's own untouched)
      const team = await tx.query.teams.findFirst({ where: eq(teams.seniorId, userId) })
      if (team) {
        updates.push(tx.update(teams).set({ archivedAt: now }).where(eq(teams.id, team.id)))
        // Set leftAt only for HR/ACCOUNTANT — НЕ для senior himself (он остаётся в team_members как identity)
        updates.push(tx.update(teamMembers).set({ leftAt: now })
          .where(and(
            eq(teamMembers.teamId, team.id),
            isNull(teamMembers.leftAt),
            ne(teamMembers.userId, userId)  // SENIOR's own entry stays leftAt=NULL
          )))
        // Audit log for team
        await this.teamAuditLogService.record({
          actorId, targetId: team.id, action: 'team_archived',
          changes: { archivedAt: { before: null, after: now.toISOString() } }
        })
      }
      const ownedProjects = await tx.query.projects.findMany({
        where: and(eq(projects.seniorId, userId), isNull(projects.archivedAt))
      })
      for (const p of ownedProjects) {
        updates.push(tx.update(projects).set({ archivedAt: now }).where(eq(projects.id, p.id)))
        updates.push(tx.update(projectMembers).set({ leftAt: now })
          .where(and(eq(projectMembers.projectId, p.id), isNull(projectMembers.leftAt))))
        await this.projectAuditLogService.record({
          actorId, targetId: p.id, action: 'project_archived',
          changes: { archivedAt: { before: null, after: now.toISOString() } }
        })
      }
    } else if (user.role === 'HR' || user.role === 'ACCOUNTANT') {
      updates.push(tx.update(teamMembers).set({ leftAt: now })
        .where(and(eq(teamMembers.userId, userId), isNull(teamMembers.leftAt))))
    } else if (user.role === 'JUNIOR') {
      updates.push(tx.update(projectMembers).set({ leftAt: now })
        .where(and(eq(projectMembers.userId, userId), isNull(projectMembers.leftAt))))
      updates.push(tx.update(teamMembers).set({ leftAt: now })
        .where(and(eq(teamMembers.userId, userId), isNull(teamMembers.leftAt))))
    }

    await Promise.all(updates)

    // Audit log entry
    await this.auditLogService.record({
      actorId, targetId: userId, action: 'user_archived',
      changes: { archivedAt: { before: null, after: now.toISOString() } }
    })

    return tx.query.users.findFirst({ where: eq(users.id, userId) })
  })
}
```

**`TeamsService.archive(teamId)` — alias для pair-archive:**

```ts
async archive(teamId: string, actorId: string): Promise<Team> {
  const team = await this.db.query.teams.findFirst({ where: eq(teams.id, teamId) })
  if (!team) throw new NotFoundException()
  // Delegate to UsersService — pair-archive logic
  await this.usersService.archive(team.seniorId, actorId)
  return this.db.query.teams.findFirst({ where: eq(teams.id, teamId) })
}

async unarchive(teamId: string, actorId: string): Promise<Team> {
  const team = await this.db.query.teams.findFirst({ where: eq(teams.id, teamId) })
  if (!team) throw new NotFoundException()
  if (!team.archivedAt) throw new BadRequestException('Not archived')
  await this.usersService.unarchive(team.seniorId, actorId)  // pair-unarchive
  return this.db.query.teams.findFirst({ where: eq(teams.id, teamId) })
}
```

**`UsersService.unarchive(userId)` — pair-aware:**

```ts
async unarchive(userId: string, actorId: string): Promise<User> {
  return this.db.transaction(async (tx) => {
    const user = await tx.query.users.findFirst({ where: eq(users.id, userId) })
    if (!user) throw new NotFoundException()
    if (!user.archivedAt) throw new BadRequestException('Not archived')

    await tx.update(users).set({ archivedAt: null }).where(eq(users.id, userId))
    await this.auditLogService.record({ actorId, targetId: userId, action: 'user_unarchived', changes: {...} })

    if (user.role === 'SENIOR') {
      // Pair: also unarchive his team
      const team = await tx.query.teams.findFirst({ where: eq(teams.seniorId, userId) })
      if (team?.archivedAt) {
        await tx.update(teams).set({ archivedAt: null }).where(eq(teams.id, team.id))
        await this.teamAuditLogService.record({ actorId, targetId: team.id, action: 'team_unarchived', changes: {...} })
      }
      // Projects DO NOT auto-unarchive
      // HR/Accountant team_members DO NOT auto-restore (leftAt stays)
    }
    // Note: HR/ACCOUNTANT/JUNIOR/ADMIN unarchive — only user record, memberships not restored

    return tx.query.users.findFirst({ where: eq(users.id, userId) })
  })
}
```

**Transaction failure handling:** все cascade-операции (`UsersService.archive`, `UsersService.unarchive` для SENIOR, `ProjectsService.unarchive` cascade=true) обёрнуты в `db.transaction()`. При любом throw внутри — автоматический `ROLLBACK` Drizzle/postgres, состояние не меняется. Audit log записи делаются в той же transaction — при rollback они тоже откатываются. NestJS exception filter возвращает 500 с generic message; в логах остаётся stack trace для debug.

Аналогичная transaction-based логика для `ProjectsService.unarchive(id, cascade)`:

```ts
async unarchive(projectId: string, actorId: string, cascade = false): Promise<Project> {
  return this.db.transaction(async (tx) => {
    const project = await tx.query.projects.findFirst({ where: eq(projects.id, projectId) })
    if (!project) throw new NotFoundException()
    if (!project.archivedAt) throw new BadRequestException('Not archived')

    const senior = await tx.query.users.findFirst({ where: eq(users.id, project.seniorId) })
    const team = await tx.query.teams.findFirst({ where: eq(teams.seniorId, project.seniorId) })

    const entitiesToCascade = []
    if (senior?.archivedAt) entitiesToCascade.push({ type: 'user', id: senior.id, name: senior.displayName })
    if (team?.archivedAt) entitiesToCascade.push({ type: 'team', id: team.id, name: team.name })

    if (entitiesToCascade.length > 0 && !cascade) {
      throw new ConflictException({ requiresCascade: true, entities: entitiesToCascade })
    }

    const now = new Date()
    if (cascade) {
      // Pair-unarchive: senior + team together (they're inseparable)
      if (senior?.archivedAt || team?.archivedAt) {
        if (senior?.archivedAt) {
          await tx.update(users).set({ archivedAt: null }).where(eq(users.id, senior.id))
          await this.auditLogService.record({ actorId, targetId: senior.id, action: 'user_unarchived', changes: {...} })
        }
        if (team?.archivedAt) {
          await tx.update(teams).set({ archivedAt: null }).where(eq(teams.id, team.id))
          await this.teamAuditLogService.record({ actorId, targetId: team.id, action: 'team_unarchived', changes: {...} })
        }
        // Note: HR/Accountant team_members.leftAt stays — admin re-adds via Teams page
      }
    }
    // Unarchive project itself
    await tx.update(projects).set({ archivedAt: null }).where(eq(projects.id, projectId))
    // project_members.leftAt stays — admin re-adds juniors via Projects page
    // Effective team (HR/Accountant) computed dynamically from senior's current team_members
    await this.projectAuditLogService.record({ actorId, targetId: projectId, action: 'project_unarchived', changes: {...} })

    return tx.query.projects.findFirst({ where: eq(projects.id, projectId) })
  })
}
```

### 6.4 Audit services

Создать `TeamAuditLogService` и `ProjectAuditLogService` по образу `UsersService/AuditLogService`. Внедряются через DI в TeamsService и ProjectsService.

### 6.5 Shared schemas (`packages/shared/src/schemas/`)

Существующие `teamSchema` и `projectSchema` (в `packages/shared/src/schemas/teams.ts` и `projects.ts`) расширить полем `archivedAt`:

```ts
// teams.ts — расширить существующий объект
export const teamSchema = z.object({
  // ... все существующие поля
  archivedAt: z.string().datetime().nullable(),
})

// projects.ts — расширить существующий объект
export const projectSchema = z.object({
  // ... все существующие поля
  archivedAt: z.string().datetime().nullable(),
})

// teamMembers — расширить leftAt
export const teamMemberSchema = z.object({
  // ... все существующие поля
  leftAt: z.string().datetime().nullable(),
})
```

Новые schemas для audit log (`teamAuditLogEntrySchema`, `projectAuditLogEntrySchema`) — копия структуры `userAuditLogEntrySchema`.

`AdminUpdateUserDto` расширяется опциональными полями для SENIOR Edit:

```ts
// users.ts adminUpdateUserSchema
.extend({
  hrIds: z.array(z.string().uuid()).optional(),
  accountantId: z.string().uuid().nullable().optional(),
})
```

### 6.6 Migration

`0012_team_archive_audit.sql`:

- ALTER TABLE teams ADD COLUMN archived_at TIMESTAMP
- ALTER TABLE team_members ADD COLUMN left_at TIMESTAMP
- ALTER TABLE projects ADD COLUMN archived_at TIMESTAMP
- CREATE TABLE team_audit_log (...)
- CREATE TABLE project_audit_log (...)
- CREATE INDEX на target_id обеих audit таблиц

## 7. PR 2 — `/crm/users` UI Refactor

### 7.1 Layout таблицы (вариант C-v2)

Grid: `64px (leading actions) | 3fr (user info) | 1.4fr (right meta)`, min-height 76px, rounded `<Card>` строки с hover-эффектом.

**Колонки:**

- **Leading actions (64px):** вертикально 2 кнопки `Pencil` + `Trash2`, 28×28 px, opacity 0.4 в покое → 1.0 на hover строки. Использовать `event.stopPropagation()` чтобы клик не триггерил navigation на профиль. Delete для своей строки — disabled (как сейчас).
- **User info (3fr):** аватар 40px + `displayName` (с inline «Вы» для self) + meta-row (email · @tg · phone в одну строку с `·` разделителями) + tech-pills (массив, **фикс существующего бага** где `{u.techStack}` рендерил строку напрямую).
- **Right meta (1.4fr):** Role badge сверху + относительная дата снизу (`2 мес назад`) через `date-fns` `formatDistanceToNow`.

**Поведение строки:**

- Вся строка обёрнута в `<Link to="/crm/profile/$userId" params={{ userId: u.id }}>` с `cursor: pointer`
- Hover: `bg-white/4` (или `bg-muted/40` через Tailwind tokens)
- Self-row: `bg-primary/6` + `border-primary/20`, leading-actions opacity всегда 1.0
- Archived-row (только при включенном toggle): `opacity-50`, badge «В архиве» рядом с Role. Leading-actions заменяются на одну кнопку «Восстановить» (icon `ArchiveRestore` 28×28, opacity 0.4 → 1.0 на hover). На profile-странице архивного юзера — также кнопка «Восстановить» в `AdminActionsMenu`. Edit-диалог для архивных не открывается (кнопки нет).

**Sort indicators:**

- Заменить `ArrowUpDown` (всегда) на `ChevronUp` / `ChevronDown` в зависимости от `sortDir`
- Активная колонка — `text-primary`, неактивная — `text-muted-foreground/40`

**Фильтры (поверх Card):**

- Search input (как сейчас)
- Role select (как сейчас)
- **NEW:** toggle «Показать архивных» (Checkbox или Switch, по умолчанию off). При включении — `?archived=true` в URL via TanStack Router `validateSearch`. Архивные юзеры подмешиваются в таблицу с visual treatment.

### 7.2 Диалоги — структура секций

**Create dialog (CreateUserDialog):**

1. **Идентичность** — Email (required), Имя и фамилия (required), Роль (Select)
2. **Контакты** — Telegram, Phone
3. **Профессия** — Tech stack (TechAutocompleteInput, массив pills)
4. **Финансы** — IF SENIOR: ShareSlider (% компания / % синьор) | IF JUNIOR/HR/ACCOUNTANT: Monthly salary (USD input)
5. **Команда** — IF SENIOR: HR multiselect + Accountant select | IF JUNIOR: Project select (initial assignment)

Секции — `<div className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-3">` с лейблом `<p className="text-xs font-medium text-muted-foreground">Section name</p>` сверху.

**Edit dialog (EditUserDialog):**

- Те же 5 секций
- В Identity-секции Email отображается **read-only** (`<div className="text-sm muted">{user.email}</div>` рядом с label) — нельзя менять (Google OAuth identifier)
- **Команда секция теперь editable для SENIOR** (фикс асимметрии): HR multiselect + Accountant select. Backend поддержка из PR 1 (`AdminUpdateUserDto` расширен).
- Для JUNIOR в Edit — секция «Проекты» показывает текущие активные проекты как read-only бейджи + ссылка «Управлять в /crm/projects» (project add/remove делается там).

**Sticky footer:**

- Слева: маленький Role badge (неинтерактивный, контекст-напоминание)
- Справа: «Отмена» + «Создать»/«Сохранить» (с loading state)

### 7.3 Archive dialog (вместо текущего DeleteUserDialog)

Новый компонент `ArchiveUserConfirmDialog`. Поведение по ролям:

| Роль       | Warning текст                                                                                                                                                                                                                                                                                                                                                                                 | Required confirmation |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| SENIOR     | «**{displayName}** и его команда **{teamName}** — связанная пара. При архивации будут архивированы: профиль синьора, команда **{teamName}** (HR/бухгалтеры команды будут отвязаны — {N}), и все его проекты ({M} штук, {K} активных JUNIORов будут отвязаны). Восстановление возможно — пара senior+team вернётся, но проекты нужно будет восстанавливать отдельно с cascade-подтверждением.» | Ввод полного имени    |
| HR         | «**{displayName}** будет архивирован и убран из **{N} команд** (HR-роль). Сами команды останутся активны.»                                                                                                                                                                                                                                                                                    | Ввод полного имени    |
| ACCOUNTANT | «**{displayName}** будет архивирован и убран из **{N} команд** (бухгалтерская роль). Сами команды останутся активны.»                                                                                                                                                                                                                                                                         | Ввод полного имени    |
| JUNIOR     | «**{displayName}** будет архивирован и убран из **{M} активных проектов**. Сами проекты останутся активны.»                                                                                                                                                                                                                                                                                   | Ввод полного имени    |
| ADMIN      | «**{displayName}** будет архивирован. Связанных сущностей нет.»                                                                                                                                                                                                                                                                                                                               | Ввод полного имени    |

Числа N/M/K приходят из нового endpoint `GET /users/:id/archive-impact` → `{ teamsCount, projectsCount, membersAffected }`.

### 7.4 Unarchive flow

В `AdminActionsMenu` для архивного юзера — кнопка «Восстановить из архива». Простой POST `/users/:id/unarchive`, toast «Юзер восстановлен». Без cascade (только сам user).

## 8. PR 3 — `/crm/team` и `/crm/projects` Archive Views + Admin Actions + Audit Log

**Цель раздела:** дать teams и projects полный аналог того что есть у users — `AdminActionsMenu` (archive/unarchive), `AuditLogTab` (история), и toggle архивных на list pages.

### 8.1 `/crm/team` (list page)

- Toggle «Показать архивных» в header (по умолчанию OFF)
- Архивные команды — `opacity-50` + badge «В архиве»
- На карточке архивной команды — кнопка «Восстановить» (вызов `POST /teams/:id/unarchive` → pair-unarchive → SENIOR + team активны, проекты остаются archived)
- На активной команде — Action menu (`⋯`) с пунктами: «Редактировать», «Архивировать»
- «Архивировать» открывает confirm dialog с warning: «**{teamName}** и её синьор **{seniorName}** — связанная пара. При архивации будут архивированы: профиль синьора, команда (HR/бухгалтеры будут отвязаны — {N}), и все его проекты ({M} штук). Это эквивалентно архивации синьора **{seniorName}**.» + ввод имени синьора для подтверждения

### 8.2 `/crm/team/:teamId` (detail page) — NEW

Создать detail page если её ещё нет, либо расширить существующую:

- Header: название команды, badge статуса (активна / в архиве), кнопка `AdminActionsMenu` (`⋯`) с действиями: «Редактировать», «Архивировать» (если активна) / «Восстановить из архива» (если архивна)
- Tabs:
  - **«Состав»** — текущие участники команды (HR, SENIOR, ACCOUNTANT — из `team_members` где `leftAt IS NULL`)
  - **«История изменений»** — `AuditLogTab` подключённый к `GET /teams/:id/audit-log`, paginated. Mirror users' AuditLogTab. Показывает все `team_*` actions: created, renamed, member added/removed, archived, unarchived.

### 8.3 `/crm/projects` (list page)

- Toggle «Показать архивных» в header (по умолчанию OFF)
- Архивные проекты — `opacity-50` + badge «В архиве»
- На карточке архивного проекта — кнопка «Восстановить»
  - При клике — клиент делает POST `/projects/:id/unarchive`
  - Если 409 + `requiresCascade` — открывается **modal**: «Для восстановления проекта **{projectName}** требуется также восстановить пару:» + список entity-карточек ({type: 'user', name: 'Иван Иванов', role: 'SENIOR'}, {type: 'team', name: 'Команда Иван'}) + кнопки «Отмена» / «Восстановить всё»
  - Кнопка «Восстановить всё» делает POST с `?cascade=true`
  - Toast: «Восстановлено: проект, синьор, команда» (или просто «проект» если cascade не нужен был)
  - **Важно UI**: после unarchive проекта effective team показывается dynamically из current senior's `team_members`, НЕ snapshot момента архивации. Если у синьора с момента архива сменился HR — после unarchive проекта будет виден новый HR
- На активном проекте — Action menu (`⋯`): «Редактировать», «Сменить статус» (active/closed), «Архивировать»
- «Архивировать» открывает confirm с warning: «Проект **{name}** будет архивирован, **{N} активных JUNIORов** будут отвязаны. Синьор и команда **не** будут архивированы. Финансовая история (транзакции, инвойсы) остаётся доступной.» + ввод имени проекта для подтверждения

### 8.4 `/crm/projects/:projectId` (detail page) — расширить

- Header: название проекта, badge статуса (active/closed + archived overlay если архив), кнопка `AdminActionsMenu` (`⋯`) аналогично teams
- Tabs:
  - **«Обзор»** (existing) — компания, домен, синьор, рейт, статус
  - **«Состав»** — effective team (computed view): SENIOR + HR/ACCOUNTANT из senior's team + JUNIORы из `project_members` где `leftAt IS NULL`
  - **«История изменений»** — NEW: `AuditLogTab` подключённый к `GET /projects/:id/audit-log`. Показывает все `project_*` actions.
  - **«Финансы»** (existing) — transactions, invoices относящиеся к проекту (показываем даже для архивных проектов)

### 8.5 Реализация (общее)

- Компонент `AuditLogTab` рефакторим в **generic компонент** который принимает `entityType: 'user' | 'team' | 'project'` и `entityId`. Внутри делает запрос на соответствующий endpoint и форматирует diff (action labels локализованы на русский).
- Компонент `AdminActionsMenu` тоже generic с `entityType` — рендерит menu items в зависимости от entity и текущего state (archived ли).
- Перекладывать существующий компонент `apps/web/app/components/user-profile/admin-actions/AdminActionsMenu.tsx` → `apps/web/app/components/admin-actions/AdminActionsMenu.tsx` (общий) либо вынести разделяемые части. Coder решает на уровне реализации.

## 9. Testing Strategy

### 9.1 PR 1 — unit-тесты (Vitest, `apps/api/`)

| File                             | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users.service.spec.ts`          | archive SENIOR — pair cascade: team archived + projects archived + HR/Acc team_members.leftAt set + own team_member entry **untouched** (assert: senior's own team_member still leftAt=NULL). archive HR/ACCOUNTANT — только team_members.leftAt. archive JUNIOR — только project_members.leftAt. archive ADMIN — только user. unarchive SENIOR — pair: senior + team active, projects stay archived, HR/Acc team_members.leftAt **NOT** restored. Audit log записан в правильные таблицы. Idempotency — двойной archive бросает 400.                                                                                                    |
| `teams.service.spec.ts`          | archive team — делегирует в UsersService.archive(team.seniorId) → pair-archive (assert: senior архивирован, projects архивированы). unarchive team — делегирует в UsersService.unarchive → pair-unarchive (assert: senior + team active, projects stay archived). Если team.seniorId не существует → 404. Audit log записан в team_audit_log.                                                                                                                                                                                                                                                                                            |
| `projects.service.spec.ts`       | archive project — `archivedAt` + project_members.leftAt для активных JUNIORов. Не трогает senior/team. unarchive project с активными senior+team — успех, project_members.leftAt **НЕ** restored. unarchive project с архивным senior → 409 + `{requiresCascade, entities}` со списком senior+team. unarchive cascade=true с архивным senior+team → разархивирует pair (senior + team) + project в одной транзакции. **Effective team test:** unarchive project, потом изменить senior's team_members (добавить HR2), GET /projects/:id → effective team содержит HR2 (current state, не snapshot). Audit log записан для каждой entity. |
| `audit-log.service.spec.ts` (×3) | `user_audit_log` + `team_audit_log` + `project_audit_log` — record/list/diff. Pagination работает.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### 9.2 PR 1 — integration tests (Vitest, через NestJS test app)

- E2E API flow: создать SENIOR + team + project → archive SENIOR → GET /teams/:id (находится с `archivedAt`) → GET /projects/:id (тоже) → unarchive project без cascade → 409 → unarchive project с cascade → всё активно
- RBAC: non-ADMIN на DELETE /teams/:id → 403

### 9.3 PR 2 — E2E (Playwright, `apps/e2e/`)

| Flow                                 | Assertions                                                                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADMIN видит таблицу C-v2             | Аватар 40px, имя+meta, tech-pills (массив), относительная дата. Hover на строке → leading actions opacity 1. Клик на строку → navigate to profile.        |
| Sort                                 | Click `Пользователь` → asc, click again → desc. `ChevronUp/Down` отображает направление.                                                                  |
| Create SENIOR                        | Секции видны (Identity / Контакты / Профессия / Финансы / Команда). HR multiselect + Accountant select работают. Submit создаёт юзера + team.             |
| Edit SENIOR                          | Открыть edit → секция «Команда» editable (новое). Сменить HR → PATCH запрос содержит `hrIds`. После save — таблица обновлена.                             |
| Archive JUNIOR с активными проектами | Click Trash → диалог «убирается из 2 проектов». Ввод имени → confirm → archive + toast. Юзер пропал из таблицы.                                           |
| Archive SENIOR                       | Warning перечисляет команду + N проектов + участников. Confirm → archive с cascade. На /crm/team — команда в архиве. На /crm/projects — проекты в архиве. |
| Toggle архивных                      | Включить → архивные появились с opacity-50 + badge. Edit/Delete скрыты. Click row → navigate to profile.                                                  |
| Unarchive юзера                      | Из profile или admin menu → click «Восстановить» → юзер активен, badge снят.                                                                              |

### 9.4 PR 3 — E2E

| Flow                                    | Assertions                                                                                                                                                                                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| /crm/team toggle архива                 | Включить → архивные команды показываются с opacity. Click «Восстановить» → pair-unarchive → SENIOR в /crm/users тоже активен. Toast «Команда и синьор восстановлены».                                                                                                                   |
| /crm/team/:id detail page               | Открыть detail → видны 2 tabs: «Состав» (HR/SENIOR/ACCOUNTANT) + «История изменений» (audit log). AdminActionsMenu имеет кнопку «Архивировать» → клик → pair-archive warning → SENIOR + проекты тоже в архиве.                                                                          |
| /crm/team archive — pair                | Click «Архивировать» в /crm/team → warning «синьор + N проектов». Confirm → check /crm/users — SENIOR имеет badge «В архиве». check /crm/projects — все его проекты в архиве.                                                                                                           |
| /crm/projects unarchive cascade         | Архивный проект архивного синьора → click «Восстановить» → modal со списком (user + team как pair). Click «Восстановить всё» → cascade unarchive. Toast «Восстановлено: проект, синьор, команда». В /crm/users senior активен. В /crm/team команда активна (без HR/Acc — нужно re-add). |
| /crm/projects unarchive without cascade | Если senior+team активны → click «Восстановить» → unarchive без modal. Effective team в /crm/projects/:id показывает current HR/Acc из senior's team.                                                                                                                                   |
| /crm/projects/:id detail audit log      | Открыть detail архивного проекта → tab «История изменений» → видны entries: `project_archived` с правильным diff и actor.                                                                                                                                                               |
| Effective team dynamism                 | Архивный проект → unarchive (без cascade). Изменить senior's HR (новый HR1 вместо старого HR0). GET /crm/projects/:id → effective team показывает HR1 (current, не snapshot).                                                                                                           |

## 10. Open Decisions (resolved + flagged for review)

1. **Архивные юзеры в `/crm/users`** — toggle «Показать архивных» (по умолчанию OFF). Архивные с `opacity-50`, badge «В архиве», без edit/delete actions. Альтернативы (tabs / sidebar pill) **не берём** — лишняя сложность.
2. **Transactions / Invoices при archive проекта** — НЕ каскадируются, остаются активными. Финансовая история должна быть видна по архивному project_id.
3. **Active SENIOR без проектов после unarchive** — возможна ситуация: разархивируем SENIOR (pair с team), его проекты остаются в архиве. SENIOR + team без проектов — OK, может создавать новые.
4. **Audit log retention** — без TTL, бесконечно. Cleanup job — отдельная фича в будущем.
5. **Email read-only в Edit** — отображается через `<div className="text-sm muted">{email}</div>` (label «Email» + value). Не путать с readonly input — не нужен.
6. **Project assignment для JUNIOR в Edit-диалоге** — НЕ позволяем менять. Только показываем активные проекты с ссылкой «Управлять в Проектах». Управление членством — единый workflow через /crm/projects/:id.
7. **`projects.status` enum (ACTIVE/CLOSED) vs `archivedAt`** — оба сохраняются. `status = CLOSED` означает «договор с клиентом закрыт» (бизнес-факт), `archivedAt` означает «админ убрал из активного UI». Можно иметь CLOSED + active OR ACTIVE + archived (теоретически — но обычно closed→archived вместе).
8. **SENIOR + team — связанная пара (инвариант)** — не может существовать SENIOR без team или team без senior. Archive SENIOR ≡ archive team — одна операция, две точки входа (UI на /crm/users и UI на /crm/team). То же для unarchive. На backend `TeamsService.archive(teamId)` делегирует в `UsersService.archive(team.seniorId)` чтобы избежать дублирования логики.
9. **Effective team проекта computed dynamically** — не snapshot момента архивации. После unarchive проекта HR/Accountant подтягиваются из текущего состояния `team_members` senior's team. Это означает: если за время архива у синьора сменился HR — проект увидит нового HR после unarchive. **Это намеренное поведение**, не баг.
10. **AdminActionsMenu + AuditLogTab — generic компоненты** — рефакторим существующие user-profile компоненты в reusable с `entityType: 'user' | 'team' | 'project'` prop. Минимизирует дублирование. Coder может выбрать вариант: общий компонент или 3 идентичных файла.
11. **SENIOR's own `team_member` entry — постоянный** — на archive senior pair НЕ ставится `leftAt = now()`. Это identity-связь синьора с командой (1:1 invariant), не обычное membership. На queries фильтруем `team_members` с условием `WHERE userId != team.seniorId OR role = SENIOR` где это критично.

## 11. Dependencies & Order

```
PR 1 — Backend Archive Foundation
   │
   │ (must merge first — PR 2 и PR 3 нуждаются в endpoints)
   │
   ├──> PR 2 — /crm/users UI refactor
   │      (нуждается в: archive endpoints с cascade, GET /users?archived=true,
   │       PATCH /users/:id с hrIds+accountantId, GET /users/:id/archive-impact)
   │
   └──> PR 3 — /crm/team + /crm/projects archive views
          (нуждается в: TeamsService.archive/unarchive,
           ProjectsService.archive/unarchive с cascade flow)
```

PR 2 и PR 3 можно дев в параллель агентами после merge PR 1.

## 12. Acceptance Criteria

### PR 1

- [ ] Drizzle migration 0012 применяется без ошибок (включая drizzle-kit generate)
- [ ] Schema содержит `teams.archivedAt`, `projects.archivedAt`, `team_members.leftAt`, `team_audit_log`, `project_audit_log`
- [ ] Все 5 cascade-сценариев в `users.service.spec.ts` зелёные (включая SENIOR pair semantics — own team_member НЕ trogаем)
- [ ] `teams.service.spec.ts`: archive/unarchive — alias для UsersService.archive/unarchive (pair)
- [ ] `projects.service.spec.ts` покрывает 409 + cascade unarchive (pair senior+team)
- [ ] Audit log записи появляются для каждого archive/unarchive action в правильную таблицу (`user_audit_log`, `team_audit_log`, `project_audit_log`)
- [ ] `GET /teams/:id/audit-log` и `GET /projects/:id/audit-log` paginated, возвращают записи
- [ ] `GET /users/:id/archive-impact`, `GET /teams/:id/archive-impact`, `GET /projects/:id/archive-impact` возвращают правильные cascade counts
- [ ] Backward compat: существующие endpoints `GET /users`, `GET /teams`, `GET /projects` по умолчанию возвращают только активных (НЕ архивированных) — breaking change для UI, требует обновления в PR 2/PR 3 frontend

### PR 2

- [ ] `/crm/users` рендерит вариант C-v2 layout (visual regression тест на screenshot)
- [ ] Tech column показывает массив pills, не строку (фикс бага)
- [ ] Дата в относительном формате
- [ ] Sort indicator показывает направление
- [ ] Hover на строке — leading actions opacity 1
- [ ] Диалоги Create/Edit — секции в одном скролле
- [ ] Edit SENIOR позволяет менять HR + Accountant (PATCH с hrIds+accountantId)
- [ ] Archive диалог SENIOR упоминает pair (профиль + команда + N проектов) + name-confirmation
- [ ] Archive диалог HR/ACCOUNTANT/JUNIOR/ADMIN с правильным warning для каждой роли
- [ ] Toggle «Показать архивных» работает + URL state
- [ ] Архивная строка показывает кнопку «Восстановить» (вместо edit/delete) → POST /users/:id/unarchive
- [ ] Для SENIOR unarchive — frontend знает что это pair (toast: «синьор и команда восстановлены»)
- [ ] E2E (см. §9.3) — все зелёные

### PR 3

- [ ] /crm/team toggle архива + кнопка «Восстановить» на архивной команде (pair-unarchive)
- [ ] /crm/team/:id detail page содержит `AdminActionsMenu` (archive/unarchive) + `AuditLogTab`
- [ ] /crm/projects toggle архива
- [ ] /crm/projects/:id detail page содержит `AdminActionsMenu` + `AuditLogTab` + tab «Состав» с effective team
- [ ] Project unarchive flow — если senior/team архивированы → modal со списком pair → cascade unarchive
- [ ] Project unarchive с активным senior+team → unarchive без cascade, effective team показывает current HR/Acc
- [ ] AdminActionsMenu и AuditLogTab — generic компоненты (`entityType` prop) либо 3 отдельных но идентичных
- [ ] При unarchive cascade=true — все entity активны + audit log записан в правильные таблицы
- [ ] E2E (см. §9.4) — все зелёные

## 13. Risks

1. **Backward compat в `GET /users`/`/teams`/`/projects`** — если сейчас findAll() возвращает архивных, UI зависит от этого. После PR 1 поведение меняется на «по умолчанию только активные». Frontend PR 2 должен обновить queries с `?archived=true` где нужно. Существующие потребители (teams page, projects page) — проверить и обновить в PR 3 или одновременно.

2. **Cascade transactions** — большая транзакция с N таблиц при archive SENIOR с 10 проектами. Postgres справится, но потенциально row-level lock contention. Mitigation: всё через FOR UPDATE, transaction небольшая по времени (< 1 сек), idempotent.

3. **Audit log volume** — при cascade SENIOR пишется ~1 + 1 + N + M audit записей. Для нормального оборота (≤10 SENIORов в компании) — не проблема. Индекс на `target_id` ускорит чтение для UI.

4. **UI regression на других страницах** — изменения в `GET /teams` (default = active only) могут затронуть `/crm/team`, `/crm/projects` queries. PR 3 покрывает это, но PR 1 merge раньше — между merge PR1 и PR3 будет окно с broken state. Mitigation: PR 1 и PR 3 мерджим одной волной либо feature-flag.

## 14. Task Decomposition (для PM писания task-files)

После approve этого spec'а — PM генерирует через `writing-plans` skill 3 separate task-files в `docs/specs/tasks/`:

- `task-archive-backend-foundation.md` — PR 1, Coder + DevOps + AutoTest, blocking
- `task-users-page-refactor.md` — PR 2, Coder + AutoTest, depends on PR 1 merge
- `task-archive-views-teams-projects.md` — PR 3, Coder + AutoTest, depends on PR 1 merge, parallel с PR 2

Dispatch — после merge PR 1: PR 2 и PR 3 параллельно через `Agent(isolation="worktree", run_in_background=True)`.

---

**Reviewer:** waiting for user approval before transitioning to writing-plans skill.
