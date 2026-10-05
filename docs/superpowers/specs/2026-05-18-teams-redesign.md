# Teams UI Redesign — Design Spec

**Date:** 2026-05-18  
**Status:** Approved

---

## Scope

Redesign of two pages: the team list (`/crm/team`) and the team page (`/crm/team/$teamId`).  
Also: a new DB migration for the `telegram` and `notes` fields on the `teams` table.

---

## 1. DB Migration

New file: `apps/api/drizzle/migrations/0002_team_telegram_notes.sql`

```sql
ALTER TABLE "teams" ADD COLUMN "telegram" varchar(500);
ALTER TABLE "teams" ADD COLUMN "notes" text;
```

Update `apps/api/src/database/schema.ts` — add the `telegram` and `notes` fields to the `teams` table.  
Update `packages/shared/src/schemas/teams.ts` — add optional fields to `teamSchema` and `updateTeamSchema`.  
Update `apps/api/src/teams/teams.service.ts` — accept `telegram` and `notes` in `update()`.

---

## 2. Team list (`/crm/team/index.tsx`)

### What to remove

- The page subtitle (`<p>Team members and roles</p>`)
- The `UserPlus` (add member) and `Trash2` (delete team) buttons from the cards

### Toolbar (new)

Above the list: search by name + filter (All / Senior / HR / Junior) + sorting (Name ↑/↓ / Members / Projects).

### List view

Instead of a grid of cards — a vertical list of rows. Each row a fixed height of `56px`:

```
[avatars -space-x] | [Team name / HR: Name, Name…] | [N mem.] [N projects] [✏]
```

- Avatars: the first 4 with `-space-x-2`, then `+N`
- HR subtitle: `text-ellipsis overflow-hidden whitespace-nowrap` → never affects the height
- Projects pill: green if > 0, gray if 0
- The ✏ (rename) button: only for `canManage` (ADMIN or the team's HR owner)
- Animation: staggered motion as now

### RBAC on the list

- ADMIN: sees all teams, the ✏ button
- HR: sees their own teams, the ✏ button
- SENIOR / JUNIOR / ACCOUNTANT: view-only, no ✏

---

## 3. Team page (`/crm/team/$teamId.tsx`)

### What to remove

- The entire "Statistics" sidebar (member counts by role)
- The "Activity" card (active projects count in the sidebar)
- The `UserPlus` "Add member" button that had no onClick

### New page structure (single column)

**Header:**

```
[← Back] [Team name]    [👤+ Add]  [✏ Edit]   ← only canManage
```

**"Members" section** — the existing list by role (SENIOR → HR → ACCOUNTANT → JUNIOR)

**"Active projects" section** with a counter badge:

```
Active projects  [2]
─────────────────────
[logo] Project name    Active  →  /crm/projects/:id
[logo] Project name    Active
```

Logo: `project.logoUrl` if present, otherwise an emoji placeholder 🏢.  
Each row — a clickable Link to `/crm/projects/:id`.

---

## 4. RBAC on the team page

| Role       | Members                                              | Projects                   | Buttons          |
| ---------- | ---------------------------------------------------- | -------------------------- | ---------------- |
| ADMIN      | All                                                  | All active teams           | ✏ Edit + 👤+ Add |
| HR         | All                                                  | All active teams           | ✏ Edit + 👤+ Add |
| SENIOR     | All (including all juniors)                          | All active teams           | —                |
| JUNIOR     | Only Senior + HR + Accountant (other juniors hidden) | Only **their own** project | —                |
| ACCOUNTANT | All                                                  | All active teams           | —                |

---

## 5. "Edit team" dialog

Fields:

- **Name** (required) — `Input`
- **Telegram** (optional) — `Input`, placeholder `https://t.me/...`, hint "Link to the team chat"
- **Notes** (optional) — `Textarea`, placeholder "Internal notes…"

Actions: Save → `PATCH /api/teams/:id` with `{ name, telegram, notes }`.

---

## 6. "Add member" dialog

**No search row.**

The list is sorted alphabetically (`displayName`), split into two groups:

**Available (checkbox):**

- HR, ACCOUNTANT — if not in the team
- JUNIOR — if not in the team AND has no active project (`project_members.leftAt IS NULL`)

**Unavailable (gray, no checkbox, with an explanation on the right):**

- ADMIN → "admin"
- Already in the team → "in the team"
- SENIOR (if the team already has a SENIOR) → "already has a senior"
- JUNIOR with an active project → "has a project"

The "Add selected (N)" button — active if at least one is selected.

---

## 7. Files that change

| File                                                       | Changes                                                  |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| `apps/api/drizzle/migrations/0002_team_telegram_notes.sql` | NEW — a new migration                                    |
| `apps/api/src/database/schema.ts`                          | `+telegram`, `+notes` on the teams table                 |
| `packages/shared/src/schemas/teams.ts`                     | `+telegram?`, `+notes?` in teamSchema / updateTeamSchema |
| `apps/api/src/teams/teams.service.ts`                      | `update()` accepts telegram, notes                       |
| `apps/web/app/routes/crm/team/index.tsx`                   | Full redesign of the list + toolbar                      |
| `apps/web/app/routes/crm/team/$teamId.tsx`                 | New layout + dialogs + RBAC                              |

---

## 8. Out of scope

- Deleting a team (remains only via the list — for now the button is removed, the logic is not removed from the backend)
- Notifications on adding a member
- Pagination of the team list
