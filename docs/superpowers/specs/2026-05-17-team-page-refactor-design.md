# Team Page Refactor — Design

## Overview

A full refactor of the team pages: the list (index.tsx) and the detail page ($teamId.tsx).

**Goals:**

- Fix the broken buttons on the detail page (Add/Remove member)
- Add a `telegramGroupUrl` field to the team (JUNIOR does not see it)
- Hide the team creation date from JUNIOR
- Move member management from the list cards to the detail page
- Extract dialogs and constants into separate components

---

## File structure

### New files

```
apps/web/app/routes/crm/team/components/
  TeamCard.tsx            ← list card (view-only + delete for ADMIN)
  MemberRow.tsx           ← member row on the detail page
  CreateSeniorDialog.tsx  ← HR creates a senior (moved from index.tsx)
  AddMemberDialog.tsx     ← add a member to the team (fixed)
  EditTeamDialog.tsx      ← edit the team: name + telegramGroupUrl
  DeleteTeamDialog.tsx    ← delete the team (moved from index.tsx)

apps/web/app/lib/
  team-constants.ts       ← ROLE_LABELS, ROLE_VARIANT, getInitials (deduplication)
```

### Changed files

```
apps/web/app/routes/crm/team/index.tsx     ← thin: grid + CreateSenior + DeleteTeam
apps/web/app/routes/crm/team/$teamId.tsx   ← thin: layout + mounting the dialogs
packages/shared/src/schemas/teams.ts       ← telegramGroupUrl in the schemas
apps/api/src/teams/teams.service.ts        ← telegramGroupUrl in CRUD
apps/api/src/teams/teams.controller.ts     ← GET /teams/:id open to all roles (already present)
apps/api/drizzle/migrations/0012_*.sql    ← ALTER TABLE teams ADD COLUMN
```

---

## DB — migration 0012

```sql
ALTER TABLE teams ADD COLUMN telegram_group_url TEXT;
```

Optional field, no NOT NULL, no default.

---

## Backend

### Shared schemas (`packages/shared/src/schemas/teams.ts`)

```ts
// createTeamSchema and updateTeamSchema:
telegramGroupUrl: z.string().url().optional().nullable()

// TeamDto:
telegramGroupUrl: string | null
```

### teams.service.ts

- `createTeam`: save `telegramGroupUrl` if provided
- `updateTeam`: update `telegramGroupUrl`
- `findAll` / `findOne`: include `telegramGroupUrl` in the response

### Endpoints — no changes

`GET /api/teams/:id` is already open to all authenticated roles (implemented in PR #11).

---

## Frontend — Team list (index.tsx)

**What stays:**

- The "Team" heading + the HR "Create a senior" button
- A grid of `<TeamCard>` components
- Auto-redirect SENIOR/JUNIOR → `/crm/team/:id`
- Mounting `<CreateSeniorDialog>` and `<DeleteTeamDialog>`

**What goes:**

- Inline Edit/AddMember buttons on the cards (move to detail)
- `EditTeamDialog` from index.tsx
- `AddMemberDialog` from index.tsx
- Duplicated constants

### TeamCard.tsx

```
┌─────────────────────────────────────┐
│  Team Alpha                    [🗑]  │  ← [🗑] ADMIN only
│  HR: Maria Ivanova                   │
├─────────────────────────────────────┤
│  ●●●●+2          3 members           │
│  Active projects: 2                  │
└─────────────────────────────────────┘
```

- The whole card — a clickable Link → `/crm/team/:id`
- The ADMIN Delete button: `e.preventDefault()` + `e.stopPropagation()`, z-index above the Link
- No Edit/AddMember buttons

---

## Frontend — Detail page ($teamId.tsx)

### Layout

```
┌──────────────────────────────────────────────────────┐
│  ← Back     Team Alpha                  [✏ Edit]     │  ← ADMIN/HR
│             Created 12 May 2025  · 🔗 Telegram        │  ← hidden from JUNIOR
│                                    [🗑 Delete]        │  ← ADMIN only
├──────────────────────────────────────────────────────┤
│  Members (3)                       [+ Add]            │  ← ADMIN/HR
│                                                      │
│  ┌─────────────────────────────────────────────────┐ │
│  │ ● Ivan Ivanov   [Senior]          → profile    │ │
│  │   ivan@email.com · TypeScript BE               │ │
│  └─────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────┐ │
│  │ ● Maria HR      [HR]              → profile [✕]│ │  ← [✕] ADMIN/HR
│  │   maria@email.com                              │ │
│  └─────────────────────────────────────────────────┘ │
│                                                      │
│  Active projects: 2                                  │
└──────────────────────────────────────────────────────┘
```

### Behavior

- **Member list**: flat, no per-role headings. Order: SENIOR → HR → ACCOUNTANT → JUNIOR.
- **Role badge**: on each member card (badge variant by role).
- **Creation date**: hidden if `user.role === 'JUNIOR'`.
- **Telegram link**: hidden if `user.role === 'JUNIOR'`. If `team.telegramGroupUrl` is not set — show nothing. If set — an icon + a `target="_blank"` link.
- **"Edit" button**: opens `EditTeamDialog` with the Name + Telegram URL fields.
- **"Delete" button**: ADMIN only, opens `DeleteTeamDialog`.
- **"+ Add" button**: ADMIN + HR owner, opens `AddMemberDialog`.
- **The [✕] button on a member**: ADMIN + HR owner. NOT rendered if:
  - `member.role === 'SENIOR'` (cannot be removed — the team must be deleted instead)
  - `member.role === 'JUNIOR'` (a derived state)
  - The last HR in the team
  - The last ACCOUNTANT in the team

### MemberRow.tsx

Props: `member`, `canManage`, `canRemove`, `onRemove`

---

## RBAC — summary table

| Action                  | ADMIN  | HR (owner)      | SENIOR     | JUNIOR                         | ACCOUNTANT |
| ----------------------- | ------ | --------------- | ---------- | ------------------------------ | ---------- |
| See the list            | ✅ all | ✅ own          | → redirect | → redirect                     | ✅ all     |
| See detail              | ✅     | ✅              | ✅ own     | ✅ own (without other juniors) | ✅         |
| See the date            | ✅     | ✅              | ✅         | ❌                             | ✅         |
| See Telegram            | ✅     | ✅              | ✅         | ❌                             | ✅         |
| Create a senior         | ❌     | ✅              | ❌         | ❌                             | ❌         |
| Edit the team           | ✅     | ✅              | ❌         | ❌                             | ❌         |
| Delete the team         | ✅     | ❌              | ❌         | ❌                             | ❌         |
| Add a member            | ✅     | ✅              | ❌         | ❌                             | ❌         |
| Remove a member         | ✅     | ✅ (with rules) | ❌         | ❌                             | ❌         |
| Delete on the list card | ✅     | ❌              | —          | —                              | ❌         |

---

## Acceptance Criteria

- [ ] `pnpm typecheck` and `pnpm lint` pass
- [ ] SENIOR/JUNIOR opening `/crm/team` → redirect to `/crm/team/:id`
- [ ] JUNIOR on the detail page does not see other JUNIORs (server-side)
- [ ] JUNIOR does not see the creation date and the Telegram link
- [ ] The "+ Add member" button on the detail page opens the dialog and adds
- [ ] The [✕] button on a member opens a confirmation and removes
- [ ] "Edit" opens the dialog with the Name + Telegram URL fields
- [ ] PATCH /api/teams/:id saves `telegramGroupUrl`
- [ ] The Telegram link is shown on the detail page (if set), opens in a new tab
- [ ] The cards on the list page are clickable, no inline Edit/AddMember buttons
- [ ] ADMIN sees the Delete button on the list card
- [ ] Duplication of ROLE_LABELS/ROLE_VARIANT/getInitials eliminated (one file `team-constants.ts`)
- [ ] Dialogs in separate components, index.tsx < 250 lines, $teamId.tsx < 200 lines

---

## Out of scope

- Changing backend RBAC (already implemented)
- Uploading photos/files for the team
- Member change history
