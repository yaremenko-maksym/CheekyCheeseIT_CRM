# Users Page Refactor + Archive System — Design Spec

**Date:** 2026-05-21
**Branch:** `claude/epic-greider-8bdbde`
**Scope:** Epic, 3 PRs
**Status:** Draft — awaiting user review

## 1. Background

Current state:

- `/crm/users` — a single 1323-line file (`apps/web/app/routes/crm/users/index.tsx`), ADMIN-only, a tabular admin panel for managing users
- The users archive is already partially implemented: the `users.archivedAt` column, the endpoint `DELETE /users/:id` → soft archive, `AuditLogService` + the UI tab `AuditLogTab` for the history of actions
- Teams and Projects use **HARD DELETE** — no soft archive, no audit log
- `project_members.leftAt` exists (soft delete of membership); `team_members` — only hard delete
- Archiving a user **does not cascade** — we archive a SENIOR, their team and projects stay active (a bug by business logic)
- There is no archived-users filter in the UI (`findAll()` returns everyone without distinction)
- In the CRUD dialogs of `/crm/users` there is a Create vs Edit asymmetry: HR + Accountant are editable only when creating a SENIOR

The epic closes these gaps and at the same time does a visual refactor of the `/crm/users` page.

## 2. Goals

1. Full archive infrastructure for teams and projects (as users already have)
2. Cascade archiving per the business rules of the roles (see §5)
3. Modal confirmation for cascade unarchive with an explicit list of entities
4. Audit log for all archive operations (teams, projects, members)
5. UI refactor of `/crm/users`: new table row structure + sectioned dialogs + Create/Edit symmetry
6. Archive views in `/crm/team` and `/crm/projects` (toggle of archived + unarchive)

## 3. Scope

### In scope

- Backend: archive columns + endpoints + cascade logic + audit logs for teams/projects/members
- Frontend: `/crm/users` table + dialogs refactor
- Frontend: archive views in `/crm/team` and `/crm/projects`
- Warnings + name-confirmation for archiving all roles
- A "Show archived" toggle in three places

### Out of scope

- Soft delete / archive for finance entities (transactions, expenses, invoices, payouts) — stay as is
- Hard delete from the archive (admin deletes permanently) — will be a separate feature in the future
- Bulk archive (select several and archive)
- Self-service unarchive — only the ADMIN can unarchive
- Advanced filters / pagination / search on `/crm/users`
- Access to `/crm/users` outside ADMIN (the page stays ADMIN-only)
- Code DRY refactor of the 1323-line `users/index.tsx` (split into components) — the Coder may do it as part of the work, but it is not mandatory
- Advanced filters on `/crm/team` and `/crm/projects` (only the archived toggle)

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
│ └─ UsersService.unarchive(id) — without cascade                 │
└─────────────────────────────────────────────────────────────────┘
                          │
                          │ (blocking)
                          ▼
        ┌─────────────────────────────────┬─────────────────────┐
        ▼                                 ▼                     ▼
┌────────────────────┐         ┌────────────────────┐    (parallel)
│ PR 2 — /crm/users  │         │ PR 3 — Archive UI  │
│ UI refactor        │         │ for /crm/team +    │
│                    │         │ /crm/projects      │
└────────────────────┘         └────────────────────┘
```

PR 2 and PR 3 can go in parallel after merging PR 1.

## 5. Cascade Rules (business logic)

**Key invariant of the system:** 1 SENIOR = 1 team. They are inseparable — there cannot be a SENIOR without a team or a team without a SENIOR. Archiving a SENIOR ≡ archiving their team — this is **one operation**, two UI entry points (`/crm/users` and `/crm/team`).

### 5.1 Archive

| Action                                                                    | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Archive SENIOR ≡ Archive their team** (one transaction, two UI entries) | `users.archivedAt = now()` for the SENIOR + `teams.archivedAt = now()` for their team + `projects.archivedAt = now()` for all their active projects + `team_members.leftAt = now()` for HR/ACCOUNTANT in their team (the SENIOR's own `team_member` entry — we do NOT touch it, they are a permanent member of their team) + `project_members.leftAt = now()` for all active JUNIORs in their projects. Audit log: 1 record in `user_audit_log` + 1 in `team_audit_log` + N in `project_audit_log`, all with one `actorId` and timestamp. |
| **Archive HR**                                                            | `users.archivedAt = now()` + `team_members.leftAt = now()` for all teams where `userId = hrId`. Project-members are not touched (HR is not a member of a project directly). Audit log: `user_audit_log` + `team_audit_log` (per team — `team_member_removed`).                                                                                                                                                                                                                                                                            |
| **Archive ACCOUNTANT**                                                    | Same as HR: `users.archivedAt = now()` + `team_members.leftAt = now()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Archive JUNIOR**                                                        | `users.archivedAt = now()` + `project_members.leftAt = now()` for all active project memberships. A JUNIOR is not stored in `team_members` (a derived state from project membership), so we do not touch team_members. Audit: `user_audit_log` + `project_audit_log`.                                                                                                                                                                                                                                                                     |
| **Archive ADMIN**                                                         | `users.archivedAt = now()` — no dependencies. Audit: `user_audit_log`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Archive PROJECT** (independent — does not touch senior/team)            | `projects.archivedAt = now()` + `project_members.leftAt = now()` for all active JUNIORs. The SENIOR and team are **not touched**. Audit: `project_audit_log`.                                                                                                                                                                                                                                                                                                                                                                             |

### 5.2 Unarchive

| Action                                                                        | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unarchive SENIOR ≡ Unarchive their team** (one transaction, two UI entries) | `users.archivedAt = NULL` for the SENIOR + `teams.archivedAt = NULL` for their team. Projects **stay archived** (to return a project to active state — a separate unarchive of the project). The HR/ACCOUNTANT `team_members.leftAt` is **NOT** restored — they must be re-added via the Teams page. The SENIOR's `team_member` entry is already active (leftAt=NULL, not touched on archive). Net result: after unarchive the team is **empty, only the SENIOR**.          |
| **Unarchive HR / ACCOUNTANT / JUNIOR / ADMIN**                                | `users.archivedAt = NULL`. `team_members.leftAt` and `project_members.leftAt` are **NOT** restored — re-add via the UI.                                                                                                                                                                                                                                                                                                                                                     |
| **Unarchive PROJECT** (senior+team active)                                    | `projects.archivedAt = NULL`. `project_members.leftAt` is NOT restored — the JUNIORs must be re-added. The **effective team of the project** (HR/ACCOUNTANT) is pulled **dynamically from the current state** of the senior's team `team_members` — that is, from those HR/Acc that are currently active in the senior's team (NOT a snapshot of the moment of archiving). If the senior's HR changed during the archive — after unarchive the project will see the new HR. |
| **Unarchive PROJECT** (senior or team archived)                               | The endpoint returns 409 with `{ requiresCascade: true, entities: [{type: 'user', id, name}, {type: 'team', id, name}] }`. The client shows a modal with the list. The ADMIN confirms → a request with `?cascade=true` → unarchive **of the senior+team pair** + unarchive of the project — all in one transaction.                                                                                                                                                         |

**Principles of `leftAt` behavior on unarchive:**

1. **Never restore `leftAt` back to NULL** on the unarchive of any entity (USER / TEAM / PROJECT). Membership is a state separate from the entity.
2. **The SENIOR's own `team_member` entry** — permanent (`leftAt = NULL` always, as long as the team exists). On archiving the senior we do not touch it, so on unarchive there is nothing to restore — it is already active.
3. **HR / ACCOUNTANT after unarchiving a team** — must be re-added via `POST /teams/:id/members`.
4. **JUNIOR after unarchiving a project** — must be re-added via `POST /projects/:id/members`.

The UI explicitly reports on unarchive: "Restoring a team does NOT restore its HR/Accountants — add them again."

**Effective team of a project (computed view):** for an active project it is computed on the fly as `{senior} ∪ {team_members of senior's team where leftAt IS NULL AND role IN (HR, ACCOUNTANT)} ∪ {project_members where leftAt IS NULL}`. This view is used by the backend when answering `GET /projects/:id` and by the frontend for display. After unarchiving a project the view automatically reflects the current state of the senior's team.

### 5.3 Audit log — a mirror of users for teams and projects

User requested: "make a similar [audit log] like users have but for projects and teams". That is, team and project get a **full analog** of what users have:

| What users have (exists)                       | Analog for teams (new)                  | Analog for projects (new)                   |
| ---------------------------------------------- | --------------------------------------- | ------------------------------------------- |
| Table `user_audit_log`                         | `team_audit_log`                        | `project_audit_log`                         |
| Service `AuditLogService.record/list/diff`     | `TeamAuditLogService`                   | `ProjectAuditLogService`                    |
| Endpoint `GET /users/:id/audit-log`            | `GET /teams/:id/audit-log`              | `GET /projects/:id/audit-log`               |
| Frontend tab `AuditLogTab` in the profile page | `AuditLogTab` in `/crm/team/:id` detail | `AuditLogTab` in `/crm/projects/:id` detail |
| `AdminActionsMenu` on the profile              | `AdminActionsMenu` on the team detail   | `AdminActionsMenu` on the project detail    |

The structure of `team_audit_log` / `project_audit_log` is identical to `user_audit_log`:

```ts
{ id, actorId, targetId, action, changes (JSONB before/after), createdAt }
```

Actions (extended list):

- `user_audit_log`: existing + `user_unarchived`
- `team_audit_log`: `team_created`, `team_renamed`, `team_archived`, `team_unarchived`, `team_member_added`, `team_member_removed`
- `project_audit_log`: `project_created`, `project_edited`, `project_status_changed`, `project_archived`, `project_unarchived`, `project_member_added`, `project_member_removed`

On a cascade operation (archive of a SENIOR pair with N projects) **several related records** are written in one transaction, all with one `actorId` and the same timestamp:

- 1 in `user_audit_log` (`user_archived`)
- 1 in `team_audit_log` (`team_archived` + N `team_member_removed`)
- N in `project_audit_log` (`project_archived` + M `project_member_removed` per project)

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
  leftAt: timestamp('left_at'), // NEW (soft delete, like project_members)
})

export const teamAuditLog = pgTable('team_audit_log', {
  // ... same shape as user_audit_log
})

export const projectAuditLog = pgTable('project_audit_log', {
  // ... same shape as user_audit_log
})
```

**Important:** we keep `projects.status` (`ACTIVE | CLOSED`) — this is a business status (closing a contract with a client), not an admin archive. Archive is a separate orthogonal concept. The UI shows both: a closed badge + an archived overlay.

### 6.2 Endpoints

| Method   | Path                                     | Role     | Behaviour                                                                                                                                                                                                 |
| -------- | ---------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DELETE` | `/users/:id` (any role)                  | ADMIN    | Soft archive with cascade per role (§5.1). For a SENIOR — pair-archive (see below). Returns the updated user.                                                                                             |
| `POST`   | `/users/:id/unarchive`                   | ADMIN    | `archivedAt = NULL`. For a SENIOR — pair-unarchive (restores the team). 400 if already active.                                                                                                            |
| `DELETE` | `/teams/:id`                             | ADMIN    | **Pair-archive:** alias for `DELETE /users/:seniorId`. Delegates to `UsersService.archive(team.seniorId)`. Returns the updated team. Audit log as a pair.                                                 |
| `POST`   | `/teams/:id/unarchive`                   | ADMIN    | **Pair-unarchive:** alias for `POST /users/:seniorId/unarchive`. Restores senior + team in one transaction. Projects stay archived.                                                                       |
| `DELETE` | `/projects/:id`                          | ADMIN    | Soft archive: `projects.archivedAt = now()` + `project_members.leftAt = now()` for active JUNIORs. Does not touch senior/team.                                                                            |
| `POST`   | `/projects/:id/unarchive`                | ADMIN    | If senior+team are active → unarchives the project (the effective team is pulled from the current state of the senior's team_members). If senior/team are archived → 409 `{ requiresCascade, entities }`. |
| `POST`   | `/projects/:id/unarchive?cascade=true`   | ADMIN    | Pair-unarchive senior+team + unarchive the project in one transaction.                                                                                                                                    |
| `GET`    | `/users?archived=true`                   | ADMIN    | Returns archived ones. By default `archived=false` (only active).                                                                                                                                         |
| `GET`    | `/teams?archived=true`                   | per RBAC | Same.                                                                                                                                                                                                     |
| `GET`    | `/projects?archived=true`                | per RBAC | Same.                                                                                                                                                                                                     |
| `GET`    | `/users/:id/archive-impact`              | ADMIN    | Returns `{ teamsCount, projectsCount, membersAffected, isPaired: boolean }`. For a SENIOR `isPaired=true` + full cascade counts. Used by the UI for warning texts.                                        |
| `GET`    | `/teams/:id/archive-impact`              | ADMIN    | Returns `{ isPaired: true, seniorName, projectsCount, membersAffected }`. The UI shows "senior {N} + N projects will be archived".                                                                        |
| `GET`    | `/projects/:id/archive-impact`           | ADMIN    | Returns `{ activeMembersCount }`. The UI shows "N active members will be removed".                                                                                                                        |
| `GET`    | `/teams/:id/audit-log?page=X&limit=Y`    | ADMIN    | List of actions from `team_audit_log`. Mirror of the users endpoint.                                                                                                                                      |
| `GET`    | `/projects/:id/audit-log?page=X&limit=Y` | ADMIN    | List of actions from `project_audit_log`. Mirror of the users endpoint.                                                                                                                                   |

`AdminUpdateUserDto` is extended with optional fields `hrIds?` and `accountantId?` for a SENIOR — `PATCH /users/:id` updates the `team_members` for this SENIOR's team (corresponds to the fix of the Edit-dialog asymmetry). Diff in the audit log: `team_member_added` for new ones, `team_member_removed` (set leftAt) for the excluded ones.

### 6.3 Service-level cascade

Pseudo-code for `UsersService.archive`:

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
        // Set leftAt only for HR/ACCOUNTANT — NOT for the senior himself (he stays in team_members as identity)
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

**`TeamsService.archive(teamId)` — alias for pair-archive:**

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

**Transaction failure handling:** all cascade operations (`UsersService.archive`, `UsersService.unarchive` for a SENIOR, `ProjectsService.unarchive` cascade=true) are wrapped in `db.transaction()`. On any throw inside — an automatic `ROLLBACK` by Drizzle/postgres, the state does not change. Audit log records are made in the same transaction — on rollback they are rolled back too. The NestJS exception filter returns 500 with a generic message; a stack trace remains in the logs for debug.

Analogous transaction-based logic for `ProjectsService.unarchive(id, cascade)`:

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

Create `TeamAuditLogService` and `ProjectAuditLogService` modeled on `UsersService/AuditLogService`. Injected via DI into TeamsService and ProjectsService.

### 6.5 Shared schemas (`packages/shared/src/schemas/`)

Extend the existing `teamSchema` and `projectSchema` (in `packages/shared/src/schemas/teams.ts` and `projects.ts`) with the `archivedAt` field:

```ts
// teams.ts — extend the existing object
export const teamSchema = z.object({
  // ... all existing fields
  archivedAt: z.string().datetime().nullable(),
})

// projects.ts — extend the existing object
export const projectSchema = z.object({
  // ... all existing fields
  archivedAt: z.string().datetime().nullable(),
})

// teamMembers — extend leftAt
export const teamMemberSchema = z.object({
  // ... all existing fields
  leftAt: z.string().datetime().nullable(),
})
```

New schemas for the audit log (`teamAuditLogEntrySchema`, `projectAuditLogEntrySchema`) — a copy of the `userAuditLogEntrySchema` structure.

`AdminUpdateUserDto` is extended with optional fields for the SENIOR Edit:

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
- CREATE INDEX on target_id of both audit tables

## 7. PR 2 — `/crm/users` UI Refactor

### 7.1 Table layout (variant C-v2)

Grid: `64px (leading actions) | 3fr (user info) | 1.4fr (right meta)`, min-height 76px, rounded `<Card>` rows with a hover effect.

**Columns:**

- **Leading actions (64px):** vertically 2 buttons `Pencil` + `Trash2`, 28×28 px, opacity 0.4 at rest → 1.0 on row hover. Use `event.stopPropagation()` so the click does not trigger navigation to the profile. Delete for your own row — disabled (as now).
- **User info (3fr):** avatar 40px + `displayName` (with inline "You" for self) + meta-row (email · @tg · phone in one line with `·` separators) + tech-pills (array, **fix of an existing bug** where `{u.techStack}` rendered the string directly).
- **Right meta (1.4fr):** Role badge on top + relative date at the bottom (`2 months ago`) via `date-fns` `formatDistanceToNow`.

**Row behavior:**

- The whole row is wrapped in `<Link to="/crm/profile/$userId" params={{ userId: u.id }}>` with `cursor: pointer`
- Hover: `bg-white/4` (or `bg-muted/40` via Tailwind tokens)
- Self-row: `bg-primary/6` + `border-primary/20`, leading-actions opacity always 1.0
- Archived-row (only with the toggle on): `opacity-50`, an "Archived" badge next to Role. Leading-actions are replaced with a single "Restore" button (icon `ArchiveRestore` 28×28, opacity 0.4 → 1.0 on hover). On the profile page of an archived user — also a "Restore" button in `AdminActionsMenu`. The Edit dialog does not open for archived ones (no button).

**Sort indicators:**

- Replace `ArrowUpDown` (always) with `ChevronUp` / `ChevronDown` depending on `sortDir`
- The active column — `text-primary`, the inactive one — `text-muted-foreground/40`

**Filters (above the Card):**

- Search input (as now)
- Role select (as now)
- **NEW:** a "Show archived" toggle (Checkbox or Switch, off by default). When turned on — `?archived=true` in the URL via TanStack Router `validateSearch`. Archived users are mixed into the table with visual treatment.

### 7.2 Dialogs — section structure

**Create dialog (CreateUserDialog):**

1. **Identity** — Email (required), First and last name (required), Role (Select)
2. **Contacts** — Telegram, Phone
3. **Profession** — Tech stack (TechAutocompleteInput, an array of pills)
4. **Finances** — IF SENIOR: ShareSlider (% company / % senior) | IF JUNIOR/HR/ACCOUNTANT: Monthly salary (USD input)
5. **Team** — IF SENIOR: HR multiselect + Accountant select | IF JUNIOR: Project select (initial assignment)

Sections — `<div className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-3">` with a label `<p className="text-xs font-medium text-muted-foreground">Section name</p>` on top.

**Edit dialog (EditUserDialog):**

- The same 5 sections
- In the Identity section the Email is displayed **read-only** (`<div className="text-sm muted">{user.email}</div>` next to the label) — it cannot be changed (Google OAuth identifier)
- **The Team section is now editable for a SENIOR** (fix of the asymmetry): HR multiselect + Accountant select. Backend support from PR 1 (`AdminUpdateUserDto` extended).
- For a JUNIOR in Edit — the "Projects" section shows the current active projects as read-only badges + a "Manage in /crm/projects" link (project add/remove is done there).

**Sticky footer:**

- On the left: a small Role badge (non-interactive, context reminder)
- On the right: "Cancel" + "Create"/"Save" (with a loading state)

### 7.3 Archive dialog (instead of the current DeleteUserDialog)

A new component `ArchiveUserConfirmDialog`. Behavior by role:

| Role       | Warning text                                                                                                                                                                                                                                                                                                                                                                                                                            | Required confirmation |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| SENIOR     | "**{displayName}** and their team **{teamName}** — a linked pair. On archiving, the following will be archived: the senior's profile, the team **{teamName}** (the team's HR/accountants will be detached — {N}), and all their projects ({M} of them, {K} active JUNIORs will be detached). Restoration is possible — the senior+team pair will return, but projects will need to be restored separately with a cascade confirmation." | Enter the full name   |
| HR         | "**{displayName}** will be archived and removed from **{N} teams** (HR role). The teams themselves will stay active."                                                                                                                                                                                                                                                                                                                   | Enter the full name   |
| ACCOUNTANT | "**{displayName}** will be archived and removed from **{N} teams** (accountant role). The teams themselves will stay active."                                                                                                                                                                                                                                                                                                           | Enter the full name   |
| JUNIOR     | "**{displayName}** will be archived and removed from **{M} active projects**. The projects themselves will stay active."                                                                                                                                                                                                                                                                                                                | Enter the full name   |
| ADMIN      | "**{displayName}** will be archived. There are no linked entities."                                                                                                                                                                                                                                                                                                                                                                     | Enter the full name   |

The numbers N/M/K come from the new endpoint `GET /users/:id/archive-impact` → `{ teamsCount, projectsCount, membersAffected }`.

### 7.4 Unarchive flow

In `AdminActionsMenu` for an archived user — a "Restore from archive" button. A simple POST `/users/:id/unarchive`, toast "User restored". Without cascade (only the user themselves).

## 8. PR 3 — `/crm/team` and `/crm/projects` Archive Views + Admin Actions + Audit Log

**Goal of the section:** give teams and projects a full analog of what users have — `AdminActionsMenu` (archive/unarchive), `AuditLogTab` (history), and a toggle of archived on the list pages.

### 8.1 `/crm/team` (list page)

- A "Show archived" toggle in the header (OFF by default)
- Archived teams — `opacity-50` + an "Archived" badge
- On an archived team card — a "Restore" button (calls `POST /teams/:id/unarchive` → pair-unarchive → SENIOR + team active, projects stay archived)
- On an active team — an Action menu (`⋯`) with items: "Edit", "Archive"
- "Archive" opens a confirm dialog with a warning: "**{teamName}** and its senior **{seniorName}** — a linked pair. On archiving, the following will be archived: the senior's profile, the team (HR/accountants will be detached — {N}), and all their projects ({M} of them). This is equivalent to archiving the senior **{seniorName}**." + entering the senior's name to confirm

### 8.2 `/crm/team/:teamId` (detail page) — NEW

Create a detail page if it does not exist yet, or extend an existing one:

- Header: the team name, a status badge (active / archived), the `AdminActionsMenu` (`⋯`) button with actions: "Edit", "Archive" (if active) / "Restore from archive" (if archived)
- Tabs:
  - **"Members"** — current team members (HR, SENIOR, ACCOUNTANT — from `team_members` where `leftAt IS NULL`)
  - **"Change history"** — `AuditLogTab` connected to `GET /teams/:id/audit-log`, paginated. Mirror of the users' AuditLogTab. Shows all `team_*` actions: created, renamed, member added/removed, archived, unarchived.

### 8.3 `/crm/projects` (list page)

- A "Show archived" toggle in the header (OFF by default)
- Archived projects — `opacity-50` + an "Archived" badge
- On an archived project card — a "Restore" button
  - On click — the client does POST `/projects/:id/unarchive`
  - If 409 + `requiresCascade` — a **modal** opens: "To restore the project **{projectName}** the pair must also be restored:" + a list of entity cards ({type: 'user', name: 'Ivan Ivanov', role: 'SENIOR'}, {type: 'team', name: 'Team Ivan'}) + buttons "Cancel" / "Restore all"
  - The "Restore all" button does POST with `?cascade=true`
  - Toast: "Restored: project, senior, team" (or just "project" if cascade was not needed)
  - **Important UI**: after unarchiving a project the effective team is shown dynamically from the current senior's `team_members`, NOT a snapshot of the moment of archiving. If the senior's HR has changed since the archive — after unarchiving the project the new HR will be visible
- On an active project — an Action menu (`⋯`): "Edit", "Change status" (active/closed), "Archive"
- "Archive" opens a confirm with a warning: "The project **{name}** will be archived, **{N} active JUNIORs** will be detached. The senior and the team will **not** be archived. The financial history (transactions, invoices) stays available." + entering the project name to confirm

### 8.4 `/crm/projects/:projectId` (detail page) — extend

- Header: the project name, a status badge (active/closed + an archived overlay if archived), the `AdminActionsMenu` (`⋯`) button similarly to teams
- Tabs:
  - **"Overview"** (existing) — company, domain, senior, rate, status
  - **"Members"** — the effective team (computed view): SENIOR + HR/ACCOUNTANT from the senior's team + JUNIORs from `project_members` where `leftAt IS NULL`
  - **"Change history"** — NEW: `AuditLogTab` connected to `GET /projects/:id/audit-log`. Shows all `project_*` actions.
  - **"Finances"** (existing) — transactions, invoices related to the project (shown even for archived projects)

### 8.5 Implementation (general)

- We refactor the `AuditLogTab` component into a **generic component** that takes `entityType: 'user' | 'team' | 'project'` and `entityId`. Inside it makes a request to the corresponding endpoint and formats the diff (action labels localized to Russian).
- The `AdminActionsMenu` component is also generic with `entityType` — renders menu items depending on the entity and the current state (whether archived).
- Move the existing component `apps/web/app/components/user-profile/admin-actions/AdminActionsMenu.tsx` → `apps/web/app/components/admin-actions/AdminActionsMenu.tsx` (shared), or extract the shared parts. The Coder decides at the implementation level.

## 9. Testing Strategy

### 9.1 PR 1 — unit tests (Vitest, `apps/api/`)

| File                             | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users.service.spec.ts`          | archive SENIOR — pair cascade: team archived + projects archived + HR/Acc team_members.leftAt set + own team_member entry **untouched** (assert: senior's own team_member still leftAt=NULL). archive HR/ACCOUNTANT — only team_members.leftAt. archive JUNIOR — only project_members.leftAt. archive ADMIN — only user. unarchive SENIOR — pair: senior + team active, projects stay archived, HR/Acc team_members.leftAt **NOT** restored. Audit log written to the correct tables. Idempotency — double archive throws 400.                                                                                                                       |
| `teams.service.spec.ts`          | archive team — delegates to UsersService.archive(team.seniorId) → pair-archive (assert: senior archived, projects archived). unarchive team — delegates to UsersService.unarchive → pair-unarchive (assert: senior + team active, projects stay archived). If team.seniorId does not exist → 404. Audit log written to team_audit_log.                                                                                                                                                                                                                                                                                                               |
| `projects.service.spec.ts`       | archive project — `archivedAt` + project_members.leftAt for active JUNIORs. Does not touch senior/team. unarchive project with active senior+team — success, project_members.leftAt **NOT** restored. unarchive project with an archived senior → 409 + `{requiresCascade, entities}` with a list of senior+team. unarchive cascade=true with an archived senior+team → unarchives the pair (senior + team) + project in one transaction. **Effective team test:** unarchive project, then change senior's team_members (add HR2), GET /projects/:id → effective team contains HR2 (current state, not snapshot). Audit log written for each entity. |
| `audit-log.service.spec.ts` (×3) | `user_audit_log` + `team_audit_log` + `project_audit_log` — record/list/diff. Pagination works.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### 9.2 PR 1 — integration tests (Vitest, via the NestJS test app)

- E2E API flow: create SENIOR + team + project → archive SENIOR → GET /teams/:id (found with `archivedAt`) → GET /projects/:id (also) → unarchive project without cascade → 409 → unarchive project with cascade → everything active
- RBAC: non-ADMIN on DELETE /teams/:id → 403

### 9.3 PR 2 — E2E (Playwright, `apps/e2e/`)

| Flow                                | Assertions                                                                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADMIN sees the C-v2 table           | Avatar 40px, name+meta, tech-pills (array), relative date. Hover on a row → leading actions opacity 1. Click on a row → navigate to profile.                          |
| Sort                                | Click `User` → asc, click again → desc. `ChevronUp/Down` shows the direction.                                                                                         |
| Create SENIOR                       | Sections visible (Identity / Contacts / Profession / Finances / Team). HR multiselect + Accountant select work. Submit creates a user + team.                         |
| Edit SENIOR                         | Open edit → the "Team" section is editable (new). Change HR → the PATCH request contains `hrIds`. After save — the table is updated.                                  |
| Archive JUNIOR with active projects | Click Trash → the dialog "removed from 2 projects". Enter the name → confirm → archive + toast. The user disappeared from the table.                                  |
| Archive SENIOR                      | The warning lists the team + N projects + members. Confirm → archive with cascade. On /crm/team — the team is archived. On /crm/projects — the projects are archived. |
| Toggle of archived                  | Turn on → archived appeared with opacity-50 + badge. Edit/Delete hidden. Click row → navigate to profile.                                                             |
| Unarchive a user                    | From the profile or admin menu → click "Restore" → the user is active, the badge is removed.                                                                          |

### 9.4 PR 3 — E2E

| Flow                                    | Assertions                                                                                                                                                                                                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| /crm/team archive toggle                | Turn on → archived teams are shown with opacity. Click "Restore" → pair-unarchive → the SENIOR in /crm/users is also active. Toast "Team and senior restored".                                                                                                                                      |
| /crm/team/:id detail page               | Open detail → 2 tabs visible: "Members" (HR/SENIOR/ACCOUNTANT) + "Change history" (audit log). AdminActionsMenu has an "Archive" button → click → pair-archive warning → SENIOR + projects also archived.                                                                                           |
| /crm/team archive — pair                | Click "Archive" in /crm/team → warning "senior + N projects". Confirm → check /crm/users — the SENIOR has an "Archived" badge. Check /crm/projects — all their projects are archived.                                                                                                               |
| /crm/projects unarchive cascade         | An archived project of an archived senior → click "Restore" → a modal with a list (user + team as a pair). Click "Restore all" → cascade unarchive. Toast "Restored: project, senior, team". In /crm/users the senior is active. In /crm/team the team is active (without HR/Acc — need to re-add). |
| /crm/projects unarchive without cascade | If senior+team are active → click "Restore" → unarchive without a modal. The effective team in /crm/projects/:id shows the current HR/Acc from the senior's team.                                                                                                                                   |
| /crm/projects/:id detail audit log      | Open the detail of an archived project → tab "Change history" → entries visible: `project_archived` with the correct diff and actor.                                                                                                                                                                |
| Effective team dynamism                 | An archived project → unarchive (without cascade). Change the senior's HR (new HR1 instead of the old HR0). GET /crm/projects/:id → the effective team shows HR1 (current, not a snapshot).                                                                                                         |

## 10. Open Decisions (resolved + flagged for review)

1. **Archived users in `/crm/users`** — a "Show archived" toggle (OFF by default). Archived ones with `opacity-50`, an "Archived" badge, without edit/delete actions. Alternatives (tabs / sidebar pill) are **not taken** — extra complexity.
2. **Transactions / Invoices when archiving a project** — do NOT cascade, stay active. The financial history must be visible by the archived project_id.
3. **An active SENIOR without projects after unarchive** — a situation is possible: we unarchive a SENIOR (pair with the team), their projects stay in the archive. SENIOR + team without projects — OK, they can create new ones.
4. **Audit log retention** — without TTL, infinitely. A cleanup job — a separate feature in the future.
5. **Email read-only in Edit** — displayed via `<div className="text-sm muted">{email}</div>` (label "Email" + value). Do not confuse with a readonly input — it is not needed.
6. **Project assignment for a JUNIOR in the Edit dialog** — we do NOT allow changing it. We only show active projects with a "Manage in Projects" link. Membership management — a single workflow via /crm/projects/:id.
7. **`projects.status` enum (ACTIVE/CLOSED) vs `archivedAt`** — both are kept. `status = CLOSED` means "the contract with the client is closed" (a business fact), `archivedAt` means "the admin removed it from the active UI". You can have CLOSED + active OR ACTIVE + archived (theoretically — but usually closed→archived together).
8. **SENIOR + team — a linked pair (invariant)** — a SENIOR without a team or a team without a senior cannot exist. Archive SENIOR ≡ archive team — one operation, two entry points (UI on /crm/users and UI on /crm/team). The same for unarchive. On the backend `TeamsService.archive(teamId)` delegates to `UsersService.archive(team.seniorId)` to avoid logic duplication.
9. **The project's effective team is computed dynamically** — not a snapshot of the moment of archiving. After unarchiving a project the HR/Accountant are pulled from the current state of the senior's team `team_members`. This means: if the senior's HR changed during the archive — the project will see the new HR after unarchive. **This is intentional behavior**, not a bug.
10. **AdminActionsMenu + AuditLogTab — generic components** — we refactor the existing user-profile components into reusable ones with an `entityType: 'user' | 'team' | 'project'` prop. Minimizes duplication. The Coder may choose the variant: a shared component or 3 identical files.
11. **The SENIOR's own `team_member` entry — permanent** — on archiving the senior pair `leftAt = now()` is NOT set. This is the senior's identity link with the team (1:1 invariant), not ordinary membership. In queries we filter `team_members` with the condition `WHERE userId != team.seniorId OR role = SENIOR` where it is critical.

## 11. Dependencies & Order

```
PR 1 — Backend Archive Foundation
   │
   │ (must merge first — PR 2 and PR 3 need the endpoints)
   │
   ├──> PR 2 — /crm/users UI refactor
   │      (needs: archive endpoints with cascade, GET /users?archived=true,
   │       PATCH /users/:id with hrIds+accountantId, GET /users/:id/archive-impact)
   │
   └──> PR 3 — /crm/team + /crm/projects archive views
          (needs: TeamsService.archive/unarchive,
           ProjectsService.archive/unarchive with cascade flow)
```

PR 2 and PR 3 can be developed in parallel by agents after merging PR 1.

## 12. Acceptance Criteria

### PR 1

- [ ] Drizzle migration 0012 applies without errors (including drizzle-kit generate)
- [ ] The schema contains `teams.archivedAt`, `projects.archivedAt`, `team_members.leftAt`, `team_audit_log`, `project_audit_log`
- [ ] All 5 cascade scenarios in `users.service.spec.ts` are green (including the SENIOR pair semantics — we do NOT touch the own team_member)
- [ ] `teams.service.spec.ts`: archive/unarchive — alias for UsersService.archive/unarchive (pair)
- [ ] `projects.service.spec.ts` covers 409 + cascade unarchive (pair senior+team)
- [ ] Audit log records appear for each archive/unarchive action in the correct table (`user_audit_log`, `team_audit_log`, `project_audit_log`)
- [ ] `GET /teams/:id/audit-log` and `GET /projects/:id/audit-log` paginated, return records
- [ ] `GET /users/:id/archive-impact`, `GET /teams/:id/archive-impact`, `GET /projects/:id/archive-impact` return the correct cascade counts
- [ ] Backward compat: the existing endpoints `GET /users`, `GET /teams`, `GET /projects` by default return only active (NOT archived) — a breaking change for the UI, requires an update in the PR 2/PR 3 frontend

### PR 2

- [ ] `/crm/users` renders the variant C-v2 layout (visual regression test on a screenshot)
- [ ] The Tech column shows an array of pills, not a string (bug fix)
- [ ] The date is in a relative format
- [ ] The sort indicator shows the direction
- [ ] Hover on a row — leading actions opacity 1
- [ ] Create/Edit dialogs — sections in a single scroll
- [ ] Edit SENIOR allows changing HR + Accountant (PATCH with hrIds+accountantId)
- [ ] The SENIOR Archive dialog mentions the pair (profile + team + N projects) + name-confirmation
- [ ] Archive dialog for HR/ACCOUNTANT/JUNIOR/ADMIN with the correct warning for each role
- [ ] The "Show archived" toggle works + URL state
- [ ] An archived row shows a "Restore" button (instead of edit/delete) → POST /users/:id/unarchive
- [ ] For a SENIOR unarchive — the frontend knows that it is a pair (toast: "senior and team restored")
- [ ] E2E (see §9.3) — all green

### PR 3

- [ ] /crm/team archive toggle + "Restore" button on an archived team (pair-unarchive)
- [ ] /crm/team/:id detail page contains `AdminActionsMenu` (archive/unarchive) + `AuditLogTab`
- [ ] /crm/projects archive toggle
- [ ] /crm/projects/:id detail page contains `AdminActionsMenu` + `AuditLogTab` + a "Members" tab with the effective team
- [ ] Project unarchive flow — if senior/team are archived → a modal with a list of the pair → cascade unarchive
- [ ] Project unarchive with an active senior+team → unarchive without cascade, the effective team shows the current HR/Acc
- [ ] AdminActionsMenu and AuditLogTab — generic components (`entityType` prop) or 3 separate but identical
- [ ] On unarchive cascade=true — all entities active + audit log written to the correct tables
- [ ] E2E (see §9.4) — all green

## 13. Risks

1. **Backward compat in `GET /users`/`/teams`/`/projects`** — if findAll() currently returns archived ones, the UI depends on this. After PR 1 the behavior changes to "by default only active". The frontend in PR 2 must update the queries with `?archived=true` where needed. Existing consumers (teams page, projects page) — check and update in PR 3 or simultaneously.

2. **Cascade transactions** — a large transaction over N tables when archiving a SENIOR with 10 projects. Postgres will handle it, but potentially row-level lock contention. Mitigation: everything via FOR UPDATE, the transaction is small in time (< 1 sec), idempotent.

3. **Audit log volume** — on a cascade SENIOR ~1 + 1 + N + M audit records are written. For a normal turnover (≤10 SENIORs in the company) — not a problem. An index on `target_id` will speed up reading for the UI.

4. **UI regression on other pages** — changes in `GET /teams` (default = active only) may affect `/crm/team`, `/crm/projects` queries. PR 3 covers this, but PR 1 merges earlier — between merging PR1 and PR3 there will be a window with a broken state. Mitigation: merge PR 1 and PR 3 in one wave, or a feature flag.

## 14. Task Decomposition (for PM to write task files)

After approving this spec — PM generates via the `writing-plans` skill 3 separate task files in `docs/specs/tasks/`:

- `task-archive-backend-foundation.md` — PR 1, Coder + DevOps + AutoTest, blocking
- `task-users-page-refactor.md` — PR 2, Coder + AutoTest, depends on PR 1 merge
- `task-archive-views-teams-projects.md` — PR 3, Coder + AutoTest, depends on PR 1 merge, parallel with PR 2

Dispatch — after merging PR 1: PR 2 and PR 3 in parallel via `Agent(isolation="worktree", run_in_background=True)`.

---

**Reviewer:** waiting for user approval before transitioning to the writing-plans skill.
